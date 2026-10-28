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

/** `.deeppairing/skeleton-scope.json` — written by update_plan_progress, read by
 *  the hook. One small file keeps the hook's fast path to a single stat. */
export const SKELETON_SCOPE_FILE = "skeleton-scope.json";

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

export function skeletonScopePath(projectRoot: string): string {
  return path.join(projectRoot, ".deeppairing", SKELETON_SCOPE_FILE);
}

/** The live scope, or null (absent, stale, unreadable, or nothing in progress). */
export function readSkeletonScope(projectRoot: string, now: number = Date.now()): SkeletonScope | null {
  try {
    const raw = JSON.parse(fs.readFileSync(skeletonScopePath(projectRoot), "utf-8")) as Partial<SkeletonScope>;
    const ids = Array.isArray(raw.activeSkelIds) ? raw.activeSkelIds.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
    if (ids.length === 0 || typeof raw.artifactId !== "string") return null;
    const at = Date.parse(String(raw.updatedAt));
    if (!Number.isFinite(at) || now - at > SKELETON_SCOPE_MAX_AGE_MS) return null;
    return { artifactId: raw.artifactId, planTitle: typeof raw.planTitle === "string" ? raw.planTitle : undefined, activeSkelIds: ids, updatedAt: String(raw.updatedAt) };
  } catch {
    return null;
  }
}

/** Write (or, with no active ids, remove) the scope file. Atomic; never throws. */
export function writeSkeletonScope(projectRoot: string, scope: SkeletonScope): void {
  const file = skeletonScopePath(projectRoot);
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

/** The hook's fast-path test: is there anything to fence right now? */
export function skeletonScopeActive(projectRoot: string, now: number = Date.now()): boolean {
  return readSkeletonScope(projectRoot, now) !== null;
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

function occurrences(text: string, needle: string, all: boolean): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let i = text.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    if (!all) break;
    i = text.indexOf(needle, i + needle.length);
  }
  return out;
}

/** A whole-file Write may change only the fence bodies. */
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

export interface SkeletonScopeViolation {
  /** Human-first prose, then the bracketed agent line (guardrailReason's shape). */
  reason: string;
  skelIds: string[];
  target: string;
}

/**
 * Pure over (tool call, scope, file reader). Null = no opinion: no live scope,
 * not an edit tool, or the edit stays inside an active fence. A fault is also
 * null — the hook fails open.
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

  let fences: SkeletonFence[];
  try {
    fences = scanSkeletonText(original, shown).filter((f) => ids.includes(f.id));
  } catch {
    return violation(`${shown} has malformed SKEL markers`);
  }
  if (fences.length === 0) return violation(`${shown} has no ${label} fence`);

  if (args.toolName === "Write") {
    return preservesOutside(original, String(input.content ?? ""), fences) ? null : violation(`It rewrites ${shown} outside the fence`);
  }
  const edits = args.toolName === "MultiEdit" ? (Array.isArray(input.edits) ? input.edits : []) : [input];
  for (const e of edits as Array<Record<string, unknown>>) {
    const needle = typeof e?.old_string === "string" ? e.old_string : "";
    for (const idx of occurrences(original, needle, e?.replace_all === true)) {
      const [start, end] = spanOf(original, idx, needle);
      if (!fences.some((f) => start > f.openLine && end < f.closeLine)) {
        return violation(`It touches ${shown}:${start}${end > start ? `-${end}` : ""}`);
      }
    }
  }
  return null;
}
