import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-write.js";

/**
 * Q2 — DURABLE PREFLIGHT BLOCKS.
 *
 * The gate firing is the single most distinctive thing deepPairing does, and
 * round 12 found it was the most ephemeral: a real block produced a 12-second
 * hero toast plus an in-memory, session-scoped log in the browser tab. No
 * server endpoint existed. If the human's browser wasn't attached (the normal
 * case — Claude Code works while the tab is closed), or if they reloaded, the
 * moment left no trace at all. Meanwhile the DEMO stashes its synthetic block
 * and replays it forever to late joiners — so the demo taught an expectation
 * production did not keep.
 *
 * This is the missing durability: a small, capped, append-only project log at
 * `.deeppairing/preflight-blocks.json`, written on the daemon side at the one
 * point every block passes through (the broadcast fan-out in create-daemon),
 * and served back at `GET /api/preflight-blocks` so the companion UI hydrates
 * its block log on page load rather than starting empty.
 *
 * Deliberate scope:
 *  - DEMO SESSIONS ARE NEVER PERSISTED. Same posture as the metrics tap ("the
 *    demo's synthetic block is daemon-side and intentionally NOT counted") —
 *    the demo replay path is untouched and keeps working exactly as before.
 *  - Capped at MAX_BLOCKS. This is a "did the moat fire?" record, not an audit
 *    trail; the metrics counter already owns the lifetime total.
 *  - Every read and write is fail-soft. A corrupt or unreadable log degrades to
 *    an empty list — losing block history must never break a block, a
 *    broadcast, or a page load.
 */

export const MAX_BLOCKS = 50;
const VERSION = 1 as const;

export interface PreflightBlockEntry {
  /** Server-assigned, stable across reloads (the client id was not). */
  id: string;
  /** When the block fired, server clock. */
  at: string;
  /** Which session the agent was working in when it was refused. */
  sessionId: string;
  /** The present_* tool that was refused. */
  toolName?: string;
  source: "session" | "team";
  /** The underlying concept/pattern that was blocked. */
  concept: string;
  /** What the agent tried to propose (the surface string that matched). */
  proposal?: string;
  /** The human's original rejection reason / the team rationale. */
  reason?: string;
  /** How the match was made. */
  via: "surface" | "concept" | "avoid" | "require";
  addedBy?: string;
}

export interface PreflightBlockLogFile {
  version: 1;
  /** Newest first. */
  blocks: PreflightBlockEntry[];
}

function logPath(projectRoot: string): string {
  return path.join(projectRoot, ".deeppairing", "preflight-blocks.json");
}

function emptyLog(): PreflightBlockLogFile {
  return { version: VERSION, blocks: [] };
}

/** Read the log from disk. Missing, unparseable, or wrong-shaped → empty. */
export function readPreflightBlocks(projectRoot: string): PreflightBlockEntry[] {
  try {
    const file = logPath(projectRoot);
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<PreflightBlockLogFile>;
    if (parsed?.version !== VERSION || !Array.isArray(parsed.blocks)) return [];
    // Defensive filter — a hand-edited file must not put junk on the UI.
    return parsed.blocks
      .filter(
        (b): b is PreflightBlockEntry =>
          !!b && typeof b.id === "string" && typeof b.concept === "string" && b.concept.length > 0,
      )
      .slice(0, MAX_BLOCKS);
  } catch {
    return [];
  }
}

/**
 * The shape a `preflight_blocked` broadcast carries (see
 * preflight-validator.ts). Loose on purpose: this is a wire payload, and a
 * future field must not make the log throw.
 */
export interface PreflightBlockedEventLike {
  type?: string;
  toolName?: string;
  source?: string;
  match?: {
    proposal?: string;
    description?: string;
    reason?: string;
    concept?: string;
    via?: string;
    addedBy?: string;
  };
}

const VALID_VIA = new Set(["surface", "concept", "avoid", "require"]);

/**
 * Project a `preflight_blocked` broadcast into a log entry, or null when the
 * event isn't one / carries nothing nameable. Pure — unit-testable without a
 * filesystem, mirroring the metrics-tap split.
 */
export function blockEntryFromEvent(
  sessionId: string,
  event: PreflightBlockedEventLike,
  now: () => string = () => new Date().toISOString(),
): PreflightBlockEntry | null {
  if (!event || event.type !== "preflight_blocked") return null;
  const match = event.match ?? {};
  const concept = (match.concept ?? match.description ?? "").trim();
  if (!concept) return null;
  const via = typeof match.via === "string" && VALID_VIA.has(match.via) ? match.via : "surface";
  const at = now();
  return {
    // Deterministic-enough id: the timestamp + a short random tail. Identity for
    // DEDUPE purposes is (concept, proposal, at) — see the web store — not this.
    id: `blk_${Date.parse(at) || Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    at,
    sessionId,
    toolName: event.toolName,
    source: event.source === "team" ? "team" : "session",
    concept,
    proposal: match.proposal,
    reason: match.reason,
    via: via as PreflightBlockEntry["via"],
    addedBy: match.addedBy,
  };
}

/**
 * Append a block to the project log (newest first, capped). Fail-soft.
 * Returns the entry that was written, or null when nothing was written.
 *
 * Demo sessions are refused here rather than at the call site so the guarantee
 * ("a demo run leaves the real project state byte-identical") holds no matter
 * who calls this next.
 */
export function recordPreflightBlock(
  projectRoot: string,
  sessionId: string,
  event: PreflightBlockedEventLike,
): PreflightBlockEntry | null {
  if (!projectRoot) return null;
  if (sessionId.startsWith("demo_")) return null;
  const entry = blockEntryFromEvent(sessionId, event);
  if (!entry) return null;
  try {
    const blocks = [entry, ...readPreflightBlocks(projectRoot)].slice(0, MAX_BLOCKS);
    const file = logPath(projectRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, { version: VERSION, blocks } satisfies PreflightBlockLogFile);
    return entry;
  } catch {
    // Non-fatal — losing the record is strictly better than breaking the block.
    return null;
  }
}

/** Test-only helper: start from a clean log. */
export function clearPreflightBlocks(projectRoot: string): void {
  try {
    const file = logPath(projectRoot);
    if (fs.existsSync(file)) writeJsonAtomic(file, emptyLog());
  } catch {
    // ignore
  }
}
