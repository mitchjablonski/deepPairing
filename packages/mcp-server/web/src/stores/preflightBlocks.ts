import { create } from "zustand";
import { apiBase, apiGet } from "../lib/api";

/**
 * #169 — the gate-firing history surfaced to the companion UI.
 *
 * A `preflight_blocked` event (deepPairing refusing an agent proposal that
 * matches a prior rejection) previously produced only a 12s hero toast — the
 * single most distinctive deepPairing moment vanished after twelve seconds with
 * no record of what was blocked, why, or when. This store keeps each fire so
 * PreflightBlockLog can render it long after the toast is gone: what was
 * blocked, the concept, the prior reason, and when.
 *
 * Q2 — NO LONGER IN-MEMORY-ONLY. Round 12's finding: the demo stashed its
 * synthetic block and replayed it to late joiners forever, while a REAL block
 * lived only here, in one tab, until reload. The human whose browser wasn't
 * attached when the gate fired — the normal case, since the agent works while
 * the tab is closed — saw nothing at all, and the demo therefore taught an
 * expectation production didn't keep. The daemon now persists every real block
 * to `.deeppairing/preflight-blocks.json` and serves it at
 * `/api/preflight-blocks`; `load()` hydrates from there on mount, for EVERY
 * session (not just demo). Live events still arrive via the WS broadcast and
 * merge on top, deduped against the hydrated set.
 *
 * F7 — this log captures MCP-lane blocks ONLY: a present_* preflight block
 * broadcasts a `preflight_blocked` WS event, which is what feeds this store.
 * The PreToolUse HOOK lane (a raw Edit/Write refused at the platform level)
 * has no daemon in the loop and emits no WS event — it records its fire to
 * .deeppairing/hooks-state.json instead, surfaced by HookStatus. Same split as
 * HookStatus vs this log: two lanes, two surfaces, deliberately.
 */

export interface PreflightBlockRecord {
  /** Stable id — server-assigned for hydrated blocks, client-minted for live ones. */
  id: string;
  /** When the block fired. */
  at: string;
  source: "session" | "team";
  /** The underlying concept/pattern that was blocked. */
  concept: string;
  /** What the agent tried to propose (the surface string that matched). */
  proposal?: string;
  /** The human's original rejection reason — the "why" behind the block. */
  reason?: string;
  /** How the match was made (surface name / underlying concept / team rule). */
  via: "surface" | "concept" | "avoid" | "require";
  /** When the ORIGINAL rejection was recorded (distinct from `at`). */
  rejectedAt?: string;
  addedBy?: string;
  projectCount?: number;
  /** Q2 — which session the agent was in. Present on server-hydrated blocks. */
  sessionId?: string;
  /**
   * Q2 review item 11 — the durable log entry's id, assigned by the daemon and
   * carried on BOTH the live WS event and the hydrated row. This is the dedupe
   * key; `id` remains the client-local React key. Absent for a demo replay
   * (never persisted) and for a pre-Q2 daemon.
   */
  serverId?: string;
}

interface PreflightBlockState {
  blocks: PreflightBlockRecord[];
  loaded: boolean;
  /**
   * Q2 — the "you haven't looked at this yet" boundary, persisted so it
   * survives the reload that used to erase the blocks themselves. Blocks with
   * `at` newer than this are unread.
   */
  lastSeenAt: string | null;
  /** Q2 — hydrate from the daemon's durable log. Call once on mount. */
  load: () => Promise<void>;
  /** Merge a single block from a `preflight_blocked` broadcast event. */
  pushBlock: (block: Omit<PreflightBlockRecord, "id" | "at"> & { at?: string }) => void;
  /** Q2 — mark everything currently held as seen (called when the log is opened). */
  markSeen: () => void;
  clear: () => void;
}

const MAX_BLOCKS_KEPT = 25;
const LAST_SEEN_KEY = "dp.gateBlocks.lastSeenAt";

/** localStorage is unavailable in private modes / some jsdom configs — never throw. */
function readLastSeen(): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(LAST_SEEN_KEY);
  } catch {
    return null;
  }
}
function writeLastSeen(at: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(LAST_SEEN_KEY, at);
  } catch {
    // ignore
  }
}

/**
 * Identity for dedupe: the same firing re-delivered (WS replay, reconnect, or a
 * live event that hydrate() also carried) must not double-append.
 *
 * Q2 review item 11 — the SERVER ID is the real answer, and it exists now: the
 * daemon persists the block before fanning out and stamps the durable entry's
 * id onto the wire event, so the live delivery and the hydrated row carry the
 * same `serverId`. The previous key was inert in the production shape — it
 * preferred `rejectedAt`, which a real `preflight_blocked` payload never
 * carries (it isn't part of the match shape), so identity fell through to
 * client-vs-server timestamp equality and a block arriving DURING load()
 * double-appended, inflating the unread count on the one signal that has to be
 * trustworthy.
 *
 * The content key stays as the fallback for the two id-less cases: a demo
 * replay (never persisted, so no id exists) and a pre-Q2 daemon.
 */
function sameBlock(
  a: PreflightBlockRecord,
  b: { concept: string; proposal?: string; at?: string; rejectedAt?: string; id?: string; serverId?: string },
): boolean {
  const bServer = b.serverId ?? b.id;
  if (bServer && a.serverId) return a.serverId === bServer;
  if (bServer && a.id === bServer) return true;
  if (a.concept !== b.concept || a.proposal !== b.proposal) return false;
  // Prefer the original-rejection timestamp when both have one (the #169 key);
  // otherwise fall back to the firing timestamp.
  if (a.rejectedAt || b.rejectedAt) return a.rejectedAt === b.rejectedAt;
  return !!b.at && a.at === b.at;
}

export const usePreflightBlockStore = create<PreflightBlockState>((set, get) => ({
  blocks: [],
  loaded: false,
  lastSeenAt: readLastSeen(),

  load: async () => {
    try {
      const res = await apiGet(`${apiBase()}/api/preflight-blocks`);
      if (!res.ok) {
        set({ loaded: true });
        return;
      }
      const body = await res.json();
      const raw: PreflightBlockRecord[] = Array.isArray(body?.blocks) ? body.blocks : [];
      const hydrated = raw
        .filter((b) => b && typeof b.concept === "string" && b.concept.length > 0)
        .map((b) => ({
          ...b,
          via: b.via ?? "surface",
          source: b.source === "team" ? ("team" as const) : ("session" as const),
          // The log entry's own id IS the server id (see item 11).
          serverId: b.serverId ?? b.id,
        }));
      // Merge UNDER anything already pushed live (a block that arrived on the
      // socket while this fetch was in flight is the same firing).
      const { blocks } = get();
      const merged = [...blocks];
      for (const h of hydrated) {
        if (!merged.some((m) => sameBlock(m, h))) merged.push(h);
      }
      merged.sort((a, b) => b.at.localeCompare(a.at));
      set({ blocks: merged.slice(0, MAX_BLOCKS_KEPT), loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  pushBlock: (block) => {
    if (!block || typeof block.concept !== "string" || block.concept.length === 0) return;
    const at = typeof block.at === "string" && block.at ? block.at : new Date().toISOString();
    const { blocks } = get();
    // F7 — dedupe a double-delivered event. The daemon fans `preflight_blocked`
    // out per session, and #194 replays events on reconnect, so the SAME block
    // can arrive twice. Independent of #194's connection-layer dedupe:
    // belt-and-suspenders, so neither layer alone can double-append.
    if (blocks.some((b) => sameBlock(b, { ...block, at }))) return;
    // The client id stays client-local (React key). Prefer the server's id for
    // it too when we have one, so the two lanes also agree on the React key.
    const id = block.serverId ?? `blk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const record: PreflightBlockRecord = { ...block, id, at };
    const next = [record, ...blocks].slice(0, MAX_BLOCKS_KEPT);
    set({ blocks: next });
  },

  markSeen: () => {
    const { blocks } = get();
    // Newest block's timestamp, or now when the log is empty.
    const newest = blocks.reduce<string | null>(
      (acc, b) => (acc && acc.localeCompare(b.at) >= 0 ? acc : b.at),
      null,
    );
    const at = newest ?? new Date().toISOString();
    writeLastSeen(at);
    set({ lastSeenAt: at });
  },

  clear: () => set({ blocks: [], loaded: false }),
}));

/** Q2 — how many held blocks fired after the human last looked. */
export function unreadBlockCount(state: Pick<PreflightBlockState, "blocks" | "lastSeenAt">): number {
  const { blocks, lastSeenAt } = state;
  if (!lastSeenAt) return blocks.length;
  return blocks.filter((b) => b.at.localeCompare(lastSeenAt) > 0).length;
}
