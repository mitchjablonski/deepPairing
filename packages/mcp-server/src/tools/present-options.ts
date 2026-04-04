import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { SessionBoundStore } from "../index.js";
import type { DecisionManagerInterface } from "../types.js";

export function createPresentOptionsTool(
  artifactStore: SessionBoundStore,
  decisionManager: DecisionManagerInterface,
) {
  return tool(
    "deepPairing_present_options",
    "Present 2-4 implementation options with tradeoffs for the human to choose from. MUST be called before making any architectural decision or choosing between approaches. This tool BLOCKS until the human makes a selection.",
    {
      context: z.string().describe("What decision needs to be made and why"),
      options: z.array(
        z.object({
          id: z.string().describe("Unique option identifier"),
          title: z.string().describe("Short title for this option"),
          description: z.string().describe("What this option involves"),
          pros: z.array(z.string()).describe("Advantages of this option"),
          cons: z.array(z.string()).describe("Disadvantages of this option"),
          effort: z.enum(["low", "medium", "high"]).describe("Implementation effort"),
          risk: z.enum(["low", "medium", "high"]).describe("Risk level"),
          recommendation: z.boolean().describe("Whether you recommend this option"),
        }),
      ).min(2).max(4).describe("The options to present"),
    },
    async (args) => {
      // Create the decision artifact
      const artifact = await artifactStore.createArtifact({
        type: "decision",
        title: args.context,
        content: {
          context: args.context,
          options: args.options,
        },
        agentReasoning: `Presenting ${args.options.length} options for: ${args.context}`,
      });

      // Block until human selects an option
      const optionIds = args.options.map((o) => o.id);
      const selection = await decisionManager.createPendingDecision(
        artifact.id,
        optionIds,
      );

      // Update artifact with selection
      await artifactStore.addComment({
        artifactId: artifact.id,
        content: `Selected: ${selection.optionId}${selection.reasoning ? ` — ${selection.reasoning}` : ""}`,
        author: "human",
      });

      const chosen = args.options.find((o) => o.id === selection.optionId);

      return {
        content: [{
          type: "text" as const,
          text: `Human selected: "${chosen?.title ?? selection.optionId}"${selection.reasoning ? `\nReasoning: ${selection.reasoning}` : ""}\n\nProceed with this approach. Do not re-propose rejected alternatives.`,
        }],
      };
    },
  );
}
