import type { ToolContext, ToolResult } from "./types.js";
import { PENDING_DRAFT_TYPES, WAITING_DRAFT_TYPES } from "./types.js";

/**
 * B3 — check_feedback, extracted from the server.ts switch (it was the last
 * big inline case, ~405 lines). Behavior is unchanged; two B3 additions:
 *
 *   - Comments are read through the TYPED Comment schema (intent,
 *     answeredByCommentId, target.lineStart/findingIndex/suggestion were being
 *     `(c as any)`-read even though the schema declares them).
 *   - Every return carries `structuredContent` mirroring the prose, so clients
 *     that support structured tool output (Claude Code does) can branch on
 *     `{status, suggestedAction, pendingArtifacts, questions, …}` instead of
 *     prose-parsing the status blob — the same fix the error path already got
 *     via `_meta` codes.
 */
export async function handleCheckFeedback(ctx: ToolContext, args: any): Promise<ToolResult> {
  const { store, server, broadcast, port } = ctx;

  // BB3 — `waitFor` scopes which feedback signal counts as "ready".
  // The agent can pin its poll to the artifact it just presented
  // (e.g. waitFor='decision' after present_options) so an unrelated
  // comment elsewhere doesn't wake the poll prematurely. Default
  // 'any' preserves the historical broad behavior.
  const waitForRaw = typeof args?.waitFor === "string" ? args.waitFor : "any";
  const waitForScope: "any" | "comments" | "decision" | "plan_review" | "artifact_status" =
    (["any", "comments", "decision", "plan_review", "artifact_status"] as const).includes(
      waitForRaw as any,
    )
      ? (waitForRaw as any)
      : "any";

  // If no immediate feedback exists, long-poll for up to 30 seconds
  const unackComments = await store.getUnacknowledgedComments();
  const resolvedDecs = await store.getResolvedDecisions();
  const allArtsForScope = await store.getArtifacts();
  const decidedPlans = allArtsForScope.filter(
    (a) => a.type === "plan" && (a.status === "approved" || a.status === "revised" || a.status === "rejected"),
  );
  const decidedAny = allArtsForScope.filter(
    (a) => a.status === "approved" || a.status === "revised" || a.status === "rejected",
  );

  const hasImmediateFor = (scope: typeof waitForScope): boolean => {
    switch (scope) {
      case "comments": return unackComments.length > 0;
      case "decision": return resolvedDecs.length > 0;
      case "plan_review": return decidedPlans.length > 0;
      case "artifact_status": return decidedAny.length > 0 || resolvedDecs.length > 0;
      case "any":
      default:
        return unackComments.length > 0 || resolvedDecs.length > 0;
    }
  };
  const hasImmediate = hasImmediateFor(waitForScope);

  if (!hasImmediate) {
    // Check if there are draft artifacts — if so, wait for human action
    const allArts = allArtsForScope;
    const hasDrafts = allArts.some(
      (a) => a.status === "draft" && (PENDING_DRAFT_TYPES as readonly string[]).includes(a.type),
    );
    if (hasDrafts) {
      // Send progress heartbeats during the wait to keep the connection alive
      const progressToken = ctx.progressToken;
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
    ctx.state.checkFeedbackPollCount = 0;
  } else {
    ctx.state.checkFeedbackPollCount++;
  }

  // CC5 — respect waitFor scope post-wake. BB3 added the entry-guard
  // branching but waitForFeedback still wakes on ANY feedback signal,
  // and the response below assembles ALL comments + decisions. So an
  // agent calling waitFor='decision' could be woken by an unrelated
  // comment, fall through, and get a response stuffed with comments
  // it explicitly said it wasn't waiting for. Re-check the scope with
  // the fresh post-wake data; if it's narrow and unsatisfied, return
  // a focused "still waiting" status instead of dumping out-of-scope
  // chatter at the agent.
  if (waitForScope !== "any") {
    const allArtsPostWake = await store.getArtifacts();
    const decidedPlansPostWake = allArtsPostWake.filter(
      (a) => a.type === "plan" && (a.status === "approved" || a.status === "revised" || a.status === "rejected"),
    );
    const decidedAnyPostWake = allArtsPostWake.filter(
      (a) => a.status === "approved" || a.status === "revised" || a.status === "rejected",
    );
    const scopeSatisfied = (() => {
      switch (waitForScope) {
        case "comments": return newComments.length > 0;
        case "decision": return newResolved.length > 0;
        case "plan_review": return decidedPlansPostWake.length > 0;
        case "artifact_status": return decidedAnyPostWake.length > 0 || newResolved.length > 0;
        default: return true;
      }
    })();
    if (!scopeSatisfied) {
      return {
        content: [{
          type: "text",
          text: `Still waiting on '${waitForScope}'. Nothing matching that scope arrived during the 30s poll. Call check_feedback again with the same waitFor (or with waitFor='any' to drain unrelated chatter).`,
        }],
        structuredContent: {
          status: "waiting",
          waitFor: waitForScope,
          suggestedAction: `Call check_feedback again with waitFor='${waitForScope}' (or 'any' to drain unrelated chatter).`,
          pendingArtifacts: [],
          questions: [],
          comments: [],
          decisions: [],
          rejected: [],
        },
      };
    }
  }

  // --- Session status preamble ---
  const allArtifacts = await store.getArtifacts();
  const totalArtifacts = allArtifacts.length;
  const approvedCount = allArtifacts.filter((a) => a.status === "approved").length;
  const pendingCount = allArtifacts.filter((a) => a.status === "draft" && (PENDING_DRAFT_TYPES as readonly string[]).includes(a.type)).length;
  const allComments = await store.getUnacknowledgedComments();
  const totalComments = allComments.length;
  const autonomyLabel = await store.getAutonomyLevel();

  // FN2 — artifacts the human REJECTED that check_feedback hasn't reported
  // yet. Without this, suggestedAction falls through to "you may proceed"
  // right after a human rejects a code_change/spec/research (only decisions
  // & plans had verdict reporting). Comment-independent (a feedback-less
  // reject still triggers it) and reported exactly once via the
  // reportedRejectedVerdicts set.
  const freshlyRejected = allArtifacts.filter(
    (a) =>
      a.status === "rejected" &&
      ["code_change", "spec", "research"].includes(a.type) &&
      !ctx.state.reportedRejectedVerdicts.has(a.id),
  );
  for (const a of freshlyRejected) ctx.state.reportedRejectedVerdicts.add(a.id);

  // Find oldest pending artifact age
  let oldestPendingAge = "";
  const pendingArts = allArtifacts.filter((a) => a.status === "draft" && (PENDING_DRAFT_TYPES as readonly string[]).includes(a.type));
  if (pendingArts.length > 0) {
    const oldestMs = Date.now() - new Date(pendingArts[0].createdAt).getTime();
    const mins = Math.floor(oldestMs / 60000);
    const secs = Math.floor((oldestMs % 60000) / 1000);
    oldestPendingAge = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  }

  // Determine suggested action
  let suggestedAction = "You may proceed with implementation.";
  if (freshlyRejected.length > 0) {
    suggestedAction = `Do NOT apply — the human REJECTED ${freshlyRejected.map((a) => `"${a.title}"`).join(", ")}. Revise the approach or propose an alternative.`;
  } else if (pendingArts.some((a) => a.type === "code_change")) {
    suggestedAction = "Wait for the code change review before applying the edit.";
  } else if (pendingArts.some((a) => a.type === "decision")) {
    suggestedAction = "Wait for decision selection before proceeding.";
  } else if (pendingArts.some((a) => a.type === "plan")) {
    suggestedAction = "Wait for plan approval before implementing.";
  } else if (pendingArts.some((a) => a.type === "spec")) {
    suggestedAction = "Wait for spec approval before planning implementation.";
  } else if (pendingArts.some((a) => a.type === "research")) {
    suggestedAction = "Wait for findings review before proposing solutions.";
  }

  parts.push(`Session: ${totalArtifacts} artifact${totalArtifacts !== 1 ? "s" : ""} (${approvedCount} approved, ${pendingCount} pending) | ${totalComments} new comment${totalComments !== 1 ? "s" : ""} | ${autonomyLabel} mode${oldestPendingAge ? `\nOldest pending: ${oldestPendingAge}` : ""}\nSuggested action: ${suggestedAction}`);

  // B3 — structured mirrors of the blocks below, populated as we format.
  const structuredQuestions: Array<Record<string, unknown>> = [];
  const structuredComments: Array<Record<string, unknown>> = [];
  const structuredDecisions: Array<Record<string, unknown>> = [];

  // Unacknowledged comments (reuse the single drain snapshot fetched above)
  const sessionMessages = allComments.filter((c) => c.target.artifactId === "__session__");
  const artifactComments = allComments.filter((c) => c.target.artifactId !== "__session__");

  // Session-level directives (free-form messages from human)
  if (sessionMessages.length > 0) {
    await store.acknowledgeComments(sessionMessages.map((c) => c.id));
    const formatted = sessionMessages.map((c) => `- ${c.content}`).join("\n");
    parts.push(`🎯 Human directive:\n${formatted}\n\nAdjust your approach based on this guidance.`);
    for (const c of sessionMessages) {
      structuredComments.push({ id: c.id, artifactId: "__session__", kind: "directive", content: c.content });
    }
  }

  // Artifact-specific comments — split questions (unanswered) out first
  // since they carry a response obligation the agent can honor with
  // answer_question. Regular comments / suggestions follow.
  // B3 — Comment is fully typed (intent/answeredByCommentId/target fields);
  // the (c as any) reads this block carried were vestigial.
  const artifactCommentsSorted = artifactComments.slice().sort((a, b) => {
    const aIsQ = a.intent === "question" && !a.answeredByCommentId ? 0 : 1;
    const bIsQ = b.intent === "question" && !b.answeredByCommentId ? 0 : 1;
    return aIsQ - bIsQ;
  });
  if (artifactCommentsSorted.length > 0) {
    await store.acknowledgeComments(artifactCommentsSorted.map((c) => c.id));
    const questionLines: string[] = [];
    const otherLines: string[] = [];
    for (const c of artifactCommentsSorted) {
      let loc = c.target.artifactId;
      if (c.target.lineStart) loc += `:${c.target.lineStart}`;
      if (c.target.findingIndex != null) loc += ` (finding #${c.target.findingIndex + 1})`;

      if (c.intent === "question" && !c.answeredByCommentId) {
        questionLines.push(
          `- ❓ QUESTION [${loc}] ${c.content}\n    → Answer via answer_question with commentId="${c.id}"`,
        );
        structuredQuestions.push({
          commentId: c.id,
          artifactId: c.target.artifactId,
          content: c.content,
          lineStart: c.target.lineStart,
          findingIndex: c.target.findingIndex,
        });
        continue;
      }
      if (c.target.suggestion) {
        const filePath = c.target.filePath ?? "unknown";
        const line = c.target.lineStart ?? "?";
        otherLines.push(`- [SUGGESTION for ${filePath}:${line}] Replace with:\n    ${c.target.suggestion}`);
        structuredComments.push({
          id: c.id,
          artifactId: c.target.artifactId,
          kind: "suggestion",
          content: c.content,
          suggestion: c.target.suggestion,
          filePath: c.target.filePath,
          lineStart: c.target.lineStart,
        });
        continue;
      }
      otherLines.push(`- [${loc}] ${c.content}`);
      structuredComments.push({
        id: c.id,
        artifactId: c.target.artifactId,
        kind: "comment",
        content: c.content,
        lineStart: c.target.lineStart,
        findingIndex: c.target.findingIndex,
      });
    }
    if (questionLines.length > 0) {
      parts.push(`Human questions (${questionLines.length}) — answer these before proceeding:\n${questionLines.join("\n")}`);
    }
    if (otherLines.length > 0) {
      parts.push(`Human comments (${otherLines.length}):\n${otherLines.join("\n")}`);
    }
  }

  // FN2 — explicit rejection verdict for non-plan/non-decision artifacts
  // (those don't have a dedicated verdict path). The reason is in the
  // human-comments block above; this makes the verdict unmissable so the
  // agent doesn't apply a rejected change.
  if (freshlyRejected.length > 0) {
    const list = freshlyRejected.map((a) => `"${a.title}" (${a.type})`).join(", ");
    parts.push(
      `❌ REJECTED (${freshlyRejected.length}): ${list}\nThe human rejected ${freshlyRejected.length === 1 ? "this" : "these"} — do NOT apply. Revise the approach or propose a different one (see their comment above for why).`,
    );
  }

  // Resolved decisions (acknowledge so they don't repeat)
  const resolved = await store.getResolvedDecisions();
  if (resolved.length > 0) {
    await store.acknowledgeDecisions(resolved.map((d) => d.decisionId));
    const formattedDecisions: string[] = [];
    for (const d of resolved) {
      const option = d.options.find((o: any) => o.id === d.response?.optionId);
      if (option) {
        const approvedDescription = `${d.context}: ${option.title}`;
        // AA1 — concept.name (from Y5) is the cross-project ledger key.
        // Pre-AA1 we passed option.description here, which is prose
        // and broke compounding (every project minted unique long
        // keys instead of bucketing under e.g. "argon2id for password
        // hashing"). Fall back to description for older agents that
        // don't supply concept.
        const approvedConcept: string | undefined =
          option.concept?.name ?? option.description ?? undefined;
        await store.recordApprovedPattern({
          description: approvedDescription,
          concept: approvedConcept,
        });
        broadcast({
          type: "ledger_write",
          kind: "approved",
          description: approvedDescription,
          concept: approvedConcept,
          sourceArtifactId: d.artifactId,
        });
        const rejected = d.options.filter((o: any) => o.id !== d.response?.optionId);
        for (const rej of rejected) {
          const rejectedDescription = `${d.context}: ${rej.title}`;
          // AA1 — read concept from the REJECTED option, not the
          // winning one. Each option carries its own pattern; the
          // rejection should compound under the rejected option's
          // concept, not the winner's.
          const rejectedConcept: string | undefined =
            rej.concept?.name ?? rej.description ?? undefined;
          // SP2 — per-option rejection reason. Pre-SP2 every rejected
          // option was stamped with the human's single overall
          // pick-reasoning ("why I chose the winner"), so B and C — often
          // rejected for DIFFERENT reasons — compounded the same blurred
          // signal in the ledger. Prefer THIS option's own cons (its
          // specific "why it's the worse fit"); keep the winner + the
          // human's reasoning as shared context when present.
          const optionCons: string[] = Array.isArray(rej.cons)
            ? rej.cons.filter((x) => typeof x === "string" && x.trim())
            : [];
          const pickContext = d.response?.reasoning
            ? ` — picked "${option.title}": ${d.response.reasoning}`
            : "";
          const composedReason = optionCons.length > 0
            ? `${optionCons.join("; ")}${pickContext}`
            : d.response?.reasoning;
          // SP2 — bound the composed reason so a verbose option (many cons
          // + long reasoning) doesn't crowd the preflight memory's
          // contextual budget. Display/recall only; matching is on
          // description/concept, so truncation is lossless for the gate.
          const rejectReason =
            composedReason && composedReason.length > 240
              ? `${composedReason.slice(0, 237)}…`
              : composedReason;
          await store.recordRejectedApproach({
            description: rejectedDescription,
            reason: rejectReason,
            sourceArtifactId: d.artifactId,
            concept: rejectedConcept,
          });
          broadcast({
            type: "ledger_write",
            kind: "rejected",
            description: rejectedDescription,
            concept: rejectedConcept,
            reason: rejectReason,
            sourceArtifactId: d.artifactId,
          });
        }
        // O7: high-stakes decisions also fire a "decision_resolved_hero"
        // event so the UI can toast the captured prediction — otherwise
        // the prediction disappears into the decision record.
        // stakes is typed on DecisionRecord; the nested `.request.stakes` read
        // is a legacy stored shape from pre-FF9 sessions — one narrow cast.
        const stakes = d.stakes ?? (d as { request?: { stakes?: string } }).request?.stakes;
        if (stakes === "high" && d.response?.predictedOutcome) {
          broadcast({
            type: "decision_resolved_hero",
            artifactId: d.artifactId,
            context: d.context,
            chosenTitle: option.title,
            predictedOutcome: d.response.predictedOutcome,
            confidence: d.response.confidence,
          });
        }
      }
      formattedDecisions.push(`- Decision "${d.context}": selected "${option?.title ?? d.response?.optionId}"${d.response?.reasoning ? ` (reasoning: ${d.response.reasoning})` : ""}`);
      structuredDecisions.push({
        decisionId: d.decisionId,
        artifactId: d.artifactId,
        context: d.context,
        selectedOptionId: d.response?.optionId,
        selectedTitle: option?.title,
        reasoning: d.response?.reasoning,
      });
    }
    parts.push(`Decision selections:\n${formattedDecisions.join("\n")}`);
  }

  // Plan review verdicts
  const pendingPlans = await store.getPendingPlanReviews();
  const planArtifacts = (await store.getArtifacts()).filter((a) => a.type === "plan");
  const reviewedPlans: string[] = [];
  // B3 — only verdicts NOT yet counted flip structuredContent.status to
  // 'feedback'; the prose below still repeats every verdict (pre-existing
  // behavior, kept), but the machine-readable status decays after one report.
  let freshPlanVerdicts = 0;
  for (const a of planArtifacts) {
    const verdict = await store.getPlanReviewVerdict(a.id);
    if (!verdict) continue;
    reviewedPlans.push(`- Plan "${a.title}": ${verdict.verdict}${verdict.feedback ? ` (feedback: ${verdict.feedback})` : ""}`);
    if (!ctx.state.reportedPlanVerdicts.has(a.id)) {
      ctx.state.reportedPlanVerdicts.add(a.id);
      freshPlanVerdicts++;
    }
  }
  if (reviewedPlans.length > 0) {
    parts.push(`Plan reviews:\n${reviewedPlans.join("\n")}`);
  }

  // Check for draft artifacts still awaiting human review
  const draftArtifacts = (await store.getArtifacts()).filter(
    (a) => a.status === "draft" && (WAITING_DRAFT_TYPES as readonly string[]).includes(a.type),
  );
  if (draftArtifacts.length > 0) {
    const waiting = draftArtifacts.map((a) => `"${a.title}" (${a.type})`).join(", ");
    parts.push(`⏳ WAITING: ${draftArtifacts.length} artifact(s) still under review: ${waiting}\nThe human is reviewing in the companion UI. Call check_feedback again to pick up their response.`);
  }

  const pendingDec = await store.getPendingDecisions();
  if (pendingDec.length > 0) {
    parts.push(`⏳ WAITING: ${pendingDec.length} decision(s) pending. The human will select in the companion UI. Call check_feedback again to pick up their choice.`);
  }
  if (pendingPlans.length > 0) {
    parts.push(`⏳ WAITING: ${pendingPlans.length} plan review(s) pending. The human will review in the companion UI. Call check_feedback again to pick up their verdict.`);
  }

  // Session memory is delivered once on the very first tool call (see
  // firstCallHint in server.ts). Intentionally NOT repeated here — mixing
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
  if (ctx.state.checkFeedbackPollCount >= 3 && pendingCount > 0) {
    parts.push(`⚠️ No human response after ${ctx.state.checkFeedbackPollCount} checks (~${ctx.state.checkFeedbackPollCount * 30}s). The human may not have the companion UI open.\nMention in your response: "Please open http://localhost:${port} to review the artifacts." Then continue polling with check_feedback.`);
  }

  // B3 — the machine-readable mirror. status: feedback (something to act on),
  // waiting (drafts/decisions/plans pending), or proceed.
  const hasActionableFeedback =
    hasNewFeedback || freshlyRejected.length > 0 || freshPlanVerdicts > 0;
  const structuredContent = {
    status: hasActionableFeedback ? "feedback" : pendingCount > 0 ? "waiting" : "proceed",
    suggestedAction,
    summary: {
      totalArtifacts,
      approved: approvedCount,
      pending: pendingCount,
      newComments: totalComments,
      autonomy: autonomyLabel,
    },
    pendingArtifacts: pendingArts.map((a) => ({ id: a.id, type: a.type, title: a.title })),
    questions: structuredQuestions,
    comments: structuredComments,
    decisions: structuredDecisions,
    rejected: freshlyRejected.map((a) => ({ id: a.id, type: a.type, title: a.title })),
  };

  // If only the preamble exists (no feedback, no waits), give a clean proceed signal
  if (parts.length === 1) {
    return {
      content: [{ type: "text", text: parts[0] }],
      structuredContent,
    };
  }

  return {
    content: [{ type: "text", text: parts.join("\n\n") }],
    structuredContent,
  };
}
