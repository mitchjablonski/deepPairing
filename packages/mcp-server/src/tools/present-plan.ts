import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ArtifactStoreInterface, PlanReviewCallback } from "../types.js";

export function createPresentPlanTool(
  artifactStore: ArtifactStoreInterface,
  onPlanReview: PlanReviewCallback,
) {
  return tool(
    "deepPairing_present_plan",
    "Present a structured implementation plan before making multi-file changes. The human will review each step and can approve, request revisions, or reject. This tool BLOCKS until the human responds.",
    {
      title: z.string().describe("Plan title"),
      steps: z.array(
        z.object({
          description: z.string().describe("What this step does"),
          files: z.array(z.string()).describe("Files that will be changed"),
          reasoning: z.string().describe("Why this step is needed"),
        }),
      ).describe("Ordered list of implementation steps"),
      estimatedChanges: z.number().describe("Estimated number of file changes"),
    },
    async (args) => {
      const artifact = await artifactStore.createArtifact({
        type: "plan",
        title: args.title,
        content: {
          steps: args.steps,
          estimatedChanges: args.estimatedChanges,
        },
        agentReasoning: `Plan with ${args.steps.length} steps, ~${args.estimatedChanges} file changes`,
      });

      // Block until human reviews the plan
      const result = await onPlanReview(artifact.id);

      if (result.verdict === "rejected") {
        await artifactStore.addComment({
          artifactId: artifact.id,
          content: result.feedback ?? "Plan rejected",
          author: "human",
        });

        return {
          content: [{
            type: "text" as const,
            text: `Plan REJECTED by human.${result.feedback ? `\nFeedback: ${result.feedback}` : ""}\n\nDo NOT proceed with this plan. Consider a different approach based on the feedback.`,
          }],
        };
      }

      if (result.verdict === "revised") {
        await artifactStore.addComment({
          artifactId: artifact.id,
          content: result.feedback ?? "Revisions requested",
          author: "human",
        });

        return {
          content: [{
            type: "text" as const,
            text: `Plan needs REVISIONS.\nFeedback: ${result.feedback ?? "See comments"}\n\nUpdate your plan based on the feedback and present it again with deepPairing_present_plan.`,
          }],
        };
      }

      // Approved
      return {
        content: [{
          type: "text" as const,
          text: `Plan APPROVED by human. Proceed with implementation.\n${result.feedback ? `Additional notes: ${result.feedback}` : ""}`,
        }],
      };
    },
  );
}
