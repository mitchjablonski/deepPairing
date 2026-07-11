import type { ToolContext, ToolResult } from "./types.js";
import { PENDING_DRAFT_TYPES, WAITING_DRAFT_TYPES } from "./types.js";
import type { Artifact } from "@deeppairing/shared";
import { SERVER_VERSION } from "../../version.js";
import { getGlobalStore } from "../../store/global-store.js";
import { AUTONOMY_POLICY_LINE } from "../autonomy-policy.js";

/**
 * H2-1 — surface a FROZEN cross-project philosophy ledger. v0.1.6 makes the
 * ledger REFUSE writes when its file is corrupt (to preserve months of history),
 * but recordInstance() returns void and every call site swallows in try/catch,
 * so the freeze was invisible: present_* / check_feedback reported success while
 * nothing was being recorded. This is the agent's poll loop, so surface it here.
 *
 * Returns `{ ledgerHealth: {...} }` ONLY when frozen; `{}` when healthy so the
 * common-case structuredContent stays byte-for-byte as before (this is the hot
 * path — no tokens added to the healthy payload). Best-effort: any error
 * reading health degrades to `{}` rather than breaking the poll.
 */
function ledgerHealthField(): { ledgerHealth?: { state: "frozen"; ledgerPath: string; backupPath?: string; remedy: string } } {
  try {
    const health = getGlobalStore().getHealth();
    if (health.state !== "frozen") return {};
    return {
      ledgerHealth: {
        state: "frozen",
        ledgerPath: health.ledgerPath,
        ...(health.backupPath ? { backupPath: health.backupPath } : {}),
        remedy:
          `The cross-project philosophy ledger at ${health.ledgerPath} is corrupt; ` +
          `new approvals/rejections are NOT being recorded until it is repaired. ` +
          (health.backupPath ? `A backup is at ${health.backupPath}. ` : "") +
          "Run `npx deeppairing doctor` for the exact one-line fix (move the unreadable file aside so a fresh ledger can start).",
      },
    };
  } catch {
    return {};
  }
}

/**
 * #140 — a comment anchored to a region of a Mermaid diagram carries the node
 * LABELS it covers TEXTUALLY, never a screenshot. Render the referent as
 * `[AuthGate, Login]` so the agent can find the node in the Mermaid source it
 * authored. Deliberately NOT `elementIds`: those are render-unique
 * (`dp-mmd-7-8-flowchart-A-0`) and mean nothing to the model. Returns "" when
 * the region names no node (a blank-area drag) — nothing useful to append.
 */
type CommentRegion = { labels?: string[]; elementIds?: string[] } | undefined;
function describeRegionRef(region: CommentRegion): string {
  if (!region) return "";
  const labels = (region.labels ?? []).filter((s) => typeof s === "string" && s.length > 0);
  if (labels.length > 0) return `[${labels.join(", ")}]`;
  return "";
}

/**
 * V-fix — derive the {previousStatus, at} of the LATEST transition from the
 * artifact's statusHistory. The store appends [..., {prev, at}, {current, at}]
 * on each transition, so the last entry is the current status and the
 * second-to-last is what it came from. Defensive: old artifacts may lack
 * statusHistory entirely — fall back to updatedAt with no previousStatus
 * rather than throwing.
 */
function deriveTransition(a: Artifact): { previousStatus?: string; at?: string } {
  const history = (a as { statusHistory?: Array<{ status?: string; at?: string }> }).statusHistory;
  if (!Array.isArray(history) || history.length === 0) {
    return { at: a.updatedAt };
  }
  const last = history[history.length - 1];
  const prev = history.length >= 2 ? history[history.length - 2] : undefined;
  return { previousStatus: prev?.status, at: last?.at ?? a.updatedAt };
}

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

  // I7 — the LIVE companion UI URL, from the daemon's real bound port. This is
  // the tool the agent polls in a loop, so carrying the URL in every
  // structuredContent means the real address is always in reach — the agent
  // never has to guess (field report: hallucinated "5173"). Null when the port
  // isn't known so we never emit a bogus URL; the key is then omitted (optional
  // per repo convention — all new structured fields are optional).
  const companionUrl = Number.isFinite(port) && port > 0 ? `http://localhost:${port}` : undefined;

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

  // GH#152 — a scoped wait says what the agent is HOPING for, but it must
  // NEVER swallow human input. A human COMMENT (or a question, which is a
  // comment with intent='question') is unambiguously actionable feedback, so
  // it satisfies EVERY scope — even one targeting an unrelated artifact (any
  // human comment is triageable; the agent can read it and decide). Without
  // this, an agent that presented a decision and polled waitFor='decision'
  // would loop forever while the human, who COMMENTED instead of picking an
  // option, waited for a reply that never came. Status-only transitions
  // (plan/spec approvals) remain scoped — that's the useful part of scoping we
  // keep: the wake still ignores non-comment artifact-status changes.
  const hasImmediateFor = (scope: typeof waitForScope): boolean => {
    switch (scope) {
      case "comments": return unackComments.length > 0;
      case "decision": return resolvedDecs.length > 0 || unackComments.length > 0;
      case "plan_review": return decidedPlans.length > 0 || unackComments.length > 0;
      case "artifact_status": return decidedAny.length > 0 || resolvedDecs.length > 0 || unackComments.length > 0;
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

      // Long-poll: wait up to 30s for feedback to arrive.
      // H1-4 — try/finally so the heartbeat interval is ALWAYS cleared.
      // DaemonClient.waitForFeedback re-throws on network-down/5xx; if the
      // daemon dies mid-poll the await throws, and without finally the
      // clearInterval was skipped — the interval then fired server.notification
      // on a dead progressToken every 10s forever. The throw still propagates
      // (the handler's caller decides), but the timer never outlives the wait.
      try {
        await store.waitForFeedback(30000);
      } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
      }
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
    // GH#152 — mirror hasImmediateFor: any new unacknowledged comment (incl.
    // questions) satisfies every scope. Once we fall through, the main
    // assembly below REPORTS and acknowledges the comment (never a comments:[]
    // dump) AND still surfaces the "decision/plan still pending" WAITING line +
    // suggestedAction — so the agent sees BOTH "the human commented, act on it"
    // and "your artifact is still awaiting a verdict."
    const scopeSatisfied = (() => {
      switch (waitForScope) {
        case "comments": return newComments.length > 0;
        case "decision": return newResolved.length > 0 || newComments.length > 0;
        case "plan_review": return decidedPlansPostWake.length > 0 || newComments.length > 0;
        case "artifact_status": return decidedAnyPostWake.length > 0 || newResolved.length > 0 || newComments.length > 0;
        default: return true;
      }
    })();
    // Belt-and-suspenders: even if some future scope logic forgets comments,
    // NEVER early-return (and strand human input with a comments:[] payload)
    // while unacknowledged comments exist. Fall through to the reporting path.
    if (!scopeSatisfied && newComments.length === 0) {
      return {
        content: [{
          type: "text",
          text: `Still waiting on '${waitForScope}'. Nothing arrived during the 30s poll — no comments, and nothing matching that scope. Call check_feedback again with the same waitFor (or waitFor='any' to also wake on other artifact-status changes).`,
        }],
        structuredContent: {
          status: "waiting",
          waitFor: waitForScope,
          suggestedAction: `Nothing arrived yet. Call check_feedback again with waitFor='${waitForScope}' (or 'any' to also wake on other artifact-status changes).`,
          companionUrl,
          serverVersion: SERVER_VERSION,
          pendingArtifacts: [],
          questions: [],
          comments: [],
          decisions: [],
          rejected: [],
          statusChanges: [],
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
  const [oldestPending] = pendingArts;
  if (oldestPending) {
    const oldestMs = Date.now() - new Date(oldestPending.createdAt).getTime();
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

  // GH#152 — when the human COMMENTED while an artifact is still awaiting its
  // verdict (e.g. commented on a decision instead of picking an option), the
  // suggestedAction must carry BOTH signals: act on the comment AND keep
  // waiting for the pending verdict. Append rather than replace so the pending
  // guidance above ("Wait for decision selection…") survives verbatim — the
  // human's comment itself is reported in the "Human comments"/"Human
  // questions" block below.
  if (newComments.length > 0 && pendingArts.length > 0) {
    suggestedAction = `${suggestedAction} The human also left a comment — read it below and consider replying (answer_question or a reply comment), then call check_feedback again.`;
  }

  parts.push(`Session: ${totalArtifacts} artifact${totalArtifacts !== 1 ? "s" : ""} (${approvedCount} approved, ${pendingCount} pending) | ${totalComments} new comment${totalComments !== 1 ? "s" : ""} | ${autonomyLabel} mode | deepPairing v${SERVER_VERSION}${oldestPendingAge ? `\nOldest pending: ${oldestPendingAge}` : ""}\nSuggested action: ${suggestedAction}`);

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
    const artsForTargets = await store.getArtifacts();
    for (const c of artifactCommentsSorted) {
      let loc = c.target.artifactId;
      if (c.target.lineStart) loc += `:${c.target.lineStart}`;
      if (c.target.findingIndex != null) loc += ` (finding #${c.target.findingIndex + 1})`;
      // D8 review [BLOCKER] — question answers and requirement comments
      // arrived UNTAGGED: the human clicked Comment on "Which DB?", typed
      // "Postgres", and the agent got a bare artifact-level comment with no
      // clue which open question it answered. Tag both, resolving the
      // question TEXT so terse answers ("yes") stay unambiguous.
      if (c.target.questionIndex != null) {
        const art = artsForTargets.find((a) => a.id === c.target.artifactId);
        const qs = (art?.content as { openQuestions?: string[] } | undefined)?.openQuestions;
        const qText = qs?.[c.target.questionIndex];
        loc += qText
          ? ` (answers open question #${c.target.questionIndex + 1}: "${qText}")`
          : ` (answers open question #${c.target.questionIndex + 1})`;
      }
      if (c.target.requirementId) loc += ` (requirement ${c.target.requirementId})`;
      // #140 — a region comment names the diagram nodes it covers TEXTUALLY so
      // the agent can find them in the Mermaid source it authored (no image).
      // e.g. "— on region [AuthGate, Login]". Labels preferred; ids as a
      // fallback. A region carrying neither is skipped (nothing to say).
      const regionRef = describeRegionRef(c.target.region);
      if (regionRef) loc += ` — on region ${regionRef}`;

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
          questionIndex: c.target.questionIndex,
          requirementId: c.target.requirementId,
          // #140 — carry ONLY the human-meaningful labels. The normalized rect
          // and the render-unique `elementIds` (e.g. dp-mmd-7-8-flowchart-A-0)
          // are unactionable to the model — the labels are the part it can find
          // in the source it authored. Spread only when labels exist, so the
          // healthy/no-region payload stays byte-for-byte as before.
          ...(c.target.region?.labels?.length ? { region: { labels: c.target.region.labels } } : {}),
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
        questionIndex: c.target.questionIndex,
        requirementId: c.target.requirementId,
        // #140 — labels only (see structuredQuestions); present only when the
        // region actually named a node.
        ...(c.target.region?.labels?.length ? { region: { labels: c.target.region.labels } } : {}),
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
      const option = d.options.find((o) => o.id === d.response?.optionId);
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
        const rejected = d.options.filter((o) => o.id !== d.response?.optionId);
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

  // V-fix — the observable per-artifact resolution signal. Drain the
  // HUMAN-driven draft→terminal transitions (approved / rejected /
  // changes_requested), report each ONCE by id, then acknowledge. This is
  // the signal the agent was missing: after revise_artifact(supersede) mints
  // a v2 draft and the human approves it, the agent could previously only
  // INFER the approval from an aggregate count moving — now it sees
  // "art_X is now approved". Read-then-ack (same ordering as comments /
  // decisions above) so it reports exactly once. Agent-driven transitions
  // (supersede/retract/obsolete) never set the flag, so they never appear.
  const changed = await store.getUnacknowledgedStatusChanges();
  const structuredStatusChanges = changed.map((a) => {
    const { previousStatus, at } = deriveTransition(a);
    return { id: a.id, type: a.type, title: a.title, status: a.status, previousStatus, at };
  });
  if (changed.length > 0) {
    await store.acknowledgeStatusChanges(changed.map((a) => a.id));
    const lines = structuredStatusChanges.map((s) => {
      const marker = s.status === "approved" ? "✅ RESOLVED" : s.status === "rejected" ? "❌ RESOLVED" : "🔔 RESOLVED";
      const from = s.previousStatus ? ` (was ${s.previousStatus})` : "";
      return `${marker}: ${s.id} (${s.type}) "${s.title}" — ${s.status}${from}`;
    });
    parts.push(`Human review verdicts (${changed.length}) — resolved BY ID:\n${lines.join("\n")}`);
  }

  // Check for draft artifacts still awaiting human review
  const draftArtifacts = (await store.getArtifacts()).filter(
    (a) => a.status === "draft" && (WAITING_DRAFT_TYPES as readonly string[]).includes(a.type),
  );
  if (draftArtifacts.length > 0) {
    // #158 — a draft the secret scanner flagged carries the warning inline so
    // the agent knows the human is reviewing something that may contain a
    // pasted credential. Labels only (e.g. "AWS access key id") — never the
    // matched value.
    const waiting = draftArtifacts
      .map((a) => `"${a.title}" (${a.type}${a.secretWarnings?.length ? " — ⚠ possible secret detected" : ""})`)
      .join(", ");
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

  // Autonomy preference reminder — non-default levels only.
  // #148 — `supervised` is DELIBERATELY silent here, not an oversight:
  // supervised IS the protocol preamble's default full ceremony, so there is
  // nothing to remind the agent of, and the healthy poll payload stays
  // byte-minimal (a standing contract — see check-feedback-ledger-health
  // .test.ts). The standing per-level guidance now also rides in the
  // first-call hint (first-call-hint.ts), sharing AUTONOMY_POLICY_LINE with
  // this block so the two surfaces can't drift. Do not "fix" this by echoing
  // the level for supervised.
  const autonomy = await store.getAutonomyLevel();
  if (autonomy !== "supervised") {
    parts.push(`Human autonomy preference: ${autonomy}. ${
      autonomy === "balanced"
        ? AUTONOMY_POLICY_LINE.balanced
        : AUTONOMY_POLICY_LINE.autonomous
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
  // V-fix — a HUMAN status change (e.g. approving a v2 draft) IS actionable:
  // the agent can now build against the approved artifact, so it should flip
  // status to 'feedback'/proceed rather than stay 'waiting'. Fold
  // changed.length into the signal alongside comments/rejected/plan verdicts.
  const hasActionableFeedback =
    hasNewFeedback || freshlyRejected.length > 0 || freshPlanVerdicts > 0 || changed.length > 0;
  const structuredContent = {
    status: hasActionableFeedback ? "feedback" : pendingCount > 0 ? "waiting" : "proceed",
    suggestedAction,
    companionUrl,
    serverVersion: SERVER_VERSION,
    summary: {
      totalArtifacts,
      approved: approvedCount,
      pending: pendingCount,
      newComments: totalComments,
      autonomy: autonomyLabel,
    },
    // #158 — nest secretWarnings (labels only, never values) INSIDE the
    // per-artifact entry, spread only when the scanner matched: the healthy
    // payload's top-level key set — and the entry shape for clean artifacts —
    // stays byte-for-byte as before (contract lock in
    // check-feedback-ledger-health.test.ts).
    pendingArtifacts: pendingArts.map((a) => ({
      id: a.id,
      type: a.type,
      title: a.title,
      ...(a.secretWarnings?.length
        ? { secretWarnings: a.secretWarnings.map((w) => w.label) }
        : {}),
    })),
    questions: structuredQuestions,
    comments: structuredComments,
    decisions: structuredDecisions,
    rejected: freshlyRejected.map((a) => ({ id: a.id, type: a.type, title: a.title })),
    statusChanges: structuredStatusChanges,
    // H2-1 — spreads `ledgerHealth` ONLY when the global ledger is frozen;
    // spreads nothing (byte-for-byte-unchanged payload) when healthy.
    ...ledgerHealthField(),
  };

  // If only the preamble exists (no feedback, no waits), give a clean proceed signal
  const [preamble] = parts;
  if (parts.length === 1 && preamble !== undefined) {
    return {
      content: [{ type: "text", text: preamble }],
      structuredContent,
    };
  }

  return {
    content: [{ type: "text", text: parts.join("\n\n") }],
    structuredContent,
  };
}
