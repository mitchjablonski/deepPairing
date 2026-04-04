import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { SessionBoundStore } from "../index.js";
import type { PlanReviewCallback } from "../types.js";

const FileChangeInputSchema = z.object({
  filePath: z.string(),
  description: z.string().optional().describe("What changes in this file"),
  changeType: z.enum(["create", "modify", "delete"]).optional(),
});

export function createPresentPlanTool(
  artifactStore: SessionBoundStore,
  onPlanReview: PlanReviewCallback,
) {
  return tool(
    "deepPairing_present_plan",
    `Present a structured implementation plan before making multi-file changes. The human will review each step and can approve, request revisions, or reject. This tool BLOCKS until the human responds.

For each step, provide:
- Which findings motivated this step (motivatedBy)
- A before/after code preview when the change is non-trivial
- Structured file changes with descriptions, not just path strings`,
    {
      title: z.string().describe("Plan title"),
      steps: z.array(
        z.object({
          description: z.string().describe("What this step does"),
          files: z.union([
            z.array(z.string()),
            z.array(FileChangeInputSchema),
          ]).describe("Files that will be changed — prefer structured format with descriptions"),
          reasoning: z.string().describe("Why this step is needed"),
          motivatedBy: z.array(z.string()).optional().describe("Finding titles that motivated this step"),
          preview: z.object({
            before: z.string().describe("Current code"),
            after: z.string().describe("Proposed code after this step"),
            filePath: z.string(),
          }).optional().describe("Before/after code preview — include for non-trivial changes"),
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

      return {
        content: [{
          type: "text" as const,
          text: `Plan APPROVED by human. Proceed with implementation.\n${result.feedback ? `Additional notes: ${result.feedback}` : ""}`,
        }],
      };
    },
  );
}
