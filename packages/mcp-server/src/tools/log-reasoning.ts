import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { SessionBoundStore } from "../index.js";

export function createLogReasoningTool(artifactStore: SessionBoundStore) {
  return tool(
    "deepPairing_log_reasoning",
    "Log your reasoning before making any code change (Edit/Write). This is REQUIRED — edits without logged reasoning will be blocked. Explain what you're about to do and why.",
    {
      action: z.string().describe("What you're about to do"),
      reasoning: z.string().describe("Why this approach was chosen"),
      alternativesConsidered: z.array(z.string()).optional().describe("Other approaches you considered"),
      confidence: z.enum(["low", "medium", "high"]).describe("How confident you are in this approach"),
    },
    async (args) => {
      await artifactStore.createArtifact({
        type: "reasoning",
        title: args.action,
        content: {
          action: args.action,
          reasoning: args.reasoning,
          alternativesConsidered: args.alternativesConsidered ?? [],
          confidence: args.confidence,
        },
        agentReasoning: args.reasoning,
      });

      // Return any pending human feedback
      const comments = await artifactStore.getUnacknowledgedComments();
      const commentContext = comments.length > 0
        ? `\n\nHuman feedback to consider:\n${comments.map((c) => `- ${c.content}`).join("\n")}`
        : "";

      if (comments.length > 0) {
        await artifactStore.acknowledgeComments(comments.map((c) => c.id));
      }

      return {
        content: [{
          type: "text" as const,
          text: `Reasoning logged. You may now proceed with the code change.${commentContext}`,
        }],
      };
    },
  );
}
