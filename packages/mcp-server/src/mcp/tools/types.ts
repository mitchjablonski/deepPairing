import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { IStore } from "../../store/store-interface.js";
import type { PreflightHelperResult } from "../tool-helpers.js";

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
 * the pendingCount tally, and the suggestedAction branch (see check-feedback.ts).
 */
export const PENDING_DRAFT_TYPES = ["research", "spec", "plan", "decision", "code_change"] as const;
/** Draft types listed in the WAITING block (decisions get their own line). */
export const WAITING_DRAFT_TYPES = ["research", "spec", "plan", "code_change"] as const;

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
  /** Drain unacknowledged human comments and format for the agent. */
  getPassiveFeedback: () => Promise<string>;
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
