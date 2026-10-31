import { useEffect, useId, useMemo, useState } from "react";
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
/** Focus expansion is BOUNDED (≈4 lines, then the row scrolls) so a long
 *  why/after can never push the composer or the content off screen. */
const EXPANDED_LEAD = "whitespace-normal break-words max-h-16 overflow-y-auto";

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
  // The lead line is ONE truncated row; it unwraps while the lead chip (the
  // single keyboard stop for the lead) or the held row has focus, and the
  // chip names the line as its description so the full what/after/why text
  // (incl. the terminal instruction) is announced on focus.
  // Sol a341 P2 — track WHICH chip has focus, not a bare boolean: when a new
  // lead arrives while the old lead's chip is focused, expansion is derived
  // against the current lead (false), and the old chip keeps its own blur
  // handler, so ownership clears on Tab away without moving focus.
  const leadLineId = useId();
  const [focusedChipId, setFocusedChipId] = useState<string | null>(null);
  const leadExpanded = !!lead && focusedChipId === lead.id;
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
      {/* The lead line shares the one row (S2 chrome budget) only while it gets
          a readable 15rem; whenever it would be narrower it wraps to the next
          row (flex-wrap + min-width), decided by the AVAILABLE width — not a
          viewport breakpoint, so 200% zoom at exactly 640px wraps too (e2e). */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0">
      {/* #430 slice 1 — no pulse: the lead line beside says what waits, in words. */}
      {total > 0 && (
        <span className="text-2xs text-accent-amber font-medium shrink-0">
          {total} item{total > 1 ? "s" : ""} waiting for you
        </span>
      )}
      {/* #430 slice 1 — the lead item's line: what, if you leave it, after, why.
          ONE row, truncated (round-14 "chrome before code" budget, e2e S2):
          the full text is the row's hover title, stays in the accessibility
          tree, and the row unwraps while its title control has focus. The
          title opens the lead artifact (a held hook ask has none — plain text,
          focusable so keyboard users can unwrap it too). Existing contrast
          tokens only, no opacity on text. Full text is also announced: the
          lead chip's aria-describedby names this row; a held row is a named
          group. */}
      {next && copy && (
        <div
          data-testid="pending-next"
          data-next-copy={copyLineText(next.title, copy)}
          title={copy.why ? `${copyLineText(next.title, copy)} · Why ${copy.why}` : copyLineText(next.title, copy)}
          id={leadLineId}
          // A held hook ask has no chip: the row itself is the keyboard stop,
          // a named group so its full text (the terminal instruction) is read.
          {...(next.artifactId ? {} : { tabIndex: 0, role: "group", "aria-label": copy.why ? `${copyLineText(next.title, copy)} · Why ${copy.why}` : copyLineText(next.title, copy) })}
          className={`basis-0 grow min-w-[min(15rem,100%)] text-2xs text-text-primary focus:whitespace-normal focus:break-words focus:max-h-16 focus:overflow-y-auto outline-none focus-visible:ring-1 focus-visible:ring-accent-amber rounded ${leadExpanded ? EXPANDED_LEAD : "truncate"}`}
        >
          {copy.lane && <><span className="font-semibold tracking-wide text-accent-amber">{copy.lane}</span>{" "}</>}
          {next.artifactId ? (
            // Mouse convenience: the lead CHIP is the keyboard stop for the
            // same artifact, so this redundant control stays out of tab order.
            <button
              type="button"
              tabIndex={-1}
              onClick={() => selectArtifact(next.artifactId!)}
              className="font-medium text-text-primary hover:underline focus-visible:underline outline-none"
            >
              {next.title}
            </button>
          ) : (
            <span className="font-medium text-text-primary">{next.title}</span>
          )}
          {copy.tags.map((t) => (
            <span key={t}>
              {" "}
              {t === "Demo"
                ? <DemoTag />
                : <span className={`px-1 rounded font-semibold ${t === "HIGH" ? "bg-accent-red-dim text-accent-red" : "bg-surface-elevated text-text-secondary"}`}>{t}</span>}
            </span>
          ))}
          {next.sessionLabel && <span> in {next.sessionLabel}</span>}
          {copy.ifIgnored && <>{" "}<span data-testid="pending-if-ignored">· {copy.ifIgnored}</span></>}
          {copy.after && <>{" "}<span data-testid="pending-after">· {copy.after}</span></>}
          {copy.why && (
            <>{" "}<span data-testid="pending-why">· <span className="font-medium">Why </span>{copy.why}</span></>
          )}
        </div>
      )}
      <div className="flex gap-1 ml-auto items-center min-w-0 max-w-[50%] shrink-0 overflow-x-auto">
        {shown.map((a) => (
          <span key={a.id} className="flex items-center bg-accent-amber-dim rounded shrink-0">
            <button
              onClick={() => selectArtifact(a.id)}
              {...(a === lead && next && copy ? { "aria-describedby": leadLineId } : {})}
              onFocus={() => setFocusedChipId(a.id)}
              onBlur={() => setFocusedChipId((id) => (id === a.id ? null : id))}
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
    </div>
  );
}
