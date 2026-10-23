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

/** Delivered ids for this session. Missing, unreadable or wrong-shaped → []
 *  (the worst case is one repeat of a notice, never a lost block). */
export function readDeliveredWorkerStops(sessionDir: string): string[] {
  try {
    const file = seenPath(sessionDir);
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<SeenFile>;
    if (parsed?.version !== VERSION || !Array.isArray(parsed.ids)) return [];
    return parsed.ids.filter((x): x is string => typeof x === "string").slice(-MAX_SEEN_WORKER_STOPS);
  } catch {
    return [];
  }
}

/**
 * Remember `ids` as delivered (atomic write, capped to the newest
 * MAX_SEEN_WORKER_STOPS). A no-op for an empty list, so a session that never
 * had a worker stop keeps a byte-unchanged directory. Throws on a failed
 * write, so the caller can report that the notice may repeat.
 */
export function markWorkerStopsDelivered(sessionDir: string, ids: readonly string[]): void {
  const fresh = ids.filter((x) => typeof x === "string" && x.length > 0);
  if (fresh.length === 0) return;
  const existing = readDeliveredWorkerStops(sessionDir);
  const have = new Set(existing);
  const next = [...existing];
  for (const id of fresh) {
    if (have.has(id)) continue;
    have.add(id);
    next.push(id);
  }
  fs.mkdirSync(sessionDir, { recursive: true });
  writeJsonAtomic(seenPath(sessionDir), { version: VERSION, ids: next.slice(-MAX_SEEN_WORKER_STOPS) } satisfies SeenFile);
}

/** The check_feedback suggested-action clause when any stop was delivered. */
export const WORKER_STOP_CLAUSE =
  "A worker was stopped. Re-plan the dependent work or ask the human before continuing.";

/** One prose block for the stops, or "" when there are none. */
export function formatWorkerStops(stops: readonly WorkerStop[]): string {
  if (stops.length === 0) return "";
  const line = (s: WorkerStop) =>
    `a \`${s.agentType ?? "worker"}\` subagent was stopped or held for your approval at \`${s.targetPath ?? "(unknown path)"}\` by stance \`${s.concept}\` (\`${s.decision}\`).`;
  if (stops.length === 1) {
    return (
      `⛔ Worker stopped (1): ${line(stops[0]!)} That edit did **not** happen through the worker. ` +
      "Don't advance work that depends on it; re-plan, or ask the human. Don't retry the same edit."
    );
  }
  return (
    `⛔ Worker stopped (${stops.length}):\n` +
    stops.map((s) => `- ${line(s)}`).join("\n") +
    "\nThose edits did **not** happen through the workers. " +
    "Don't advance work that depends on them; re-plan, or ask the human. Don't retry the same edits."
  );
}
