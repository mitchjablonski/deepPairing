import { useEffect, useMemo, useState } from "react";
import { useModal } from "../hooks/useModal";
import { useConnectionStore } from "../stores/connection";
import { useContextBankStore, hostForProject } from "../stores/contextBank";
import { useToastStore } from "../stores/toast";
import { enterSessionReplay } from "../lib/session-replay";
import {
  ageTone,
  compactAge,
  displayCounts,
  groupBank,
  laneTags,
  samePath,
  visibleDecisions,
  type BankOpenDecision,
  type BankRow,
  type BankSession,
} from "../lib/bank";

/**
 * THE CONTEXT BANK SURFACE — "where did I leave off?", across every project.
 *
 * Triage-first, in four sections, in this order and no other:
 *
 *   1. NEEDS YOU        open decisions + draft reviews. Highest stakes first,
 *                       then oldest. This is the only lane that is a queue.
 *   2. WAITING ON AGENT unanswered questions. A SEPARATE LANE, never merged
 *                       into the one above — that is the AGENT's turn, and
 *                       putting it under "needs you" would point the human at
 *                       the one thing they cannot act on (see M1 in the data
 *                       layer, and the switcher's "waiting on you" badge, which
 *                       has excluded human questions since MP1).
 *   3. QUIET            neither side owes anything; parked, most recent first.
 *   4. DONE             finished threads.
 *
 * Demo/fixture data is grouped into its own COLLAPSED section with an honest
 * banner — flagged, never hidden, and never allowed to sit at the top of a real
 * triage queue.
 *
 * HONESTY: the server GRADES every one-liner it derives, because a dry-run over
 * real data found 1,003 artifacts and exactly one debrief. A `thin` card says so
 * in its own words rather than dressing a title up as a summary. Everything here
 * keys on `derivationQuality`, never on `derivationRung` — a degraded session can
 * report the `debrief-summary` rung while being force-graded thin.
 */

const LANE_META = {
  needsYou: {
    testId: "bank-lane-needs-you",
    title: "Needs you",
    blurb: "Open decisions and draft reviews — work that is stalled on you.",
    dot: "bg-accent-amber",
  },
  waiting: {
    testId: "bank-lane-waiting",
    title: "Waiting on the agent",
    blurb: "You asked; no answer yet. Nothing to do here — it's the agent's turn.",
    dot: "bg-accent-blue",
  },
  quiet: {
    testId: "bank-lane-quiet",
    title: "Quiet / parked",
    blurb: "Nobody owes anybody anything. Most recent first.",
    dot: "bg-text-muted",
  },
  done: {
    testId: "bank-lane-done",
    title: "Done",
    blurb: "Every artifact reached a terminal state and no loop is open.",
    dot: "bg-accent-green",
  },
} as const;

/** The salience chips. Amber is reserved for "needs you" (T3 disambiguation). */
function SalienceChip({ tag }: { tag: string }) {
  const style =
    tag === "needs-you"
      ? "bg-accent-amber-dim text-accent-amber"
      : tag === "waiting-on-agent"
        ? "bg-accent-blue-dim text-accent-blue"
        : tag === "done"
          ? "bg-accent-green-dim text-accent-green"
          : "bg-surface-secondary text-text-muted";
  const label =
    tag === "needs-you"
      ? "needs you"
      : tag === "waiting-on-agent"
        ? "waiting on agent"
        : tag;
  return (
    <span className={`px-1.5 py-0.5 rounded text-2xs font-semibold ${style}`}>{label}</span>
  );
}

/** The one-liner's trust grade, stated rather than implied. */
function QualityChip({ session }: { session: BankSession }) {
  if (session.derivationQuality === "rich") {
    return (
      <span className="px-1.5 py-0.5 rounded text-2xs font-semibold bg-accent-green-dim text-accent-green">
        debriefed
      </span>
    );
  }
  if (session.derivationQuality === "medium") {
    return (
      <span className="px-1.5 py-0.5 rounded text-2xs bg-surface-secondary text-text-muted">
        partial summary
      </span>
    );
  }
  return (
    <span className="px-1.5 py-0.5 rounded text-2xs bg-surface-secondary text-text-muted">
      title only
    </span>
  );
}

/**
 * THE HONESTY LINE. A `thin` card must SAY it is thin — the whole point of the
 * server's grading is lost if the UI renders all three grades identically.
 */
function QualityNote({ session }: { session: BankSession }) {
  if (session.derivationQuality === "rich") return null;
  if (session.derivationQuality === "medium") {
    return (
      <p className="mt-1 text-2xs text-text-muted" data-testid="bank-quality-note">
        This summarizes one change or one open question — not the session. End sessions with a
        debrief to make this card richer.
      </p>
    );
  }
  return (
    <p className="mt-1 text-2xs text-text-muted" data-testid="bank-quality-note">
      {session.oneLiner
        ? "No debrief was recorded for this session — showing the best available title. End sessions with a debrief to make this card rich."
        : "No debrief, summary or open question was recorded for this session — there is nothing here to summarize. End sessions with a debrief to make this card rich."}
    </p>
  );
}

function AgeBadge({ ageDays }: { ageDays?: number }) {
  if (ageDays === undefined) return <span className="text-2xs text-text-muted italic">age unknown</span>;
  const tone = ageTone(ageDays);
  const style =
    tone === "red"
      ? "bg-accent-red-dim text-accent-red"
      : tone === "amber"
        ? "bg-accent-amber-dim text-accent-amber"
        : "bg-surface-secondary text-text-muted";
  return (
    <span
      className={`px-1.5 py-0.5 rounded text-2xs font-semibold ${style}`}
      title={`Open for ${ageDays} day${ageDays === 1 ? "" : "s"}`}
    >
      {ageDays}d open
    </span>
  );
}

interface DecisionRowProps {
  decision: BankOpenDecision;
  session: BankSession;
  isCurrentProject: boolean;
  onSwitchToProject: () => void;
}

/**
 * One open decision, with its triage affordances.
 *
 * The close-out button exists ONLY for the CURRENT project: the route refuses a
 * cross-project write with a clean 400 (two daemons owning the same files is the
 * AA4 hazard), so offering the button off-project would be offering a click that
 * cannot land. Off-project rows get the honest alternative instead — go there.
 */
function DecisionRow({ decision, session, isCurrentProject, onSwitchToProject }: DecisionRowProps) {
  const closeOut = useContextBankStore((s) => s.closeOut);
  const closing = useContextBankStore((s) => !!s.closing[decision.artifactId]);
  // A refused close-out remounts this row (the optimistic removal unmounted it),
  // so the note the human typed has to come back from the store or it is lost
  // on exactly the path where they are about to retry. A restored draft also
  // re-arms the confirm, so the sentence is on screen rather than one click away.
  const savedNote = useContextBankStore((s) => s.noteDrafts[decision.artifactId] ?? "");
  const [confirming, setConfirming] = useState(!!savedNote);
  const [note, setNote] = useState(savedNote);

  const confirm = async () => {
    setConfirming(false);
    await closeOut({
      decisionId: decision.decisionId,
      artifactId: decision.artifactId,
      sessionId: session.sessionId,
      projectRoot: session.projectRoot,
      note,
    });
    setNote("");
  };

  return (
    <li className="p-2 rounded border border-border-subtle bg-surface-secondary" data-testid="bank-decision">
      <p className="text-xs text-text-primary">{decision.context || decision.title}</p>
      <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
        <AgeBadge ageDays={decision.ageDays} />
        {decision.stakes && (
          <span className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-surface-elevated text-text-muted">
            {decision.stakes} stakes
          </span>
        )}
        {/* NEVER the word "superseded". The server matches an EXPLICIT id
            mention, which is evidence that a later card REFERS to this one —
            not proof it replaced it. A false "superseded" tells the human to
            close work that is still owed, so the copy stays a hint. */}
        {decision.likelySuperseded && (
          <span
            className="px-1.5 py-0.5 rounded text-2xs bg-surface-elevated text-text-secondary"
            title={
              decision.supersededByArtifactId
                ? `${decision.supersededByArtifactId} names this card's id. It may or may not replace it.`
                : "A later card in this session names this card's id."
            }
            data-testid="bank-mentions-badge"
          >
            another card mentions this
          </span>
        )}
      </div>

      {isCurrentProject ? (
        confirming ? (
          <div className="mt-2 space-y-1.5" data-testid="bank-close-out-confirm">
            <p className="text-2xs text-text-secondary">
              Close this out without deciding? It's recorded as retired-unanswered — no option is
              chosen on your behalf.
            </p>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              aria-label="Why are you closing this out? (optional)"
              placeholder="Optional note — e.g. “a later card replaced this”"
              className="w-full px-2 py-1 bg-surface-elevated border border-border-default rounded text-2xs
                         text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-blue"
            />
            <div className="flex items-center gap-1.5">
              <button
                onClick={confirm}
                className="px-2 py-0.5 rounded text-2xs font-semibold bg-accent-amber-dim text-accent-amber
                           hover:bg-surface-hover transition-colors"
              >
                Confirm close-out
              </button>
              <button
                onClick={() => setConfirming(false)}
                className="px-2 py-0.5 rounded text-2xs text-text-muted hover:text-text-primary transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            disabled={closing}
            data-testid="bank-close-out"
            className="mt-2 px-2 py-0.5 rounded text-2xs text-text-secondary border border-border-default
                       hover:text-text-primary hover:border-accent-amber transition-colors disabled:opacity-50"
            title="Retire this question without answering it — no option is recorded as chosen"
          >
            {closing ? "Closing…" : "Close without deciding"}
          </button>
        )
      ) : (
        <button
          onClick={onSwitchToProject}
          data-testid="bank-switch-to-act"
          className="mt-2 px-2 py-0.5 rounded text-2xs text-text-secondary border border-border-default
                     hover:text-text-primary hover:border-accent-blue transition-colors"
          title={`This decision lives in ${session.projectName}. Open that project's companion to act on it.`}
        >
          Switch to {session.projectName} to act
        </button>
      )}
    </li>
  );
}

interface RowProps {
  row: BankRow;
  lane: keyof typeof LANE_META;
  currentProjectRoot: string | null;
  onClose: () => void;
}

/**
 * One index row + its RE-ENTRY CARD (the expanded half): what this thread is,
 * what loops are open, and the one click that puts you back into it.
 */
function BankRowItem({ row, lane, currentProjectRoot, onClose }: RowProps) {
  const { session, project } = row;
  const expandKey = `${row.key}::${lane}`;
  const expanded = useContextBankStore((s) => !!s.expanded[expandKey]);
  const toggleExpanded = useContextBankStore((s) => s.toggleExpanded);
  const closedOut = useContextBankStore((s) => s.closedOut);
  const peers = useContextBankStore((s) => s.peers);
  const activeSessions = useConnectionStore((s) => s.activeSessions);
  const switchSession = useConnectionStore((s) => s.switchSession);

  const isCurrentProject = samePath(session.projectRoot, currentProjectRoot);
  const decisions = visibleDecisions(session, closedOut);
  const tags = laneTags(session);
  const alsoIn =
    lane === "needsYou" && tags.waiting
      ? "also waiting on the agent"
      : lane === "waiting" && tags.needsYou
        ? "also needs you"
        : null;

  const switchToProject = () => {
    const host = hostForProject(peers, session.projectRoot);
    if (!host) {
      useToastStore.getState().push({
        kind: "info",
        title: `No companion running for ${session.projectName}`,
        body: `Start Claude Code in ${session.projectRoot} — the bank can read that project from disk, but only its own daemon can write to it.`,
      });
      return;
    }
    // The client already honours ?session=<id>, so land on the right project
    // AND the right thread in one navigation.
    if (typeof window !== "undefined") {
      window.location.assign(`http://${host}/?session=${encodeURIComponent(session.sessionId)}`);
    }
  };

  const openHere = async () => {
    if (activeSessions.some((s) => s.sessionId === session.sessionId)) {
      switchSession(session.sessionId);
      onClose();
      return;
    }
    const ok = await enterSessionReplay(session.sessionId, decisions[0]?.artifactId);
    if (ok) onClose();
  };

  return (
    <li
      className={`rounded-lg border border-white/[0.06] bg-surface-elevated ${project.stale ? "opacity-50" : ""}`}
      data-testid="bank-row"
      data-session-id={session.sessionId}
    >
      <button
        onClick={() => toggleExpanded(expandKey)}
        aria-expanded={expanded}
        className="w-full text-left p-2.5 rounded-lg hover:bg-surface-hover transition-colors
                   focus:outline-none focus:ring-1 focus:ring-accent-blue"
      >
        <div className="flex items-baseline gap-2 min-w-0">
          {/* Expanding is the ONLY route from this index into a session, so the
              affordance has to be visible, not just announced via aria-expanded.
              Same glyph pair the fixture section already uses. */}
          <span className="text-2xs text-text-muted shrink-0" aria-hidden="true">
            {expanded ? "▾" : "▸"}
          </span>
          <span className="text-2xs font-semibold text-text-secondary shrink-0 max-w-[30%] truncate">
            {project.name}
          </span>
          <span className="flex-1 min-w-0 text-xs text-text-primary truncate">
            {session.oneLiner || <span className="italic text-text-muted">no description recorded</span>}
          </span>
          <span
            className="text-2xs text-text-muted shrink-0 font-mono"
            title={`Last activity ${session.lastActivity}`}
          >
            {compactAge(session.lastActivity)}
          </span>
        </div>
        <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
          {(session.salience ?? []).map((tag) => (
            <SalienceChip key={tag} tag={tag} />
          ))}
          <QualityChip session={session} />
          {decisions.length > 0 && (
            <span className="text-2xs text-text-muted">
              {decisions.length} open decision{decisions.length === 1 ? "" : "s"}
            </span>
          )}
          {session.draftReviewCount > 0 && (
            <span className="text-2xs text-text-muted">
              {session.draftReviewCount} draft review{session.draftReviewCount === 1 ? "" : "s"}
            </span>
          )}
          {session.unansweredQuestionCount > 0 && (
            <span className="text-2xs text-accent-blue">
              {session.unansweredQuestionCount} unanswered question
              {session.unansweredQuestionCount === 1 ? "" : "s"}
            </span>
          )}
          {alsoIn && <span className="text-2xs text-text-muted italic">{alsoIn}</span>}
          {project.stale && (
            <span
              className="px-1.5 py-0.5 rounded text-2xs bg-surface-secondary text-text-muted"
              title={project.projectRoot}
            >
              path no longer exists
            </span>
          )}
          {(session.degraded || project.degraded) && (
            /* Neutral, NOT amber. Amber on this surface means "your attention
               is owed" (needs-you); an unreadable file is a data-quality fact,
               not a queue item, and a third amber meaning would dilute the one
               that drives action. The numeric age badges keep their amber/red
               because they are contextual to a decision the human is reading. */
            <span
              className="px-1.5 py-0.5 rounded text-2xs bg-surface-secondary text-text-secondary"
              title={session.degradedReason ?? project.degradedReason ?? "Partial read"}
              data-testid="bank-degraded"
            >
              partially read
            </span>
          )}
        </div>
      </button>

      {expanded && (
        <div className="px-2.5 pb-2.5 space-y-2.5 border-t border-border-subtle pt-2.5" data-testid="bank-card">
          <section>
            <h4 className="text-2xs font-semibold text-text-muted uppercase tracking-wide">What this is</h4>
            <p className="text-xs text-text-primary mt-1">
              {session.oneLiner || <span className="italic text-text-muted">Nothing was recorded.</span>}
            </p>
            <QualityNote session={session} />
            <p className="mt-1 text-2xs text-text-muted font-mono truncate" title={session.projectRoot}>
              {session.sessionId} · {session.artifactCount} artifact
              {session.artifactCount === 1 ? "" : "s"}
            </p>
          </section>

          <section>
            <h4 className="text-2xs font-semibold text-text-muted uppercase tracking-wide">Open loops</h4>
            {decisions.length === 0 && session.draftReviewCount === 0 && (
              <p className="text-2xs text-text-muted mt-1">No decision or review is waiting on you.</p>
            )}
            {decisions.length > 0 && (
              <ul className="mt-1.5 space-y-1.5">
                {decisions.map((d) => (
                  <DecisionRow
                    key={d.decisionId}
                    decision={d}
                    session={session}
                    isCurrentProject={isCurrentProject}
                    onSwitchToProject={switchToProject}
                  />
                ))}
              </ul>
            )}
            {session.draftReviewCount > 0 && (
              <p className="text-2xs text-text-secondary mt-1.5">
                {session.draftReviewCount} changeset/code review still awaiting your verdict.
              </p>
            )}
          </section>

          {/* The question lane keeps its own block inside the card too — the
              agent owing you an answer is not an item on your to-do list. */}
          {session.unansweredQuestionCount > 0 && (
            <section data-testid="bank-card-waiting">
              <h4 className="text-2xs font-semibold text-accent-blue uppercase tracking-wide">
                Waiting on the agent
              </h4>
              <p className="text-2xs text-text-secondary mt-1">
                {session.unansweredQuestionCount} question
                {session.unansweredQuestionCount === 1 ? "" : "s"} you asked with no answer yet.
              </p>
            </section>
          )}

          <div className="flex items-center gap-1.5 pt-0.5">
            {isCurrentProject ? (
              <button
                onClick={openHere}
                data-testid="bank-open-here"
                className="px-2 py-0.5 rounded text-2xs font-semibold border border-border-default text-text-secondary
                           hover:text-text-primary hover:border-accent-blue transition-colors"
              >
                Open this thread
              </button>
            ) : (
              <button
                onClick={switchToProject}
                data-testid="bank-open-elsewhere"
                className="px-2 py-0.5 rounded text-2xs font-semibold border border-border-default text-text-secondary
                           hover:text-text-primary hover:border-accent-blue transition-colors"
              >
                Switch to {session.projectName}
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function BankLane({
  lane,
  rows,
  currentProjectRoot,
  onClose,
}: {
  lane: keyof typeof LANE_META;
  rows: BankRow[];
  currentProjectRoot: string | null;
  onClose: () => void;
}) {
  const meta = LANE_META[lane];
  return (
    <section data-testid={meta.testId} className="mb-4">
      <div className="flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} aria-hidden="true" />
        <h3 className="text-xs font-semibold text-text-primary">{meta.title}</h3>
        <span className="text-2xs text-text-muted">({rows.length})</span>
      </div>
      {/* An empty lane keeps its heading (its zero is information) but drops the
          blurb — four explanatory paragraphs over four empty lists is chrome. */}
      {rows.length === 0 ? (
        <p className="text-2xs text-text-muted italic mt-0.5">Nothing here.</p>
      ) : (
        <p className="text-2xs text-text-muted mt-0.5 mb-1.5">{meta.blurb}</p>
      )}
      {rows.length > 0 && (
        <ul className="space-y-1.5">
          {rows.map((row) => (
            <BankRowItem
              key={`${row.key}::${lane}`}
              row={row}
              lane={lane}
              currentProjectRoot={currentProjectRoot}
              onClose={onClose}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export function ContextBankView({ onClose }: { onClose: () => void }) {
  const { dialogProps } = useModal({ onClose });
  const bank = useContextBankStore((s) => s.bank);
  const loading = useContextBankStore((s) => s.loading);
  const error = useContextBankStore((s) => s.error);
  const load = useContextBankStore((s) => s.load);
  const currentProjectRoot = useConnectionStore((s) => s.projectRoot);
  const [showFixtures, setShowFixtures] = useState(false);

  // ONE fresh read on open (the endpoint's own 2s floor absorbs a double-open);
  // no polling — the manual Refresh below is the freshness affordance.
  useEffect(() => {
    load({ fresh: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open-once read; `load` is a stable store action
  }, []);

  const lanes = useMemo(() => groupBank(bank), [bank]);
  // Every number on this surface comes from the SAME grouping the lanes render
  // — never from `bank.totals`, which counts the fixtures the lanes quarantine.
  const counts = useMemo(() => displayCounts(bank, lanes), [bank, lanes]);
  const nothing =
    !loading &&
    !error &&
    bank !== null &&
    lanes.needsYou.length === 0 &&
    lanes.waiting.length === 0 &&
    lanes.quiet.length === 0 &&
    lanes.done.length === 0 &&
    lanes.fixtures.length === 0;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-start justify-center pt-12"
      onClick={onClose}
    >
      <div
        {...dialogProps}
        aria-label="My active threads"
        data-testid="context-bank-view"
        className="w-full max-w-3xl max-h-[80vh] overflow-y-auto bg-surface-elevated border border-border-default rounded-lg p-4 focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-sm font-bold text-text-primary">My active threads</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => load({ fresh: true })}
              disabled={loading}
              data-testid="bank-refresh"
              className="px-2 py-0.5 rounded text-2xs text-text-muted border border-border-default
                         hover:text-text-primary hover:bg-surface-hover transition-colors disabled:opacity-50"
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
            <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xs">
              Esc
            </button>
          </div>
        </div>
        <p className="text-2xs text-text-muted mb-3">
          Every project deepPairing has seen, and where each thread was left. Read from disk — nothing
          here polls another project's daemon.
        </p>

        {bank && (
          <p className="text-2xs text-text-muted mb-3" data-testid="bank-totals">
            {counts.projects} project{counts.projects === 1 ? "" : "s"} ·{" "}
            {counts.sessions} thread{counts.sessions === 1 ? "" : "s"} ·{" "}
            <span className="text-accent-amber">{counts.needsYou} need you</span> ·{" "}
            <span className="text-accent-blue">{counts.waitingOnAgent} waiting on the agent</span>
            {counts.staleProjects > 0 && ` · ${counts.staleProjects} missing path`}
            {counts.fixtures > 0 && ` · ${counts.fixtures} demo`}
          </p>
        )}

        {loading && !bank && (
          <div className="py-8 text-center text-text-muted text-sm" role="status">
            Reading your projects…
          </div>
        )}

        {error && (
          <div
            role="status"
            className="mb-3 px-3 py-2 rounded-lg bg-accent-amber-dim border border-accent-amber/30 text-2xs text-accent-amber"
          >
            Couldn't read the bank: {error}
          </div>
        )}

        {nothing && (
          <div className="py-10 text-center text-text-muted text-sm">
            Nothing recorded yet. Once you pair in a project, its threads collect here.
          </div>
        )}

        {bank && !nothing && (
          <>
            <BankLane lane="needsYou" rows={lanes.needsYou} currentProjectRoot={currentProjectRoot} onClose={onClose} />
            <BankLane lane="waiting" rows={lanes.waiting} currentProjectRoot={currentProjectRoot} onClose={onClose} />
            <BankLane lane="quiet" rows={lanes.quiet} currentProjectRoot={currentProjectRoot} onClose={onClose} />
            <BankLane lane="done" rows={lanes.done} currentProjectRoot={currentProjectRoot} onClose={onClose} />

            {/* Demo/fixture data — flagged and grouped, never hidden and never
                mixed into a real queue. Collapsed by default. */}
            {lanes.fixtures.length > 0 && (
              <section data-testid="bank-section-fixtures" className="mt-2">
                <button
                  onClick={() => setShowFixtures((v) => !v)}
                  aria-expanded={showFixtures}
                  className="w-full flex items-center gap-1.5 px-2 py-1 rounded text-2xs text-text-muted
                             border border-border-subtle hover:text-text-secondary hover:bg-surface-hover transition-colors"
                >
                  <span aria-hidden="true">{showFixtures ? "▾" : "▸"}</span>
                  demo / fixture data ({lanes.fixtures.length})
                </button>
                {showFixtures && (
                  <div className="mt-1.5">
                    <p className="text-2xs text-text-muted mb-1.5">
                      These threads are deepPairing's own demo data, not your work. They're shown so
                      nothing is silently filtered out of your bank.
                    </p>
                    <ul className="space-y-1.5">
                      {lanes.fixtures.map((row) => (
                        <BankRowItem
                          key={`${row.key}::fixture`}
                          row={row}
                          lane="quiet"
                          currentProjectRoot={currentProjectRoot}
                          onClose={onClose}
                        />
                      ))}
                    </ul>
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
