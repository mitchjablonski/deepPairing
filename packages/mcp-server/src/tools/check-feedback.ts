import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ArtifactStoreInterface } from "../types.js";

export function createCheckFeedbackTool(artifactStore: ArtifactStoreInterface) {
  return tool(
    "deepPairing_check_feedback",
    "Check for any new human comments or feedback. Call this periodically (every 3-5 tool calls) to pick up human input. The human may be commenting on your findings, plans, or code changes in real-time.",
    {
      artifactId: z.string().optional().describe("Check feedback for a specific artifact, or omit for all"),
    },
    async (args) => {
      const comments = await artifactStore.getUnacknowledgedComments();

      if (comments.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: "No new human feedback. Continue with your current approach.",
          }],
        };
      }

      // Acknowledge all returned comments
      await artifactStore.acknowledgeComments(comments.map((c) => c.id));

      const formatted = comments.map((c) => {
        const target = c.target;
        let location = "";
        if (target.lineNumber != null) location = ` (line ${target.lineNumber})`;
        if (target.findingIndex != null) location = ` (finding #${target.findingIndex + 1})`;
        if (target.stepIndex != null) location = ` (step #${target.stepIndex + 1})`;
        return `- [${target.artifactId}${location}] ${c.content}`;
      }).join("\n");

      return {
        content: [{
          type: "text" as const,
          text: `Human feedback (${comments.length} comment${comments.length > 1 ? "s" : ""}):\n${formatted}\n\nConsider this feedback in your next actions. If the feedback changes your approach, explain how.`,
        }],
      };
    },
  );
}
