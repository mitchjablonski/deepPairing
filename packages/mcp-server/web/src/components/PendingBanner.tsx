import { useEffect, useMemo, useState } from "react";
import type { Artifact } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { useConnectionStore } from "../stores/connection";
import { useReplayStore } from "../stores/replay";
import { usePreflightBlockStore } from "../stores/preflightBlocks";
import { computePending, isSinglePendingInView } from "../lib/pending";
import { computeAttention } from "../lib/attention";
import { attentionHolds, copyFor, copyLineText, reachFrom } from "../lib/attentionCopy";
import { noAgentLive } from "../lib/liveness";
import { useTabOffline } from "../lib/connectionGrace";
import { sessionLabelsFrom } from "../lib/sessionLabel";
import { useOfflineReason } from "../hooks/useOfflineReason";
import { DemoTag } from "./ProvenanceMarker";

/**
 * The "waiting for your review" banner. Driven by the shared computePending
 * selector (lib/pending) so it counts the SAME set as the cross-project badge —
 * draft reviewable artifacts that are genuinely YOUR turn. Human-asked questions
 * are NOT shown here: they're the agent's turn (TurnIndicator surfaces them as a
 * "waiting on the agent" badge), and a "waiting on you" banner you can't action
 * is just a nag.
 *
 * Every counted draft gets a quick "Dismiss" here (marks it obsolete), so an
 * abandoned draft can be cleared without opening the artifact and hunting for
 * the tertiary dismiss link.
 *
 * #430 slice 1 — the default view's needs-you line. The LEAD chip is the
 * attention model's `next` (most consequential first), and under the chips one
 * line says what it is, what waits on it and what happens when you respond —
 * from lib/attentionCopy, the SAME module the opt-in Next-up bar reads. The
 * count, the 3-chip cap, "+N more", Open and the two-step dismiss are
 * unchanged; the old pulse is gone (words, not motion). This deliberately
 * revises PR 3's "OFF exactly as before" for the lead item only (Astra's scope
 * review, condition 4).
 */
export function PendingBanner() {
  const offline = useOfflineReason(); // #467 review — the dismiss chip is an act
  const artifacts = useArtifactStore((s) => s.artifacts);
  const selectArtifact = useArtifactStore((s) => s.selectArtifact);
  const selectedArtifactId = useArtifactStore((s) => s.selectedArtifactId);
  const updateArtifactStatus = useArtifactStore((s) => s.updateArtifactStatus);
  // UX5 — dismissing marks a draft obsolete, which the API can't undo back to
  // draft, so require a two-step confirm instead of a one-click destructive ✕.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const sampleContent = useArtifactStore((s) => s.sampleContent);
  const sampleSessionIds = useArtifactStore((s) => s.sampleSessionIds);
  const activeSessions = useConnectionStore((s) => s.activeSessions);
  const boundSessionId = useConnectionStore((s) => s.sessionId);
  const replayActive = useReplayStore((s) => s.active);
  const tabOffline = useTabOffline();
  const blocks = usePreflightBlockStore((s) => s.blocks);
  const lastSeenAt = usePreflightBlockStore((s) => s.lastSeenAt);

  const { drafts, total } = computePending(artifacts);
  // The Decide set IS computePending's drafts (parity-tested), so `next` is one
  // of `drafts` (only the order differs) — or a terminal-held hook `ask`, which
  // has no chip: it is answered in the terminal, never dismissed here.
  const sessionLabels = useMemo(() => sessionLabelsFrom(activeSessions), [activeSessions]);
  // Holds are passed so a terminal-held hook `ask` can lead (blocking tier,
  // #430 slice 1) exactly as on the bar; the count below is still drafts only.
  const next = useMemo(() => computeAttention({
    artifacts, sessionLabels, boundSessionId, sample: { content: sampleContent, sessionIds: sampleSessionIds },
    system: { holds: attentionHolds(blocks, lastSeenAt) },
  }).next, [artifacts, sessionLabels, boundSessionId, sampleContent, sampleSessionIds, blocks, lastSeenAt]);
  const reach = reachFrom({ replay: replayActive, tabOffline, agentGone: noAgentLive(activeSessions) });
  const copy = next ? copyFor(next, artifacts, reach, blocks) : null;
  const lead = next ? drafts.find((d) => d.id === next.artifactId) : undefined;
  const others = lead ? drafts.filter((d) => d !== lead) : drafts;
  const shown: Artifact[] = lead ? [lead, ...others.slice(0, 2)] : others.slice(0, 3);
  const hidden = lead ? others.slice(2) : others.slice(3);
  // J2b (#212) — lite-frame step-down: when the ONE pending draft is the card
  // already on screen, it IS the call to action (its own status badge + review
  // actions), so this banner would just restate what the card + the header count
  // pill already say. Suppress it. The shared predicate keeps this in lockstep
  // with the header-pill collapse in App (they can't disagree). The banner still
  // shows for 2+ pending and when the single pending draft is NOT selected (the
  // scent to reach it) — see isSinglePendingInView.
  const suppressed = isSinglePendingInView(artifacts, selectedArtifactId);

  // Review (LOW) — the suppression is an in-component early return, so this
  // instance never UNMOUNTS: a chip left in the armed "Dismiss?" state would
  // persist across a suppress → reappear cycle (select the draft to hide the
  // banner, deselect to bring it back), collapsing the two-step confirm to a
  // single click across a hidden interval. Disarm whenever we suppress, so the
  // banner always reappears with its chips reset (the onBlur reset can't fire —
  // an unmounted-by-return chip never blurs).
  // #430 slice 1 (Sol review 5676282653, P1) — a terminal-held hook `ask` is
  // not an artifact card: the empty-drafts and single-card-in-view step-downs
  // are artifact-only, so they never hide a held lead (it has no card to be
  // the call to action). Draft count membership is unchanged.
  const heldLead = next?.kind === "held" && next.terminal === true;
  const bannerHidden = !heldLead && (total === 0 || suppressed);
  useEffect(() => {
    if (bannerHidden) setConfirmingId(null);
  }, [bannerHidden]);

  if (bannerHidden) return null;

  return (
    // Q4 review (L5) — a named landmark. This strip is the app's "what needs
    // you" summary and its chips jump straight to those drafts, but it sat
    // outside every landmark, so axe's `region` rule flagged its text and a
    // screen-reader user could not jump to the one surface that says what to
    // do next.
    <div
      role="region"
      aria-label="Waiting for you"
      data-testid="pending-banner"
      className="px-3 py-1 bg-accent-amber-dim/50 border-b border-accent-amber/15"
    >
      <div className="flex items-center gap-2 min-w-0">
      {/* #430 slice 1 — no pulse: the line below says what waits, in words. */}
      {total > 0 && (
        <span className="text-2xs text-accent-amber font-medium shrink-0">
          {total} item{total > 1 ? "s" : ""} waiting for you
        </span>
      )}
      <div className="flex gap-1 ml-auto items-center min-w-0 overflow-x-auto">
        {shown.map((a) => (
          <span key={a.id} className="flex items-center bg-accent-amber-dim rounded shrink-0">
            <button
              onClick={() => selectArtifact(a.id)}
              className="px-2 py-0.5 text-accent-amber rounded-l text-2xs hover:bg-accent-amber-dim/80 transition-colors"
              title={a.title}
            >
              {a.title.slice(0, 28)}{a.title.length > 28 ? "…" : ""}
            </button>
            {/* Quick dismiss — clears an abandoned/moot draft without opening it.
                Two-step: first click asks to confirm (obsolete can't be undone). */}
            <button
              disabled={!!offline}
              onClick={() => {
                if (confirmingId === a.id) {
                  // store rolls back + toasts on failure; swallow so a failed
                  // POST isn't an unhandled rejection (UX7d theme)
                  void updateArtifactStatus(a.id, "obsolete").catch(() => {});
                  setConfirmingId(null);
                } else {
                  setConfirmingId(a.id);
                }
              }}
              onBlur={() => setConfirmingId((id) => (id === a.id ? null : id))}
              // Q4 (round-12 UX #3) — the waiting strip's measured AA failure.
              // The sibling "+N more" comment below already names this class,
              // but the dismiss chip kept its /70: composited it lands at
              // #a88743 on the chip's own amber-dim fill = 3.13:1 light /
              // 3.58:1 dark, both under AA, on the control that DESTROYS a
              // draft. The /70 only bought a rest-vs-hover distinction the
              // hover BACKGROUND already carries — drop it and the same chip
              // reads 5.85:1 light / 5.61:1 dark.
              className={`px-1.5 py-0.5 rounded-r text-2xs border-l border-accent-amber/20 transition-colors ${
                confirmingId === a.id
                  ? "text-accent-amber font-semibold bg-accent-amber-dim"
                  : "text-accent-amber hover:bg-accent-amber-dim/80"
              }`}
              title={offline ?? (confirmingId === a.id ? "Click again to dismiss (can't be undone)" : "Dismiss — overcome by new information")}
              aria-label={confirmingId === a.id ? `Confirm dismiss ${a.title}` : `Dismiss ${a.title}`}
            >
              {confirmingId === a.id ? "Dismiss?" : "✕"}
            </button>
          </span>
        ))}
        {/* #192 (usability L8) — the chip strip is capped at 3, so with 5+
            pending the debrief/explainer (created last, at the end of a run) fell
            off silently. A quiet "+N more" jumps to the first hidden draft
            (advancing into the tail like the n-key), and its title lists them. */}
        {hidden.length > 0 && (
          <button
            onClick={() => selectArtifact(hidden[0]!.id)}
            // Sits on the chip background (like the sibling chips) rather than the
            // darker banner surface so the small text keeps AA contrast (a bare
            // text-accent-amber/70 on the banner bg fails 4.5:1 — caught by axe).
            className="px-2 py-0.5 text-2xs text-accent-amber bg-accent-amber-dim rounded shrink-0 hover:bg-accent-amber-dim/80 transition-colors"
            title={`${hidden.length} more waiting: ${hidden.map((d) => d.title).join(", ")}`}
            aria-label={`${hidden.length} more waiting — jump to the next`}
          >
            +{hidden.length} more
          </button>
        )}
      </div>
      </div>
      {/* #430 slice 1 — the lead item's line: what, if you leave it, after.
          Plain text (no controls inside, so nothing nests), wraps rather than
          truncating, existing contrast tokens only, no opacity on text. */}
      {next && copy && (
        <div data-testid="pending-next" data-next-copy={copyLineText(next.title, copy)} className="text-2xs pb-0.5 min-w-0">
          <p className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 min-w-0 text-text-primary">
            {copy.lane && <span className="font-semibold tracking-wide text-accent-amber">{copy.lane}</span>}
            <span className="font-medium text-text-primary break-words min-w-0">{next.title}</span>
            {copy.tags.map((t) => t === "Demo"
              ? <DemoTag key={t} />
              : (
                <span
                  key={t}
                  className={`px-1 rounded font-semibold ${t === "HIGH" ? "bg-accent-red-dim text-accent-red" : "bg-surface-elevated text-text-secondary"}`}
                >
                  {t}
                </span>
              ))}
            {next.sessionLabel && <span>in {next.sessionLabel}</span>}
            {copy.ifIgnored && <span data-testid="pending-if-ignored">· {copy.ifIgnored}</span>}
            {copy.after && <span data-testid="pending-after">· {copy.after}</span>}
          </p>
          {copy.why && (
            <p data-testid="pending-why" className="text-text-primary line-clamp-2 break-words" title={copy.why}>
              <span className="font-medium">Why </span>{copy.why}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
