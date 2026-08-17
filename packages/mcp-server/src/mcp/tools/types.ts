import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { IStore } from "../../store/store-interface.js";
import type { PreflightHelperResult, PresentIdempotencyBegin } from "../tool-helpers.js";

/**
 * X4 — shared per-call context for tool handlers.
 *
 * Every per-tool handler used to live as a `case` body inside a 1000-line
 * switch in server.ts. Each closed over the same handful of dependencies
 * (the store, the broadcast fn, the elicit/preflight/auto-name helpers,
 * the per-session counter for check_feedback). Lifting them all into
 * named modules under `mcp/tools/` makes each handler discoverable and
 * unit-testable without spinning up the full server.
 *
 * The handler signature is uniform: `handle(ctx, args)` returning an MCP
 * tool-call result. Anything mutable that crossed call boundaries (the
 * check_feedback poll counter) lives in `state` so the handler can write
 * to it via reference, not closure.
 */
export type BroadcastFn = (event: any) => void;

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  /** B3 — machine-readable mirror of the prose for tools that declare an
   *  outputSchema (check_feedback). Clients that support structured tool
   *  output stop prose-parsing the status blob. */
  structuredContent?: Record<string, unknown>;
};

/**
 * F1 — the draft artifact types that make check_feedback WAIT for the human and
 * count toward "pending". These MUST stay in sync across the long-poll gate,
 * the pendingCount tally, and the suggestedAction branch (see check-feedback.ts)
 * — and across the daemon badge (create-daemon's PENDING_REVIEWABLE) and the web
 * banner (lib/pending.ts REVIEWABLE_TYPES), pinned equal by a parity test.
 *
 * P3 — `explainer` LEFT this set. It is acknowledge-only (below), so counting it
 * as pending made every surface contradict the payload that carried it: an
 * explainer-only poll reported status "waiting" with pending=1, sat in the 30s
 * long-poll, and told the agent not to block on the very thing it was blocking
 * on. A read-only walk-through is not work owed. It is still delivered — the
 * "📖 TO READ" line (WAITING_DRAFT_TYPES) is now its ONLY mention — and its
 * comments/questions still flow back normally.
 */
export const PENDING_DRAFT_TYPES = ["research", "spec", "plan", "decision", "code_change", "changeset", "debrief"] as const;
/** Draft types listed in the WAITING block (decisions get their own line).
 *  Deliberately a SUPERSET of PENDING_DRAFT_TYPES on the acknowledge-only types:
 *  an explainer is reported (under "📖 TO READ") without being counted pending. */
export const WAITING_DRAFT_TYPES = ["research", "spec", "plan", "code_change", "changeset", "debrief", "explainer"] as const;
/**
 * P3 — the ACKNOWLEDGE-ONLY draft types: read-only artifacts whose companion-UI
 * footer is an acknowledge bar ("Got it" / "Ask more" — ArtifactStatusActions'
 * `acknowledgeMode`), with NO Reject and NO Request-changes. Nothing here
 * proposes an approach, so nothing here awaits a VERDICT: check_feedback lists
 * these under a distinct "📖 TO READ" line instead of the "⏳ WAITING … under
 * review" nag, they do NOT count toward pending, and they never hold the
 * long-poll open.
 *
 * EXPLAINER ONLY, deliberately: the debrief and research surfaces keep the full
 * verdict triad (the debrief merely suppresses the reject-CONCEPT ledger write,
 * which is a ledger concern, not a verdict one). Add a type here only when its
 * UI footer actually drops the verdict triad — and when you do, drop it from
 * PENDING_DRAFT_TYPES + the daemon/web mirrors in the same commit. Pinned in
 * check-feedback-readonly-nag.test.ts.
 */
export const ACKNOWLEDGE_ONLY_DRAFT_TYPES = ["explainer"] as const;

export interface ToolHelpers {
  /** MCP elicitation with graceful fallback. */
  tryElicit: (message: string) => Promise<"approve" | "review" | null>;
  /**
   * Pre-flight refusal for rejected approaches and team-pref violations.
   * Y1' — always returns a trace so the caller can persist it via
   * `store.recordPreflightTrace(artifactId, trace)` for the UI breadcrumb.
   * `{ ok: true, trace }` admits; `{ ok: false, response, trace }` blocks.
   */
  preflightRejectedApproaches: (
    toolName: string,
    proposalStrings: string[],
    proposalPaths?: string[],
    /** (A) The proposal's own named concept(s) for the concept↔concept lane. */
    proposalConcepts?: string[],
  ) => Promise<PreflightHelperResult>;
  /** Idempotently rename the session from the first meaningful artifact title. */
  autoNameSession: (title: string) => Promise<void>;
  /**
   * Drain unacknowledged human comments and format for the agent. `excludeIds`
   * (N2 #226) keeps specific comments out of the echoed text while still
   * acknowledging them — e.g. answer_question excludes the comment it just
   * answered so its own success reply doesn't echo the human's question back.
   */
  getPassiveFeedback: (excludeIds?: string[]) => Promise<string>;
  /**
   * N2 (#226) — short-window content-hash de-dup for present_* tools. Call
   * before minting: `duplicate` set → return the dedup response; otherwise the
   * caller owns creation and must `commit(id)` on success / `abort()` on throw.
   */
  beginPresentIdempotency: (toolName: string, contentHash: string) => Promise<PresentIdempotencyBegin>;
}

/** Per-session mutable counters that cross tool-call boundaries. */
export interface ToolState {
  /** check_feedback poll counter — drives the "human may not have UI open" nudge. */
  checkFeedbackPollCount: number;
  /** FN2 — rejected artifacts already reported by check_feedback (report once). */
  reportedRejectedVerdicts: Set<string>;
  /** B3 — plan verdicts already counted toward structuredContent.status. The
   *  prose re-reports reviewed plans every poll (pre-existing, skim-past-able);
   *  the machine-readable status must DECAY to 'proceed' once reported, or a
   *  session with one reviewed plan reads status='feedback' forever. */
  reportedPlanVerdicts: Set<string>;
}

export interface ToolContext {
  server: Server;
  store: IStore;
  broadcast: BroadcastFn;
  port: number;
  helpers: ToolHelpers;
  state: ToolState;
  /** B3 — per-request MCP progress token (check_feedback heartbeats). */
  progressToken?: string | number;
}
