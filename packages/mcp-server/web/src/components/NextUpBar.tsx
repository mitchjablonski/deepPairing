import { useEffect, useMemo, useRef, useState } from "react";
import type { Artifact } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import { useConnectionStore } from "../stores/connection";
import { useReplayStore } from "../stores/replay";
import { usePreflightBlockStore } from "../stores/preflightBlocks";
import { computeAttention, type Attention, type AttentionItem, type FailureKind, type SummaryLane } from "../lib/attention";
import { noAgentLive } from "../lib/liveness";
import { WAITING_TONE } from "../lib/waitingTone";
import { LANE_MARKS } from "../lib/laneMarks";
import { resumePromptFor } from "./ResumeQuestionsBanner";

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
  const p = line.primary;
  switch (p.lane) {
    // §5 lane glyphs: ▲ a decision, ● a review — the SAME marks the sidebar
    // rows wear (lib/laneMarks, PR 4), so the two can't drift.
    case "decide": return `${(p.item!.kind === "decision" ? LANE_MARKS.decide : LANE_MARKS.review).glyph} ${p.item!.title}`;
    case "flag": return `⚠ Possible secret in ${p.item!.title}`;
    case "waiting": return `${LANE_MARKS.waiting.glyph} WAITING ON CLAUDE`;
    case "held": return "■ HELD";
    default: return "○ Nothing needs you";
  }
}

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

/** §4.4 — "what happens after you respond", reusing the app's honest copy. */
function afterFor(item: AttentionItem, artifacts: Artifact[], agentGone: boolean): string {
  const a = item.artifactId ? artifacts.find((x) => x.id === item.artifactId) : undefined;
  switch (item.kind) {
    case "decision":
      return agentGone
        ? "Saved — Claude sees your choice when the session resumes"
        : "Claude continues with the option you pick";
    case "review-blocking": {
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

export function NextUpBar() {
  const artifacts = useArtifactStore((s) => s.artifacts);
  const comments = useArtifactStore((s) => s.comments);
  const requests = useArtifactStore((s) => s.requests);
  const selectArtifact = useArtifactStore((s) => s.selectArtifact);
  const connected = useConnectionStore((s) => s.connected);
  const staleDaemon = useConnectionStore((s) => s.staleDaemon);
  const snapshotUnavailable = useConnectionStore((s) => s.snapshotUnavailable);
  const sessionConflict = useConnectionStore((s) => s.sessionConflict);
  const markBlocksSeen = usePreflightBlockStore((s) => s.markSeen);
  const activeSessions = useConnectionStore((s) => s.activeSessions);
  const replayActive = useReplayStore((s) => s.active);
  const blocks = usePreflightBlockStore((s) => s.blocks);
  const lastSeenAt = usePreflightBlockStore((s) => s.lastSeenAt);

  const attention = useMemo(() => computeAttention({
    artifacts,
    comments,
    requests,
    system: {
      disconnected: !connected,
      staleDaemon,
      snapshotUnavailable,
      sessionConflict,
      replay: replayActive,
      // Unread stance holds (the same boundary the ⋯ gate log uses).
      holds: blocks
        .filter((b) => !lastSeenAt || b.at > lastSeenAt)
        .map((b) => ({ id: b.id, title: b.proposal ? `"${b.concept}" stopped: ${b.proposal}` : `"${b.concept}"`, at: b.at })),
    },
  }), [artifacts, comments, requests, connected, staleDaemon, snapshotUnavailable, sessionConflict, replayActive, blocks, lastSeenAt]);

  const agentGone = noAgentLive(activeSessions);
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
  const after = item ? afterFor(item, artifacts, agentGone) : "";
  const [copied, setCopied] = useState(false);
  const copyResumePrompt = async () => {
    // Same honesty rule as the banner: only claim success on an actual resolve.
    const writeText = navigator.clipboard?.writeText?.bind(navigator.clipboard);
    if (!writeText) return;
    try {
      await writeText(resumePromptFor(openQuestionCount));
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
  useEffect(() => {
    if (prevNext.current !== undefined && prevNext.current !== nextId) {
      const n = attention.next;
      setAnnouncement(n ? `Next up: ${(LANE_WORD[n.kind] ?? "").toLowerCase()} — ${n.title}` : "Next up: nothing needs you");
    }
    prevNext.current = nextId;
    // attention.next is derived from the same memo as nextId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextId]);

  const tone =
    primary.lane === "decide" ? "text-accent-amber"
    : primary.lane === "flag" ? "text-accent-red"
    : primary.lane === "waiting" ? WAITING_TONE.text
    : "text-text-secondary";
  const lineText = attentionLineText(attention);

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
        {/* The lane WORD is part of the accessible text (a screen reader hears
            "DECIDE ▲ …", not a bare glyph). */}
        {item && LANE_WORD[item.kind] && (
          <span className={`shrink-0 font-semibold tracking-wide ${tone}`}>{LANE_WORD[item.kind]}</span>
        )}
        {/* Truncation order: why (shrink 1000) → after (shrink 100) → title (shrink 1). */}
        <span data-token className={`min-w-0 truncate font-medium ${tone}`} style={{ flexShrink: 1 }} title={primaryToken(attention.line)}>
          {primaryToken(attention.line)}
        </span>
        {item?.stakes === "high" && (
          <span className="shrink-0 px-1 rounded bg-accent-red-dim text-accent-red font-semibold">HIGH</span>
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
          </li>
        ))}
      </ol>
    </div>
  );
}
