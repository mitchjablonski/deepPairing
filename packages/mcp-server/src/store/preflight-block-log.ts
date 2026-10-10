import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-write.js";
import type { ProposalPrecondition, ProposalSnapshot, StanceAllowanceReceipt, StanceRef } from "@deeppairing/shared";

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
  // #470 — stance exceptions. All optional, all written by the daemon only.
  // None of this is authority: the daemon grants from its IN-MEMORY copy of the
  // block, never from this file (editing it can't arm an allowance).
  /** The artifact type the refused call would have created. */
  artifactType?: string;
  /** Locates a retry of the refused call (raw args, minus transport _meta). */
  callFingerprint?: string;
  /** Daemon-computed sha256 over snapshot + preconditions. */
  effectiveDigest?: string;
  /** What would be created — the preview's source. Omitted when not eligible. */
  snapshot?: ProposalSnapshot;
  preconditions?: ProposalPrecondition[];
  /** The exact stance row that matched. */
  stance?: StanceRef;
  /** The daemon-issued registration that made the refused call. */
  registrationId?: string;
  /** Whether "Allow this proposal once" can be offered for this block. */
  eligible?: boolean;
  ineligibleReason?: string;
  /** The receipt of the allowance granted on this block, if any. */
  allowance?: StanceAllowanceReceipt;
  /** Set when this block replaced an allowance whose dependency moved. */
  supersedesAllowanceId?: string;
  /** Set when the human acted on this block (a grant), so Held drops it. */
  seenAt?: string;
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

/**
 * Read the log from disk. Missing, unparseable, or wrong-shaped → empty.
 *
 * Q2 review LOW — a corrupt log is COPIED ASIDE before it is discarded, to
 * `preflight-blocks.json.corrupt-<ISO>`. This is the salvage rule ("back up
 * before any committing drop") and the same convention Q1 landed for
 * hooks-state.json. It matters more here than the empty return suggests: the
 * next write rebuilds the file from what this read returned, so silently
 * returning [] on a parse error is what ACTUALLY destroys the history — the
 * bad bytes get overwritten by a one-entry file the moment the gate fires
 * again. The copy makes that recoverable by hand.
 */
export function readPreflightBlocks(projectRoot: string): PreflightBlockEntry[] {
  const file = logPath(projectRoot);
  let raw: string;
  try {
    if (!fs.existsSync(file)) return [];
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return []; // unreadable — nothing to salvage
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PreflightBlockLogFile>;
    if (parsed?.version === VERSION && Array.isArray(parsed.blocks)) {
      // Defensive filter — a hand-edited file must not put junk on the UI.
      return parsed.blocks
        .filter(
          (b): b is PreflightBlockEntry =>
            !!b && typeof b.id === "string" && typeof b.concept === "string" && b.concept.length > 0,
        )
        .slice(0, MAX_BLOCKS);
    }
    // Parsed but wrong shape (a future/older version, or hand-mangled) — still
    // a drop, so still worth a copy.
  } catch {
    /* fall through to the salvage copy */
  }
  // Empty file is not corrupt — there is nothing to preserve, and writing a
  // zero-byte .corrupt- sibling on every read would be litter.
  if (raw.trim().length > 0) {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      fs.writeFileSync(`${file}.corrupt-${stamp}`, raw);
    } catch {
      /* best-effort */
    }
  }
  return [];
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
  // #470 — set only by the daemon's internal preflight-block route, which
  // strips any caller-supplied copies and recomputes them.
  artifactType?: string;
  callFingerprint?: string;
  effectiveDigest?: string;
  snapshot?: ProposalSnapshot;
  preconditions?: ProposalPrecondition[];
  stance?: StanceRef;
  registrationId?: string;
  eligible?: boolean;
  ineligibleReason?: string;
  supersedesAllowanceId?: string;
}

/** #470 — the stance-exception fields a daemon-prepared event carries onto its
 *  log entry, omitted when absent so a plain block's entry is unchanged. */
const EXCEPTION_FIELDS = [
  "artifactType", "callFingerprint", "effectiveDigest", "snapshot", "preconditions",
  "stance", "registrationId", "eligible", "ineligibleReason", "supersedesAllowanceId",
] as const;

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
    ...Object.fromEntries(EXCEPTION_FIELDS.filter((k) => event[k] !== undefined).map((k) => [k, event[k]])),
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

/**
 * #470 — rewrite entries in place (receipts, seenAt, the changed linkage). The
 * daemon is the only writer and this read-modify-write is synchronous, so it
 * can't interleave with another daemon-side write. Fail-soft like the append:
 * returns false when nothing was written. A receipt is a record, not
 * authority, so losing one never changes what an allowance admits.
 */
export function updatePreflightBlocks(
  projectRoot: string,
  mutate: (entry: PreflightBlockEntry) => PreflightBlockEntry | null,
): boolean {
  if (!projectRoot) return false;
  try {
    let changed = false;
    const blocks = readPreflightBlocks(projectRoot).map((entry) => {
      const next = mutate(entry);
      if (!next) return entry;
      changed = true;
      return next;
    });
    if (!changed) return false;
    const file = logPath(projectRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, { version: VERSION, blocks } satisfies PreflightBlockLogFile);
    return true;
  } catch {
    return false;
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
