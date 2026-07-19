import { create } from "zustand";

/**
 * #169 — the gate-firing history surfaced to the companion UI.
 *
 * A `preflight_blocked` event (deepPairing refusing an agent proposal that
 * matches a prior rejection) previously produced only a 12s hero toast — the
 * single most distinctive deepPairing moment vanished after twelve seconds with
 * no record of what was blocked, why, or when. This store keeps each fire in
 * memory for the session so PreflightBlockLog can render it long after the toast
 * is gone: what was blocked, the concept, the prior reason, and when.
 *
 * In-memory + session-scoped by design (mirrors hookStatus.ts). There is no
 * server endpoint for per-block detail — the metrics store keeps only the
 * aggregate count — so a page reload starts fresh; the toast + this log are the
 * live surfaces.
 *
 * F7 — this log captures MCP-lane blocks ONLY: a present_* preflight block
 * broadcasts a `preflight_blocked` WS event, which is what feeds this store.
 * The PreToolUse HOOK lane (a raw Edit/Write refused at the platform level)
 * has no daemon in the loop and emits no WS event — it records its fire to
 * .deeppairing/hooks-state.json instead, surfaced by HookStatus. Same split as
 * HookStatus vs this log: two lanes, two surfaces, deliberately.
 */

export interface PreflightBlockRecord {
  /** Stable client id (the moment is the record — no server id exists). */
  id: string;
  /** When the block fired, from the client's receipt of the event. */
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
}

interface PreflightBlockState {
  blocks: PreflightBlockRecord[];
  /** Merge a single block from a `preflight_blocked` broadcast event. */
  pushBlock: (block: Omit<PreflightBlockRecord, "id" | "at"> & { at?: string }) => void;
  clear: () => void;
}

const MAX_BLOCKS_KEPT = 25;

export const usePreflightBlockStore = create<PreflightBlockState>((set, get) => ({
  blocks: [],

  pushBlock: (block) => {
    if (!block || typeof block.concept !== "string" || block.concept.length === 0) return;
    const at = typeof block.at === "string" && block.at ? block.at : new Date().toISOString();
    const { blocks } = get();
    // F7 — dedupe a double-delivered event. The daemon fans `preflight_blocked`
    // out per session, and #194 replays events on reconnect, so the SAME block
    // can arrive twice. Identity is (rejectedAt + concept + proposal): the
    // original rejection's timestamp + what it blocked + what was proposed —
    // stable across redeliveries of one firing (client `at`/`id` are not, so
    // they can't be the key). Independent of #194's connection-layer dedupe:
    // belt-and-suspenders, so neither layer alone can double-append.
    const isDup = blocks.some(
      (b) =>
        b.rejectedAt === block.rejectedAt &&
        b.concept === block.concept &&
        b.proposal === block.proposal,
    );
    if (isDup) return;
    const id = `blk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const record: PreflightBlockRecord = { ...block, id, at };
    const next = [record, ...blocks].slice(0, MAX_BLOCKS_KEPT);
    set({ blocks: next });
  },

  clear: () => set({ blocks: [] }),
}));
