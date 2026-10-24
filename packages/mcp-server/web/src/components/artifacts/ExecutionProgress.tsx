import { useConnectionStore } from "../../stores/connection";

/**
 * D10 (H2) — execution tracking UI, shared by plans (`steps[]`) and, since
 * #569 (#507 S1), specs (`tasks[]`). update_plan_progress writes the statuses;
 * these render them. `noun` picks the copy: plans keep their exact wording.
 */
export type ExecutionStatus = "pending" | "in_progress" | "done" | "skipped";
type Noun = "step" | "task";

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** D10 (H2) — live "Step 3 of 7" strip; mirrors TriageProgressStrip's shape. */
export function ExecutionStrip({
  items,
  sessionId,
  noun = "step",
}: {
  items: Array<{ status?: ExecutionStatus }>;
  sessionId?: string;
  noun?: Noun;
}) {
  const done = items.filter((s) => s.status === "done" || s.status === "skipped").length;
  const active = items.findIndex((s) => s.status === "in_progress");
  const pct = items.length === 0 ? 0 : Math.round((done / items.length) * 100);
  const kind = noun === "task" ? "Spec" : "Plan";
  // F8 (M2) — "Executing" is a claim about a LIVE agent; on a dead session
  // it contradicted the SessionWrapCard rendered right above it. The dead
  // wrapper narrates honestly instead.
  const sessionLive = useConnectionStore(
    (s) => s.activeSessions.find((x) => x.sessionId === sessionId)?.live !== false,
  );
  return (
    <div
      role="group"
      aria-label={`${kind} execution: ${done} of ${items.length} ${noun}s complete`}
      className="px-3 py-2 bg-surface-secondary border border-white/[0.06] rounded-lg flex items-center gap-3"
    >
      <span className="text-2xs font-semibold text-text-secondary uppercase tracking-wide shrink-0">
        {done === items.length
          ? `${kind} complete`
          : !sessionLive
            ? `Paused at ${noun} ${(active >= 0 ? active : done) + 1} of ${items.length} — agent exited`
            : active >= 0
              ? `Executing ${noun} ${active + 1} of ${items.length}`
              : `${done} of ${items.length} done`}
      </span>
      <div className="flex-1 h-1.5 rounded-full bg-surface-elevated overflow-hidden">
        <div
          className="h-full rounded-full bg-accent-green transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-2xs text-text-muted shrink-0">{pct}%</span>
    </div>
  );
}

/** D10 — per-step (or per-task) execution marker (replaces the plain number once tracked). */
export function StepStatusMarker({
  index,
  status,
  noun = "step",
}: {
  index: number;
  status?: ExecutionStatus;
  noun?: Noun;
}) {
  const label = `${capitalize(noun)} ${index + 1}`;
  if (status === "done") {
    return (
      <span className="shrink-0 w-5 h-5 rounded-full bg-accent-green-dim text-accent-green text-xs flex items-center justify-center mt-0.5" title="Done" aria-label={`${label}: done`}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 5l2.5 2.5L8 3" /></svg>
      </span>
    );
  }
  if (status === "in_progress") {
    return (
      <span className="shrink-0 w-5 h-5 rounded-full bg-accent-blue-dim text-accent-blue text-xs font-bold flex items-center justify-center mt-0.5 animate-pulse" title="In progress" aria-label={`${label}: in progress`}>
        {index + 1}
      </span>
    );
  }
  if (status === "skipped") {
    return (
      <span className="shrink-0 w-5 h-5 rounded-full bg-surface-elevated text-text-muted text-xs flex items-center justify-center mt-0.5 line-through" title="Skipped" aria-label={`${label}: skipped`}>
        {index + 1}
      </span>
    );
  }
  return (
    <span className="shrink-0 w-5 h-5 rounded-full bg-accent-blue-dim text-accent-blue text-xs font-bold flex items-center justify-center mt-0.5" role="img" aria-label={`${label}: pending`}>
      {index + 1}
    </span>
  );
}

/** The statuses that never show the live strip — the run is not executable. */
export const NON_EXECUTABLE_STATUSES = ["draft", "rejected", "retracted", "obsolete", "superseded", "revised"];

/** #579 — a successor exists only after the artifact is actually superseded. */
export const isClosedWithSuccessor = (status?: string) => status === "superseded";

/** #579 — replaces the live strip after a successor has replaced this artifact. */
export function SupersededProgressCue({ noun = "step" }: { noun?: Noun }) {
  const kind = noun === "task" ? "spec" : "plan";
  return (
    <div
      role="note"
      aria-label={`Superseded ${kind} progress`}
      className="px-3 py-2 bg-surface-secondary border border-white/[0.06] rounded-lg text-2xs text-text-muted"
    >
      Superseded — see the latest version of this {kind}. Progress below is a historical snapshot, not live.
    </div>
  );
}

/** A human requested a revision; a successor may not exist yet. */
export function RevisionRequestedProgressCue({ noun = "step" }: { noun?: Noun }) {
  const kind = noun === "task" ? "spec" : "plan";
  return (
    <div
      role="note"
      aria-label={`Revision requested ${kind} progress`}
      className="px-3 py-2 bg-surface-secondary border border-white/[0.06] rounded-lg text-2xs text-text-muted"
    >
      Revision requested — awaiting an updated brief for this {kind}. Progress below is a historical snapshot, not live.
    </div>
  );
}
