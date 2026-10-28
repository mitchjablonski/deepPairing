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

/** Every fence under `root` (server side: present_plan / update_plan_progress
 *  checks). Malformed files are reported, not thrown. */
export function scanSkeletonFences(root: string, maxFiles = 20_000): { fences: SkeletonFence[]; errors: string[] } {
  const fences: SkeletonFence[] = [];
  const errors: string[] = [];
  let seen = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (seen >= maxFiles) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(abs);
        continue;
      }
      if (!e.isFile()) continue;
      seen++;
      let text: string;
      try {
        if (fs.statSync(abs).size > 1_000_000) continue;
        text = fs.readFileSync(abs, "utf-8");
      } catch {
        continue;
      }
      if (!text.includes("SKEL[")) continue;
      const rel = path.relative(root, abs).split(path.sep).join("/");
      try {
        fences.push(...scanSkeletonText(text, rel));
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
  };
  walk(root);
  return { fences, errors };
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
  if (ids.length === 0 || typeof r.artifactId !== "string") return null;
  const at = Date.parse(String(r.updatedAt));
  if (!Number.isFinite(at) || now - at > SKELETON_SCOPE_MAX_AGE_MS) return null;
  return {
    artifactId: r.artifactId,
    activeSkelIds: ids,
    updatedAt: String(r.updatedAt),
    ...(typeof r.planTitle === "string" ? { planTitle: r.planTitle } : {}),
    ...(typeof r.sessionId === "string" && r.sessionId ? { sessionId: r.sessionId } : {}),
    ...(typeof r.workspaceRoot === "string" && r.workspaceRoot ? { workspaceRoot: r.workspaceRoot } : {}),
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
    if (scope.activeSkelIds.length === 0) {
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

function within(dir: string, abs: string): boolean {
  const rel = path.relative(dir, abs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The scopes that govern one edit: the edit's own session's (when the hook
 * event names one), and only those whose working tree holds the target file.
 * With no session on the event, every live scope for that tree applies — more
 * fencing, never less. Returns one merged scope, or null.
 */
export function selectSkeletonScope(scopes: SkeletonScope[], args: { sessionId?: string; targetAbs: string }): SkeletonScope | null {
  const mine = scopes.filter(
    (s) => (!args.sessionId || !s.sessionId || s.sessionId === args.sessionId) && (!s.workspaceRoot || within(s.workspaceRoot, args.targetAbs)),
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

/** Text outside the given fences' BODIES (markers included) must be identical. */
function preservesOutside(original: string, next: string, fences: SkeletonFence[]): boolean {
  const lines = original.split("\n");
  const sorted = [...fences].sort((a, b) => a.openLine - b.openLine);
  const segments: string[] = [];
  let from = 0;
  for (const f of sorted) {
    segments.push(lines.slice(from, f.openLine).join("\n"));
    from = f.closeLine - 1;
  }
  segments.push(lines.slice(from).join("\n"));
  let pos = 0;
  for (let k = 0; k < segments.length; k++) {
    const seg = segments[k]!;
    if (k === 0 && !next.startsWith(seg)) return false;
    if (k === segments.length - 1) return next.endsWith(seg) && next.length - seg.length >= pos;
    const idx = next.indexOf(seg, pos);
    if (idx === -1) return false;
    pos = idx + seg.length;
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

  const violation = (what: string): SkeletonScopeViolation => ({
    skelIds: ids,
    target: shown,
    reason:
      `Allow this edit outside the skeleton? ${what}. The approved skeleton${scope.planTitle ? ` ("${scope.planTitle}")` : ""} ` +
      `is being filled, and ${label} may only change code inside its fence. Allowing it changes the structure you approved.\n` +
      `[SKELETON_SCOPE — agent: this is a skeleton change. Don't route around the fence; stop and propose the change ` +
      `(what, where, why) to your pair, then revise the plan before filling on.]`,
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
      for (const [start, end] of applied.spans) {
        if (!current.some((f) => start > f.openLine && end < f.closeLine)) {
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
