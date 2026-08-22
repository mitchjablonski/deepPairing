import { useEffect, useMemo, useState } from "react";
import type { Comment } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { useConnectionStore } from "../stores/connection";
import { computePending, summarizeTurnParts } from "../lib/pending";
import { isUnansweredQuestion } from "../lib/unanswered";
import { buildThreads } from "../lib/threading";

/**
 * Top-header turn indicator + agent narration pill.
 *
 * States:
 *   - Disconnected → hidden
 *   - Pending human action → amber "Your turn — X findings, Y decisions"
 *   - Otherwise → blue "Agent working" + a rolling narration line pulled
 *     from the most recent log_reasoning.action. This is the "watching a
 *     peer think" mechanic: instead of a static spinner, the human sees
 *     what the agent is currently working on.
 */
/**
 * F2 (#196 M4) — banner-soup dedup. When the sibling PendingBanner /
 * ResumeQuestionsBanner is visible (App passes these flags), the matching
 * header pill collapses to a count-only badge so the same fact doesn't render
 * verbatim twice (pills summarize, banners act). Both default false, so the
 * component renders the full pills in isolation (tests) and whenever a banner
 * is dismissed/absent.
 *
 * J2b (#212) — the same collapse also fires when the PendingBanner is
 * SUPPRESSED because the one pending draft is the card on screen
 * (`pendingCardInView`). The banner is gone, but the full "Your turn — 1 finding"
 * breakdown would still restate what the visible card already says, so the pill
 * steps down to the bare count summary too — the frame carries the fact once.
 */
export function TurnIndicator({
  pendingBannerVisible = false,
  questionsBannerVisible = false,
  pendingCardInView = false,
}: {
  pendingBannerVisible?: boolean;
  questionsBannerVisible?: boolean;
  pendingCardInView?: boolean;
} = {}) {
  const artifacts = useArtifactStore((s) => s.artifacts);
  const comments = useArtifactStore((s) => s.comments);
  const selectArtifact = useArtifactStore((s) => s.selectArtifact);
  const selectedArtifactId = useArtifactStore((s) => s.selectedArtifactId);
  const connected = useConnectionStore((s) => s.connected);
  // B2 — heartbeat liveness. The daemon broadcasts a throttled agent_activity
  // on every internal API call the wrapper makes, so this keeps ticking during
  // a long edit run where no artifact/comment lands (the timestamps below go
  // quiet and the old inference flipped to "Up to date" on a busy agent).
  const agentActivityAt = useConnectionStore((s) => s.agentActivityAt);
  const agentActiveSince = useConnectionStore((s) => s.agentActiveSince);

  const latestReasoningAction = useMemo(() => {
    // Walk backward through artifacts to find the most recent reasoning
    // artifact; use its action field as the narration.
    for (let i = artifacts.length - 1; i >= 0; i--) {
      const a = artifacts[i]!; // `!` safe: 0 <= i < artifacts.length loop bound
      if (a.type === "reasoning" && a.status !== "superseded" && a.status !== "retracted") {
        const action = (a.content as any)?.action;
        if (typeof action === "string" && action.trim()) return action.trim();
      }
    }
    return null;
  }, [artifacts]);

  // D10 (H2) — when an approved plan is mid-execution, say WHICH step
  // instead of the generic "working": the post-approval build was the
  // longest unnarrated stretch in the session.
  const planProgress = useMemo(() => {
    // Newest first (latestReasoningAction's idiom): an older abandoned
    // half-tracked plan must not mask the one actually executing. Terminal
    // statuses never narrate "Executing".
    for (let i = artifacts.length - 1; i >= 0; i--) {
      const a = artifacts[i]!; // `!` safe: 0 <= i < artifacts.length loop bound
      if (
        a.type !== "plan" ||
        ["draft", "superseded", "rejected", "retracted", "obsolete"].includes(a.status)
      ) continue;
      const steps = (a.content as { steps?: Array<{ status?: string }> } | null)?.steps;
      if (!Array.isArray(steps) || !steps.some((st) => st?.status)) continue;
      const done = steps.filter((st) => st?.status === "done" || st?.status === "skipped").length;
      if (done === steps.length) continue; // finished plans go back to generic copy
      const active = steps.findIndex((st) => st?.status === "in_progress");
      return { current: active >= 0 ? active + 1 : Math.min(done + 1, steps.length), total: steps.length };
    }
    return null;
  }, [artifacts]);

  // Q4: aggregate unanswered questions across all artifacts so the badge
  // surfaces "N waiting on agent" at a glance. Points at the first-asked
  // unanswered question when clicked.
  const unanswered = useMemo(() => {
    // H1 — the SHARED predicate over threads, not a private flat filter:
    // the old filter counted a root as waiting even after the agent
    // answered a FOLLOW-UP (markCommentAnswered stamps the reply id, not
    // the root) — this badge said "1 waiting" while the Conversation badge
    // and rail said answered. buildThreads + isUnansweredQuestion is the
    // exact pair those surfaces use, so the three can't drift.
    const out: Array<{ artifactId: string; comment: Comment }> = [];
    for (const [artifactId, list] of Object.entries(comments)) {
      for (const t of buildThreads(list as Comment[])) {
        if (isUnansweredQuestion(t.root, t.replies)) {
          out.push({ artifactId, comment: t.root });
        }
      }
    }
    out.sort((a, b) => a.comment.createdAt.localeCompare(b.comment.createdAt));
    return out;
  }, [comments]);

  // U2 — liveness: the newest artifact/comment timestamp. After AGENT_IDLE_MS
  // with no new activity we stop claiming "Agent working" (the old behavior
  // pulsed forever, telling the human to keep waiting on an idle/finished
  // agent). A timer flips `idle` so it updates even without a re-render.
  const lastActivityMs = useMemo(() => {
    let max = 0;
    for (const a of artifacts) {
      const t = new Date(a.createdAt).getTime();
      if (Number.isFinite(t) && t > max) max = t;
    }
    for (const list of Object.values(comments)) {
      for (const c of list as Comment[]) {
        // M3 — only AGENT-authored comments count as agent liveness. A human
        // posting a comment while the agent is gone used to bump this, pulsing
        // "Agent working" for 45s over an exited agent (the composer below said
        // otherwise). Human input is never proof the agent is alive.
        if (c.author !== "agent") continue;
        const t = new Date(c.createdAt).getTime();
        if (Number.isFinite(t) && t > max) max = t;
      }
    }
    return max;
  }, [artifacts, comments]);

  const AGENT_IDLE_MS = 45_000;
  // B2 — liveness = max(artifact/comment timestamps, heartbeat). Either signal
  // keeps "Agent working" honest; the heartbeat covers the artifact-quiet gaps.
  const effectiveActivityMs = Math.max(lastActivityMs, agentActivityAt ?? 0);
  const [idle, setIdle] = useState(false);
  // C2 — zero signal ever (no artifact, no comment, no heartbeat) must NOT
  // claim "Agent working": pre-C2 that claim was unfalsifiable at t=0 — it
  // pulsed forever even if Claude had exited. The B2 heartbeat fires on the
  // wrapper's very first internal call (session register), so a live agent
  // produces a signal within seconds; until then say "Connected" honestly.
  const neverActive = effectiveActivityMs === 0;
  useEffect(() => {
    setIdle(false);
    if (!effectiveActivityMs) return;
    const remaining = AGENT_IDLE_MS - (Date.now() - effectiveActivityMs);
    if (remaining <= 0) { setIdle(true); return; }
    const t = setTimeout(() => setIdle(true), remaining);
    return () => clearTimeout(t);
  }, [effectiveActivityMs]);

  // B2 — elapsed "· Nm" label while working: waiting becomes watching a peer
  // think, not staring at a pulse dot. nowTick exists ONLY to force a re-render
  // every 30s; the render itself always reads fresh Date.now().
  const [, setNowTick] = useState(0);
  useEffect(() => {
    if (idle || !agentActiveSince) return;
    const t = setInterval(() => setNowTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [idle, agentActiveSince]);
  const elapsedMin =
    !idle && agentActiveSince ? Math.floor((Date.now() - agentActiveSince) / 60_000) : 0;

  // F8 (M6, review-hardened) — "waiting on the agent" is a promise; the
  // badge aggregates questions ACROSS sessions, so it stays honest if ANY
  // question's owning session can still answer. Hook lives ABOVE the early
  // returns (D10's exact rules-of-hooks lesson — the local e2e caught the
  // repeat before push).
  const activeSessions = useConnectionStore((st) => st.activeSessions);
  // M3 — the exited signal for the agent's-turn pill: a session explicitly
  // reported gone (live:false) and none is live. A merely-absent session list
  // (fresh connect, no registration yet) is NOT "exited" — that stays the
  // neverActive "Connected — waiting" beat. Mirrors ResumeQuestionsBanner.
  const hasDeadSession = activeSessions.some((s) => s.live === false);
  const anyAgentLive = activeSessions.some((s) => s.live !== false);
  const agentExited = hasDeadSession && !anyAgentLive;

  if (!connected) return null;

  // UX1 — derive the whose-turn signal from the SAME predicate PendingBanner
  // uses (lib/pending), so the header can't disagree with the banner. Pre-UX1
  // this used an inline filter that omitted code_change, so a draft code change
  // showed "1 waiting" in the banner but "Agent working"/"Up to date" here.
  const pending = computePending(artifacts).drafts;
  const totalPending = pending.length;

  // Q4 — badge rendered alongside the turn pill. Violet = "waiting on agent"
  // (inverse of the amber "your turn"). Click jumps to the oldest unanswered
  // question so the user can see what was asked.
  const anyAnswerable = unanswered.some(
    (q) => activeSessions.find((x) => x.sessionId === q.comment.sessionId)?.live !== false,
  );
  // M4 — when ResumeQuestionsBanner is showing (agent exited + open questions),
  // its "N questions waiting for Claude" is the actionable surface; this header
  // badge collapses to a count-only chip so the label isn't rendered twice. The
  // "(agent exited)" wording also moves OUT of this badge — the agent's-turn
  // pill now states "Agent exited" once, canonically (M3).
  const questionsBadge = unanswered.length > 0 ? (
    <button
      type="button"
      onClick={() => {
        const first = unanswered[0];
        if (first) selectArtifact(first.artifactId);
      }}
      title={anyAnswerable
        ? `${unanswered.length} question${unanswered.length > 1 ? "s" : ""} waiting on the agent — click to jump`
        : `${unanswered.length} unanswered question${unanswered.length > 1 ? "s" : ""} — the agent exited; they'll be seen if the session resumes`}
      // Only override the accessible name in COMPACT mode (visible text is a
      // bare count then); in full mode the visible label is the name.
      aria-label={questionsBannerVisible
        ? `${unanswered.length} unanswered question${unanswered.length > 1 ? "s" : ""} — click to jump`
        : undefined}
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-2xs font-medium bg-accent-violet-dim text-accent-violet shrink-0 hover:bg-accent-violet-dim/80 transition-colors"
    >
      <span className="font-bold">❓</span>
      {questionsBannerVisible
        ? unanswered.length
        : <>{unanswered.length} question{unanswered.length > 1 ? "s" : ""} {anyAnswerable ? "waiting" : "unanswered"}</>}
    </button>
  ) : null;

  if (totalPending > 0) {
    // #192 (usability H1) — the bucket-table summary counts EVERY reviewable
    // type (changeset/debrief/explainer included) and falls back to "N items"
    // if a future type isn't yet bucketed, so this can never render a dangling
    // "Your turn —" while the tab badge shows a count.
    const parts = summarizeTurnParts(pending);

    // B1 — the strongest CTA in the app was a plain div: the user read "Your
    // turn" then had to go hunt in the sidebar. Clicking jumps to the first
    // pending artifact; repeated clicks cycle through them.
    const jumpToPending = () => {
      if (pending.length === 0) return;
      const idx = pending.findIndex((a) => a.id === selectedArtifactId);
      const next = pending[(idx + 1) % pending.length]; // idx=-1 → pending[0]
      if (next) selectArtifact(next.id);
    };

    return (
      <div className="flex items-center gap-2 min-w-0" role="status" aria-live="polite">
        <button
          type="button"
          onClick={jumpToPending}
          title={`Your turn — ${parts.join(", ")}${pending.length > 1 ? " · click to jump to the next item" : " · click to jump"}`}
          aria-label={`Your turn — ${parts.join(", ")} · click to jump`}
          // #189 — TRUNCATES instead of shrink-0. At the VS Code webview width
          // (~900px) the full "Your turn — 1 finding, 1 decision, 1 change, 1
          // plan" string forced the pill past the nav and garbled the labels.
          // min-w-0 + truncate lets it yield; the full text stays in the title.
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-2xs font-medium bg-accent-amber-dim text-accent-amber min-w-0 hover:brightness-110 transition-[filter] cursor-pointer"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-accent-amber animate-pulse shrink-0" />
          {/* M4 — PendingBanner (right below the header) lists these items with
              jump + dismiss chips, so when it's visible the header pill drops
              its verbatim "1 finding, 1 decision" breakdown; the full text stays
              in the title + aria-label.
              S2 (round-14) — the pending TOTAL is the ONE authoritative signal,
              and the visible banner OWNS it ("N items waiting for you" + chips +
              jump). So when the banner is up the header pill drops the number
              entirely — a bare "Your turn" jump affordance — instead of
              restating the same count one band above the banner (the round-14
              "pending count drawn 4×" dedup). J2b (#212) — when the banner is
              SUPPRESSED because the one pending draft is the card in view, the
              banner is gone, so the header becomes the count source: it keeps
              "N for you". */}
          <span className="truncate">
            {pendingBannerVisible
              ? "Your turn"
              : pendingCardInView
                ? `${totalPending} for you`
                : `Your turn — ${parts.join(", ")}`}
          </span>
        </button>
        {questionsBadge}
      </div>
    );
  }

  // Agent's turn. While there's recent activity, show "Agent working" + a
  // narration line ("watch your peer think"); once idle past the threshold,
  // switch to a neutral "Up to date" so we don't pulse forever at an agent
  // that's finished or gone.
  return (
    <div className="flex items-center gap-2 min-w-0" role="status" aria-live="polite">
      {agentExited ? (
        // M3 — the bound session's wrapper exited. The old branch only knew
        // "Agent working"/"Up to date" (both wrong: the agent is gone, not
        // idle), so a comment posted now pulsed "Agent working" for 45s. No
        // pulse — nothing is happening — and a resume voice matching the
        // composer + ResumeQuestionsBanner below.
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-2xs font-medium bg-surface-elevated text-text-muted shrink-0" title="The agent's session ended. Resume it in Claude Code to continue.">
          <span className="w-1.5 h-1.5 rounded-full bg-text-muted/50" />
          Agent exited — resume to continue
        </div>
      ) : neverActive ? (
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-2xs font-medium bg-surface-elevated text-text-muted shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-accent-blue/60" />
          Connected — waiting for the agent's first move
        </div>
      ) : idle ? (
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-2xs font-medium bg-surface-elevated text-text-muted shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-text-muted/50" />
          Up to date
        </div>
      ) : (
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-2xs font-medium bg-surface-elevated text-text-muted shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-accent-blue animate-pulse" />
          {planProgress
            ? `Executing plan — step ${planProgress.current} of ${planProgress.total}`
            : "Agent working"}{elapsedMin >= 1 ? ` · ${elapsedMin}m` : ""}
        </div>
      )}
      {questionsBadge}
      {!idle && !agentExited && latestReasoningAction && (
        <span
          className="text-2xs text-text-muted truncate italic min-w-0 max-w-md"
          title={latestReasoningAction}
        >
          {latestReasoningAction}
        </span>
      )}
    </div>
  );
}
