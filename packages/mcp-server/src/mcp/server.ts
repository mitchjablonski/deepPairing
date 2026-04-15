import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { nanoid } from "nanoid";
import type { IStore } from "../store/store-interface.js";
import { formatSessionMarkdown } from "../export/format-markdown.js";

type BroadcastFn = (event: any) => void;

export function createMcpServer(store: IStore, broadcast: BroadcastFn, port = 3847) {
  const server = new Server(
    { name: "deeppairing", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // --- List Tools ---
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "deepPairing_present_findings",
        description: `USE THIS instead of presenting research as plain text. Present findings with rich evidence (code snippets, explanations) in the companion UI at localhost:${port}. This is NON-BLOCKING — call check_feedback after to get the human's response. Always include a descriptive title.`,
        inputSchema: {
          type: "object" as const,
          properties: {
            title: { type: "string", description: "Descriptive title for this research artifact (e.g., 'Authentication System Analysis', 'Database Performance Audit')" },
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
                  confidence: { type: "string", enum: ["low", "medium", "high"], description: "How confident are you in this finding?" },
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
        description: "USE THIS instead of listing options as plain text. Present 2-4 options with pros/cons/effort/risk for the human to choose in the companion UI. NON-BLOCKING — call check_feedback in a loop after to get their selection.",
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
        description: "USE THIS instead of describing plans as plain text. Present implementation steps with file changes and before/after previews. NON-BLOCKING — call check_feedback in a loop after for approval/revision/rejection.",
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
                  condition: { type: "string", description: "Condition for this step (e.g., 'if tests pass'). Makes this a conditional branch." },
                  branches: {
                    type: "array",
                    description: "Sub-steps that execute if the condition is met",
                    items: {
                      type: "object",
                      properties: {
                        description: { type: "string" },
                        files: { description: "Files affected" },
                        reasoning: { type: "string" },
                      },
                      required: ["description", "reasoning"],
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
        description: "REQUIRED before every Edit or Write. Log what you're about to do and why. Use alternativeDetails for structured rejected alternatives. The human sees this in the companion UI.",
        inputSchema: {
          type: "object" as const,
          properties: {
            action: { type: "string", description: "What you're about to do" },
            reasoning: { type: "string", description: "Why this approach" },
            alternativesConsidered: { type: "array", items: { type: "string" } },
            alternativeDetails: {
              type: "array",
              description: "Structured alternatives with rejection reasons",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  reason: { type: "string", description: "Why this alternative was rejected" },
                },
                required: ["title", "reason"],
              },
            },
            confidence: { type: "string", enum: ["low", "medium", "high"] },
          },
          required: ["action", "reasoning", "confidence"],
        },
      },
      {
        name: "deepPairing_check_feedback",
        description: "Poll for human feedback from the companion UI. The human responds in the browser, NOT the terminal. Call this in a loop after presenting artifacts — if it returns WAITING, call it again immediately. Do NOT stop polling to ask the user in the terminal.",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
      {
        name: "deepPairing_present_code_change",
        description: "USE THIS to present code changes with before/after diffs for human review in the companion UI. NON-BLOCKING — call check_feedback in a loop after to get approval. Include reasoning and confidence level.",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "File being changed" },
            changeType: { type: "string", enum: ["create", "modify", "delete"], description: "Type of change" },
            before: { type: "string", description: "Code before the change (empty for create)" },
            after: { type: "string", description: "Code after the change (empty for delete)" },
            reasoning: { type: "string", description: "Why this change is being made" },
            confidence: { type: "string", enum: ["low", "medium", "high"], description: "How confident are you in this change?" },
            relatedFindings: { type: "array", items: { type: "string" }, description: "Artifact IDs of findings that motivated this" },
          },
          required: ["filePath", "changeType", "after", "reasoning"],
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
  async function getPassiveFeedback(): Promise<string> {
    const comments = await store.getUnacknowledgedComments();
    if (comments.length === 0) return "";
    await store.acknowledgeComments(comments.map((c) => c.id));
    const formatted = comments.map((c) => `- ${c.content}`).join("\n");
    return `\n\n[Human feedback]: ${formatted}`;
  }

  // --- Call Tool ---
  let firstToolCall = true;
  let sessionMemoryDelivered = false;
  let checkFeedbackPollCount = 0;

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs ?? {}) as Record<string, any>;

    // First tool call hint
    let firstCallHint = "";
    if (firstToolCall) {
      firstToolCall = false;
      firstCallHint = `\n[First use this session] The companion UI is at http://localhost:${port} — the human can review artifacts, comment, and make decisions there.`;
    }

    switch (name) {
      case "deepPairing_present_findings": {
        const id = `art_${nanoid(10)}`;
        const artifact = await store.createArtifact({
          id,
          type: "research",
          title: args?.title ?? "Research Findings",
          content: {
            summary: args?.summary,
            findings: args?.findings,
            openQuestions: args?.openQuestions ?? [],
          },
        });
        broadcast({ type: "artifact_created", artifact });
        return {
          content: [{ type: "text", text: `Findings recorded (${id}). Human can review at localhost:${port}. Call deepPairing_check_feedback for their comments.${firstCallHint}${await getPassiveFeedback()}` }],
        };
      }

      case "deepPairing_present_options": {
        const id = `art_${nanoid(10)}`;
        const decisionId = `dec_${nanoid(10)}`;
        const artifact = await store.createArtifact({
          id,
          type: "decision",
          title: args?.context ?? "Decision",
          content: { context: args?.context, options: args?.options, decisionId },
          relatedArtifactIds: args?.relatedFindings,
        });
        await store.recordDecisionRequest({
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
          content: [{ type: "text", text: `Decision "${args?.context}" presented to human (${decisionId}). They can select an option at localhost:${port} or tell you directly. Call deepPairing_check_feedback to see if they've decided.${await getPassiveFeedback()}` }],
        };
      }

      case "deepPairing_present_plan": {
        const id = `art_${nanoid(10)}`;
        const artifact = await store.createArtifact({
          id,
          type: "plan",
          title: args?.title ?? "Implementation Plan",
          content: { steps: args?.steps, estimatedChanges: args?.estimatedChanges },
          relatedArtifactIds: args?.relatedFindings,
        });
        await store.recordPlanReview(id);
        broadcast({ type: "artifact_created", artifact });
        broadcast({ type: "plan_review_request", artifactId: id, title: args?.title });
        return {
          content: [{ type: "text", text: `Plan "${args?.title}" presented for review (${id}). Human can approve/revise/reject at localhost:${port}. Call deepPairing_check_feedback for their verdict.${await getPassiveFeedback()}` }],
        };
      }

      case "deepPairing_log_reasoning": {
        const id = `art_${nanoid(10)}`;
        const artifact = await store.createArtifact({
          id,
          type: "reasoning",
          title: args?.action ?? "Reasoning",
          content: {
            action: args?.action,
            reasoning: args?.reasoning,
            alternativesConsidered: args?.alternativesConsidered ?? [],
            alternativeDetails: args?.alternativeDetails,
            confidence: args?.confidence,
          },
          agentReasoning: args?.reasoning,
        });
        broadcast({ type: "artifact_created", artifact });
        return {
          content: [{ type: "text", text: `Reasoning logged. Proceed with code changes.${await getPassiveFeedback()}` }],
        };
      }

      case "deepPairing_present_code_change": {
        const id = `art_${nanoid(10)}`;
        const artifact = await store.createArtifact({
          id,
          type: "code_change",
          title: `${args?.changeType ?? "modify"} ${args?.filePath ?? "file"}`,
          content: {
            filePath: args?.filePath,
            changeType: args?.changeType ?? "modify",
            before: args?.before ?? "",
            after: args?.after ?? "",
            reasoning: args?.reasoning,
            confidence: args?.confidence,
          },
          agentReasoning: args?.reasoning,
          relatedArtifactIds: args?.relatedFindings,
        });
        broadcast({ type: "artifact_created", artifact });
        return {
          content: [{ type: "text", text: `Code change presented for review (${id}): ${args?.changeType} ${args?.filePath}. Human can review at localhost:${port}.${await getPassiveFeedback()}` }],
        };
      }

      case "deepPairing_check_feedback": {
        // If no immediate feedback exists, long-poll for up to 30 seconds
        const unackComments = await store.getUnacknowledgedComments();
        const resolvedDecs = await store.getResolvedDecisions();
        const hasImmediate = unackComments.length > 0 || resolvedDecs.length > 0;

        if (!hasImmediate) {
          // Check if there are draft artifacts — if so, wait for human action
          const allArts = await store.getArtifacts();
          const hasDrafts = allArts.some(
            (a) => a.status === "draft" && ["research", "plan", "decision", "code_change"].includes(a.type),
          );
          if (hasDrafts) {
            // Send progress heartbeats during the wait to keep the connection alive
            const progressToken = request.params._meta?.progressToken;
            let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
            if (progressToken != null) {
              let tick = 0;
              heartbeatTimer = setInterval(() => {
                tick++;
                server.notification({
                  method: "notifications/progress",
                  params: { progressToken, progress: tick, total: 3, message: "Waiting for human review..." },
                });
              }, 10000);
            }

            // Long-poll: wait up to 30s for feedback to arrive
            await store.waitForFeedback(30000);

            if (heartbeatTimer) clearInterval(heartbeatTimer);
          }
        }

        const parts: string[] = [];

        // Track consecutive empty polls for escalation
        const newComments = await store.getUnacknowledgedComments();
        const newResolved = await store.getResolvedDecisions();
        const hasNewFeedback = newComments.length > 0 || newResolved.length > 0;
        if (hasNewFeedback) {
          checkFeedbackPollCount = 0;
        } else {
          checkFeedbackPollCount++;
        }

        // --- Session status preamble ---
        const allArtifacts = await store.getArtifacts();
        const totalArtifacts = allArtifacts.length;
        const approvedCount = allArtifacts.filter((a) => a.status === "approved").length;
        const pendingCount = allArtifacts.filter((a) => a.status === "draft" && ["research", "plan", "decision"].includes(a.type)).length;
        const totalComments = (await store.getUnacknowledgedComments()).length;
        const autonomyLabel = await store.getAutonomyLevel();

        // Find oldest pending artifact age
        let oldestPendingAge = "";
        const pendingArts = allArtifacts.filter((a) => a.status === "draft" && ["research", "plan", "decision"].includes(a.type));
        if (pendingArts.length > 0) {
          const oldestMs = Date.now() - new Date(pendingArts[0].createdAt).getTime();
          const mins = Math.floor(oldestMs / 60000);
          const secs = Math.floor((oldestMs % 60000) / 1000);
          oldestPendingAge = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
        }

        // Determine suggested action
        let suggestedAction = "You may proceed with implementation.";
        if (pendingArts.some((a) => a.type === "decision")) {
          suggestedAction = "Wait for decision selection before proceeding.";
        } else if (pendingArts.some((a) => a.type === "plan")) {
          suggestedAction = "Wait for plan approval before implementing.";
        } else if (pendingArts.some((a) => a.type === "research")) {
          suggestedAction = "Wait for findings review before proposing solutions.";
        }

        parts.push(`Session: ${totalArtifacts} artifact${totalArtifacts !== 1 ? "s" : ""} (${approvedCount} approved, ${pendingCount} pending) | ${totalComments} new comment${totalComments !== 1 ? "s" : ""} | ${autonomyLabel} mode${oldestPendingAge ? `\nOldest pending: ${oldestPendingAge}` : ""}\nSuggested action: ${suggestedAction}`);

        // Unacknowledged comments
        const allComments = await store.getUnacknowledgedComments();
        const sessionMessages = allComments.filter((c) => c.target.artifactId === "__session__");
        const artifactComments = allComments.filter((c) => c.target.artifactId !== "__session__");

        // Session-level directives (free-form messages from human)
        if (sessionMessages.length > 0) {
          await store.acknowledgeComments(sessionMessages.map((c) => c.id));
          const formatted = sessionMessages.map((c) => `- ${c.content}`).join("\n");
          parts.push(`🎯 Human directive:\n${formatted}\n\nAdjust your approach based on this guidance.`);
        }

        // Artifact-specific comments
        const comments = artifactComments;
        if (comments.length > 0) {
          await store.acknowledgeComments(comments.map((c) => c.id));
          const formatted = comments.map((c) => {
            let loc = c.target.artifactId;
            if ((c.target as any).lineStart) loc += `:${(c.target as any).lineStart}`;
            if ((c.target as any).findingIndex != null) loc += ` (finding #${(c.target as any).findingIndex + 1})`;
            if ((c.target as any).suggestion) {
              const filePath = (c.target as any).filePath ?? "unknown";
              const line = (c.target as any).lineStart ?? "?";
              return `- [SUGGESTION for ${filePath}:${line}] Replace with:\n    ${(c.target as any).suggestion}`;
            }
            return `- [${loc}] ${c.content}`;
          }).join("\n");
          parts.push(`Human comments (${comments.length}):\n${formatted}`);
        }

        // Resolved decisions (acknowledge so they don't repeat)
        const resolved = await store.getResolvedDecisions();
        if (resolved.length > 0) {
          await store.acknowledgeDecisions(resolved.map((d) => d.decisionId));
          const formattedDecisions: string[] = [];
          for (const d of resolved) {
            const option = d.options.find((o: any) => o.id === d.response?.optionId);
            if (option) {
              await store.recordApprovedPattern(`${d.context}: ${option.title}`);
              const rejected = d.options.filter((o: any) => o.id !== d.response?.optionId);
              for (const rej of rejected) {
                await store.recordRejectedApproach(`${d.context}: ${rej.title}`);
              }
            }
            formattedDecisions.push(`- Decision "${d.context}": selected "${option?.title ?? d.response?.optionId}"${d.response?.reasoning ? ` (reasoning: ${d.response.reasoning})` : ""}`);
          }
          parts.push(`Decision selections:\n${formattedDecisions.join("\n")}`);
        }

        // Plan review verdicts
        const pendingPlans = await store.getPendingPlanReviews();
        const planArtifacts = (await store.getArtifacts()).filter((a) => a.type === "plan");
        const reviewedPlans: string[] = [];
        for (const a of planArtifacts) {
          const verdict = await store.getPlanReviewVerdict(a.id);
          if (!verdict) continue;
          reviewedPlans.push(`- Plan "${a.title}": ${verdict.verdict}${verdict.feedback ? ` (feedback: ${verdict.feedback})` : ""}`);
        }
        if (reviewedPlans.length > 0) {
          parts.push(`Plan reviews:\n${reviewedPlans.join("\n")}`);
        }

        // Check for draft artifacts still awaiting human review
        const draftArtifacts = (await store.getArtifacts()).filter(
          (a) => a.status === "draft" && ["research", "plan"].includes(a.type),
        );
        if (draftArtifacts.length > 0) {
          const waiting = draftArtifacts.map((a) => `"${a.title}" (${a.type})`).join(", ");
          parts.push(`⏳ WAITING: ${draftArtifacts.length} artifact(s) still under review: ${waiting}\nThe human is reviewing in the companion UI. Call deepPairing_check_feedback again to pick up their response.`);
        }

        const pendingDec = await store.getPendingDecisions();
        if (pendingDec.length > 0) {
          parts.push(`⏳ WAITING: ${pendingDec.length} decision(s) pending. The human will select in the companion UI. Call deepPairing_check_feedback again to pick up their choice.`);
        }
        if (pendingPlans.length > 0) {
          parts.push(`⏳ WAITING: ${pendingPlans.length} plan review(s) pending. The human will review in the companion UI. Call deepPairing_check_feedback again to pick up their verdict.`);
        }

        // Session memory — deliver once on first check_feedback
        if (!sessionMemoryDelivered) {
          sessionMemoryDelivered = true;
          const memory = await store.getSessionMemory();
          const memoryParts: string[] = [];
          if (memory.rejectedApproaches.length > 0) {
            memoryParts.push(`Rejected approaches (NEVER propose these again):\n${memory.rejectedApproaches.map((a) => `  - ${a}`).join("\n")}`);
          }
          if (memory.approvedPatterns.length > 0) {
            memoryParts.push(`Approved patterns (prefer these):\n${memory.approvedPatterns.map((a) => `  - ${a}`).join("\n")}`);
          }
          if (memoryParts.length > 0) {
            parts.push(`📋 From previous sessions:\n${memoryParts.join("\n")}`);
          }
        }

        // Always include autonomy preference
        const autonomy = await store.getAutonomyLevel();
        if (autonomy !== "supervised") {
          parts.push(`Human autonomy preference: ${autonomy}. ${
            autonomy === "balanced"
              ? "Skip findings for simple tasks. Present options only for genuine architectural choices."
              : "Proceed with recommended options. The human will review after. Only present decisions for high-risk or irreversible changes."
          }`);
        }

        // Engagement hint (only in balanced/autonomous mode, after some reviews)
        const metrics = await store.getEngagementMetrics();
        if (autonomy !== "supervised" && metrics.avgReviewLatencyMs > 0) {
          const avgSecs = Math.round(metrics.avgReviewLatencyMs / 1000);
          const hint = avgSecs < 30
            ? `Human reviewing quickly (avg ${avgSecs}s) — safe to present more artifacts without batching.`
            : avgSecs > 300
              ? `Human taking longer on reviews (avg ${Math.round(avgSecs / 60)}m) — consider batching related findings together.`
              : null;
          if (hint) {
            parts.push(`Engagement: ${hint}`);
          }
        }

        // Escalation hint after repeated empty polls
        if (checkFeedbackPollCount >= 3 && pendingCount > 0) {
          parts.push(`⚠️ No human response after ${checkFeedbackPollCount} checks (~${checkFeedbackPollCount * 30}s). The human may not have the companion UI open.\nMention in your response: "Please open http://localhost:${port} to review the artifacts." Then continue polling with check_feedback.`);
        }

        // If only the preamble exists (no feedback, no waits), give a clean proceed signal
        if (parts.length === 1) {
          return {
            content: [{ type: "text", text: parts[0] }],
          };
        }

        return {
          content: [{ type: "text", text: parts.join("\n\n") }],
        };
      }

      case "deepPairing_export_session": {
        const format = (args?.format ?? "full") as "full" | "pr-description" | "adr";
        const state = await store.getFullState();
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
