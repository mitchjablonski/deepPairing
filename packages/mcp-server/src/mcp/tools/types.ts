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
};

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
}

export interface ToolContext {
  server: Server;
  store: IStore;
  broadcast: BroadcastFn;
  port: number;
  helpers: ToolHelpers;
  state: ToolState;
}
