import type { ToolContext, ToolResult } from "./types.js";
import { PENDING_DRAFT_TYPES, WAITING_DRAFT_TYPES, ACKNOWLEDGE_ONLY_DRAFT_TYPES } from "./types.js";
import type { Artifact, Request } from "@deeppairing/shared";
import { deliverComment, commentSecretNote, requestSecretNote, requestScopeNote } from "./check-feedback-delivery.js";
import { SERVER_VERSION } from "../../version.js";
import { collectUnansweredQuestions, describeRequestIntent } from "@deeppairing/shared";
import { getGlobalStore } from "../../store/global-store.js";
import { composeOptionRejectReason, recordRejectedOption } from "../../store/rejected-option-recorder.js";
import { AUTONOMY_POLICY_LINE } from "../autonomy-policy.js";
import { sessionOwesDebrief } from "../../debrief-gate.js";
import { cliInvocation } from "../../cli-invocation.js";

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
          "Run `" + cliInvocation("doctor") + "` for the exact one-line fix (move the unreadable file aside so a fresh ledger can start).",
      },
    };
  } catch {
    return {};
  }
}

/**
 * #171/#175 — a changeset's per-file DISPOSITION, surfaced to the agent so it
 * can see which files the human marked look-right vs. flagged for changes (and
 * WHY, via reviewReasons). Returns `{ reviewState, reviewReasons, filesReviewed,
 * filesTotal }` ONLY for a changeset with files; `{}` for every other artifact
 * so the pending-entry shape stays byte-for-byte unchanged for non-changeset
 * drafts. #175 — "needs_changes" joins "reviewed"; legacy "skipped" is still
 * counted as dispositioned (so an old in-flight changeset's count is stable).
 */
function changesetReviewField(a: Artifact): {
  reviewState?: Record<string, "reviewed" | "needs_changes" | "skipped">;
  reviewReasons?: Record<string, string>;
  filesReviewed?: number;
  filesTotal?: number;
} {
  if (a.type !== "changeset") return {};
  const content = a.content as {
    files?: Array<{ path?: string }>;
    reviewState?: Record<string, unknown>;
    reviewReasons?: Record<string, unknown>;
  } | null;
  const files = Array.isArray(content?.files) ? content!.files : [];
  if (files.length === 0) return {};
  const raw = content?.reviewState ?? {};
  const reviewState: Record<string, "reviewed" | "needs_changes" | "skipped"> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === "reviewed" || v === "needs_changes" || v === "skipped") reviewState[k] = v;
  }
  const rawReasons = content?.reviewReasons ?? {};
  const reviewReasons: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawReasons)) {
    if (typeof v === "string" && v.length > 0) reviewReasons[k] = v;
  }
  const filesReviewed = files.filter((f) => {
    const s = f.path ? reviewState[f.path] : undefined;
    return s === "reviewed" || s === "needs_changes" || s === "skipped";
  }).length;
  const out: {
    reviewState: Record<string, "reviewed" | "needs_changes" | "skipped">;
    reviewReasons?: Record<string, string>;
    filesReviewed: number;
    filesTotal: number;
  } = { reviewState, filesReviewed, filesTotal: files.length };
  if (Object.keys(reviewReasons).length > 0) out.reviewReasons = reviewReasons;
  return out;
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

type WaitForScope = "any" | "comments" | "decision" | "plan_review" | "artifact_status";

/**
 * #188 (PAYDOWN) — the ONE scope→signal mapping. It was duplicated as the
 * pre-poll `hasImmediateFor` closure and the post-wake `scopeSatisfied` IIFE
 * (near-identical copies whose own comments admitted drift risk); this is the
 * single source both call sites now feed with their own freshly-counted signals.
 *
 * GH#152 — a scoped wait says what the agent is HOPING for, but it must NEVER
 * swallow human input. A human COMMENT (or a question, which is a comment with
 * intent='question') is unambiguously actionable feedback, so it satisfies EVERY
 * scope — even one targeting an unrelated artifact (any human comment is
 * triageable; the agent can read it and decide). Status-only transitions
 * (plan/spec approvals) remain scoped — that's the useful part of scoping we
 * keep: the wake still ignores non-comment artifact-status changes.
 */
function scopeHasSignal(
  scope: WaitForScope,
  signals: { comments: number; decisions: number; decidedPlans: number; decidedAny: number },
): boolean {
  switch (scope) {
    case "comments": return signals.comments > 0;
    case "decision": return signals.decisions > 0 || signals.comments > 0;
    case "plan_review": return signals.decidedPlans > 0 || signals.comments > 0;
    case "artifact_status": return signals.decidedAny > 0 || signals.decisions > 0 || signals.comments > 0;
    case "any":
    default:
      return signals.comments > 0 || signals.decisions > 0;
  }
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
  let companionUrl = Number.isFinite(port) && port > 0 ? `http://localhost:${port}` : undefined;

  // N2 (#226 scope 5) — self-heal companion-URL note. If the daemon idle-shut
  // and respawned on a NEW port during this call's store access (TIME_WAIT),
  // the DaemonClient re-adopted it transparently — but any URL the agent
  // already gave the human now points at the dead port. Reflect the LIVE port
  // in companionUrl and, once per port change, return a prose nudge so the
  // agent corrects it. Drain-once: whichever return path executes calls this.
  // Optional store methods → no-op for the in-process FileStore.
  const portRecoveryNote = (): string => {
    const livePort = store.getLivePort?.();
    if (typeof livePort === "number" && livePort > 0) {
      companionUrl = `http://localhost:${livePort}`;
    }
    const notice = store.consumePortChangeNotice?.() ?? null;
    if (!notice) return "";
    return (
      `\n\n⚠️ The daemon restarted on a new port — the companion UI is now at ${companionUrl} ` +
      `(was http://localhost:${notice.previousPort}). If you already gave the human the old URL, correct it: send them ${companionUrl}.`
    );
  };

  // BB3 — `waitFor` scopes which feedback signal counts as "ready".
  // The agent can pin its poll to the artifact it just presented
  // (e.g. waitFor='decision' after present_options) so an unrelated
  // comment elsewhere doesn't wake the poll prematurely. Default
  // 'any' preserves the historical broad behavior.
  const waitForRaw = typeof args?.waitFor === "string" ? args.waitFor : "any";
  const waitForScope: WaitForScope =
    (["any", "comments", "decision", "plan_review", "artifact_status"] as const).includes(
      waitForRaw as any,
    )
      ? (waitForRaw as any)
      : "any";

  // If no immediate feedback exists, long-poll for up to 30 seconds
  const unackComments = await store.getUnacknowledgedComments();
  const resolvedDecs = await store.getResolvedDecisions();
  // #176 — a pending client-reported render failure is actionable feedback
  // (the human is looking at a broken diagram), so it must satisfy the entry
  // gate exactly like a human comment — otherwise check_feedback would sit in
  // the 30s long-poll while a fix is already owed. Optional method → [].
  const pendingRenderFailuresAtGate = (await store.getUnacknowledgedRenderFailures?.()) ?? [];
  const allArtsForScope = await store.getArtifacts();
  const decidedPlans = allArtsForScope.filter(
    (a) => a.type === "plan" && (a.status === "approved" || a.status === "revised" || a.status === "rejected"),
  );
  const decidedAny = allArtsForScope.filter(
    (a) => a.status === "approved" || a.status === "revised" || a.status === "rejected",
  );

  // #188 — the scope→signal decision lives in the shared scopeHasSignal (see
  // its GH#152 note); here we feed it the PRE-poll snapshot counts.
  // #176 — a pending render failure satisfies EVERY scope (like a human
  // comment): a broken diagram the human sees is always triageable.
  const hasImmediate =
    scopeHasSignal(waitForScope, {
      comments: unackComments.length,
      decisions: resolvedDecs.length,
      decidedPlans: decidedPlans.length,
      decidedAny: decidedAny.length,
    }) || pendingRenderFailuresAtGate.length > 0;

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

  // O3 (#231) — ONE post-wake snapshot of the store lanes the rest of the poll
  // reads. Pre-O3 the handler re-fetched each of these 2-6× per poll; in prod
  // (DaemonClient) every read is an un-memoized HTTP round-trip (getFullState
  // re-serializes the whole session each time). Between here and the drains
  // below, check_feedback performs NO artifact/comment/decision MUTATION — it
  // only ACKNOWLEDGES, which never changes membership nor any field these reads
  // surface (getUnacknowledgedComments is captured pre-ack; carryover keys on
  // answeredByCommentId, not `acknowledged`) — so a single snapshot is
  // byte-identical to the old repeated reads. Pinned by
  // check-feedback-golden-parity.test.ts; measured by
  // check-feedback-read-amplification.test.ts. `getFullState` is captured lazily
  // at its first use below so the scoped early-return path never pays for it.
  const newComments = await store.getUnacknowledgedComments();
  const newResolved = await store.getResolvedDecisions();
  const postWakeArtifacts = await store.getArtifacts();
  const postWakeRenderFailures = (await store.getUnacknowledgedRenderFailures?.()) ?? [];
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
    // O3 — reuse the post-wake artifact snapshot (was a redundant getArtifacts).
    const decidedPlansPostWake = postWakeArtifacts.filter(
      (a) => a.type === "plan" && (a.status === "approved" || a.status === "revised" || a.status === "rejected"),
    );
    const decidedAnyPostWake = postWakeArtifacts.filter(
      (a) => a.status === "approved" || a.status === "revised" || a.status === "rejected",
    );
    // GH#152 — same scopeHasSignal mapping as the pre-poll gate: any new
    // unacknowledged comment (incl. questions) satisfies every scope. Once we
    // fall through, the main assembly below REPORTS and acknowledges the comment
    // (never a comments:[] dump) AND still surfaces the "decision/plan still
    // pending" WAITING line + suggestedAction — so the agent sees BOTH "the
    // human commented, act on it" and "your artifact is still awaiting a
    // verdict." Fed the FRESH post-wake counts.
    const scopeSatisfied = scopeHasSignal(waitForScope, {
      comments: newComments.length,
      decisions: newResolved.length,
      decidedPlans: decidedPlansPostWake.length,
      decidedAny: decidedAnyPostWake.length,
    });
    // #176 — a render failure that woke this poll must also fall through to the
    // reporting path, never be stranded by a narrow scope's early-return.
    // O3 — reuse the post-wake render-failure snapshot (was a redundant read).
    const newRenderFailures = postWakeRenderFailures;
    // Belt-and-suspenders: even if some future scope logic forgets comments,
    // NEVER early-return (and strand human input with a comments:[] payload)
    // while unacknowledged comments (or render failures) exist. Fall through to
    // the reporting path.
    if (!scopeSatisfied && newComments.length === 0 && newRenderFailures.length === 0) {
      const portNote = portRecoveryNote();
      return {
        content: [{
          type: "text",
          text: `Still waiting on '${waitForScope}'. Nothing arrived during the 30s poll — no comments, and nothing matching that scope. Call check_feedback again with the same waitFor (or waitFor='any' to also wake on other artifact-status changes).${portNote}`,
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
  // O3 — reuse the post-wake snapshots (were redundant getArtifacts /
  // getUnacknowledgedComments reads; allComments == the same pre-ack set).
  const allArtifacts = postWakeArtifacts;
  const totalArtifacts = allArtifacts.length;
  const approvedCount = allArtifacts.filter((a) => a.status === "approved").length;
  const pendingCount = allArtifacts.filter((a) => a.status === "draft" && (PENDING_DRAFT_TYPES as readonly string[]).includes(a.type)).length;
  const allComments = newComments;
  const totalComments = allComments.length;
  // O3 — read autonomy ONCE; the engagement-hint block below reuses this.
  const autonomyLabel = await store.getAutonomyLevel();

  // M2 — unanswered human questions in THIS poll (artifact-scoped questions the
  // agent owes an answer). Computed here so suggestedAction can LEAD with them
  // (the delivery loop that populates structuredQuestions runs later).
  const openQuestionCount = allComments.filter(
    (c) =>
      c.author === "human" &&
      c.intent === "question" &&
      !c.answeredByCommentId &&
      c.target.artifactId !== "__session__",
  ).length;

  // FN2 — artifacts the human REJECTED that check_feedback hasn't reported
  // yet. Without this, suggestedAction falls through to "you may proceed"
  // right after a human rejects a code_change/spec/research (only plans had
  // verdict reporting). Comment-independent (a feedback-less reject still
  // triggers it) and reported exactly once via the reportedRejectedVerdicts set.
  //
  // #169 — `decision` belongs here too. A PICKED decision flips to `approved`
  // (its verdict rides the getResolvedDecisions path below), but a WHOLE-CARD
  // rejection ("none of these") sets status=rejected with NO resolved-decision
  // record — so it had no verdict surface at all and suggestedAction reported
  // "You may proceed with implementation." the instant the human rejected the
  // framing. Including it here gives a rejected decision the same "Do NOT apply /
  // address the rejection" posture every other rejected type gets.
  const freshlyRejected = allArtifacts.filter(
    (a) =>
      a.status === "rejected" &&
      // #171 — changeset joins the verdict-reported set (same #195 bug class:
      // without it, a rejected changeset would fall through to "You may
      // proceed" the instant the human rejects the approach).
      // #190 — `debrief` joins for the same reason: a rejected debrief (the human
      // says "this doesn't reflect what we built") must get the "Do NOT apply /
      // address the rejection" posture, not "You may proceed".
      // #190 A2 — `explainer` joins too: a rejected explainer ("this walk-through
      // is wrong / misleading") must get "Do NOT apply", not "You may proceed".
      ["code_change", "spec", "research", "decision", "changeset", "debrief", "explainer"].includes(a.type) &&
      !ctx.state.reportedRejectedVerdicts.has(a.id),
  );
  for (const a of freshlyRejected) ctx.state.reportedRejectedVerdicts.add(a.id);

  // O3 (#231) — ONE getFullState for the whole poll. Pre-O3 this was called 3×
  // (pendingRequests, hasUnansweredQuestions, carryover), each re-serializing the
  // entire session in prod. All three consumers key on immutable fields
  // (requests, comment content, answeredByCommentId), so one best-effort snapshot
  // is byte-identical. `null` on failure → each consumer keeps its own fallback.
  let fullState: Awaited<ReturnType<typeof store.getFullState>> | null = null;
  try {
    fullState = await store.getFullState();
  } catch {
    // Non-fatal — full state is best-effort; each consumer degrades below.
  }

  // G1 (#198b) — pending (unserved) human-initiated requests. Best-effort read
  // off full state so it works for BOTH FileStore (direct) and DaemonClient
  // (its /state includes `requests`); an old store without the key yields [].
  const pendingRequests: Request[] = fullState
    ? (fullState.requests ?? []).filter((r) => !r.servedByArtifactId)
    : [];

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
  } else if (pendingArts.some((a) => a.type === "changeset")) {
    suggestedAction = "Wait for the changeset review — the human is reviewing each file — before applying the edits.";
  } else if (pendingArts.some((a) => a.type === "decision")) {
    suggestedAction = "Wait for decision selection before proceeding.";
  } else if (pendingArts.some((a) => a.type === "plan")) {
    suggestedAction = "Wait for plan approval before implementing.";
  } else if (pendingArts.some((a) => a.type === "spec")) {
    suggestedAction = "Wait for spec approval before planning implementation.";
  } else if (pendingArts.some((a) => a.type === "research")) {
    suggestedAction = "Wait for findings review before proposing solutions.";
  } else if (pendingArts.some((a) => a.type === "debrief")) {
    // #190 — a debrief is the end-of-run comprehension surface; the human reads
    // it and may ask questions. Answer any questions (answer_question) and keep
    // polling until they close it out.
    suggestedAction = "The debrief is presented — the human is reading it. Answer any questions they raise, then continue polling.";
  } else if (pendingArts.some((a) => a.type === "explainer")) {
    // #190 A2 — an explainer is a read-only walk-through; the human reads it and
    // may ask questions. Answer any questions (answer_question) and keep polling.
    suggestedAction = "The explainer is presented — the human is reading the walk-through. Answer any questions they raise, then continue polling.";
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

  // H1 — debrief-owed reinforcement. Heuristic (documented): nag ONLY when the
  // run is WINDING DOWN — no pending drafts to review, nothing freshly rejected
  // to revise, and NO question the agent still owes an answer on — AND the
  // session presented substantive code work (a changeset/code_change) but has
  // no debrief yet. This keeps it off the mid-flight path (where suggestedAction
  // is a "wait for review" instruction) and only fires at the natural
  // end-of-run moment the debrief rule targets.
  //
  // The "no unanswered question" gate is on PERSISTED state, not this poll's
  // `openQuestionCount` (which counts UNACKNOWLEDGED questions — those drain
  // after one poll even if never answered, so a stale-but-open question would
  // wrongly let the nag fire on the next poll). We use the same
  // collectUnansweredQuestions tail-walk (answeredByCommentId) every other
  // surface uses, so the nag genuinely waits until questions are ANSWERED.
  // J2a (#210) — ceremony scales with task size. The nag fires only when the
  // session SHAPE owes a debrief: a changeset, 2+ code_changes, or a decision
  // moment. A trivial single-file surgical fix (exactly one code_change, no
  // changeset, no decision) closes with its own self-summarizing code_change —
  // no separate debrief owed, so no nag. Same predicate the Stop hook applies
  // (debrief-gate.ts). This subsumes the old hasCodeWork + !hasDebrief gate.
  const shapeOwesDebrief = sessionOwesDebrief(allArtifacts);
  // O3 — reuse the single fullState snapshot; fall back to this-poll's
  // unacknowledged count when full state was unavailable.
  const hasUnansweredQuestions = fullState
    ? collectUnansweredQuestions(fullState.comments ?? []).length > 0
    : openQuestionCount > 0;
  const owesDebrief =
    pendingArts.length === 0 &&
    freshlyRejected.length === 0 &&
    !hasUnansweredQuestions &&
    shapeOwesDebrief;
  if (owesDebrief) {
    suggestedAction = `${suggestedAction} You presented code this run but no present_debrief yet — when the feature wraps, end with ONE present_debrief so your pair gets the walk-through.`;
  }

  // G1 (#198b) — pending human requests. Ordering (documented + pinned by
  // check-feedback-request.test.ts): a request ranks AFTER unanswered questions
  // AND AFTER freshlyRejected's safety-critical "Do NOT apply" posture. Append
  // here (the openQuestionCount prepend below still leads, and the freshlyRejected
  // base is already in `suggestedAction`), so the final order is
  // questions → rejected/pending-review → requests.
  if (pendingRequests.length > 0) {
    suggestedAction = `${suggestedAction} The human sent ${pendingRequests.length} request${pendingRequests.length === 1 ? "" : "s"} — serve ${pendingRequests.length === 1 ? "it" : "them"} (see "Human requests" below) with the matching present_* artifact.`;
  }

  // M2 — questions LEAD the suggestedAction: when the human left open questions,
  // answering them comes before any rejection/comment guidance (which stays,
  // just after). Prepend last so it sits at the very front.
  if (openQuestionCount > 0) {
    suggestedAction = `Answer the ${openQuestionCount} open question${openQuestionCount === 1 ? "" : "s"} first (reply with answer_question). ${suggestedAction}`;
  }

  parts.push(`Session: ${totalArtifacts} artifact${totalArtifacts !== 1 ? "s" : ""} (${approvedCount} approved, ${pendingCount} pending) | ${totalComments} new comment${totalComments !== 1 ? "s" : ""} | ${autonomyLabel} mode | deepPairing v${SERVER_VERSION}${oldestPendingAge ? `\nOldest pending: ${oldestPendingAge}` : ""}\nSuggested action: ${suggestedAction}`);

  // B3 — structured mirrors of the blocks below, populated as we format.
  const structuredQuestions: Array<Record<string, unknown>> = [];
  const structuredComments: Array<Record<string, unknown>> = [];
  const structuredDecisions: Array<Record<string, unknown>> = [];
  // #172 — suggested edits the agent owes a response on.
  const structuredSuggestions: Array<Record<string, unknown>> = [];

  // Unacknowledged comments (reuse the single drain snapshot fetched above)
  const sessionMessages = allComments.filter((c) => c.target.artifactId === "__session__");
  const artifactComments = allComments.filter((c) => c.target.artifactId !== "__session__");

  // Session-level directives (free-form messages from human)
  if (sessionMessages.length > 0) {
    await store.acknowledgeComments(sessionMessages.map((c) => c.id));
    const formatted = sessionMessages.map((c) => `- ${c.content}${commentSecretNote(c)}`).join("\n");
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
    const suggestionLines: string[] = [];
    const otherLines: string[] = [];
    // O3 — reuse the post-wake artifact snapshot (was a redundant getArtifacts).
    const artsForTargets = postWakeArtifacts;
    // #188 (PAYDOWN) — the per-lane delivery branches (suggestion state-machine,
    // del-side removed line, cross-file anchors, questionIndex, requirementId,
    // optionId, sectionId/grain, region, followUp) now live ONCE in
    // deliverComment (check-feedback-delivery.ts), consumed by both the questions
    // and comments paths. This loop is the thin dispatch: it routes each
    // delivery into its prose block + structured array and tracks whether any
    // delivered question/comment was a late follow-up (#187 — drives the one
    // guidance paragraph below).
    let anyFollowUp = false;
    for (const c of artifactCommentsSorted) {
      const delivery = deliverComment(c, artsForTargets);
      if (delivery.isFollowUp) anyFollowUp = true;
      switch (delivery.bucket) {
        case "suggestion":
          suggestionLines.push(delivery.prose);
          structuredSuggestions.push(delivery.structured);
          break;
        case "question":
          questionLines.push(delivery.prose);
          structuredQuestions.push(delivery.structured);
          break;
        case "comment":
          otherLines.push(delivery.prose);
          structuredComments.push(delivery.structured);
          break;
      }
    }
    if (questionLines.length > 0) {
      parts.push(`Human questions (${questionLines.length}) — answer these before proceeding:\n${questionLines.join("\n")}`);
    }
    if (suggestionLines.length > 0) {
      parts.push(`🔧 Suggested edits (${suggestionLines.length}) — you MUST respond to each (apply / apply-with-extension / counter). An unanswered suggestion stays PENDING in the UI as visible debt:\n${suggestionLines.join("\n")}`);
    }
    if (otherLines.length > 0) {
      parts.push(`Human comments (${otherLines.length}):\n${otherLines.join("\n")}`);
    }
    // #187 — one guidance paragraph, appended ONLY when at least one follow-up
    // comment/question was delivered above (anyFollowUp set from deliverComment's
    // isFollowUp). Absent otherwise → normal delivery is byte-for-byte unchanged.
    if (anyFollowUp) {
      parts.push(
        `ℹ️ The [follow-up ...] item(s) above are FOLLOW-UP FEEDBACK on an already-APPROVED artifact — NOT a review reopening. The review outcome stands; do not treat this as a rejection or a request to re-run the review. Address it as new input: answer it (answer_question / a reply comment), or present a new artifact or revision if it genuinely warrants one.`,
      );
    }
  }

  // #192 (serving H1) — CARRYOVER: unanswered human questions from EARLIER in
  // this project's session that the normal drain above won't re-report because a
  // PRIOR run already acknowledged them (acknowledge ≠ answered). The session
  // store is per-project and reloads across runs, so a question asked after a
  // run ended — e.g. on a debrief/explainer ask-anything thread just as the
  // agent stopped polling — lives on and must be answerable on the NEXT run
  // without the human re-raising it. Read-only: uses the SAME tail-walk
  // predicate (collectUnansweredQuestions) every UI surface uses, does NOT
  // re-acknowledge anything, and is spread into structuredContent ONLY when
  // non-empty so the healthy hot-path payload stays byte-for-byte unchanged.
  // Scope = same-session-chain (the project's one deterministic session id) —
  // documented; cross-*project* questions are out of scope.
  const structuredCarryover: Array<Record<string, unknown>> = [];
  try {
    // O3 — reuse the single fullState snapshot (was a 3rd getFullState). When it
    // was unavailable, carryover is skipped exactly as the old catch did.
    const carryover = fullState ? collectUnansweredQuestions(fullState.comments ?? []) : [];
    // Don't double-report a comment already delivered in THIS poll — questions
    // (structuredQuestions) AND directives/comments (structuredComments, which
    // includes the __session__ directive drain). Belt-and-suspenders alongside
    // the __session__ exclusion below.
    const deliveredIds = new Set<string>();
    for (const q of structuredQuestions) {
      const id = (q.commentId ?? q.id) as string | undefined;
      if (id) deliveredIds.add(id);
    }
    for (const q of structuredComments) {
      const id = (q.id ?? q.commentId) as string | undefined;
      if (id) deliveredIds.add(id);
    }
    const older = carryover.filter(
      (q) =>
        // FIX 1 — target/dedupe the ACTUAL open-question comment (the tail-walk
        // landing, which for a reply-question is NOT the thread root).
        !deliveredIds.has(q.question.id) &&
        // HUNCH — a __session__ question is drained as a DIRECTIVE above (and
        // acknowledged); collecting it here too would double-surface it in the
        // same poll. Session directives never carry over as questions.
        q.artifactId !== "__session__",
    );
    if (older.length > 0) {
      for (const q of older) {
        const entry = {
          commentId: q.question.id,
          artifactId: q.artifactId,
          content: String(q.question.content ?? "").slice(0, 200),
        };
        structuredCarryover.push(entry);
        // #225 (N1, item 2) — carried-over questions ALSO join structuredContent
        // .questions. Pre-this they landed ONLY in prose (the "↩️ carried over"
        // block) and the `unansweredCarryover` array — so a STRUCTURED-ONLY client
        // (one that branches on `.questions` and never prose-parses) never saw an
        // open question re-raised from a prior run. They're the same answer_question
        // obligation as a fresh question, so the primary lane must carry them too;
        // `carryover: true` distinguishes them for a client that cares. `older`
        // already excludes everything delivered NEW this poll (deliveredIds), so
        // there is no double-listing within `questions`. Spread-discipline holds:
        // this runs ONLY when older.length > 0, so the healthy hot-path payload
        // (empty structuredQuestions) is byte-for-byte unchanged.
        structuredQuestions.push({ ...entry, carryover: true as const });
      }
      // FIX 4 — carry the secret-warning note the normal drain appends, so a
      // carried-over question that may contain a pasted credential is flagged.
      const lines = older.map(
        (q) => `  • ${q.artifactId || "(session)"} — comment ${q.question.id}: "${String(q.question.content ?? "").slice(0, 120)}"${commentSecretNote(q.question)}`,
      );
      parts.push(
        `↩️ ${older.length} unanswered question${older.length === 1 ? "" : "s"} carried over from earlier — the human asked ${older.length === 1 ? "it" : "them"} before (possibly a previous run) and ${older.length === 1 ? "it is" : "they are"} still open. Answer each with answer_question (commentId = the question's id) before new work:\n${lines.join("\n")}`,
      );
    }
  } catch {
    // Non-fatal — carryover is best-effort; the normal drain already ran.
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

  // G1 (#198b) — pending human REQUESTS prose block. Placed AFTER the carryover
  // + REJECTED blocks (so it ranks after unanswered questions and after the
  // rejection posture, matching the suggestedAction ordering). Requests do NOT
  // drain like comments — they persist until the agent serves them (passes
  // servedRequestId on the fulfilling present_* call), so they re-surface each
  // poll like a WAITING line until served.
  if (pendingRequests.length > 0) {
    const lines = pendingRequests.map(
      (r) => `- 📨 REQUEST [${r.id}] — ${describeRequestIntent(r.intent)}: ${r.text}${requestSecretNote(r)}${requestScopeNote(r)}\n    → Serve it with the matching present_* tool, passing servedRequestId:"${r.id}" so it links back and clears here.`,
    );
    parts.push(
      `📨 Human requests (${pendingRequests.length}) — the human ASKED for ${pendingRequests.length === 1 ? "this" : "these"}. Serve with the matching present_* tool (explain→present_explainer, plan→present_plan/present_spec, status→present_debrief):\n${lines.join("\n")}`,
    );
  }

  // Resolved decisions (acknowledge so they don't repeat)
  // O3 — reuse the post-wake resolved-decisions snapshot (newResolved); no
  // acknowledge ran between the snapshot and here, so it is the same set.
  const resolved = newResolved;
  if (resolved.length > 0) {
    await store.acknowledgeDecisions(resolved.map((d) => d.decisionId));
    const formattedDecisions: string[] = [];
    for (const d of resolved) {
      const option = d.options.find((o) => o.id === d.response?.optionId);
      // P3 — the DECISION LABEL for every human-facing key this block mints.
      // M1.1 gave present_options a short fork-naming `title` and made it the
      // artifact/card/session heading, but this block kept keying on the full
      // `context` PARAGRAPH — so the ledger (and export-learnings) showed
      // "<three-line background paragraph>: Redis" where every other surface
      // showed "Cache backend: Redis". Same label everywhere now.
      //
      // BACKWARD COMPAT (load-bearing, and stated precisely because the first
      // cut of this comment overclaimed): this changes what NEW entries RECORD.
      // The BLOCKING lanes that carry the moat are key-length-invariant —
      //   - the post-colon `specificNoun` lane (findRejectedApproachMatch) sees
      //     the option title under BOTH the old paragraph-prefixed key and the
      //     new title-prefixed one, so a re-proposal of a rejected option
      //     blocks identically either way; and
      //   - the concept lane keys on option.concept.name, untouched here, so
      //     the paraphrase catch is unaffected.
      // The one lane that DID read the whole description — the reverse-phrase
      // check — was prefix-sensitive in both directions (a long key blocked any
      // short proposal appearing in the background paragraph, INCLUDING the
      // chosen winner; a short key would block a later option titled with the
      // generic fork words). It is now scoped to `specificNoun` too
      // (preflight-validator.ts), which removes both false-block classes and
      // makes this key change genuinely behavior-neutral for legitimate
      // proposals. Divergence cases pinned in
      // check-feedback-decision-title.test.ts.
      const decisionLabel = d.title?.trim() || d.context;
      if (option) {
        const approvedDescription = `${decisionLabel}: ${option.title}`;
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
          // SP2 — per-option rejection reason. Pre-SP2 every rejected
          // option was stamped with the human's single overall
          // pick-reasoning ("why I chose the winner"), so B and C — often
          // rejected for DIFFERENT reasons — compounded the same blurred
          // signal in the ledger. Prefer THIS option's own cons (its
          // specific "why it's the worse fit"); keep the winner + the
          // human's reasoning as shared context when present.
          //
          // #169 — the compose + concept-key + record/broadcast is now shared
          // with the WHOLE-CARD rejection path (rejected-option-recorder.ts):
          // recordRejectedOption keys the session ledger on
          // `${context}: ${option.title}` and the cross-project ledger on the
          // REJECTED option's own concept, so the two paths can't drift.
          const pickContext = d.response?.reasoning
            ? ` — picked "${option.title}": ${d.response.reasoning}`
            : "";
          const rejectReason = composeOptionRejectReason(rej, pickContext, d.response?.reasoning);
          await recordRejectedOption(store, broadcast, {
            context: decisionLabel,
            option: rej,
            reason: rejectReason,
            sourceArtifactId: d.artifactId,
          });
        }
      }
      formattedDecisions.push(`- Decision "${decisionLabel}": selected "${option?.title ?? d.response?.optionId}"${d.response?.reasoning ? ` (reasoning: ${d.response.reasoning})` : ""}`);
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
  // O3 — reuse the post-wake artifact snapshot (was a redundant getArtifacts).
  const planArtifacts = postWakeArtifacts.filter((a) => a.type === "plan");
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

  // #176 (Option A) — client-reported Mermaid RENDER FAILURES. The browser is
  // the only place a version-matched mermaid parse runs, so when a diagram
  // genuinely fails to render there (after the #163 repair pass), it POSTs a
  // report back. Surface it so the agent learns its diagram is broken — the
  // human is looking at a fallback/broken diagram right now. Report ONCE, then
  // acknowledge (drain), mirroring the status-change path above. NO source /
  // secret ever rides here: the store redacted a secret-shaped error/title
  // before persisting. Old stores without the drain simply yield [].
  // O3 — reuse the post-wake render-failure snapshot (was a redundant read); no
  // acknowledge ran between the snapshot and here.
  const renderFailures = postWakeRenderFailures;
  const structuredRenderFailures = renderFailures.map((f) => ({
    artifactId: f.artifactId,
    visualId: f.visualId,
    ...(f.title ? { title: f.title } : {}),
    error: f.error,
  }));
  if (renderFailures.length > 0) {
    await store.acknowledgeRenderFailures?.(
      renderFailures.map((f) => ({ artifactId: f.artifactId, visualId: f.visualId })),
    );
    const lines = renderFailures.map((f) => {
      const name = f.title ? `"${f.title}"` : `visual ${f.visualId}`;
      return `- ${name} (${f.visualId}) on artifact ${f.artifactId} failed to render: ${f.error}`;
    });
    parts.push(
      `🖼️ Diagram render failures (${renderFailures.length}) — the human sees a broken/repaired diagram:\n${lines.join("\n")}\nFix the Mermaid source and re-present the affected visual (revise_artifact).`,
    );
  }

  // Check for draft artifacts still awaiting human review
  // O3 — reuse the post-wake artifact snapshot (was a redundant getArtifacts).
  const draftArtifacts = postWakeArtifacts.filter(
    (a) => a.status === "draft" && (WAITING_DRAFT_TYPES as readonly string[]).includes(a.type),
  );
  // P3 — split the nag by WHAT THE HUMAN OWES. An EXPLAINER is read-only: its
  // footer is an ACKNOWLEDGE bar ("Got it" / "Ask more" — see
  // ArtifactStatusActions' acknowledgeMode), there is no Reject and no
  // Request-changes, so nothing about it is "awaiting your verdict". Listing it
  // under ⏳ WAITING made the agent (and the human reading the transcript)
  // treat a walk-through it was ASKED for as a blocking review obligation.
  // Explainer is the ONLY acknowledge-only type today: debrief and research
  // keep the full verdict triad (the debrief only suppresses the reject-concept
  // LEDGER write, not the verdict), so they stay in the WAITING line.
  const verdictDrafts = draftArtifacts.filter(
    (a) => !(ACKNOWLEDGE_ONLY_DRAFT_TYPES as readonly string[]).includes(a.type),
  );
  const readOnlyDrafts = draftArtifacts.filter(
    (a) => (ACKNOWLEDGE_ONLY_DRAFT_TYPES as readonly string[]).includes(a.type),
  );
  // #158 — a draft the secret scanner flagged carries the warning inline so
  // the agent knows the human is reviewing something that may contain a
  // pasted credential. Labels only (e.g. "AWS access key id") — never the
  // matched value.
  const nameDraft = (a: Artifact): string =>
    `"${a.title}" (${a.type}${a.secretWarnings?.length ? " — ⚠ possible secret detected" : ""})`;
  if (verdictDrafts.length > 0) {
    const waiting = verdictDrafts.map(nameDraft).join(", ");
    parts.push(`⏳ WAITING: ${verdictDrafts.length} artifact(s) still under review: ${waiting}\nThe human is reviewing in the companion UI. Call check_feedback again to pick up their response.`);
  }
  if (readOnlyDrafts.length > 0) {
    const toRead = readOnlyDrafts.map(nameDraft).join(", ");
    parts.push(`📖 TO READ: ${readOnlyDrafts.length} read-only artifact(s) the human hasn't acknowledged yet: ${toRead}\nThese await no verdict — they're explanations, not proposals. The human clicks "Got it" (or asks a follow-up) when they've read them. Don't block on these.`);
  }

  // P3 — the pending-decision nag, made non-self-contradicting. A round-11
  // dogfood payload reported a decision SELECTION and "⏳ WAITING: 1
  // decision(s) pending" in the same breath, which reads as the SAME decision
  // being both resolved and pending. Two things caused that read, both fixed
  // here:
  //   (a) the line was ANONYMOUS — a count with no names — so a genuinely
  //       DIFFERENT still-open decision (a re-ask, or an option set the human
  //       never picked from) was indistinguishable from the one just
  //       delivered. It now NAMES each pending decision (short M1.1 title when
  //       present, else the context, bounded) with its dec_ id.
  //   (b) the orphan class: getPendingDecisions excludes records whose artifact
  //       is superseded/retracted/rejected/obsolete, but NOT `approved` — so a
  //       decision record left response-less while its artifact reached a
  //       terminal state by any other path (the /api/decisions no-record
  //       fallback, a straight Approve on the card) nagged FOREVER. Filter both
  //       the just-delivered ids and any record whose backing artifact is no
  //       longer open, so a delivered selection can never also be counted
  //       pending.
  // `resolved` is this poll's delivered set (drained + acknowledged above).
  const deliveredDecisionIds = new Set(resolved.map((d) => d.decisionId));
  const openArtifactIds = new Set(
    postWakeArtifacts.filter((a) => a.status === "draft" || a.status === "reviewing").map((a) => a.id),
  );
  const pendingDec = (await store.getPendingDecisions()).filter(
    (d) =>
      !deliveredDecisionIds.has(d.decisionId) &&
      // A record whose artifact this session doesn't carry at all stays pending
      // (mirrors the store's own "unknown ids stay pending" stance).
      (!postWakeArtifacts.some((a) => a.id === d.artifactId) || openArtifactIds.has(d.artifactId)),
  );
  if (pendingDec.length > 0) {
    const named = pendingDec
      .map((d) => {
        const label = d.title?.trim() || d.context;
        const short = label.length > 80 ? `${label.slice(0, 79)}…` : label;
        return `"${short}" (${d.decisionId})`;
      })
      .join(", ");
    parts.push(`⏳ WAITING: ${pendingDec.length} decision(s) pending: ${named}. The human will select in the companion UI. Call check_feedback again to pick up their choice.`);
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
  // O3 — reuse the autonomy level read once above (was a redundant read).
  const autonomy = autonomyLabel;
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

  // M1 — poll give-up ceiling. The escalation above is unbounded ("continue
  // polling"); after ~6 consecutive empty polls, offer a SANCTIONED exit so the
  // agent isn't stuck spinning forever. Only appears at high pollCount (the
  // healthy/early payloads are byte-unchanged). This is TRUE thanks to #192 E1:
  // artifacts persist and open questions carry over to the next run.
  if (ctx.state.checkFeedbackPollCount >= 6 && pendingCount > 0) {
    parts.push(`🛑 After ${ctx.state.checkFeedbackPollCount} empty polls you don't have to keep spinning. It's fine to STOP here: summarize what's still pending (the ${pendingCount} artifact${pendingCount === 1 ? "" : "s"} under review) in your reply and end the run. Nothing is lost — the artifacts persist and any unanswered questions carry over to your NEXT run (they resurface on your first check_feedback and in the first-call hint). Keep polling only if you'd rather wait.`);
  }

  // B3 — the machine-readable mirror. status: feedback (something to act on),
  // waiting (drafts/decisions/plans pending), or proceed.
  // V-fix — a HUMAN status change (e.g. approving a v2 draft) IS actionable:
  // the agent can now build against the approved artifact, so it should flip
  // status to 'feedback'/proceed rather than stay 'waiting'. Fold
  // changed.length into the signal alongside comments/rejected/plan verdicts.
  const hasActionableFeedback =
    hasNewFeedback || freshlyRejected.length > 0 || freshPlanVerdicts > 0 || changed.length > 0 ||
    // #176 — a broken diagram the human is staring at is actionable: the agent
    // should fix + re-present, not sit in 'waiting'.
    renderFailures.length > 0 ||
    // G1 (#198b) — a pending human request is something to act on (serve it).
    pendingRequests.length > 0;
  const status = hasActionableFeedback ? "feedback" : pendingCount > 0 ? "waiting" : "proceed";
  // N2 (#226 scope 5) — reflect any mid-call daemon self-heal to a new port in
  // companionUrl (below) and capture the one-line prose nudge for the text.
  // No-op (empty string, companionUrl unchanged) unless the port actually moved.
  const portNote = portRecoveryNote();
  const structuredContent = {
    status,
    // M3 — busy-poll dedup: the full suggestedAction can run long on busy polls
    // and it ALREADY rides the prose preamble ("Suggested action: …") verbatim.
    // On a busy poll (waiting/feedback) drop the machine-readable echo — `status`
    // + the structured lists carry the actionable signal, and the prose keeps
    // the full text. On the healthy 'proceed' hot path the default is short and
    // the byte-for-byte payload contract keeps it (see check-feedback-test-
    // helpers HEALTHY_CHECK_FEEDBACK_KEYS).
    ...(status === "proceed" ? { suggestedAction } : {}),
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
      // #171 — surface a changeset's per-file review progress so the agent can
      // see which files the human has reviewed/skipped (and where your comments
      // concentrate). Spread only for changesets that carry state, so every
      // other pending entry stays byte-for-byte unchanged.
      ...changesetReviewField(a),
    })),
    questions: structuredQuestions,
    comments: structuredComments,
    decisions: structuredDecisions,
    // #172 — spread ONLY when there are suggestions to act on, so the healthy /
    // no-suggestion poll payload stays byte-for-byte (contract lock in
    // check-feedback-ledger-health.test.ts).
    ...(structuredSuggestions.length > 0 ? { suggestions: structuredSuggestions } : {}),
    rejected: freshlyRejected.map((a) => ({ id: a.id, type: a.type, title: a.title })),
    statusChanges: structuredStatusChanges,
    // #192 — spread `unansweredCarryover` ONLY when older unanswered questions
    // exist, so the healthy poll payload's top-level key set stays byte-for-byte
    // (contract lock in check-feedback-ledger-health.test.ts / the golden SHA).
    ...(structuredCarryover.length > 0 ? { unansweredCarryover: structuredCarryover } : {}),
    // #176 — spread `renderFailures` ONLY when a diagram broke, so the healthy
    // poll payload's top-level key set stays byte-for-byte (contract lock in
    // check-feedback-ledger-health.test.ts). Never carries source or a secret.
    ...(structuredRenderFailures.length > 0 ? { renderFailures: structuredRenderFailures } : {}),
    // G1 (#198b) — spread `requests` ONLY when the human has an unserved request,
    // so the healthy poll payload's top-level key set stays byte-for-byte (same
    // contract lock as renderFailures/unansweredCarryover above).
    ...(pendingRequests.length > 0
      ? {
          requests: pendingRequests.map((r) => ({
            id: r.id,
            text: r.text,
            intent: r.intent,
            // P2 — the UI-supplied provenance + scope ride the SAME only-when-present
            // spread discipline as the keys above: a plain composer request's entry
            // stays byte-identical, while a walk-me-through request carries the exact
            // file/line/artifact the explainer must be scoped (and linked) to.
            ...(r.source ? { source: r.source } : {}),
            ...(r.scope ? { scope: r.scope } : {}),
          })),
        }
      : {}),
    // H2-1 — spreads `ledgerHealth` ONLY when the global ledger is frozen;
    // spreads nothing (byte-for-byte-unchanged payload) when healthy.
    ...ledgerHealthField(),
  };

  // If only the preamble exists (no feedback, no waits), give a clean proceed signal
  const [preamble] = parts;
  if (parts.length === 1 && preamble !== undefined) {
    return {
      content: [{ type: "text", text: `${preamble}${portNote}` }],
      structuredContent,
    };
  }

  return {
    content: [{ type: "text", text: `${parts.join("\n\n")}${portNote}` }],
    structuredContent,
  };
}
