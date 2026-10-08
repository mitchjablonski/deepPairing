import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Artifact } from "@deeppairing/shared";
import { useArtifactStore, artifactStoreGeneration, isBackfilled } from "../stores/artifact";
import { useConnectionStore } from "../stores/connection";
import { useReplayStore } from "../stores/replay";
import { usePreflightBlockStore } from "../stores/preflightBlocks";
import { computeAttention, type Attention, type AttentionItem, type FailureKind, type SummaryLane } from "../lib/attention";
import { noAgentLive } from "../lib/liveness";
import { useTabOffline, useConnectionGraceStore, useHydrationStalled, HYDRATION_STALLED_TEXT, reloadPage } from "../lib/connectionGrace";
import { useSiblingSyncStore } from "../lib/siblingSync";
import { sessionLabelsFrom } from "../lib/sessionLabel";
import { WAITING_TONE } from "../lib/waitingTone";
import { LANE_MARKS, NOTHING_GLYPH } from "../lib/laneMarks";
import { resumePromptFor } from "./ResumeQuestionsBanner";
import { RequestPips, RequestResumeButton, useRequestResumeBridge } from "./RequestComposerBanner";

/**
 * #430 PR 2 — THE NEXT-UP BAR (docs/design/attention-hierarchy.md §4). One line
 * under the session tabs that answers: what is next, why it matters, and what
 * happens after you respond. Rendered ONLY from `computeAttention` (PR 1a) —
 * lanes, the oldest-first `next`, "+N high decision" and the §4.3 precedence —
 * so it can never disagree with the model the rest of the redesign reads.
 *
 * PR 2 scope: behind the `nextUpBar` preference (default OFF), shown IN
 * ADDITION to today's banners. Absorbing them is PR 3.
 *
 * Rules this component keeps (design §3, §4.3, §7):
 *   - it ROUTES, never acts: "Open" selects an artifact on an explicit click;
 *     there is no approve / retire control here (Retire stays in ⋯);
 *   - a change of `next` never moves selection, focus or scroll;
 *   - the line is one row; "+N high decision", the lane word/glyph, the failure
 *     prefix and the counts never truncate — `why`, then `after`, then the
 *     title do (flex-shrink ratios below);
 *   - one polite announcement, only when `next.id` changes;
 *   - every state has a glyph AND a word, never colour alone.
 */

const PREFIX_TEXT: Record<FailureKind, string> = {
  disconnected: "⚠ DISCONNECTED",
  "stale-daemon": "⚠ STALE DAEMON",
  replay: "REPLAY",
  "snapshot-unavailable": "⚠ SNAPSHOT UNAVAILABLE",
  "session-conflict": "⚠ SESSION CONFLICT",
};

const SUMMARY_TEXT: Record<SummaryLane, (n: number) => string> = {
  "high-decision": (n) => `+${n} high decision`,
  decide: (n) => `Decide ${n}`,
  flags: (n) => `⚠ flags ${n}`,
  waiting: (n) => `Waiting ${n}`,
  held: (n) => `Held ${n}`,
  read: (n) => `Read ${n}`,
};

/** The primary token, in the doc's §4.3 wording (the line tests pin these). */
function primaryToken(line: Attention["line"]): string {
  const t = primaryCore(line);
  // #457 state G — while disconnected the line is what the tab LAST KNEW, and
  // says so (design §4.3 worked table: "▲ next (last known)").
  return line.prefix === "disconnected" && line.primary.lane !== "waiting" ? `${t} (last known)` : t;
}

function primaryCore(line: Attention["line"]): string {
  const p = line.primary;
  switch (p.lane) {
    // §5 lane glyphs: ▲ a decision, ● a review — the SAME marks the sidebar
    // rows wear (lib/laneMarks, PR 4), so the two can't drift.
    case "decide": return `${(p.item!.kind === "decision" ? LANE_MARKS.decide : LANE_MARKS.review).glyph} ${p.item!.title}`;
    case "flag": return `⚠ Possible secret in ${p.item!.title}`;
    case "waiting": return `${LANE_MARKS.waiting.glyph} WAITING ON CLAUDE`;
    // #457 D4 — design state F names what was held (`"concept" stopped:
    // proposal`), so the line still says it after the hero toast fades.
    case "held": return `■ HELD ${p.item!.title}`;
    // #430 PR 5 (PR 4 review) — ◇, not ○: ○ is the sidebar's Read lane, so
    // the empty state gets its own glyph and ○ only ever means "to read".
    default: return `${NOTHING_GLYPH} Nothing needs you`;
  }
}

/** #467 review — the neutral line while the tab is still loading what needs you. */
const HOLD_TEXT = "Checking what needs you…";

/** The line exactly as the design's worked table writes it: prefix · primary · summary. */
export function attentionLineText(a: Attention): string {
  return [
    a.line.prefix ? PREFIX_TEXT[a.line.prefix] : null,
    primaryToken(a.line),
    ...a.line.summary.map((s) => SUMMARY_TEXT[s.lane](s.count)),
  ].filter(Boolean).join(" · ");
}

/** §4.4 — "why it matters", from the item's own content. Never invented. */
function whyFor(item: AttentionItem, artifacts: Artifact[]): string {
  const a = item.artifactId ? artifacts.find((x) => x.id === item.artifactId) : undefined;
  if (item.kind === "decision") {
    const ctx = (a?.content as { context?: unknown } | undefined)?.context;
    return typeof ctx === "string" ? ctx : "";
  }
  if (item.kind === "question") return `You asked: ${item.title}`;
  if (item.kind === "request") return `You asked for: ${item.title}`;
  if (item.kind === "revision") return `You requested changes to ${item.title}`;
  return "";
}

/** Whether Claude can act on a response right now (#457 D3). */
export type AgentReach = "live" | "gone" | "disconnected" | "replay";

/** §4.4 — "what happens after you respond", reusing the app's honest copy.
 *  #457 D3 — never promise what an absent agent will do: replay is read-only,
 *  a disconnected tab can't deliver, and an exited agent acts on resume. */
function afterFor(item: AttentionItem, artifacts: Artifact[], reach: AgentReach): string {
  const a = item.artifactId ? artifacts.find((x) => x.id === item.artifactId) : undefined;
  const agentGone = reach === "gone";
  if (reach === "replay" && item.kind !== "flag") return "Replay is read-only — nothing you do here reaches Claude";
  // #465 N3 — it is THIS TAB that lost the daemon, not Claude.
  if (reach === "disconnected" && item.kind !== "flag") return "This tab is offline — your response can be sent once it reconnects to deepPairing";
  switch (item.kind) {
    case "decision":
      return agentGone
        ? "Saved — Claude sees your choice when the session resumes"
        : "Claude continues with the option you pick";
    case "review-blocking": {
      if (agentGone) return "Saved — Claude acts on your verdict when the session resumes";
      if (a?.type === "plan") {
        const n = ((a.content as { steps?: unknown[] } | null)?.steps ?? []).length;
        return `Approve → Claude executes ${n} step${n === 1 ? "" : "s"} · Request changes → Claude revises the plan`;
      }
      return "Your verdicts go back as one review; Claude is waiting on it";
    }
    case "review":
      return agentGone
        ? "Saved — Claude sees your verdict when the session resumes"
        : "Your verdict reaches Claude on its next check (usually < 30s)";
    case "flag":
      return "Already stored and will appear in exports — if it's a real credential, rotate it";
    case "question":
    case "request":
    case "revision":
      return agentGone
        ? "Claude exited — it's answered when the session resumes"
        : "Claude answers on its next check";
    default:
      return "";
  }
}

const LANE_WORD: Partial<Record<AttentionItem["kind"], string>> = {
  decision: "DECIDE",
  "review-blocking": "REVIEW",
  review: "REVIEW",
  flag: "POSSIBLE SECRET",
};

/** #430 PR 5 — the bar-ON home of the demo CTA and the wrap card (design §5):
 *  App decides WHETHER each shows (today's conditions); the bar decides WHERE —
 *  inline in its quiet state, otherwise in the ⌄ view. `demo` receives the
 *  bar's dismiss (the card stays in ⌄ after a dismiss); the wrap card keeps its
 *  own per-session Dismiss, exactly as with the bar off. */
export interface QuietCards {
  demo?: ((dismiss?: () => void) => ReactNode) | null;
  wrap?: ReactNode | null;
}

export function NextUpBar({ quietCards = {} }: { quietCards?: QuietCards } = {}) {
  const artifacts = useArtifactStore((s) => s.artifacts);
  const comments = useArtifactStore((s) => s.comments);
  const requests = useArtifactStore((s) => s.requests);
  const selectArtifact = useArtifactStore((s) => s.selectArtifact);
  const connected = useConnectionStore((s) => s.connected);
  const tabOffline = useTabOffline();
  const staleDaemon = useConnectionStore((s) => s.staleDaemon);
  const snapshotUnavailable = useConnectionStore((s) => s.snapshotUnavailable);
  const sessionConflict = useConnectionStore((s) => s.sessionConflict);
  const markBlocksSeen = usePreflightBlockStore((s) => s.markSeen);
  const activeSessions = useConnectionStore((s) => s.activeSessions);
  const replayActive = useReplayStore((s) => s.active);
  const blocks = usePreflightBlockStore((s) => s.blocks);
  const lastSeenAt = usePreflightBlockStore((s) => s.lastSeenAt);

  const sessionLabels = useMemo(() => sessionLabelsFrom(activeSessions), [activeSessions]);
  const boundSessionId = useConnectionStore((s) => s.sessionId);
  const attention = useMemo(() => computeAttention({
    artifacts,
    comments,
    requests,
    sessionLabels,
    boundSessionId,
    system: {
      // #467 review — the shared offline answer (first-connect grace): a page
      // load is not an outage.
      disconnected: tabOffline,
      staleDaemon,
      snapshotUnavailable,
      sessionConflict,
      replay: replayActive,
      // Unread stance holds (the same boundary the ⋯ gate log uses).
      holds: blocks
        .filter((b) => !lastSeenAt || b.at > lastSeenAt)
        .map((b) => ({ id: b.id, title: b.proposal ? `"${b.concept}" stopped: ${b.proposal}` : `"${b.concept}"`, at: b.at })),
    },
  }), [artifacts, comments, requests, sessionLabels, boundSessionId, tabOffline, staleDaemon, snapshotUnavailable, sessionConflict, replayActive, blocks, lastSeenAt]);

  const agentGone = noAgentLive(activeSessions);
  // #457 state G — the outage clock (ticks only while disconnected).
  const disconnectedSince = useConnectionStore((s) => s.disconnectedSince);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (connected) return;
    const t = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(t);
  }, [connected]);
  const prolongedOutage = tabOffline && disconnectedSince != null && nowMs - disconnectedSince >= 60_000;
  const [expanded, setExpanded] = useState<false | "all" | "high">(false);
  // The holds whose "Why" was opened: shown in the expansion after they are
  // marked seen (which, like opening the ⋯ gate log, clears them from the lane).
  const [whyHolds, setWhyHolds] = useState<AttentionItem[]>([]);
  const primary = attention.line.primary;
  const item = primary.item;
  // #430 PR 3 — absorbing ResumeQuestionsBanner: when the agent exited with
  // your questions open, the bar carries the banner's count ("Exited with N of
  // your questions open"), its jump (Open → the oldest question's artifact) and
  // its Copy-resume-prompt action.
  //
  // #452 review — this is a SUMMARY action, shown whenever the agent is gone
  // and questions are open, whatever holds the primary slot: the common exit
  // leaves drafts in Decide, and the resume flow must not hide behind them.
  const openQuestions = attention.lanes.waiting.filter((w) => w.kind === "question");
  const openQuestionCount = openQuestions.length;
  const resumeCase = agentGone && openQuestionCount > 0;
  const oldestQuestion = openQuestions[0]; // waiting is oldest-first
  const why = item ? whyFor(item, artifacts) : "";
  const reach: AgentReach = replayActive ? "replay" : tabOffline ? "disconnected" : agentGone ? "gone" : "live";
  const after = item ? afterFor(item, artifacts, reach) : "";
  // #430 PR 5 — the request pips + resume bridge (moved here from the
  // composer row when the bar is ON; same hook, same rules).
  const requestBridge = useRequestResumeBridge();
  // #430 PR 5 — "quiet" = nothing needs your judgment right now: the demo CTA
  // and wrap card sit inline only then (never pushing a decision off the line).
  const quiet = primary.lane === "nothing" || primary.lane === "waiting" || primary.lane === "held";
  const [demoDismissed, setDemoDismissed] = useState(false);
  const demoInline = !!quietCards.demo && quiet && !demoDismissed;
  const wrapInline = !!quietCards.wrap && quiet;
  const [copied, setCopied] = useState(false);
  const copyResumePrompt = async () => {
    // Same honesty rule as the banner: only claim success on an actual resolve.
    const writeText = navigator.clipboard?.writeText?.bind(navigator.clipboard);
    if (!writeText) return;
    try {
      await writeText(resumePromptFor(openQuestionCount));
      // #457 D5 — the banner's live region spoke "Copied ✓"; so does the bar.
      setAnnouncement("Copied ✓ — resume prompt");
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard denied — don't claim success */ }
  };

  // #430 PR 3 — the palette's "Open review queue" expands this bar and moves
  // focus to it (an explicit request, so focus may move; `next` changes never do).
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const open = () => {
      setExpanded("all");
      sectionRef.current?.focus();
    };
    window.addEventListener("dp:open-next-up", open);
    return () => window.removeEventListener("dp:open-next-up", open);
  }, []);

  // ONE polite announcer that speaks only when `next.id` changes (never on
  // mount, never when a count moves). It never touches selection or scroll.
  const nextId = attention.next?.id ?? null;
  const prevNext = useRef<string | null | undefined>(undefined);
  const [announcement, setAnnouncement] = useState("");
  // #457 D8 — a connect/hydration resets and refills the store, so `next`
  // flickered review → nothing → review within ~33ms and was SPOKEN. Changes
  // that land while the store is settling (not hydrated yet, or within 750ms of
  // a store reset — the arrival region's own hydration window) move the
  // baseline silently; only settled changes are announced.
  const hydrated = useConnectionStore((s) => s.hydrated);
  const generation = artifactStoreGeneration();
  const lastGeneration = useRef(generation);
  const settleUntil = useRef(0);
  if (generation !== lastGeneration.current) {
    lastGeneration.current = generation;
    settleUntil.current = Date.now() + 750;
  }
  const settling = () => !hydrated || Date.now() < settleUntil.current;
  useEffect(() => {
    // #458 review — `next` moving onto a sibling session's backfilled HISTORY
    // is not news either (only a genuinely new artifact is).
    if (prevNext.current !== undefined && prevNext.current !== nextId && !settling() && !(nextId && isBackfilled(nextId))) {
      const n = attention.next;
      setAnnouncement(n ? `Next up: ${(LANE_WORD[n.kind] ?? "").toLowerCase()} — ${n.title}` : "Next up: nothing needs you");
    }
    prevNext.current = nextId;
    // attention.next is derived from the same memo as nextId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextId]);

  // #457 D5 — with the bar ON, ResumeQuestionsBanner (and its aria-live) is
  // absorbed, so the exit/resume state spoke nothing. The SAME single announcer
  // now says it, in the banner's words, when it appears or its count changes
  // (never on mount, like `next`).
  const resumeAnnounceCount = resumeCase ? openQuestionCount : 0;
  const prevResume = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (prevResume.current !== undefined && resumeAnnounceCount > 0 && prevResume.current !== resumeAnnounceCount && !settling()) {
      setAnnouncement(`${resumeAnnounceCount} question${resumeAnnounceCount === 1 ? "" : "s"} waiting for Claude`);
    }
    prevResume.current = resumeAnnounceCount;
    // `settling` reads refs + the hydrated flag at effect time; the trigger is
    // the count alone (like `next` above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeAnnounceCount]);

  const tone =
    primary.lane === "decide" ? "text-accent-amber"
    : primary.lane === "flag" ? "text-accent-red"
    : primary.lane === "waiting" ? WAITING_TONE.text
    : "text-text-secondary";
  // #467 review — never claim "Nothing needs you" before the tab knows: until
  // the session has hydrated and the first sibling sync has merged (or the
  // first-connect grace ran out — no siblings to wait for), an empty Decide
  // lane may only mean "not loaded yet". Hold a neutral line instead.
  const siblingSettled = useSiblingSyncStore((s) => s.settled);
  const graceOver = useConnectionGraceStore((s) => s.graceOver);
  const hydrationStalled = useHydrationStalled();
  // Nothing to wait for when the bound session is the only one known.
  const noSiblings = activeSessions.length > 0 && activeSessions.every((x) => x.sessionId === boundSessionId);
  const holdingRaw = primary.lane === "nothing" && !attention.line.prefix && (!hydrated || !(siblingSettled || graceOver || noSiblings));
  // #477 — the hold is bounded: connected but never hydrated past
  // HYDRATION_STALL_MS says so truthfully, with Reload (lib/connectionGrace).
  const stalled = hydrationStalled && !hydrated;
  const holding = holdingRaw && !stalled;
  const primaryText = stalled ? `⚠ ${HYDRATION_STALLED_TEXT}` : holding ? HOLD_TEXT : primaryToken(attention.line);
  const lineText = stalled ? `⚠ ${HYDRATION_STALLED_TEXT}` : holding ? HOLD_TEXT : attentionLineText(attention);

  return (
    <section
      ref={sectionRef}
      id="next-up"
      tabIndex={-1}
      aria-label="Next up"
      data-testid="next-up-bar"
      data-line={lineText}
      className="border-b border-border-default bg-surface-secondary"
    >
      <div className="flex items-center gap-2 px-3 py-1 min-w-0 text-2xs">
        {attention.line.prefix && (
          <span data-token className="shrink-0 font-semibold text-accent-red">{PREFIX_TEXT[attention.line.prefix]}</span>
        )}
        {/* #457 state G — the same 60s escalation the DisconnectBanner makes:
            a blip and a dead daemon must not look identical on the line. */}
        {prolongedOutage && (
          <span
            data-testid="next-up-doctor"
            className="shrink-0 px-1 rounded bg-accent-red-dim text-accent-red font-mono"
            title="Still disconnected after a minute — the daemon may be down. Run `node packages/mcp-server/dist/cli/init.js doctor --fix` in the project, then reload."
          >
            doctor --fix
          </span>
        )}
        {/* The lane WORD is part of the accessible text (a screen reader hears
            "DECIDE ▲ …", not a bare glyph). */}
        {item && LANE_WORD[item.kind] && (
          <span className={`shrink-0 font-semibold tracking-wide ${tone}`}>{LANE_WORD[item.kind]}</span>
        )}
        {/* Truncation order: why (shrink 1000) → after (shrink 100) → title (shrink 1). */}
        <span data-token className={`min-w-0 truncate font-medium ${tone}`} style={{ flexShrink: 1 }} title={primaryText}>
          {primaryText}
        </span>
        {stalled && (
          <button
            type="button"
            onClick={reloadPage}
            data-testid="next-up-reload"
            className="shrink-0 px-1.5 py-0.5 rounded border border-border-default text-text-secondary hover:bg-surface-hover"
            title="The tab connected but its first snapshot never arrived — reload to fetch it again"
          >
            Reload
          </button>
        )}
        {item?.stakes === "high" && (
          <span className="shrink-0 px-1 rounded bg-accent-red-dim text-accent-red font-semibold">HIGH</span>
        )}
        {/* #457 D2 — which session this is (only when >1 is merged). */}
        {item?.sessionLabel && (
          <span data-testid="next-up-session" className="shrink-0 max-w-[12rem] truncate text-text-muted" title={`Session: ${item.sessionLabel}`}>
            in {item.sessionLabel}
          </span>
        )}
        {why && (
          <span className="min-w-0 truncate text-text-muted" style={{ flexShrink: 1000 }} title={why}>· {why}</span>
        )}
        {after && (
          <span className="min-w-0 truncate text-text-secondary" style={{ flexShrink: 100 }} title={after}>· {after}</span>
        )}
        {item?.artifactId && (primary.lane === "decide" || primary.lane === "flag" || primary.lane === "waiting") && (
          <button
            type="button"
            onClick={() => selectArtifact(item.artifactId!)}
            className="shrink-0 px-1.5 py-0.5 rounded border border-border-default text-text-secondary hover:bg-surface-hover"
          >
            Open
          </button>
        )}
        {primary.lane === "held" && (
          <button
            type="button"
            onClick={() => {
              // Opening the record counts as seeing it — the same lastSeenAt
              // boundary the ⋯ gate log sets when it is opened.
              setWhyHolds(attention.lanes.held);
              markBlocksSeen();
              setExpanded("all");
            }}
            className="shrink-0 px-1.5 py-0.5 rounded border border-border-default text-text-secondary hover:bg-surface-hover"
          >
            Why
          </button>
        )}
        <span className="flex-1" />
        {resumeCase && (
          <span className="shrink-0 flex items-center gap-1" data-testid="next-up-resume">
            <button
              type="button"
              onClick={() => oldestQuestion?.artifactId && selectArtifact(oldestQuestion.artifactId)}
              className={`px-1.5 py-0.5 rounded ${WAITING_TONE.chip} ${WAITING_TONE.chipHover}`}
              title="Claude exited with your questions open — jump to the oldest one"
            >
              💤 Exited with {openQuestionCount} of your question{openQuestionCount === 1 ? "" : "s"} open
            </button>
            <button
              type="button"
              onClick={() => void copyResumePrompt()}
              className={`px-1.5 py-0.5 rounded ${WAITING_TONE.chip} ${WAITING_TONE.chipHover}`}
              title="Copy a paste-able resume prompt for Claude Code"
            >
              {copied ? "Copied ✓" : "Copy resume prompt"}
            </button>
          </span>
        )}
        <RequestResumeButton bridge={requestBridge} className="" label="Copy request resume prompt" />
        {attention.line.summary.map((s) =>
          s.lane === "high-decision" ? (
            <button
              key={s.lane}
              type="button"
              data-token
              onClick={() => setExpanded((e) => (e === "high" ? false : "high"))}
              className="shrink-0 px-1.5 py-0.5 rounded bg-accent-red-dim text-accent-red font-semibold"
            >
              {SUMMARY_TEXT[s.lane](s.count)}
            </button>
          ) : (
            <span key={s.lane} data-token className="shrink-0 text-text-muted">{SUMMARY_TEXT[s.lane](s.count)}</span>
          ),
        )}
        {/* #455 review — a card that exists but isn't inline (something needs
            you — e.g. the scripted demo always leaves a draft debrief) gets a
            PINNED token into ⌄, never truncated (shrink-0, like "+N high
            decision"), so it is never invisible. */}
        {quietCards.demo && !demoInline && !demoDismissed && (
          <button
            type="button"
            data-token
            data-testid="next-up-next-step"
            onClick={() => setExpanded("all")}
            className={`shrink-0 px-1.5 py-0.5 rounded ${WAITING_TONE.chip} ${WAITING_TONE.chipHover}`}
            title="The demo's next step: install deepPairing in Claude Code"
          >
            Next step ⌄
          </button>
        )}
        {quietCards.wrap && !wrapInline && (
          <button
            type="button"
            data-token
            data-testid="next-up-recap"
            onClick={() => setExpanded("all")}
            className="shrink-0 px-1.5 py-0.5 rounded bg-surface-elevated text-text-secondary hover:bg-surface-hover"
            title="Session recap"
          >
            Recap ⌄
          </button>
        )}
        <button
          type="button"
          aria-expanded={!!expanded}
          aria-controls="next-up-details"
          aria-label={expanded ? "Collapse next-up details" : "Expand next-up details"}
          onClick={() => setExpanded((e) => (e ? false : "all"))}
          className="shrink-0 px-1 text-text-muted hover:text-text-secondary"
        >
          {expanded ? "⌃" : "⌄"}
        </button>
      </div>

      {(demoInline || wrapInline) && (
        <div className="px-3 pb-2 space-y-1" data-testid="next-up-quiet-cards">
          {demoInline && quietCards.demo!(() => setDemoDismissed(true))}
          {wrapInline && quietCards.wrap}
        </div>
      )}

      {expanded && (
        <div id="next-up-details" className="px-3 pb-2 space-y-1 text-2xs text-text-secondary">
          {why && <div><span className="text-text-muted">Why </span>{why}</div>}
          {after && <div><span className="text-text-muted">After </span>{after}</div>}
          {expanded === "high" ? (
            <Queue
              title="High-stakes decisions"
              // Exactly the ones "+N high decision" counts: high, other than `next`.
              items={attention.lanes.decide.filter((d) => d.kind === "decision" && d.stakes === "high" && d.id !== attention.next?.id)}
              onOpen={selectArtifact}
            />
          ) : (
            <>
              <Queue title="Decide" items={attention.lanes.decide} onOpen={selectArtifact} />
              <Queue title="Possible secrets" items={attention.lanes.flags} onOpen={selectArtifact} />
              <Queue title="Waiting on Claude" items={attention.lanes.waiting} onOpen={selectArtifact} />
              {(attention.lanes.held.length > 0 || whyHolds.length > 0) && (
                <div>
                  <div className="text-text-muted">Held by your stance</div>
                  <ul className="ml-3 list-disc">
                    {(attention.lanes.held.length > 0 ? attention.lanes.held : whyHolds).map((h) => <li key={h.id}>{h.title}</li>)}
                  </ul>
                  <div className="text-text-muted">Nothing to do unless you want to retire the stance — that lives in the ⋯ gate log.</div>
                </div>
              )}
              <Queue title="Read" items={attention.lanes.read} onOpen={selectArtifact} />
              {/* #430 PR 5 — the request pips (served ✓ jumps to the artifact;
                  unserved are also Waiting items above). */}
              {requestBridge.requests.length > 0 && (
                <div data-testid="next-up-requests">
                  <div className="text-text-muted">Your requests ({requestBridge.requests.length})</div>
                  <div className="ml-3 mt-0.5"><RequestPips /></div>
                </div>
              )}
              {/* Cards not shown inline (something needs you, or dismissed). */}
              {quietCards.demo && !demoInline && quietCards.demo()}
              {quietCards.wrap && !wrapInline && quietCards.wrap}
            </>
          )}
        </div>
      )}

      {/* The one polite announcer (§7). */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="next-up-announcer">
        {announcement}
      </div>
    </section>
  );
}

function Queue({ title, items, onOpen }: { title: string; items: AttentionItem[]; onOpen: (id: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="text-text-muted">{title} ({items.length})</div>
      <ol className="ml-3 list-decimal">
        {items.map((it) => (
          <li key={it.id}>
            {it.artifactId ? (
              <button type="button" onClick={() => onOpen(it.artifactId!)} className="hover:underline text-left">
                {it.title}
              </button>
            ) : (
              <span>{it.title}</span>
            )}
            {it.stakes === "high" && <span className="ml-1 text-accent-red font-semibold">HIGH</span>}
            {it.sessionLabel && <span className="ml-1 text-text-muted">— {it.sessionLabel}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}
