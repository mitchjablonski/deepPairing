import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ArtifactStoreInterface } from "../types.js";

export function createPresentFindingsTool(artifactStore: ArtifactStoreInterface) {
  return tool(
    "deepPairing_present_findings",
    "Present your research findings in a structured format. Call this AFTER researching the codebase and BEFORE proposing any solutions. The human will see these findings and can comment on them.",
    {
      summary: z.string().describe("Brief summary of what you found"),
      findings: z.array(
        z.object({
          category: z.string().describe("Category (Security, Architecture, Performance, etc.)"),
          detail: z.string().describe("What you found"),
          evidence: z.string().describe("File path, line number, or other evidence"),
          significance: z.enum(["low", "medium", "high"]).describe("How important is this finding"),
        }),
      ).describe("List of findings from your research"),
      openQuestions: z.array(z.string()).optional().describe("Questions that need human input"),
    },
    async (args) => {
      const artifact = await artifactStore.createArtifact({
        type: "research",
        title: "Research Findings",
        content: {
          summary: args.summary,
          findings: args.findings,
          openQuestions: args.openQuestions ?? [],
        },
      });

      // Return any unacknowledged human comments as context
      const comments = await artifactStore.getUnacknowledgedComments();
      const commentContext = comments.length > 0
        ? `\n\nHuman feedback from earlier in this session:\n${comments.map((c) => `- ${c.content}`).join("\n")}`
        : "";

      if (comments.length > 0) {
        await artifactStore.acknowledgeComments(comments.map((c) => c.id));
      }

      return {
        content: [{
          type: "text" as const,
          text: `Findings presented to human (artifact: ${artifact.id}). They can now review and comment.${commentContext}`,
        }],
      };
    },
  );
}
