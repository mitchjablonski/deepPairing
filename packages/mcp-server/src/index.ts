import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { McpDependencies, ArtifactStoreInterface, PlanReviewCallback } from "./types.js";
import { createPresentFindingsTool } from "./tools/present-findings.js";
import { createPresentOptionsTool } from "./tools/present-options.js";
import { createPresentPlanTool } from "./tools/present-plan.js";
import { createLogReasoningTool } from "./tools/log-reasoning.js";
import { createCheckFeedbackTool } from "./tools/check-feedback.js";

export type { McpDependencies, ArtifactStoreInterface, DecisionManagerInterface, PlanReviewCallback, PlanReviewResult } from "./types.js";

/**
 * Wraps an ArtifactStoreInterface with a bound sessionId.
 * MCP tools call the wrapper without knowing about sessionId —
 * the wrapper passes it through internally.
 */
export interface SessionBoundStore {
  createArtifact(params: {
    type: Parameters<ArtifactStoreInterface["createArtifact"]>[1]["type"];
    title: string;
    content: Record<string, unknown>;
    agentReasoning?: string;
  }): ReturnType<ArtifactStoreInterface["createArtifact"]>;
  addComment(params: {
    artifactId: string;
    content: string;
    author: "human" | "agent";
  }): ReturnType<ArtifactStoreInterface["addComment"]>;
  getUnacknowledgedComments(): ReturnType<ArtifactStoreInterface["getUnacknowledgedComments"]>;
  acknowledgeComments(ids: string[]): ReturnType<ArtifactStoreInterface["acknowledgeComments"]>;
  getArtifactsBySession(): ReturnType<ArtifactStoreInterface["getArtifactsBySession"]>;
}

export function bindStoreToSession(
  store: ArtifactStoreInterface,
  sessionId: string,
): SessionBoundStore {
  return {
    createArtifact: (params) => store.createArtifact(sessionId, params),
    addComment: (params) => store.addComment(sessionId, params),
    getUnacknowledgedComments: () => store.getUnacknowledgedComments(sessionId),
    acknowledgeComments: (ids) => store.acknowledgeComments(ids),
    getArtifactsBySession: () => store.getArtifactsBySession(sessionId),
  };
}

/**
 * Creates an in-process MCP server with deepPairing's collaboration tools.
 * Returns a config object that can be passed directly to the Agent SDK's
 * `mcpServers` option.
 */
export function createDeepPairingMcpServer(
  deps: McpDependencies,
  onPlanReview: PlanReviewCallback,
) {
  // Bind the artifact store to this session so MCP tools don't need sessionId
  const boundStore = bindStoreToSession(deps.artifactStore, deps.sessionId);

  const tools = [
    createPresentFindingsTool(boundStore),
    createPresentOptionsTool(boundStore, deps.decisionManager),
    createPresentPlanTool(boundStore, onPlanReview),
    createLogReasoningTool(boundStore),
    createCheckFeedbackTool(boundStore),
  ];

  // Cast needed: SDK expects Zod 4 types but we use Zod 3
  return createSdkMcpServer({ tools } as any);
}
