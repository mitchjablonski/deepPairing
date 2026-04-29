import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { IStore } from "../store/store-interface.js";
import type { TeamPreference } from "@deeppairing/shared";
import {
  ELICIT_APPROVE_SCHEMA,
  decideElicitResponse,
} from "./elicit.js";
import { runPreflight } from "./preflight-validator.js";

type BroadcastFn = (event: any) => void;

/**
 * X4 — shared per-call helpers, lifted out of server.ts so the CallTool
 * dispatcher reads as routing. Each helper is called once-per-request from
 * the corresponding tool case; they were closure-scoped before, but
 * nothing in them needed the closure beyond `server`/`store`/`broadcast`,
 * which are now arguments.
 */

/**
 * Try to elicit a quick response from the user via MCP elicitation. Falls
 * back gracefully if the client doesn't support it. Behavior is pinned by
 * `decideElicitResponse` (exported from elicit.ts) so the response-handling
 * logic can be unit-tested without an SDK round trip.
 */
export async function tryElicit(
  server: Server,
  message: string,
): Promise<"approve" | "review" | null> {
  try {
    const result = await server.elicitInput({
      message,
      requestedSchema: ELICIT_APPROVE_SCHEMA,
    });
    return decideElicitResponse(result);
  } catch {
    // Client doesn't support elicitation — fall back to polling
    return null;
  }
}

/**
 * Pre-flight: refuse to record an artifact whose content matches an
 * approach the human previously rejected (session-scoped) OR violates a
 * team-agreed avoid/require preference (committed to .deeppairing/team.json).
 * Returns a tool error response if either lane matches, or null otherwise.
 *
 * U5 — the matching/orchestration logic lives in preflight-validator.ts.
 * This wrapper only handles the side-effecty bits (reading the store,
 * broadcasting the block event, shaping the MCP tool-error response).
 */
export async function preflightRejectedApproaches(
  store: IStore,
  broadcast: BroadcastFn,
  toolName: string,
  proposalStrings: string[],
  proposalPaths: string[] = [],
): Promise<{ content: Array<{ type: "text"; text: string }>; isError: true } | null> {
  const memory = await store.getSessionMemory();
  const teamPrefs: TeamPreference[] =
    typeof (store as any).getTeamPreferences === "function"
      ? (await (store as any).getTeamPreferences()) ?? []
      : [];

  const result = runPreflight({
    toolName,
    proposalStrings,
    proposalPaths,
    rejectedApproaches: memory.rejectedApproaches,
    teamPreferences: teamPrefs,
  });

  if (!result.blocked) return null;

  // Make the invisible moat felt: broadcast the block so the companion UI
  // can surface a toast.
  broadcast(result.block.broadcastEvent);

  return {
    content: [{ type: "text", text: result.block.message }],
    isError: true as const,
  };
}

/**
 * Auto-name the session from the first meaningful artifact title. Idempotent
 * across the SessionNameLatch instance — once latched, subsequent calls are
 * no-ops, even with different titles.
 */
export class SessionNameLatch {
  private named = false;

  constructor(private readonly store: IStore) {}

  async maybeName(title: string): Promise<void> {
    if (this.named || !title || title === "Research Findings" || title === "Reasoning") return;
    this.named = true;
    if ("renameSession" in this.store && typeof (this.store as any).renameSession === "function") {
      await (this.store as any).renameSession(title);
    }
  }
}

/**
 * Drain unacknowledged human comments and format them for the agent. Returns
 * an empty string when nothing is pending (so the caller can append it
 * unconditionally).
 */
export async function getPassiveFeedback(store: IStore): Promise<string> {
  const comments = await store.getUnacknowledgedComments();
  if (comments.length === 0) return "";
  await store.acknowledgeComments(comments.map((c) => c.id));
  const formatted = comments.map((c) => `- ${c.content}`).join("\n");
  return `\n\n[Human feedback]: ${formatted}`;
}
