import { useMemo, type ReactNode } from "react";
import { useArtifactStore } from "../stores/artifact";
import { useConnectionStore, selectHydratedForBinding } from "../stores/connection";
import { useReplayStore } from "../stores/replay";
import {
  buildBriefExceptionIndex,
  summarizeBriefExceptions,
  EXCEPTION_BUCKETS,
  EXCEPTION_BUCKET_LABELS,
  type BriefExceptionIndex,
  type ExceptionEntry,
  type ExceptionGrain,
} from "../lib/briefExceptions";

/**
 * #572 slice A2 — the brief's linked exception cards, read-only navigation.
 *
 * Readiness (Sol's hydration resolution, as amended): everything is HIDDEN in
 * replay and replay-exit recovery (no cursor semantics, no live-state mix);
 * until the current binding has hydrated it says "loading", and a refused
 * snapshot / session conflict says "unavailable" — never an exhaustive zero.
 * Counts are always "in this view" observations, not assurance.
 */
export type BriefExceptionsState =
  | { kind: "hidden" }
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "ready"; index: BriefExceptionIndex };

export function useBriefExceptions(briefId: string | null | undefined, sessionId: string | null | undefined): BriefExceptionsState {
  const artifacts = useArtifactStore((s) => s.artifacts);
  const replayActive = useReplayStore((s) => s.active);
  const replayExiting = useReplayStore((s) => s.exiting);
  const hydrated = useConnectionStore(selectHydratedForBinding);
  const snapshotUnavailable = useConnectionStore((s) => s.snapshotUnavailable);
  const sessionConflict = useConnectionStore((s) => s.sessionConflict);
  const index = useMemo(
    () => (briefId && sessionId ? buildBriefExceptionIndex(artifacts, briefId, sessionId) : null),
    [artifacts, briefId, sessionId],
  );
  if (replayActive || replayExiting || !briefId || !sessionId) return { kind: "hidden" };
  if (snapshotUnavailable || sessionConflict) return { kind: "unavailable" };
  if (!hydrated) return { kind: "loading" };
  return index ? { kind: "ready", index } : { kind: "hidden" };
}

/** The strip's compact count: the SAME index the brief's own lists use. */
export function briefExceptionStripText(state: BriefExceptionsState): string | null {
  switch (state.kind) {
    case "hidden": return null;
    case "loading": return "Linked exceptions loading…";
    case "unavailable": return "Linked exceptions unavailable";
    case "ready": {
      const { index } = state;
      if (index.total === 0) return summarizeBriefExceptions(index);
      const statuses = (["draft", "reviewing"] as const)
        .filter((k) => index.buckets[k] > 0)
        .map((k) => ` · ${index.buckets[k]} ${k}`)
        .join("");
      return `${summarizeBriefExceptions(index)}${statuses}`;
    }
  }
}

function grainText(g: ExceptionGrain): string {
  const name = g.kind === "edgePath" ? `edge path ${g.id}` : g.id;
  return g.match === "known" ? name : `${name} (${g.match})`;
}

function EntryButton({ entry, extra }: { entry: ExceptionEntry; extra?: string }) {
  const selectExact = useArtifactStore((s) => s.selectArtifactExact);
  const parts = [
    entry.bucket === "other" ? `status ${entry.status}` : EXCEPTION_BUCKET_LABELS[entry.bucket],
    ...(entry.incompleteHistory ? ["history incomplete"] : []),
    ...(entry.historical ? [`raised against v${entry.pinnedVersion}`] : []),
    ...(extra ? [extra] : []),
  ];
  return (
    <li>
      <button
        type="button"
        onClick={() => selectExact(entry.decisionId)}
        data-testid="brief-exception-entry"
        data-decision-id={entry.decisionId}
        data-bucket={entry.bucket}
        title={`Open this exact card (${entry.decisionId})`}
        className="w-full min-w-0 text-left rounded px-1.5 py-0.5 text-2xs text-text-secondary hover:bg-surface-elevated focus:outline-none focus-visible:ring-1 focus-visible:ring-accent-blue cursor-pointer"
      >
        <span className="font-medium text-text-primary break-words">{entry.title}</span>
        <span className="text-text-muted break-words"> · {parts.join(" · ")}</span>
      </button>
    </li>
  );
}

function Group({ label, testId, count, children }: { label: string; testId: string; count: number; children: ReactNode }) {
  return (
    <details data-testid={testId} className="rounded border border-border-default px-2 py-1">
      <summary className="cursor-pointer text-2xs text-text-secondary break-words">
        {label} ({count})
      </summary>
      <ul className="mt-1 space-y-0.5">{children}</ul>
    </details>
  );
}

/**
 * Mounted on the spec, near its requirements. Expandable per-requirement lists
 * (exact version, unique raw explicit ids), a brief-level "not
 * requirement-specific" group, "unattributed" (unknown / ambiguous grain),
 * historical groups ("raised against vN", keyed by the exact pinned version),
 * and uncounted diagnostics. Navigation only (exact artifact), no writes.
 */
export function BriefExceptionsSection({ briefId, sessionId }: { briefId: string; sessionId: string | null | undefined }) {
  const state = useBriefExceptions(briefId, sessionId);
  const selectExact = useArtifactStore((s) => s.selectArtifactExact);
  if (state.kind === "hidden") return null;
  const heading = (
    <h3 className="text-2xs font-semibold text-text-muted uppercase tracking-wide mb-1.5">Linked exception cards</h3>
  );
  if (state.kind !== "ready") {
    return (
      <section aria-label="Linked exception cards" data-testid="brief-exceptions" data-state={state.kind}>
        {heading}
        <p className="text-2xs text-text-muted italic" data-testid="brief-exceptions-summary">
          {state.kind === "loading" ? "Loading linked exception cards…" : "Linked exception cards unavailable (the session snapshot did not load)."}
        </p>
      </section>
    );
  }
  const { index } = state;
  const bucketLine = EXCEPTION_BUCKETS
    .filter((b) => index.buckets[b] > 0)
    .flatMap((b) => b === "other"
      ? Object.entries(index.otherStatuses).map(([status, n]) => `${n} ${status}`)
      : [`${index.buckets[b]} ${EXCEPTION_BUCKET_LABELS[b]}`])
    .join(" · ");
  const requirementGroups = index.requirementIds.filter((id) => (index.byRequirement[id] ?? []).length > 0);
  return (
    <section aria-label="Linked exception cards" data-testid="brief-exceptions" data-state="ready">
      {heading}
      <p className="text-2xs text-text-secondary break-words" data-testid="brief-exceptions-summary">
        {summarizeBriefExceptions(index)}
      </p>
      {bucketLine && (
        <p className="text-2xs text-text-muted break-words" data-testid="brief-exceptions-buckets">{bucketLine}</p>
      )}
      {index.total > 0 && (
        <p className="text-[9px] text-text-muted italic">Declared links only: a resolved card is not a met requirement.</p>
      )}
      <div className="mt-1.5 space-y-1">
        {requirementGroups.map((id) => (
          <Group key={id} label={id} testId="brief-exceptions-requirement" count={index.byRequirement[id]!.length}>
            {index.byRequirement[id]!.map((e) => <EntryButton key={e.decisionId} entry={e} />)}
          </Group>
        ))}
        {index.briefLevel.length > 0 && (
          <Group label="Not requirement-specific" testId="brief-exceptions-brief-level" count={index.briefLevel.length}>
            {index.briefLevel.map((e) => <EntryButton key={e.decisionId} entry={e} />)}
          </Group>
        )}
        {index.unattributed.length > 0 && (
          <Group label="Unattributed (unknown or ambiguous id on this version)" testId="brief-exceptions-unattributed" count={index.unattributed.length}>
            {index.unattributed.map(({ entry, grains }) => (
              <EntryButton key={entry.decisionId} entry={entry} extra={grains.map(grainText).join(", ")} />
            ))}
          </Group>
        )}
        {index.historical.map((g) => (
          <Group
            key={g.key}
            label={`Raised against v${g.pinnedVersion} · ${g.grain ? grainText(g.grain) : "whole brief"}`}
            testId="brief-exceptions-historical"
            count={g.entries.length}
          >
            <li>
              <button
                type="button"
                onClick={() => selectExact(g.pinnedBriefId)}
                data-testid="brief-exceptions-open-pinned"
                className="text-2xs text-accent-violet hover:underline cursor-pointer"
              >
                Open v{g.pinnedVersion} ({g.pinnedBriefId})
              </button>
            </li>
            {g.entries.map((e) => <EntryButton key={e.decisionId} entry={e} />)}
          </Group>
        ))}
        {(index.ambiguous.length > 0 || index.unreadable.length > 0) && (
          <Group
            label="Not counted (ambiguous lineage or unreadable link)"
            testId="brief-exceptions-diagnostics"
            count={index.ambiguous.length + index.unreadable.length}
          >
            {index.ambiguous.map((d) => (
              <li key={d.memberIds.join("|")} className="text-2xs text-text-muted break-words" data-testid="brief-exceptions-ambiguous">
                Ambiguous lineage ({d.reasons.join(", ")}):{" "}
                {d.memberIds.map((id, i) => (
                  <span key={`${id}-${i}`}>
                    {i > 0 && ", "}
                    <button type="button" className="underline cursor-pointer" onClick={() => selectExact(id)}>{id}</button>
                  </span>
                ))}
              </li>
            ))}
            {index.unreadable.map((u) => (
              <li key={u.decisionId} className="text-2xs text-text-muted break-words" data-testid="brief-exceptions-unreadable">
                <button type="button" className="underline cursor-pointer" onClick={() => selectExact(u.decisionId)}>{u.decisionId}</button>
                {" "}— link to {u.rawId ?? "a brief"} unreadable or out of policy
              </li>
            ))}
          </Group>
        )}
      </div>
    </section>
  );
}
