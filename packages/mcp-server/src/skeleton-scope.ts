import fs from "node:fs";
import path from "node:path";

/**
 * Skeleton plans — the plan IS the code's shape.
 *
 * The agent writes the skeleton to disk first: real files, types, signatures and
 * wiring, with every body a fenced stub —
 *
 *     // SKEL[2] drop near-duplicate points
 *     throw new Error("SKEL_TODO");
 *     // /SKEL[2]
 *
 * — then presents a plan whose steps carry `skelId`. Once the human approves
 * the shape, the fills can run without per-step approval because they are
 * FENCED: while a step is `in_progress` (update_plan_progress), the preflight
 * hook asks on any Edit/Write/MultiEdit that touches code outside that step's
 * fences. A signature change, new helper or new file is a skeleton change, and
 * skeleton changes go back to the human.
 *
 * LEAF module (node:fs + node:path only) — the plugin-bundled hook inlines it
 * and the init-generated hook reaches it through preflight-hook-core, so it must
 * stay as cheap to import as guardrail-rules.ts.
 */

export const SKEL_TODO = "SKEL_TODO";

/** `.deeppairing/skeleton-scopes/<artifactId>.json` — ONE FILE PER PLAN,
 *  written only by that plan's update_plan_progress. Per-plan files mean
 *  progress on plan B can never replace or remove plan A's fence (#606 review)
 *  and there is no shared read-modify-write to lose an update in. */
export const SKELETON_SCOPE_DIR = "skeleton-scopes";

/** A scope older than this is ignored (a crashed run must not fence tomorrow's
 *  unrelated edits). Mirrors CEREMONY_MAX_AGE_MS. */
export const SKELETON_SCOPE_MAX_AGE_MS = 8 * 60 * 60 * 1000;

export interface SkeletonFence {
  id: string;
  title: string;
  /** As passed in (repo-relative from scanSkeletonFences, absolute from the hook). */
  file: string;
  /** 1-based line of the opening marker. */
  openLine: number;
  /** 1-based line of the closing marker. */
  closeLine: number;
  status: "todo" | "filled";
}

export interface SkeletonScope {
  artifactId: string;
  planTitle?: string;
  /** Fence ids of the plan's in_progress skeleton steps. Empty = no fencing. */
  activeSkelIds: string[];
  updatedAt: string;
  /** The deepPairing session executing the plan. The hook applies a scope only
   *  to edits from that session (when the hook event carries one). */
  sessionId?: string;
  /** The working tree the plan is filled in (a linked worktree's own dir, not
   *  the canonical root). Edits to files outside it are not this scope's. */
  workspaceRoot?: string;
  /**
   * Parity PR 4 (#610 review M1) — set on the scope of a RESHAPED skeleton plan
   * (the newer version a supersede created; `artifactId` is that version).
   * While that version awaits approval (draft / revised) the fence is PAUSED:
   * the hook asks on any edit to the plan's declared files. Once approved, its
   * own in-progress fences apply; if it is rejected or retracted, the previous
   * version's fences are restored — only when that version had been approved.
   */
  reshape?: SkeletonReshape;
}

export interface SkeletonReshape {
  /** The version this reshape superseded. */
  fromId: string;
  /** The plans' declared files (both versions), relative to `workspaceRoot`. */
  files: string[];
  /** Was the superseded version approved when it was superseded? */
  restoreApproved: boolean;
  /** Its in-progress fences then (restored only when `restoreApproved`). */
  restoreSkelIds: string[];
}

function parseReshape(raw: unknown): SkeletonReshape | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Partial<SkeletonReshape>;
  if (typeof r.fromId !== "string" || !r.fromId) return undefined;
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []);
  return { fromId: r.fromId, files: strs(r.files), restoreApproved: r.restoreApproved === true, restoreSkelIds: strs(r.restoreSkelIds) };
}

const COMMENT = String.raw`(?:\/\/|#|--|;|\/\*|<!--|\{\/\*)`;
const ID = String.raw`([A-Za-z0-9][\w.-]*)`;
const OPEN_RE = new RegExp(String.raw`^\s*${COMMENT}\s*SKEL\[${ID}\]\s*(.*?)\s*(?:\*\/\}?|-->)?\s*$`);
const CLOSE_RE = new RegExp(String.raw`^\s*${COMMENT}\s*\/SKEL\[${ID}\]\s*(?:\*\/\}?|-->)?\s*$`);

/** Parse one file's fences. Throws on malformed nesting (callers decide). */
export function scanSkeletonText(text: string, file: string): SkeletonFence[] {
  const lines = text.split("\n");
  const fences: SkeletonFence[] = [];
  let open: { id: string; title: string; openLine: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    const close = CLOSE_RE.exec(line);
    if (close) {
      if (!open || open.id !== close[1]) throw new Error(`${file}:${lineNo}: /SKEL[${close[1]}] closes ${open ? `SKEL[${open.id}]` : "nothing"}`);
      const body = lines.slice(open.openLine, lineNo - 1).join("\n");
      fences.push({ ...open, file, closeLine: lineNo, status: body.includes(SKEL_TODO) ? "todo" : "filled" });
      open = null;
      continue;
    }
    const m = OPEN_RE.exec(line);
    if (m) {
      if (open) throw new Error(`${file}:${lineNo}: SKEL[${m[1]}] opened inside SKEL[${open.id}]`);
      open = { id: m[1]!, title: m[2] ?? "", openLine: lineNo };
    }
  }
  if (open) throw new Error(`${file}:${open.openLine}: SKEL[${open.id}] is never closed`);
  return fences;
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".deeppairing", "dist", "build", "out", ".next", ".turbo", "coverage", "__pycache__", ".venv", "venv", "target"]);

/** Prose files show the marker syntax in examples; they never hold real fences. */
const PROSE_FILE = /\.(md|mdx|markdown|rst|txt)$/i;

function scanFile(root: string, abs: string, fences: SkeletonFence[], errors: string[]): void {
  let text: string;
  try {
    if (fs.statSync(abs).size > 1_000_000) return;
    text = fs.readFileSync(abs, "utf-8");
  } catch {
    return;
  }
  if (!text.includes("SKEL[")) return;
  const rel = path.relative(root, abs).split(path.sep).join("/");
  try {
    fences.push(...scanSkeletonText(text, rel));
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Fences for the server-side checks (present_plan / update_plan_progress).
 * #606 review M3/M4 — with `files` (the plan's declared step files and
 * file_map paths) ONLY those are read: no repo walk on the tool path, and a
 * doc or fixture showing the syntax can't pose as a real fence. Without
 * declared files it falls back to a bounded walk that skips prose files.
 * Malformed files are reported, not thrown.
 */
export function scanSkeletonFences(
  root: string,
  opts: { files?: string[]; maxFiles?: number } = {},
): { fences: SkeletonFence[]; errors: string[]; truncated: boolean } {
  const fences: SkeletonFence[] = [];
  const errors: string[] = [];
  if (opts.files && opts.files.length > 0) {
    for (const f of new Set(opts.files)) {
      const abs = path.resolve(root, f);
      if (within(root, abs)) scanFile(root, abs, fences, errors);
    }
    return { fences, errors, truncated: false };
  }
  const maxFiles = opts.maxFiles ?? 20_000;
  let seen = 0;
  let truncated = false;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (seen >= maxFiles) {
        truncated = true;
        return;
      }
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(abs);
        continue;
      }
      if (!e.isFile() || PROSE_FILE.test(e.name)) continue;
      seen++;
      scanFile(root, abs, fences, errors);
    }
  };
  walk(root);
  return { fences, errors, truncated };
}

/** The files a plan declares: every step's `files` plus every file_map path. */
export function planDeclaredFiles(content: { steps?: Array<{ files?: unknown }>; visuals?: Array<{ kind?: unknown; files?: unknown }> }): string[] {
  const out: string[] = [];
  const take = (v: unknown) => {
    if (typeof v === "string" && v) out.push(v);
    else if (v && typeof v === "object") {
      const o = v as { filePath?: unknown; path?: unknown };
      const p = typeof o.filePath === "string" ? o.filePath : typeof o.path === "string" ? o.path : "";
      if (p) out.push(p);
    }
  };
  for (const st of content.steps ?? []) if (Array.isArray(st.files)) st.files.forEach(take);
  for (const v of content.visuals ?? []) if (v.kind === "file_map" && Array.isArray(v.files)) v.files.forEach(take);
  return [...new Set(out)];
}


export function skeletonScopeDir(projectRoot: string): string {
  return path.join(projectRoot, ".deeppairing", SKELETON_SCOPE_DIR);
}

function scopeFileName(artifactId: string): string | null {
  return /^[A-Za-z0-9_-]{1,80}$/.test(artifactId) ? `${artifactId}.json` : null;
}

function parseScope(raw: unknown, now: number): SkeletonScope | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<SkeletonScope>;
  const ids = Array.isArray(r.activeSkelIds) ? r.activeSkelIds.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
  const reshape = parseReshape(r.reshape);
  // A reshape scope is live with no active ids: it pauses, then restores.
  if ((ids.length === 0 && !reshape) || typeof r.artifactId !== "string") return null;
  const at = Date.parse(String(r.updatedAt));
  if (!Number.isFinite(at) || now - at > SKELETON_SCOPE_MAX_AGE_MS) return null;
  return {
    artifactId: r.artifactId,
    activeSkelIds: ids,
    updatedAt: String(r.updatedAt),
    ...(typeof r.planTitle === "string" ? { planTitle: r.planTitle } : {}),
    ...(typeof r.sessionId === "string" && r.sessionId ? { sessionId: r.sessionId } : {}),
    ...(typeof r.workspaceRoot === "string" && r.workspaceRoot ? { workspaceRoot: r.workspaceRoot } : {}),
    ...(reshape ? { reshape } : {}),
  };
}

/** Every live scope (absent, stale and unreadable files are skipped). */
export function readSkeletonScopes(projectRoot: string, now: number = Date.now()): SkeletonScope[] {
  let names: string[];
  try {
    names = fs.readdirSync(skeletonScopeDir(projectRoot)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: SkeletonScope[] = [];
  for (const n of names) {
    try {
      const scope = parseScope(JSON.parse(fs.readFileSync(path.join(skeletonScopeDir(projectRoot), n), "utf-8")), now);
      if (scope) out.push(scope);
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Write this plan's scope, or remove it when nothing is in progress. Touches
 *  only the plan's own file. Atomic; never throws. */
export function writeSkeletonScope(projectRoot: string, scope: SkeletonScope): void {
  const name = scopeFileName(scope.artifactId);
  if (!name) return;
  const file = path.join(skeletonScopeDir(projectRoot), name);
  try {
    if (scope.activeSkelIds.length === 0 && !scope.reshape) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(scope, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    /* fail open: no scope file = no fencing */
  }
}

/** The hook's fast-path test: is any plan's fence live right now? */
export function skeletonScopeActive(projectRoot: string, now: number = Date.now()): boolean {
  return readSkeletonScopes(projectRoot, now).length > 0;
}

/**
 * #606 review (M5) — the scope file says which steps are in progress; the STORE
 * says whether the plan may be executed. A fence is live only while its plan is
 * `approved` in its own session's artifacts.json, so revising, superseding,
 * rejecting or withdrawing the plan drops the fence at once (status changes
 * force a flush, so the hook sees them). Unreadable store → false (fail open,
 * the backstop's contract).
 */
export function planApprovedOnDisk(projectRoot: string, sessionId: string, artifactId: string): boolean {
  return planOnDisk(projectRoot, sessionId, artifactId)?.status === "approved";
}

/** Parity PR 4 — a plan's status and in-progress fence ids, read from the
 *  owning session's artifacts.json. Null when unreadable or not a plan. */
export function planOnDisk(projectRoot: string, sessionId: string, artifactId: string): { status: string; inProgressSkelIds: string[] } | null {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(sessionId)) return null;
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(projectRoot, ".deeppairing", "sessions", sessionId, "artifacts.json"), "utf-8"));
    if (!Array.isArray(arr)) return null;
    const plan = arr.find((a: unknown) => !!a && typeof a === "object" && (a as { id?: unknown }).id === artifactId) as
      | { type?: unknown; status?: unknown; content?: { steps?: Array<{ skelId?: unknown; status?: unknown }> } }
      | undefined;
    if (plan?.type !== "plan" || typeof plan.status !== "string") return null;
    const steps = Array.isArray(plan.content?.steps) ? plan.content!.steps! : [];
    const inProgressSkelIds = steps
      .filter((st) => st && typeof st.skelId === "string" && st.skelId && st.status === "in_progress")
      .map((st) => st.skelId as string);
    return { status: plan.status, inProgressSkelIds };
  } catch {
    return null;
  }
}

/**
 * Parity PR 4 (#610 review M1) — what each live scope means right now, read
 * against the store: `fenced` scopes gate edits to their active fences (an
 * approved plan's own, an approved reshape's in-progress fences, or a
 * rejected reshape's restored previous fences); `paused` scopes are reshapes
 * awaiting approval, which ask on any edit to their declared files.
 */
export function resolveSkeletonScopes(projectRoot: string, scopes: SkeletonScope[]): { fenced: SkeletonScope[]; paused: SkeletonScope[] } {
  const fenced: SkeletonScope[] = [];
  const paused: SkeletonScope[] = [];
  for (const s of scopes) {
    if (!s.sessionId) continue;
    const plan = planOnDisk(projectRoot, s.sessionId, s.artifactId);
    if (!plan) continue;
    if (!s.reshape) {
      if (plan.status === "approved" && s.activeSkelIds.length > 0) fenced.push(s);
      continue;
    }
    if (plan.status === "draft" || plan.status === "revised") {
      paused.push(s);
    } else if (plan.status === "approved") {
      const ids = [...new Set([...s.activeSkelIds, ...plan.inProgressSkelIds])];
      if (ids.length > 0) fenced.push({ ...s, activeSkelIds: ids });
    } else if ((plan.status === "rejected" || plan.status === "retracted") && s.reshape.restoreApproved && s.reshape.restoreSkelIds.length > 0) {
      fenced.push({ ...s, activeSkelIds: s.reshape.restoreSkelIds });
    }
  }
  return { fenced, paused };
}

/** Read one plan's scope file (null when absent, stale or unreadable). */
export function readSkeletonScopeFile(projectRoot: string, artifactId: string, now: number = Date.now()): SkeletonScope | null {
  const name = scopeFileName(artifactId);
  if (!name) return null;
  try {
    return parseScope(JSON.parse(fs.readFileSync(path.join(skeletonScopeDir(projectRoot), name), "utf-8")), now);
  } catch {
    return null;
  }
}

/**
 * Parity PR 4 — the paused gate: while a reshaped skeleton awaits approval,
 * any Edit/Write/MultiEdit to one of its declared files asks (strict-stop:
 * stops). Null when no paused scope of this session/tree names the file.
 */
export function evaluatePausedEdit(args: {
  toolName: string;
  toolInput: unknown;
  paused: SkeletonScope[];
  sessionId: string;
  projectRoot: string;
  strict?: boolean;
}): SkeletonScopeViolation | null {
  if (args.toolName !== "Edit" && args.toolName !== "Write" && args.toolName !== "MultiEdit") return null;
  const input = (args.toolInput ?? {}) as Record<string, unknown>;
  const fp = input.file_path ?? input.filePath;
  if (typeof fp !== "string" || !fp) return null;
  const abs = path.resolve(args.projectRoot, fp);
  if (abs.split(path.sep).includes(".deeppairing")) return null;
  const mine = args.paused.filter((s) => s.sessionId === args.sessionId && (!s.workspaceRoot || within(s.workspaceRoot, abs)));
  for (const s of mine) {
    const base = s.workspaceRoot ?? args.projectRoot;
    const rel = path.relative(base, abs).split(path.sep).join("/");
    const files = (s.reshape?.files ?? []).map((f) => path.relative(base, path.resolve(base, f)).split(path.sep).join("/"));
    if (!files.includes(rel)) continue;
    const plan = s.planTitle ? ` ("${s.planTitle}")` : "";
    return {
      skelIds: [],
      target: rel,
      reason: args.strict
        ? `Edit to ${rel} stopped before execution (strict-stop mode). The skeleton${plan} was reshaped and the new version awaits your approval, so fills are paused. [SKELETON_PAUSED]`
        : `Allow this edit while the skeleton change awaits your approval? The skeleton${plan} was reshaped and the new version isn't approved yet, so fills are paused for its files (${rel}).\n` +
          `[SKELETON_PAUSED — agent: a reshaped skeleton plan awaits re-review. Don't fill or restructure its files until your pair approves the new version; poll check_feedback.]`,
    };
  }
  return null;
}

function within(dir: string, abs: string): boolean {
  const rel = path.relative(dir, abs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The scopes that govern one edit: exactly the edit's OWN session's, and only
 * those whose working tree holds the target file. The caller always passes the
 * session id derived the way the server derives it — from the hook event's
 * Claude session id, or the fallback id when the event carries none — so a
 * missing identity matches only a fallback-mode server's plan and never fences
 * another session (#606 review). Subagents carry their parent's session id and
 * so inherit its fence: they are part of the same execution. Returns one merged
 * scope, or null.
 */
export function selectSkeletonScope(scopes: SkeletonScope[], args: { sessionId: string; targetAbs: string }): SkeletonScope | null {
  const mine = scopes.filter(
    (s) => s.sessionId === args.sessionId && (!s.workspaceRoot || within(s.workspaceRoot, args.targetAbs)),
  );
  if (mine.length === 0) return null;
  const titles = [...new Set(mine.map((s) => s.planTitle).filter((t): t is string => !!t))];
  return {
    artifactId: mine.map((s) => s.artifactId).join(","),
    activeSkelIds: [...new Set(mine.flatMap((s) => s.activeSkelIds))],
    updatedAt: mine.map((s) => s.updatedAt).sort().at(-1)!,
    ...(titles.length > 0 ? { planTitle: titles.join(", ") } : {}),
  };
}

// ---- the gate ----

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** The line span replacing `needle` at `index` touches. A leading/trailing
 *  newline belongs to a neighbouring line's terminator, not to that line. */
function spanOf(text: string, index: number, needle: string): [number, number] {
  let start = lineOf(text, index);
  let end = start;
  for (let i = 0; i < needle.length; i++) if (needle.charCodeAt(i) === 10) end++;
  if (needle.startsWith("\n") && end > start) start++;
  if (needle.endsWith("\n") && end > start) end--;
  return [start, end];
}

/** Apply one Edit the way the Edit tool does: first occurrence, or all. Null
 *  when old_string is absent (the tool call fails on its own). */
function applyEdit(text: string, oldStr: string, newStr: string, all: boolean): { text: string; spans: Array<[number, number]> } | null {
  if (!oldStr) return null;
  const first = text.indexOf(oldStr);
  if (first === -1) return null;
  const spans: Array<[number, number]> = [];
  let out = "";
  let from = 0;
  let i = first;
  while (i !== -1) {
    spans.push(spanOf(text, i, oldStr));
    out += text.slice(from, i) + newStr;
    from = i + oldStr.length;
    if (!all) break;
    i = text.indexOf(oldStr, from);
  }
  return { text: out + text.slice(from), spans };
}

/**
 * Every line outside the given fences' BODIES — marker lines included — must
 * survive WHOLE and in order. Compared line by line, so nothing can be appended
 * to or prefixed onto a marker line (#606 review: a substring match let a
 * marker-line suffix through).
 */
function preservesOutside(original: string, next: string, fences: SkeletonFence[]): boolean {
  const lines = original.split("\n");
  const out = next.split("\n");
  const sorted = [...fences].sort((a, b) => a.openLine - b.openLine);
  const segments: string[][] = [];
  let from = 0;
  for (const f of sorted) {
    segments.push(lines.slice(from, f.openLine));
    from = f.closeLine - 1;
  }
  segments.push(lines.slice(from));
  const matchesAt = (seg: string[], at: number) => at >= 0 && at + seg.length <= out.length && seg.every((l, i) => out[at + i] === l);
  let pos = 0;
  for (let k = 0; k < segments.length; k++) {
    const seg = segments[k]!;
    if (k === 0) {
      if (!matchesAt(seg, 0)) return false;
      pos = seg.length;
    } else if (k === segments.length - 1) {
      if (out.length - seg.length < pos || !matchesAt(seg, out.length - seg.length)) return false;
    } else {
      let at = pos;
      while (at + seg.length <= out.length && !matchesAt(seg, at)) at++;
      if (!matchesAt(seg, at)) return false;
      pos = at + seg.length;
    }
  }
  return true;
}

const signature = (fences: SkeletonFence[]): string => fences.map((f) => `${f.id}\u0000${f.title}`).join("\u0001");

const HASH_COMMENT_EXT = /\.(py|pyi|rb|sh|bash|zsh|ya?ml|toml|r|pl|ex|exs|nim|cr|coffee)$/i;

/**
 * Does a filled body escape the scope it was fenced in? Language-agnostic
 * heuristics, so a miss falls back to "ask" only in the direction of MORE
 * prompting:
 *   - brackets — a running ()[]{} depth (strings and line comments skipped)
 *     that dips below zero closed the enclosing function/block; one that
 *     doesn't end at zero left something open for the code after the fence.
 *   - indentation — a non-blank body line indented less than the opening
 *     marker left the enclosing block (the Python shape of the same escape).
 */
export function bodyEscapesFence(body: string, markerLine: string, file: string): string | null {
  const indentOf = (l: string) => (/^[ \t]*/.exec(l)?.[0] ?? "").replace(/\t/g, "    ").length;
  const markerIndent = indentOf(markerLine);
  const hash = HASH_COMMENT_EXT.test(file);
  let depth = 0;
  let quote: string | null = null;
  const lines = body.split("\n");
  for (const line of lines) {
    if (line.trim() && !quote && indentOf(line) < markerIndent) return "a line is indented outside the fence's block";
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if ((c === "/" && line[i + 1] === "/") || (hash && c === "#")) break;
      else if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (--depth < 0) return "it closes the block the fence sits in";
      }
    }
    if (quote && quote !== "`") quote = null; // ' and " don't span lines
  }
  return depth === 0 ? null : "it leaves a bracket open past the fence";
}

export interface SkeletonScopeViolation {
  /** Human-first prose, then the bracketed agent line (guardrailReason's shape). */
  reason: string;
  skelIds: string[];
  target: string;
}

/**
 * Pure over (tool call, scope, file reader). Null = no opinion: no live scope,
 * not an edit tool, or the edit's RESULT changes only active fence bodies and
 * each stays inside its block. A fault is also null — the hook fails open.
 *
 * #606 review — the result is what's checked, not just where old_string sat:
 * new_string can carry markers or close the enclosing function, and an
 * old-span check alone admitted both.
 */
export function evaluateSkeletonEdit(args: {
  toolName: string;
  toolInput: unknown;
  scope: SkeletonScope | null;
  readFile: (absPath: string) => string | null;
  /** For display and for resolving a relative file_path. */
  projectRoot: string;
  /** strict-stop words the reason as a stop, not a question (#547). */
  strict?: boolean;
}): SkeletonScopeViolation | null {
  const { scope } = args;
  if (!scope || scope.activeSkelIds.length === 0) return null;
  if (args.toolName !== "Edit" && args.toolName !== "Write" && args.toolName !== "MultiEdit") return null;
  const input = (args.toolInput ?? {}) as Record<string, unknown>;
  const fp = input.file_path ?? input.filePath;
  if (typeof fp !== "string" || !fp) return null;
  const abs = path.resolve(args.projectRoot, fp);
  // deepPairing's own state has its own always-ask class; don't double-prompt.
  if (abs.split(path.sep).includes(".deeppairing")) return null;
  const rel = path.relative(args.projectRoot, abs);
  const shown = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : abs;
  const ids = scope.activeSkelIds;
  const label = ids.length === 1 ? `step SKEL[${ids[0]}]` : `steps ${ids.map((i) => `SKEL[${i}]`).join(", ")}`;

  const plan = scope.planTitle ? ` ("${scope.planTitle}")` : "";
  const violation = (what: string): SkeletonScopeViolation => ({
    skelIds: ids,
    target: shown,
    reason: args.strict
      ? `Edit to ${shown} stopped before execution (strict-stop mode). ${what}. The approved skeleton${plan} is being filled, and ` +
        `${label} may only change code inside its fence. Propose the skeleton change to your pair and revise the plan, ` +
        `or set the step back to pending before an agreed structural edit. [SKELETON_SCOPE]`
      : `Allow this edit outside the skeleton? ${what}. The approved skeleton${plan} ` +
        `is being filled, and ${label} may only change code inside its fence. Allowing it changes the structure you approved.\n` +
        `[SKELETON_SCOPE — agent: this is a skeleton change. Don't route around the fence; stop and propose the change ` +
        `(what, where, why) to your pair. Once they agree, revise the plan (or set the step back to pending) before the structural edit.]`,
  });

  const original = args.readFile(abs);
  if (original === null) return args.toolName === "Write" ? violation(`It creates a new file, ${shown}`) : null;

  let before: SkeletonFence[];
  try {
    before = scanSkeletonText(original, shown);
  } catch {
    return violation(`${shown} has malformed SKEL markers`);
  }
  const active = before.filter((f) => ids.includes(f.id));
  if (active.length === 0) return violation(`${shown} has no ${label} fence`);

  // 1. Build the result. Edits are checked one by one against the text they
  //    actually apply to (MultiEdit is sequential), so the first out-of-fence
  //    edit is named by its own line numbers.
  let next: string;
  if (args.toolName === "Write") {
    next = String(input.content ?? "");
  } else {
    const edits = (args.toolName === "MultiEdit" ? (Array.isArray(input.edits) ? input.edits : []) : [input]) as Array<Record<string, unknown>>;
    next = original;
    for (const e of edits) {
      const oldStr = typeof e?.old_string === "string" ? e.old_string : "";
      const applied = applyEdit(next, oldStr, typeof e?.new_string === "string" ? e.new_string : "", e?.replace_all === true);
      if (!applied) return null; // the tool fails on its own
      let current: SkeletonFence[];
      try {
        current = scanSkeletonText(next, shown).filter((f) => ids.includes(f.id));
      } catch {
        return violation(`${shown} has malformed SKEL markers`);
      }
      // A span may include the fence's own marker lines: with identical stubs,
      // the marker is often the only thing that makes old_string unique
      // (#606 review H1). Whether the markers SURVIVE is checked on the result.
      for (const [start, end] of applied.spans) {
        if (!current.some((f) => start >= f.openLine && end <= f.closeLine)) {
          return violation(`It touches ${shown}:${start}${end > start ? `-${end}` : ""}`);
        }
      }
      next = applied.text;
    }
  }

  // 2. The markers must survive exactly: same fences, same order, same titles.
  let after: SkeletonFence[];
  try {
    after = scanSkeletonText(next, shown);
  } catch {
    return violation(`It leaves malformed SKEL markers in ${shown}`);
  }
  if (signature(after) !== signature(before)) return violation(`It adds, removes or retitles SKEL markers in ${shown}`);

  // 3. Everything outside the active bodies must be byte-identical.
  if (!preservesOutside(original, next, active)) return violation(`It changes ${shown} outside the fence`);

  // 4. And each filled body must stay inside the block it was fenced in.
  const nextLines = next.split("\n");
  for (const f of after.filter((x) => ids.includes(x.id))) {
    const body = nextLines.slice(f.openLine, f.closeLine - 1).join("\n");
    const escape = bodyEscapesFence(body, nextLines[f.openLine - 1] ?? "", shown);
    if (escape) return violation(`In ${shown}:${f.openLine}-${f.closeLine}, ${escape}`);
  }
  return null;
}
