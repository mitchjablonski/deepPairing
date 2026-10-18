/**
 * #546 — preflight FAILURE diagnostics: observability, not enforcement.
 *
 * Every preflight read, import, parse and evaluation fault fails OPEN, and many
 * of them end in an ordinary "no fire" that looks exactly like a genuine
 * non-match. This module gives those faults a small taxonomy and a bounded,
 * redacted record in `.deeppairing/hooks-state.json`, under its own top-level
 * `preflightFailures` field (beside `fires`, `guardrailAsks` and whatever #552
 * adds to the fire entries — a separate field, so neither writer reshapes the
 * other's data). `deeppairing doctor` reads it back.
 *
 * What it deliberately does NOT do:
 *   - change any decision. The hook's stdout, stderr and exit status are the
 *     same with or without this module; a fault that was a no-fire stays one;
 *   - record an expected non-match. A missing preferences.json, a project with
 *     no team file, an edit that matches nothing: none of these is a fault;
 *   - record content. A class, a fixed source label, an error CODE or NAME
 *     (never a message: Node's JSON.parse messages quote the input), a count
 *     and two timestamps. No paths, no ledger text, no tool input, no
 *     environment values, no session id;
 *   - create `.deeppairing/`. A hook that ran outside an initialised project
 *     leaves no state behind.
 *
 * Node builtins only (via hook-state.ts): the init-generated hook imports this
 * leaf by URL on its failure path, including when the matcher core itself
 * failed to import.
 */
import { hookStatePath, mutateHookState } from "./hook-state.js";

/** The taxonomy. `nonmatch` is intentionally absent: it is never recorded. */
export const PREFLIGHT_FAILURE_CLASSES = [
  "input_malformed",
  "ledger_unreadable",
  "ledger_corrupt",
  // #557 — one ledger entry the matcher can't read, skipped so the rest enforce.
  "ledger_entry_skipped",
  "matcher_import_failed",
  "evaluator_threw",
  "session_store_unreadable",
] as const;
export type PreflightFailureClass = (typeof PREFLIGHT_FAILURE_CLASSES)[number];

/** Fixed source labels — the only free-standing words a record can carry. */
export const PREFLIGHT_FAILURE_SOURCES = [
  "stdin",
  "preferences",
  "team",
  "sessions",
  "core",
  "rules",
  "matcher",
  "backstop",
  "state",
  "hook",
] as const;
export type PreflightFailureSource = (typeof PREFLIGHT_FAILURE_SOURCES)[number];

export interface PreflightFailureNote {
  cls: PreflightFailureClass;
  source: PreflightFailureSource;
  /** An errno code (`EACCES`), an error constructor name (`SyntaxError`), or "schema"/"corrupt"/"shape". */
  tag: string;
  /** #557 — for ledger_entry_skipped: the skipped entries' array indices. */
  indices?: number[];
}

/** A per-invocation collector. Readers push; the entry flushes once. */
export type PreflightFailureSink = PreflightFailureNote[];

export interface PreflightFailureEntry {
  count: number;
  firstAt: string;
  lastAt: string;
  /** `<source>:<code>` of the most recent occurrence, e.g. `preferences:SyntaxError`. */
  detail: string;
  /** #557 — ledger_entry_skipped only: the most recent run's skipped indices (≤ 8). */
  indices?: number[];
}

export const PREFLIGHT_FAILURES_FIELD = "preflightFailures";
/** Counts saturate here rather than grow without bound. */
export const PREFLIGHT_FAILURE_COUNT_CAP = 1_000_000;
const DETAIL_MAX = 64;
/** At most this many skipped-entry indices are kept. */
export const PREFLIGHT_FAILURE_INDICES_CAP = 8;

function boundedIndices(v: unknown): number[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((i): i is number => Number.isInteger(i) && i >= 0 && i < 1_000_000).slice(0, PREFLIGHT_FAILURE_INDICES_CAP);
  return out.length > 0 ? out : undefined;
}

const CLASS_SET: ReadonlySet<string> = new Set(PREFLIGHT_FAILURE_CLASSES);
const SOURCE_SET: ReadonlySet<string> = new Set(PREFLIGHT_FAILURE_SOURCES);
const CODE_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** An error's code or constructor name — never its message. */
export function failureCode(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && CODE_RE.test(code)) return code;
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string" && CODE_RE.test(name)) return name;
  }
  return "Error";
}

function hasErrno(err: unknown): boolean {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^E[A-Z0-9]+$/.test(code);
}

/**
 * Turn a caught fault into a note, or null when it is not a fault.
 *
 *   kind "ledger" / "store": ENOENT is the expected "nothing here yet" (null);
 *     another errno is unreadable; anything else (a parse error) is corrupt.
 *   kind "schema": parsed, but the shape is not one the reader accepts.
 *   kind "import" / "evaluate" / "input": the class is the kind.
 */
export function noteFailure(
  kind: "ledger" | "store" | "schema" | "import" | "evaluate" | "input",
  source: PreflightFailureSource,
  err?: unknown,
): PreflightFailureNote | null {
  switch (kind) {
    case "ledger":
    case "store": {
      const code = failureCode(err);
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      const unreadable = hasErrno(err);
      if (kind === "store") return { cls: "session_store_unreadable", source, tag: unreadable ? failureCode(err) : "corrupt" };
      return { cls: unreadable ? "ledger_unreadable" : "ledger_corrupt", source, tag: code };
    }
    case "schema":
      return { cls: "ledger_corrupt", source, tag: "schema" };
    case "import":
      return { cls: "matcher_import_failed", source, tag: failureCode(err) };
    case "evaluate":
      return { cls: "evaluator_threw", source, tag: failureCode(err) };
    case "input":
      return { cls: "input_malformed", source, tag: err === undefined ? "shape" : failureCode(err) };
  }
}

/** Push a note when there is one. Never throws. */
export function pushFailure(sink: PreflightFailureSink | undefined, note: PreflightFailureNote | null): void {
  try {
    if (sink && note) sink.push(note);
  } catch {
    /* never */
  }
}

function sanitizeDetail(note: PreflightFailureNote): string {
  const source = SOURCE_SET.has(note.source) ? note.source : "hook";
  const tag = typeof note.tag === "string" && CODE_RE.test(note.tag) ? note.tag : "Error";
  return `${source}:${tag}`.slice(0, DETAIL_MAX);
}

function validIso(v: unknown): v is string {
  return typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));
}

/**
 * Read the field back in its bounded shape: known classes only, well-formed
 * entries only. Anything else (a hand edit, a future build's extra class) is
 * dropped, so a reader can never be handed an unbounded value.
 */
export function readPreflightFailures(state: unknown): Partial<Record<PreflightFailureClass, PreflightFailureEntry>> {
  const out: Partial<Record<PreflightFailureClass, PreflightFailureEntry>> = {};
  const field = state && typeof state === "object" ? (state as Record<string, unknown>)[PREFLIGHT_FAILURES_FIELD] : undefined;
  if (!field || typeof field !== "object" || Array.isArray(field)) return out;
  for (const cls of PREFLIGHT_FAILURE_CLASSES) {
    const e = (field as Record<string, unknown>)[cls] as Record<string, unknown> | undefined;
    if (!e || typeof e !== "object") continue;
    const count = typeof e.count === "number" && Number.isFinite(e.count) ? Math.max(0, Math.min(Math.floor(e.count), PREFLIGHT_FAILURE_COUNT_CAP)) : 0;
    if (count === 0 || !validIso(e.firstAt) || !validIso(e.lastAt)) continue;
    const detail = typeof e.detail === "string" && /^[a-z]+:[A-Za-z0-9_]{1,40}$/.test(e.detail) ? e.detail : "hook:Error";
    const indices = boundedIndices(e.indices);
    out[cls] = { count, firstAt: e.firstAt, lastAt: e.lastAt, detail, ...(indices ? { indices } : {}) };
  }
  return out;
}

/** Apply one invocation's notes to an in-memory state (exported for tests). */
export function applyPreflightFailures(state: Record<string, unknown>, notes: readonly PreflightFailureNote[], now: number): void {
  const current = readPreflightFailures(state);
  const iso = new Date(now).toISOString();
  // One increment per class per invocation: a corrupt preferences.json read by
  // both the fast path and the matcher is ONE failed hook run, not two.
  const seen = new Map<PreflightFailureClass, PreflightFailureNote>();
  for (const note of notes) {
    if (note && CLASS_SET.has(note.cls)) seen.set(note.cls, note);
  }
  for (const [cls, note] of seen) {
    const prev = current[cls];
    const indices = boundedIndices(note.indices);
    current[cls] = {
      count: Math.min((prev?.count ?? 0) + 1, PREFLIGHT_FAILURE_COUNT_CAP),
      firstAt: prev?.firstAt ?? iso,
      lastAt: iso,
      detail: sanitizeDetail(note),
      ...(indices ? { indices } : {}),
    };
  }
  state[PREFLIGHT_FAILURES_FIELD] = current;
}

/**
 * Flush one hook invocation's notes into the project's hooks-state, under the
 * same lock as the fire log. A no-op for an empty sink (the expected path, so
 * a healthy hook pays nothing) and when `.deeppairing/` does not exist. Never
 * throws.
 */
export function recordPreflightFailures(projectRoot: string, notes: readonly (PreflightFailureNote | null | undefined)[], now: number = Date.now()): void {
  try {
    const real = notes.filter((n): n is PreflightFailureNote => !!n);
    if (real.length === 0 || typeof projectRoot !== "string" || !projectRoot) return;
    mutateHookState(hookStatePath(projectRoot), (state) => applyPreflightFailures(state, real, now), { createDir: false });
  } catch {
    /* recording must never fail the hook itself */
  }
}
