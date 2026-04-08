import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { nanoid } from "nanoid";
import type { FileStore } from "../store/file-store.js";
import { formatSessionMarkdown } from "../export/format-markdown.js";

type BroadcastFn = (event: any) => void;

export function createMcpServer(store: FileStore, broadcast: BroadcastFn) {
  const server = new Server(
    { name: "deeppairing", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // --- List Tools ---
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "deepPairing_present_findings",
        description: "Present research findings with rich evidence (code snippets, explanations). The human can review and comment in the companion UI at localhost:3847.",
        inputSchema: {
          type: "object" as const,
          properties: {
            summary: { type: "string", description: "Brief summary of findings" },
            findings: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  category: { type: "string" },
                  title: { type: "string" },
                  detail: { type: "string" },
                  evidence: { description: "Code snippets with explanations — use rich format" },
                  significance: { type: "string", enum: ["low", "medium", "high"] },
                  impact: { type: "string" },
                  recommendation: { type: "string" },
                },
                required: ["category", "detail", "significance"],
              },
            },
            openQuestions: { type: "array", items: { type: "string" } },
          },
          required: ["summary", "findings"],
        },
      },
      {
        name: "deepPairing_present_options",
        description: "Present 2-4 options for the human to choose from. NON-BLOCKING — records the options and returns immediately. Call check_feedback later to see if the human has decided.",
        inputSchema: {
          type: "object" as const,
          properties: {
            context: { type: "string", description: "What decision needs to be made" },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  title: { type: "string" },
                  description: { type: "string" },
                  pros: { type: "array", items: { type: "string" } },
                  cons: { type: "array", items: { type: "string" } },
                  effort: { type: "string", enum: ["low", "medium", "high"] },
                  risk: { type: "string", enum: ["low", "medium", "high"] },
                  recommendation: { type: "boolean" },
                },
                required: ["id", "title", "description", "pros", "cons", "effort", "risk", "recommendation"],
              },
              minItems: 2,
              maxItems: 4,
            },
          },
          required: ["context", "options"],
        },
      },
      {
        name: "deepPairing_present_plan",
        description: "Present an implementation plan for human review. NON-BLOCKING — records the plan and returns. Call check_feedback later for approval/revision/rejection.",
        inputSchema: {
          type: "object" as const,
          properties: {
            title: { type: "string" },
            steps: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  description: { type: "string" },
                  files: { description: "Files affected" },
                  reasoning: { type: "string" },
                  motivatedBy: { type: "array", items: { type: "string" } },
                  preview: {
                    type: "object",
                    properties: {
                      before: { type: "string" },
                      after: { type: "string" },
                      filePath: { type: "string" },
                    },
                  },
                },
                required: ["description", "reasoning"],
              },
            },
            estimatedChanges: { type: "number" },
          },
          required: ["title", "steps", "estimatedChanges"],
        },
      },
      {
        name: "deepPairing_log_reasoning",
        description: "Log your reasoning before making code changes. Required before Edit/Write.",
        inputSchema: {
          type: "object" as const,
          properties: {
            action: { type: "string", description: "What you're about to do" },
            reasoning: { type: "string", description: "Why this approach" },
            alternativesConsidered: { type: "array", items: { type: "string" } },
            confidence: { type: "string", enum: ["low", "medium", "high"] },
          },
          required: ["action", "reasoning", "confidence"],
        },
      },
      {
        name: "deepPairing_check_feedback",
        description: "Check for human feedback — comments, decision selections, and plan review verdicts. Call this periodically.",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
      {
        name: "deepPairing_export_session",
        description: "Export the current session as markdown. Formats: 'pr-description' (concise for PR bodies), 'adr' (architecture decision record), 'full' (complete session with code).",
        inputSchema: {
          type: "object" as const,
          properties: {
            format: { type: "string", enum: ["pr-description", "adr", "full"], description: "Export format" },
          },
        },
      },
    ],
  }));

  // --- Passive feedback helper ---
  function getPassiveFeedback(): string {
    const comments = store.getUnacknowledgedComments();
    if (comments.length === 0) return "";
    store.acknowledgeComments(comments.map((c) => c.id));
    const formatted = comments.map((c) => `- ${c.content}`).join("\n");
    return `\n\n[Human feedback]: ${formatted}`;
  }

  // --- Call Tool ---
  let firstToolCall = true;

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs ?? {}) as Record<string, any>;

    // First tool call hint
    let firstCallHint = "";
    if (firstToolCall) {
      firstToolCall = false;
      firstCallHint = "\n[First use this session] The companion UI is at http://localhost:3847 — the human can review artifacts, comment, and make decisions there.";
    }

    switch (name) {
      case "deepPairing_present_findings": {
        const id = `art_${nanoid(10)}`;
        const artifact = store.createArtifact({
          id,
          type: "research",
          title: "Research Findings",
          content: {
            summary: args?.summary,
            findings: args?.findings,
            openQuestions: args?.openQuestions ?? [],
          },
        });
        broadcast({ type: "artifact_created", artifact });
        return {
          content: [{ type: "text", text: `Findings recorded (${id}). Human can review at localhost:3847. Call deepPairing_check_feedback for their comments.${firstCallHint}${getPassiveFeedback()}` }],
        };
      }

      case "deepPairing_present_options": {
        const id = `art_${nanoid(10)}`;
        const decisionId = `dec_${nanoid(10)}`;
        const artifact = store.createArtifact({
          id,
          type: "decision",
          title: args?.context ?? "Decision",
          content: { context: args?.context, options: args?.options, decisionId },
          relatedArtifactIds: args?.relatedFindings,
        });
        store.recordDecisionRequest({
          decisionId,
          artifactId: id,
          context: args?.context,
          options: args?.options,
        });
        broadcast({ type: "artifact_created", artifact });
        broadcast({
          type: "decision_request",
          decisionId,
          artifactId: id,
          context: args?.context,
          options: args?.options,
        });
        return {
          content: [{ type: "text", text: `Decision "${args?.context}" presented to human (${decisionId}). They can select an option at localhost:3847 or tell you directly. Call deepPairing_check_feedback to see if they've decided.${getPassiveFeedback()}` }],
        };
      }

      case "deepPairing_present_plan": {
        const id = `art_${nanoid(10)}`;
        const artifact = store.createArtifact({
          id,
          type: "plan",
          title: args?.title ?? "Implementation Plan",
          content: { steps: args?.steps, estimatedChanges: args?.estimatedChanges },
          relatedArtifactIds: args?.relatedFindings,
        });
        store.recordPlanReview(id);
        broadcast({ type: "artifact_created", artifact });
        broadcast({ type: "plan_review_request", artifactId: id, title: args?.title });
        return {
          content: [{ type: "text", text: `Plan "${args?.title}" presented for review (${id}). Human can approve/revise/reject at localhost:3847. Call deepPairing_check_feedback for their verdict.${getPassiveFeedback()}` }],
        };
      }

      case "deepPairing_log_reasoning": {
        const id = `art_${nanoid(10)}`;
        const artifact = store.createArtifact({
          id,
          type: "reasoning",
          title: args?.action ?? "Reasoning",
          content: {
            action: args?.action,
            reasoning: args?.reasoning,
            alternativesConsidered: args?.alternativesConsidered ?? [],
            confidence: args?.confidence,
          },
          agentReasoning: args?.reasoning,
        });
        broadcast({ type: "artifact_created", artifact });
        return {
          content: [{ type: "text", text: `Reasoning logged. Proceed with code changes.${getPassiveFeedback()}` }],
        };
      }

      case "deepPairing_check_feedback": {
        // If no immediate feedback exists, long-poll for up to 30 seconds
        const hasImmediate = store.getUnacknowledgedComments().length > 0 ||
          store.getResolvedDecisions().length > 0;

        if (!hasImmediate) {
          // Check if there are draft artifacts — if so, wait for human action
          const hasDrafts = store.getArtifacts().some(
            (a) => a.status === "draft" && ["research", "plan", "decision"].includes(a.type),
          );
          if (hasDrafts) {
            // Long-poll: wait up to 30s for feedback to arrive
            await store.waitForFeedback(30000);
          }
        }

        const parts: string[] = [];

        // Unacknowledged comments
        const allComments = store.getUnacknowledgedComments();
        const sessionMessages = allComments.filter((c) => c.target.artifactId === "__session__");
        const artifactComments = allComments.filter((c) => c.target.artifactId !== "__session__");

        // Session-level directives (free-form messages from human)
        if (sessionMessages.length > 0) {
          store.acknowledgeComments(sessionMessages.map((c) => c.id));
          const formatted = sessionMessages.map((c) => `- ${c.content}`).join("\n");
          parts.push(`🎯 Human directive:\n${formatted}\n\nAdjust your approach based on this guidance.`);
        }

        // Artifact-specific comments
        const comments = artifactComments;
        if (comments.length > 0) {
          store.acknowledgeComments(comments.map((c) => c.id));
          const formatted = comments.map((c) => {
            let loc = c.target.artifactId;
            if ((c.target as any).lineStart) loc += `:${(c.target as any).lineStart}`;
            if ((c.target as any).findingIndex != null) loc += ` (finding #${(c.target as any).findingIndex + 1})`;
            return `- [${loc}] ${c.content}`;
          }).join("\n");
          parts.push(`Human comments (${comments.length}):\n${formatted}`);
        }

        // Resolved decisions (acknowledge so they don't repeat)
        const resolved = store.getResolvedDecisions();
        if (resolved.length > 0) {
          store.acknowledgeDecisions(resolved.map((d) => d.decisionId));
          const formatted = resolved.map((d) => {
            const option = d.options.find((o: any) => o.id === d.response?.optionId);
            return `- Decision "${d.context}": selected "${option?.title ?? d.response?.optionId}"${d.response?.reasoning ? ` (reasoning: ${d.response.reasoning})` : ""}`;
          }).join("\n");
          parts.push(`Decision selections:\n${formatted}`);
        }

        // Plan review verdicts
        const pendingPlans = store.getPendingPlanReviews();
        const reviewedPlans = Array.from(store.getArtifacts())
          .filter((a) => a.type === "plan")
          .map((a) => {
            const verdict = store.getPlanReviewVerdict(a.id);
            if (!verdict) return null;
            return `- Plan "${a.title}": ${verdict.verdict}${verdict.feedback ? ` (feedback: ${verdict.feedback})` : ""}`;
          })
          .filter(Boolean);
        if (reviewedPlans.length > 0) {
          parts.push(`Plan reviews:\n${reviewedPlans.join("\n")}`);
        }

        // Check for draft artifacts still awaiting human review
        const draftArtifacts = store.getArtifacts().filter(
          (a) => a.status === "draft" && ["research", "plan"].includes(a.type),
        );
        if (draftArtifacts.length > 0) {
          const waiting = draftArtifacts.map((a) => `"${a.title}" (${a.type})`).join(", ");
          parts.push(`⏳ WAITING: ${draftArtifacts.length} artifact(s) still under review: ${waiting}\nDo NOT proceed to the next phase until the human approves these. They may still be reviewing and adding comments.`);
        }

        const pendingDec = store.getPendingDecisions();
        if (pendingDec.length > 0) {
          parts.push(`⏳ WAITING: ${pendingDec.length} decision(s) pending. Wait for the human to select.`);
        }
        if (pendingPlans.length > 0) {
          parts.push(`⏳ WAITING: ${pendingPlans.length} plan review(s) pending. Wait for approval.`);
        }

        if (parts.length === 0) {
          return {
            content: [{ type: "text", text: "No pending feedback or reviews. All artifacts approved. You may proceed." }],
          };
        }

        return {
          content: [{ type: "text", text: parts.join("\n\n") + "\n\nIncorporate feedback and wait for pending reviews before proceeding." }],
        };
      }

      case "deepPairing_export_session": {
        const format = (args?.format ?? "full") as "full" | "pr-description" | "adr";
        const state = store.getFullState();
        const markdown = formatSessionMarkdown(state, format);
        return {
          content: [{ type: "text", text: markdown }],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  });

  return {
    server,
    async start() {
      const transport = new StdioServerTransport();
      await server.connect(transport);
    },
  };
}
