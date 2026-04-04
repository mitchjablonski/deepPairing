import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { McpDependencies, PlanReviewCallback } from "./types.js";
import { createPresentFindingsTool } from "./tools/present-findings.js";
import { createPresentOptionsTool } from "./tools/present-options.js";
import { createPresentPlanTool } from "./tools/present-plan.js";
import { createLogReasoningTool } from "./tools/log-reasoning.js";
import { createCheckFeedbackTool } from "./tools/check-feedback.js";

export type { McpDependencies, ArtifactStoreInterface, DecisionManagerInterface, PlanReviewCallback, PlanReviewResult } from "./types.js";

/**
 * Creates an in-process MCP server with deepPairing's collaboration tools.
 * Returns a config object that can be passed directly to the Agent SDK's
 * `mcpServers` option.
 */
export function createDeepPairingMcpServer(
  deps: McpDependencies,
  onPlanReview: PlanReviewCallback,
) {
  const tools = [
    createPresentFindingsTool(deps.artifactStore),
    createPresentOptionsTool(deps.artifactStore, deps.decisionManager),
    createPresentPlanTool(deps.artifactStore, onPlanReview),
    createLogReasoningTool(deps.artifactStore),
    createCheckFeedbackTool(deps.artifactStore),
  ];

  // Cast needed: SDK expects Zod 4 types but we use Zod 3
  return createSdkMcpServer({ tools } as any);
}
