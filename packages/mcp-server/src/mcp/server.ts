import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { nanoid } from "nanoid";
import type { IStore, RejectedApproach } from "../store/store-interface.js";
import { formatSessionMarkdown } from "../export/format-markdown.js";

/**
 * Check a set of proposal strings against previously rejected approaches.
 * Returns the first match found, or null if none. Matching is case-insensitive
 * substring in either direction — if the rejected approach's description
 * contains a proposal phrase, or vice versa, that's a match.
 */
function findRejectedApproachMatch(
  proposalStrings: string[],
  rejected: RejectedApproach[],
): { proposal: string; rejected: RejectedApproach } | null {
  const clean = (s: string) => s.trim().toLowerCase();
  for (const rej of rejected) {
    const rejNormalized = clean(rej.description);
    if (!rejNormalized) continue;
    // Split the rejected description on `:` so "Deploy: Railway" matches
    // "Railway" proposals cleanly without requiring the whole context.
    const rejParts = rejNormalized.split(":").map((p) => p.trim()).filter(Boolean);
    for (const proposal of proposalStrings) {
      const p = clean(proposal);
      if (!p) continue;
      // Direct substring in either direction
      if (rejNormalized.includes(p) || p.includes(rejNormalized)) {
        return { proposal, rejected: rej };
      }
      // Match on any colon-delimited fragment of the rejection
      for (const part of rejParts) {
        if (part.length < 3) continue; // Skip noise tokens
        if (p.includes(part)) return { proposal, rejected: rej };
      }
    }
  }
  return null;
}

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
        description:
          "REQUIRED before every Edit or Write. Log what you're about to do and why. " +
          "\n\nPAIRING IMPERATIVE: whenever a real engineering concept or pattern is at play, NAME IT via `concept` (e.g. 'dependency inversion', 'optimistic UI', 'debounce vs throttle'). " +
          "Name the concept even when it feels obvious — the human is learning FROM you, and surfacing the pattern name turns every action into a teaching moment. " +
          "Include `evidence` pointing at the files/lines that motivated this step when the reasoning came from the codebase. " +
          "Use `alternativeDetails` for structured rejected alternatives with reasons. " +
          "The human sees this in the companion UI.",
        inputSchema: {
          type: "object" as const,
          properties: {
            action: { type: "string", description: "What you're about to do, in plain English" },
            reasoning: { type: "string", description: "Why this approach" },
            concept: {
              type: "object",
              description:
                "The named concept or pattern this reasoning applies. Name the concept whenever one applies — this is how the human learns.",
              properties: {
                name: { type: "string", description: "Concept name (e.g. 'dependency inversion', 'optimistic UI')" },
                oneLineExplanation: {
                  type: "string",
                  description: "One-sentence plain-English definition, for readers who may not know the concept",
                },
              },
              required: ["name"],
            },
            evidence: {
              type: "array",
              description: "Files / line ranges that motivated this reasoning step",
              items: {
                type: "object",
                properties: {
                  filePath: { type: "string" },
                  lineStart: { type: "number" },
                  lineEnd: { type: "number" },
                  snippet: { type: "string" },
                  explanation: { type: "string" },
                },
              },
            },
            relatesTo: {
              type: "object",
              description: "Back-link to another artifact this reasoning elaborates, answers, or supersedes",
              properties: {
                artifactId: { type: "string" },
                kind: { type: "string", enum: ["elaborates", "answers", "supersedes"] },
              },
              required: ["artifactId", "kind"],
            },
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
        description: "Export the current session as markdown. Formats: 'pr-description' (concise for PR bodies), 'adr' (architecture decision record), 'full' (complete session with code), 'replay' (chronological walkthrough with annotations — useful for re-reading and learning).",
        inputSchema: {
          type: "object" as const,
          properties: {
            format: { type: "string", enum: ["pr-description", "adr", "full", "replay"], description: "Export format" },
          },
        },
      },
      {
        name: "deepPairing_answer_question",
        description:
          "Reply to a question comment the human asked about an artifact. The human asked via the companion UI's 'Ask why' affordance; check_feedback surfaces these with a ❓QUESTION prefix and the commentId. Answering via this tool (rather than a plain reply) links your answer back to the question so the UI can collapse it under the original ask, and marks the question resolved.\n\nTreat this as a teaching moment — include evidence when the answer points at real code.",
        inputSchema: {
          type: "object" as const,
          properties: {
            commentId: { type: "string", description: "The id of the question comment to answer (cmt_...)" },
            answer: { type: "string", description: "Your explanation, in markdown" },
            evidence: {
              type: "array",
              description: "Optional code snippets supporting the answer",
              items: {
                type: "object",
                properties: {
                  filePath: { type: "string" },
                  lineStart: { type: "number" },
                  lineEnd: { type: "number" },
                  snippet: { type: "string" },
                  explanation: { type: "string" },
                },
              },
            },
          },
          required: ["commentId", "answer"],
        },
      },
      {
        name: "deepPairing_retract_artifact",
        description:
          "Gracefully back out an artifact you just presented. Use this when you realize mid-flight you shouldn't have presented something (e.g. you proposed a rejected approach, you noticed an error, or context changed). Marks the artifact as retracted with your reason so the human sees why. Continue your workflow; do NOT stop to ask in the terminal.",
        inputSchema: {
          type: "object" as const,
          properties: {
            artifactId: { type: "string", description: "The id returned when the artifact was presented (e.g. 'art_abc123')." },
            reason: { type: "string", description: "Short explanation of why you're retracting — shown to the human." },
          },
          required: ["artifactId", "reason"],
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
  let sessionNamed = false;
  let checkFeedbackPollCount = 0;

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs ?? {}) as Record<string, any>;

    // First tool call hint — also deliver session memory HERE (not inside
    // check_feedback) so the agent knows rejected approaches / approved
    // patterns BEFORE it tries to present anything. Prevents the "WAITING +
    // warning" ambiguity where the agent couldn't tell whether to keep polling
    // or retract a proposal.
    let firstCallHint = "";
    if (firstToolCall) {
      firstToolCall = false;
      const hintParts: string[] = [
        `[First use this session] The companion UI is at http://localhost:${port} — the human can review artifacts, comment, and make decisions there.`,
      ];
      const memory = await store.getSessionMemory();
      const memoryParts: string[] = [];
      if (memory.rejectedApproaches.length > 0) {
        memoryParts.push(
          `Rejected approaches (NEVER propose these — present_* tools will refuse):\n${memory.rejectedApproaches
            .map((a) => `  - ${a.description}${a.reason ? ` — reason: ${a.reason}` : ""}`)
            .join("\n")}`,
        );
      }
      if (memory.approvedPatterns.length > 0) {
        memoryParts.push(
          `Approved patterns (prefer these):\n${memory.approvedPatterns.map((a) => `  - ${a}`).join("\n")}`,
        );
      }
      if (memoryParts.length > 0) {
        hintParts.push(`\n📋 From previous sessions:\n${memoryParts.join("\n")}`);
      }
      firstCallHint = `\n${hintParts.join("\n")}`;
    }

    /**
     * Try to elicit a quick response from the user via MCP elicitation.
     * Falls back gracefully if the client doesn't support it.
     * Returns "approve" | "review" | "reject" | null (not supported).
     */
    /**
     * Try to elicit a quick response from the user via MCP elicitation.
     * Accept = approve, Decline = open companion UI for review.
     * Falls back gracefully if the client doesn't support it.
     */
    const tryElicit = async (message: string): Promise<"approve" | "review" | null> => {
      try {
        const result = await server.elicitInput({
          message,
          requestedSchema: {
            type: "object" as const,
            properties: {},
          },
        });
        // Accept = approve the artifact, Decline = review in companion UI
        if (result.action === "accept") return "approve";
        if (result.action === "decline" || result.action === "cancel") return "review";
      } catch {
        // Client doesn't support elicitation — fall back to polling
      }
      return null;
    };

    /**
     * Pre-flight: refuse to record an artifact whose content matches an
     * approach the human previously rejected. Returns a tool error response
     * if a match is found, or null if the tool should proceed.
     */
    const preflightRejectedApproaches = async (
      toolName: string,
      proposalStrings: string[],
    ): Promise<{ content: Array<{ type: "text"; text: string }>; isError: true } | null> => {
      const memory = await store.getSessionMemory();
      if (memory.rejectedApproaches.length === 0) return null;
      const match = findRejectedApproachMatch(proposalStrings, memory.rejectedApproaches);
      if (!match) return null;
      const reasonLine = match.rejected.reason
        ? `\nPrior rejection reason: "${match.rejected.reason}"`
        : "";
      const message =
        `REJECTED_APPROACH_BLOCKED: ${toolName} refused — your proposal contains "${match.proposal}" ` +
        `which the user previously rejected ("${match.rejected.description}").${reasonLine}\n\n` +
        `Do NOT retry with this approach. Revise your proposal to exclude it, or — if you believe ` +
        `conditions have changed — present_findings first to make the case for reconsidering, then ` +
        `wait for the human's response via check_feedback. The artifact was NOT created.`;
      return {
        content: [{ type: "text", text: message }],
        isError: true as const,
      };
    };

    /** Auto-name the session from the first meaningful artifact title */
    const autoNameSession = async (title: string) => {
      if (sessionNamed || !title || title === "Research Findings" || title === "Reasoning") return;
      sessionNamed = true;
      // If the store supports renaming sessions (DaemonClient does)
      if ("renameSession" in store && typeof (store as any).renameSession === "function") {
        await (store as any).renameSession(title);
      }
    };

    const result = await (async () => { switch (name) {
      case "deepPairing_present_findings": {
        const findings: any[] = Array.isArray(args?.findings) ? args.findings : [];
        const proposals: string[] = [
          args?.title ?? "",
          args?.summary ?? "",
          ...findings.map((f) => f?.title ?? ""),
          ...findings.map((f) => f?.recommendation ?? ""),
        ].filter(Boolean);
        const blocked = await preflightRejectedApproaches("present_findings", proposals);
        if (blocked) return blocked;

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
        await autoNameSession(artifact.title);

        // Try elicitation for quick approval
        const elicitAction = await tryElicit(
          `Findings: "${artifact.title}"\n\n` +
          `Accept to approve these findings.\n` +
          `Decline to review in detail at http://localhost:${port}`
        );
        if (elicitAction === "approve") {
          await store.updateArtifactStatus(id, "approved");
          return {
            content: [{ type: "text", text: `Findings recorded and approved (${id}).${await getPassiveFeedback()}` }],
          };
        }

        return {
          content: [{ type: "text", text: `Findings recorded (${id}). Human can review at localhost:${port}. Call deepPairing_check_feedback for their response.${await getPassiveFeedback()}` }],
        };
      }

      case "deepPairing_present_options": {
        const proposedOptions: any[] = Array.isArray(args?.options) ? args.options : [];
        const proposals: string[] = [
          args?.context ?? "",
          ...proposedOptions.map((o) => o?.title ?? ""),
          ...proposedOptions.map((o) => o?.description ?? ""),
        ].filter(Boolean);
        const blocked = await preflightRejectedApproaches("present_options", proposals);
        if (blocked) return blocked;

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

        // Try elicitation for quick selection
        const options = args?.options ?? [];
        // Decisions with multiple options are best reviewed in the companion UI
        // Skip elicitation — the option comparison UI is much richer than a terminal form

        return {
          content: [{ type: "text", text: `Decision "${args?.context}" presented to human (${decisionId}). They can select at localhost:${port}. Call deepPairing_check_feedback for their choice.${await getPassiveFeedback()}` }],
        };
      }

      case "deepPairing_present_plan": {
        const planSteps: any[] = Array.isArray(args?.steps) ? args.steps : [];
        const proposals: string[] = [
          args?.title ?? "",
          ...planSteps.map((s) => s?.description ?? ""),
          ...planSteps.map((s) => s?.reasoning ?? ""),
          ...planSteps.flatMap((s) =>
            Array.isArray(s?.files) ? s.files.map((f: any) => String(f)) : [],
          ),
        ].filter(Boolean);
        const blocked = await preflightRejectedApproaches("present_plan", proposals);
        if (blocked) return blocked;

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

        // Try elicitation for quick approval
        const elicitAction = await tryElicit(
          `Plan: "${args?.title}" (${args?.steps?.length ?? 0} steps)\n\n` +
          `Accept to approve this plan.\n` +
          `Decline to review steps in detail at http://localhost:${port}`
        );
        if (elicitAction === "approve") {
          await store.updateArtifactStatus(id, "approved");
          await store.resolvePlanReview(id, "approved");
          return {
            content: [{ type: "text", text: `Plan "${args?.title}" approved (${id}). Proceed with implementation.${await getPassiveFeedback()}` }],
          };
        }

        return {
          content: [{ type: "text", text: `Plan "${args?.title}" presented for review (${id}). Human can approve/revise/reject at localhost:${port}. Call deepPairing_check_feedback for their verdict.${await getPassiveFeedback()}` }],
        };
      }

      case "deepPairing_log_reasoning": {
        const id = `art_${nanoid(10)}`;
        const relatedIds = args?.relatesTo?.artifactId ? [args.relatesTo.artifactId] : undefined;
        const artifact = await store.createArtifact({
          id,
          type: "reasoning",
          title: args?.action ?? "Reasoning",
          content: {
            action: args?.action,
            reasoning: args?.reasoning,
            concept: args?.concept,
            evidence: args?.evidence,
            relatesTo: args?.relatesTo,
            alternativesConsidered: args?.alternativesConsidered ?? [],
            alternativeDetails: args?.alternativeDetails,
            confidence: args?.confidence,
          },
          agentReasoning: args?.reasoning,
          relatedArtifactIds: relatedIds,
        });
        broadcast({ type: "artifact_created", artifact });
        // Gentle nudge when the agent omits `concept` — the pairing value
        // hinges on the concept being surfaced, not the reasoning prose.
        const nudge = args?.concept?.name
          ? ""
          : "\n(Pairing nudge: name the underlying concept via `concept` so the human learns the pattern, not just the fix.)";
        return {
          content: [{ type: "text", text: `Reasoning logged. Proceed with code changes.${nudge}${await getPassiveFeedback()}` }],
        };
      }

      case "deepPairing_present_code_change": {
        const proposals: string[] = [
          args?.filePath ?? "",
          args?.reasoning ?? "",
        ].filter(Boolean);
        const blocked = await preflightRejectedApproaches("present_code_change", proposals);
        if (blocked) return blocked;

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

        // Artifact-specific comments — split questions (unanswered) out first
        // since they carry a response obligation the agent can honor with
        // answer_question. Regular comments / suggestions follow.
        const artifactCommentsSorted = artifactComments.slice().sort((a, b) => {
          const aIsQ = (a as any).intent === "question" && !(a as any).answeredByCommentId ? 0 : 1;
          const bIsQ = (b as any).intent === "question" && !(b as any).answeredByCommentId ? 0 : 1;
          return aIsQ - bIsQ;
        });
        if (artifactCommentsSorted.length > 0) {
          await store.acknowledgeComments(artifactCommentsSorted.map((c) => c.id));
          const questionLines: string[] = [];
          const otherLines: string[] = [];
          for (const c of artifactCommentsSorted) {
            let loc = c.target.artifactId;
            if ((c.target as any).lineStart) loc += `:${(c.target as any).lineStart}`;
            if ((c.target as any).findingIndex != null) loc += ` (finding #${(c.target as any).findingIndex + 1})`;

            if ((c as any).intent === "question" && !(c as any).answeredByCommentId) {
              questionLines.push(
                `- ❓ QUESTION [${loc}] ${c.content}\n    → Answer via deepPairing_answer_question with commentId="${c.id}"`,
              );
              continue;
            }
            if ((c.target as any).suggestion) {
              const filePath = (c.target as any).filePath ?? "unknown";
              const line = (c.target as any).lineStart ?? "?";
              otherLines.push(`- [SUGGESTION for ${filePath}:${line}] Replace with:\n    ${(c.target as any).suggestion}`);
              continue;
            }
            otherLines.push(`- [${loc}] ${c.content}`);
          }
          if (questionLines.length > 0) {
            parts.push(`Human questions (${questionLines.length}) — answer these before proceeding:\n${questionLines.join("\n")}`);
          }
          if (otherLines.length > 0) {
            parts.push(`Human comments (${otherLines.length}):\n${otherLines.join("\n")}`);
          }
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
                await store.recordRejectedApproach(
                  `${d.context}: ${rej.title}`,
                  d.response?.reasoning,
                  d.artifactId,
                );
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

        // Session memory is delivered once on the very first tool call (see
        // firstCallHint above). Intentionally NOT repeated here — mixing
        // WAITING signals with past-violation warnings creates contradictory
        // imperatives ("keep polling" vs "fix the violation now"). Pre-flight
        // validation in present_* tools is the enforcement point.

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

      case "deepPairing_answer_question": {
        const commentId = String(args?.commentId ?? "").trim();
        const answer = String(args?.answer ?? "").trim();
        if (!commentId || !answer) {
          return {
            content: [{ type: "text", text: "answer_question requires commentId and answer." }],
            isError: true,
          };
        }

        // Some stores may not yet implement getComment / markCommentAnswered
        // (e.g., a future fake). Guard so the tool still works with a plain
        // IStore.
        let parent: any = undefined;
        if (typeof (store as any).getComment === "function") {
          parent = await (store as any).getComment(commentId);
        }
        if (!parent) {
          return {
            content: [{ type: "text", text: `answer_question: no comment with id ${commentId}.` }],
            isError: true,
          };
        }

        const answerId = `cmt_${nanoid(10)}`;
        const codeRefs = Array.isArray(args?.evidence)
          ? args.evidence
              .filter((e: any) => e && typeof e === "object")
              .map((e: any) => ({
                filePath: String(e.filePath ?? ""),
                lineStart: Number(e.lineStart ?? 1),
                lineEnd: Number(e.lineEnd ?? e.lineStart ?? 1),
                snippet: e.snippet ? String(e.snippet) : undefined,
              }))
              .filter((e: any) => e.filePath)
          : undefined;

        const answerComment = await store.addComment({
          id: answerId,
          artifactId: parent.target?.artifactId ?? "__session__",
          content: answer,
          author: "agent",
          target: parent.target ?? { artifactId: "__session__" },
          parentCommentId: commentId,
        } as any);

        // Attach code references if the agent supplied evidence
        if (codeRefs && codeRefs.length > 0) {
          (answerComment as any).codeReferences = codeRefs;
        }

        if (typeof (store as any).markCommentAnswered === "function") {
          await (store as any).markCommentAnswered(commentId, answerId);
        }

        broadcast({ type: "comment_added", comment: answerComment });
        return {
          content: [{ type: "text", text: `Answered ${commentId}. The human will see the reply under their question.${await getPassiveFeedback()}` }],
        };
      }

      case "deepPairing_retract_artifact": {
        const artifactId = String(args?.artifactId ?? "").trim();
        const reason = String(args?.reason ?? "").trim();
        if (!artifactId) {
          return {
            content: [{ type: "text", text: "retract_artifact requires artifactId." }],
            isError: true,
          };
        }
        if (!reason) {
          return {
            content: [{ type: "text", text: "retract_artifact requires a reason — the human sees why you're backing out." }],
            isError: true,
          };
        }
        const artifacts = await store.getArtifacts();
        const artifact = artifacts.find((a) => a.id === artifactId);
        if (!artifact) {
          return {
            content: [{ type: "text", text: `retract_artifact: no artifact with id ${artifactId}.` }],
            isError: true,
          };
        }
        if (artifact.status !== "draft" && artifact.status !== "reviewing") {
          return {
            content: [{ type: "text", text: `retract_artifact: ${artifactId} is ${artifact.status}, too late to retract. Use check_feedback instead.` }],
            isError: true,
          };
        }
        await store.updateArtifactStatus(artifactId, "retracted");
        await store.addComment({
          id: `cmt_${nanoid(10)}`,
          artifactId,
          content: `Retracted: ${reason}`,
          author: "agent",
        });
        broadcast({ type: "artifact_updated", artifactId, status: "retracted" });
        return {
          content: [{ type: "text", text: `Retracted ${artifactId}. Continue your workflow — call check_feedback or present a revised artifact.${await getPassiveFeedback()}` }],
        };
      }

      case "deepPairing_export_session": {
        const format = (args?.format ?? "full") as "full" | "pr-description" | "adr" | "replay";
        const state = await store.getFullState();
        // Include learner annotations when exporting as replay.
        const enriched =
          format === "replay" && typeof (store as any).getAnnotations === "function"
            ? { ...state, annotations: await (store as any).getAnnotations() }
            : state;
        const markdown = formatSessionMarkdown(enriched, format);
        return {
          content: [{ type: "text", text: markdown }],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    } })();

    // Append firstCallHint to the outgoing text content of any tool result so
    // the agent receives session memory (rejected approaches) on its very
    // first tool call regardless of which tool it was.
    if (firstCallHint && result?.content && Array.isArray(result.content)) {
      const first = result.content[0] as any;
      if (first?.type === "text" && typeof first.text === "string") {
        first.text = `${first.text}${firstCallHint}`;
      }
    }
    return result;
  });

  return {
    server,
    async start() {
      const transport = new StdioServerTransport();
      await server.connect(transport);
    },
  };
}
