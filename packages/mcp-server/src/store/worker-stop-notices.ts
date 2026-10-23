import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-write.js";
import { MAX_BLOCKS, type PreflightBlockEntry } from "./preflight-block-log.js";

/**
 * #569 pilot task A (#553/#572) — tell the LEAD when a worker subagent was
 * gate-stopped.
 *
 * A worker's PreToolUse hook firing already lands in the project block log
 * (`preflight-blocks.json`) with its `agentId`/`agentType` and, when the
 * parent's Claude session resolved to a live deepPairing session, that
 * session's id (else `"hook"`). Claude Code does not relay the deny to the
 * lead (the handoff omits it; live re-check on 2.1.309, #553). So the lead's
 * next `check_feedback` reads it from here, once.
 *
 * Deliberate scope:
 *  - SESSION-SCOPED. Only entries whose `sessionId` is this dp session. An
 *    unresolved `"hook"` entry is delivered to NO session: we can't tell whose
 *    worker it was, and guessing would tell the wrong lead.
 *  - WORKERS ONLY. An entry without `agentId` is the lead's own edit, which
 *    the lead already saw refused in its own tool result.
 *  - DELIVERED ONCE. Delivered ids go to a small per-session file, so a
 *    restart doesn't re-announce them.
 *  - NEVER AUTHORISING. This is a notice. It grants, retires and resumes
 *    nothing; the stance and the human's answer stay where they were.
 *  - Stops that fire while no daemon runs are never logged (the daemon's
 *    watcher writes the log), so they are never delivered either.
 */

/** What the lead is told about one stop. */
export interface WorkerStop {
  id: string;
  agentType?: string;
  targetPath?: string;
  concept: string;
  decision: "ask" | "deny";
  at: string;
}

/** One read of the lane: the new stops, plus a one-time salvage notice. */
export interface WorkerStopBatch {
  stops: WorkerStop[];
  notice?: string;
}

/**
 * Cap on remembered ids. It must be at least MAX_BLOCKS: the block log keeps
 * only the newest MAX_BLOCKS entries, and ids are delivered in log order, so
 * an id evicted from here (100 newer deliveries since) is long gone from the
 * log and can't come back.
 */
export const MAX_SEEN_WORKER_STOPS = Math.max(100, MAX_BLOCKS);

const FILE = "worker-stops-delivered.json";
const VERSION = 1 as const;

interface SeenFile {
  version: 1;
  /** Oldest first. */
  ids: string[];
}

/**
 * The worker stops in `entries` that belong to `sessionId` and haven't been
 * delivered. Pure. Oldest first, so the lead reads them in the order they
 * happened (the log is newest first).
 */
export function workerStopsFor(
  entries: readonly PreflightBlockEntry[],
  sessionId: string,
  seenIds: Iterable<string>,
): WorkerStop[] {
  if (!sessionId || sessionId === "hook") return [];
  const seen = new Set(seenIds);
  const out: WorkerStop[] = [];
  for (const e of entries) {
    if (!e || e.lane !== "hook") continue;
    if (typeof e.agentId !== "string" || e.agentId.length === 0) continue;
    if (e.sessionId !== sessionId) continue;
    if (seen.has(e.id)) continue;
    const stop: WorkerStop = {
      id: e.id,
      concept: e.concept,
      decision: e.decision === "deny" ? "deny" : "ask",
      at: e.at,
    };
    if (e.agentType) stop.agentType = e.agentType;
    if (e.targetPath) stop.targetPath = e.targetPath;
    out.push(stop);
  }
  return out.reverse();
}

function seenPath(sessionDir: string): string {
  return path.join(sessionDir, FILE);
}

type SeenRead = { kind: "ok"; ids: string[] } | { kind: "missing" } | { kind: "corrupt"; raw: string };

function readSeen(sessionDir: string): SeenRead {
  const file = seenPath(sessionDir);
  let raw: string;
  try {
    if (!fs.existsSync(file)) return { kind: "missing" };
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return { kind: "missing" }; // unreadable: nothing to salvage
  }
  // Empty is not corrupt (the salvage rule): nothing to preserve.
  if (raw.trim().length === 0) return { kind: "missing" };
  try {
    const parsed = JSON.parse(raw) as Partial<SeenFile>;
    if (parsed?.version === VERSION && Array.isArray(parsed.ids)) {
      return { kind: "ok", ids: parsed.ids.filter((x): x is string => typeof x === "string").slice(-MAX_SEEN_WORKER_STOPS) };
    }
  } catch {
    /* fall through */
  }
  return { kind: "corrupt", raw };
}

/** Copy a corrupt file aside before anything overwrites it (the convention
 *  preflight-blocks.json and hooks-state.json follow). Returns the backup's
 *  basename, or undefined when the copy failed. */
function backUpCorrupt(sessionDir: string, raw: string): string | undefined {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${seenPath(sessionDir)}.corrupt-${stamp}`;
    fs.writeFileSync(backup, raw);
    return path.basename(backup);
  } catch {
    return undefined;
  }
}

function writeSeen(sessionDir: string, ids: readonly string[]): void {
  fs.mkdirSync(sessionDir, { recursive: true });
  writeJsonAtomic(seenPath(sessionDir), { version: VERSION, ids: ids.slice(-MAX_SEEN_WORKER_STOPS) } satisfies SeenFile);
}

/** Delivered ids for this session, read-only. Missing, empty or corrupt → []. */
export function readDeliveredWorkerStops(sessionDir: string): string[] {
  const r = readSeen(sessionDir);
  return r.kind === "ok" ? r.ids : [];
}

/**
 * The delivered ids, salvaging a CORRUPT file instead of treating it as
 * "nothing seen" (which would re-deliver up to MAX_BLOCKS old stops at once):
 * the file is copied aside to `worker-stops-delivered.json.corrupt-<ISO>`,
 * then rewritten as "seen = every stop of this session in the log now", and a
 * one-time notice says so. The notice is one-time because the rewrite makes
 * the next read healthy.
 */
export function loadDeliveredWorkerStops(
  sessionDir: string,
  currentIds: () => readonly string[],
): { ids: string[]; notice?: string } {
  const r = readSeen(sessionDir);
  if (r.kind === "ok") return { ids: r.ids };
  if (r.kind === "missing") return { ids: [] };
  const backup = backUpCorrupt(sessionDir, r.raw);
  const ids = [...currentIds()];
  try {
    writeSeen(sessionDir, ids);
  } catch {
    /* the in-memory answer below still suppresses the repeat for this poll */
  }
  const n = ids.length;
  return {
    ids,
    notice:
      `⚠️ This session's worker-stop delivery record was unreadable${backup ? ` (backed up to ${backup})` : ""}. ` +
      `${n === 0 ? "No" : n} earlier worker stop${n === 1 ? " was" : "s were"} marked as seen without being re-sent; ` +
      "the companion's gate log still lists every stop.",
  };
}

/**
 * Remember `ids` as delivered (atomic write, capped to the newest
 * MAX_SEEN_WORKER_STOPS). A no-op for an empty list, so a session that never
 * had a worker stop keeps a byte-unchanged directory. A corrupt file is
 * backed up before it's overwritten. Throws on a failed write, so the caller
 * can report that the notice may repeat.
 */
export function markWorkerStopsDelivered(sessionDir: string, ids: readonly string[]): void {
  const fresh = ids.filter((x) => typeof x === "string" && x.length > 0);
  if (fresh.length === 0) return;
  const r = readSeen(sessionDir);
  if (r.kind === "corrupt") backUpCorrupt(sessionDir, r.raw);
  const existing = r.kind === "ok" ? r.ids : [];
  const have = new Set(existing);
  const next = [...existing];
  for (const id of fresh) {
    if (have.has(id)) continue;
    have.add(id);
    next.push(id);
  }
  writeSeen(sessionDir, next);
}

/** The check_feedback suggested-action clause: a deny among the stops… */
export const WORKER_STOP_CLAUSE =
  "A worker was stopped. Re-plan the dependent work or ask the human before continuing.";
/** …or only asks (the edit may have gone through). */
export const WORKER_ASK_CLAUSE =
  "A worker's edit was put to the human by a stance. Check whether it went through before relying on it.";

export function workerStopClause(stops: readonly WorkerStop[]): string | null {
  if (stops.length === 0) return null;
  return stops.some((s) => s.decision === "deny") ? WORKER_STOP_CLAUSE : WORKER_ASK_CLAUSE;
}

/**
 * Make a worker-supplied value safe inside a prose code span: control
 * characters and line breaks become spaces (no forged lines), backticks become
 * "'" (no escaping the span), whitespace collapses, and the length is bounded.
 */
export function proseSafe(value: string, max: number): string {
  const flat = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/`/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function stopSentence(s: WorkerStop): string {
  const type = proseSafe(s.agentType ?? "worker", 60) || "worker";
  const target = proseSafe(s.targetPath ?? "(unknown path)", 200) || "(unknown path)";
  const concept = proseSafe(s.concept, 120);
  if (s.decision === "deny") {
    return (
      `a \`${type}\` subagent was **stopped** at \`${target}\` by stance \`${concept}\`. That edit did not happen. ` +
      "Don't advance work that depends on it; re-plan or ask the human. Don't retry the same edit."
    );
  }
  return (
    `a \`${type}\` subagent's edit to \`${target}\` matched stance \`${concept}\`, and Claude Code **asked the human**. ` +
    "It may or may not have gone through, so check the file before relying on it. Don't retry it if it was refused."
  );
}

/** One prose block for the stops, or "" when there are none. */
export function formatWorkerStops(stops: readonly WorkerStop[]): string {
  if (stops.length === 0) return "";
  const denies = stops.filter((s) => s.decision === "deny").length;
  const label =
    denies === stops.length ? "Worker stopped" : denies === 0 ? "Worker asked the human" : "Worker stopped or asked the human";
  if (stops.length === 1) return `⛔ ${label} (1): ${stopSentence(stops[0]!)}`;
  return `⛔ ${label} (${stops.length}):\n${stops.map((s) => `- ${stopSentence(s)}`).join("\n")}`;
}
