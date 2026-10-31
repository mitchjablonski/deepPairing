import { useMemo, type ReactNode } from "react";
import { claimSectionKey, type Artifact } from "@deeppairing/shared";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore, selectHydratedForBinding } from "../../stores/connection";
import { useReplayStore } from "../../stores/replay";
import {
  CLAIM_COPY,
  classifyDebriefClaims,
  hasDebriefClaims,
  rawPinId,
  type ClaimRow,
  type DebriefClaimsView,
  type EvidenceView,
} from "../../lib/debriefClaims";

/**
 * #572 slice B1 — the agent's account against its pinned brief, on the
 * debrief. Read-only; it changes no gate, acknowledgement, attention count,
 * question or authority.
 *
 * Readiness (Sol's addendum clause 6): HIDDEN in replay and replay-exit
 * recovery; a refused snapshot / session conflict says "unavailable"; until
 * the current binding hydrates it says "loading" (with the saved raw pin id)
 * and derives no rows. Only then is the pin resolved, against the exact saved
 * id in the debrief's own session.
 *
 * Comments ride the existing sectionId lane: `debrief:claim:<escaped id>` per
 * row, `debrief:claims` for the block (the only target when the saved claims
 * are unreadable or duplicated, so no ambiguous row target exists).
 */
export function DebriefClaims({
  artifact,
  grain,
}: {
  artifact: Artifact;
  /** The debrief's per-block comment surface (BlockGrain), injected. */
  grain: (sectionId: string, label: string) => ReactNode;
}) {
  const artifacts = useArtifactStore((s) => s.artifacts);
  const replayActive = useReplayStore((s) => s.active);
  const replayExiting = useReplayStore((s) => s.exiting);
  const hydrated = useConnectionStore(selectHydratedForBinding);
  const snapshotUnavailable = useConnectionStore((s) => s.snapshotUnavailable);
  const sessionConflict = useConnectionStore((s) => s.sessionConflict);
  const ready = !replayActive && !replayExiting && !snapshotUnavailable && !sessionConflict && hydrated;
  const view = useMemo(() => (ready ? classifyDebriefClaims(artifact, artifacts) : null), [ready, artifact, artifacts]);

  if (!hasDebriefClaims(artifact)) return null;
  if (replayActive || replayExiting) return null;
  const shell = (state: string, children: ReactNode) => (
    <section
      aria-label={CLAIM_COPY.heading}
      data-testid="debrief-claims"
      data-state={state}
      data-comment-anchor="debrief:claims"
      className="bg-surface-secondary rounded-lg border border-white/[0.06] p-3.5 space-y-2"
    >
      {children}
    </section>
  );
  if (snapshotUnavailable || sessionConflict || !hydrated || !view) {
    const pinId = rawPinId(artifact);
    const unavailable = snapshotUnavailable || sessionConflict;
    return shell(unavailable ? "unavailable" : "loading", (
      <p className="text-2xs text-text-muted italic" data-testid="debrief-claims-notice">
        {unavailable ? CLAIM_COPY.unavailableSnapshot : CLAIM_COPY.loading}
        {pinId !== undefined && <span data-testid="debrief-claims-raw-pin"> Saved brief link: {pinId}.</span>}
      </p>
    ));
  }
  return shell("ready", <ReadyClaims artifact={artifact} view={view} grain={grain} />);
}

function PinLine({ view }: { view: DebriefClaimsView }) {
  const selectExact = useArtifactStore((s) => s.selectArtifactExact);
  const pin = view.pin;
  if (pin.kind === "ready") {
    return (
      <h3 className="text-xs font-semibold text-text-muted tracking-wide break-words" data-testid="debrief-claims-heading" data-pin-state={pin.closed ? "closed" : "current"}>
        {CLAIM_COPY.heading} against{" "}
        <button
          type="button"
          onClick={() => selectExact(pin.artifactId)}
          className="underline cursor-pointer text-accent-violet"
          title={`Open this exact brief version (${pin.artifactId})`}
          data-testid="debrief-claims-open-pin"
        >
          "{pin.title}" v{pin.version}
        </button>{" "}
        ({pin.status}) — {CLAIM_COPY.notAcceptance}
      </h3>
    );
  }
  const detail =
    pin.kind === "rejected" ? `${CLAIM_COPY.pinRejected}${pin.attemptedId !== undefined ? ` (${pin.attemptedId})` : ""}: ${pin.reason}`
      : pin.kind === "unreadable" ? `${pin.rawId ?? "a brief"}: ${CLAIM_COPY.pinUnreadable}`
        : pin.kind === "unavailable" ? `${pin.artifactId}: ${pin.text}`
          : CLAIM_COPY.noPin;
  return (
    <div>
      <h3 className="text-xs font-semibold text-text-muted tracking-wide" data-testid="debrief-claims-heading" data-pin-state={pin.kind}>
        {CLAIM_COPY.heading} — {CLAIM_COPY.notAcceptance}
      </h3>
      <p className="text-2xs text-text-muted break-words" data-testid="debrief-claims-pin">{detail}</p>
    </div>
  );
}

function OriginLine({ artifact, view }: { artifact: Artifact; view: DebriefClaimsView }) {
  const o = view.origin;
  const who = o.presentedBy ?? CLAIM_COPY.agentUnknown;
  const text =
    o.kind === "self" ? `Reported in this version (v${o.version}) by ${who} · ${CLAIM_COPY.agentReported}`
      : o.kind === "carried" ? `Reported in v${o.version} (${o.originId}) by ${who}; carried unchanged onto this v${artifact.version} · ${CLAIM_COPY.agentReported}`
        : o.kind === "unavailable" ? `${CLAIM_COPY.originUnavailable} (${o.originId}) · ${CLAIM_COPY.agentReported}`
          : `${CLAIM_COPY.originUnknown} · ${CLAIM_COPY.agentReported}`;
  return <p className="text-2xs text-text-muted break-words" data-testid="debrief-claims-origin" data-origin={o.kind}>{text}</p>;
}

function EvidenceItem({ e }: { e: EvidenceView }) {
  const selectExact = useArtifactStore((s) => s.selectArtifactExact);
  const item = e.item;
  let body: ReactNode;
  if (item.kind === "check") {
    body = (
      <>
        <span>ran <code className="break-all">{item.ran}</code>: {item.outcome}</span>
        {item.excerpt !== undefined && <pre className="mt-1 whitespace-pre-wrap break-words text-[10px] text-text-muted">{item.excerpt}</pre>}
      </>
    );
  } else if (item.kind === "observation") {
    body = <span className="break-words">observed: {item.text}</span>;
  } else if (item.kind === "source") {
    const ev = item.evidence;
    body = typeof ev === "string"
      ? <span className="break-words">source: {ev}</span>
      : (
        <span className="break-words">
          source: <code className="break-all">{ev.filePath !== undefined
            ? `${ev.filePath}${typeof ev.lineStart === "number" ? `:${ev.lineStart}${typeof ev.lineEnd === "number" ? `-${ev.lineEnd}` : ""}` : ""}`
            : ev.locator ? `${ev.locator.kind} ${ev.locator.value}` : "passage"}</code>
          {ev.explanation ? ` — ${ev.explanation}` : ""}
          {ev.snippet ? <pre className="mt-1 whitespace-pre-wrap break-words text-[10px] text-text-muted">{ev.snippet}</pre> : null}
        </span>
      );
  } else {
    const target = e.target;
    body = target
      ? (
        <span className="break-words">
          artifact:{" "}
          <button type="button" className="underline cursor-pointer" onClick={() => selectExact(target.id)} data-testid="debrief-claim-artifact" title={`Open ${target.id}`}>
            {target.title}
          </button>
          {item.note !== undefined ? ` — ${item.note}` : ""}
        </span>
      )
      : <span className="break-words" data-testid="debrief-claim-artifact-unavailable">artifact: {item.artifactId} ({CLAIM_COPY.artifactUnavailable}){item.note !== undefined ? ` — ${item.note}` : ""}</span>;
  }
  return (
    <li className="text-2xs text-text-secondary" data-testid="debrief-claim-evidence" data-kind={e.kind}>
      <span className="text-text-muted">[{e.tag}{e.source ? ` · ${e.source}` : ""}]</span> {body}
    </li>
  );
}

const matchText = (m: ClaimRow["match"]): string | null =>
  m === "unknown" ? CLAIM_COPY.unknownId : m === "ambiguous" ? CLAIM_COPY.ambiguousId : m === "unattributed" ? CLAIM_COPY.unattributed : null;

function ReadyClaims({ artifact, view, grain }: { artifact: Artifact; view: DebriefClaimsView; grain: (sectionId: string, label: string) => ReactNode }) {
  const claims = view.claims;
  return (
    <>
      <PinLine view={view} />
      {claims.kind !== "none" && <OriginLine artifact={artifact} view={view} />}
      {(claims.kind === "unreadable" || claims.kind === "duplicate") && (
        <div data-testid="debrief-claims-unreadable" data-kind={claims.kind} className="space-y-1">
          <p className="text-2xs text-accent-amber break-words">
            {claims.kind === "unreadable" ? CLAIM_COPY.claimsUnreadable : `${CLAIM_COPY.claimsDuplicate} ${claims.ids.join(", ")}`}
          </p>
          <details>
            <summary className="cursor-pointer text-2xs text-text-muted">Saved claims (raw)</summary>
            <pre className="whitespace-pre-wrap break-words text-[10px] text-text-muted">{claims.raw}</pre>
          </details>
        </div>
      )}
      {(claims.kind === "rows" || view.noClaimIds.length > 0) && (
        <ul className="space-y-2" data-testid="debrief-claims-rows">
          {claims.kind === "rows" && claims.rows.map((r) => {
            const mt = matchText(r.match);
            return (
              <li key={`c:${r.requirementId}`} className="rounded-md border border-border-default p-2 space-y-1" data-testid="debrief-claim-row" data-claim={r.claim} data-match={r.match}>
                <div className="text-xs break-words">
                  <span className="font-medium text-text-primary">{r.requirementId}</span>
                  <span className="text-text-secondary"> · {r.label}</span>
                  {mt && <span className="text-accent-amber"> · {mt}</span>}
                </div>
                {r.evidence.length > 0 && <ul className="space-y-0.5">{r.evidence.map((e, i) => <EvidenceItem key={i} e={e} />)}</ul>}
                {r.noCheckReported && <p className="text-2xs text-text-muted" data-testid="debrief-claim-no-check">{CLAIM_COPY.noCheck}</p>}
                {r.notRun !== undefined && <p className="text-2xs text-text-secondary break-words" data-testid="debrief-claim-not-run">{CLAIM_COPY.notRunPrefix} {r.notRun}</p>}
                {r.explanation !== undefined && <p className="text-2xs text-text-secondary break-words">{CLAIM_COPY.explanationPrefix} {r.explanation}</p>}
                {grain(`debrief:claim:${claimSectionKey(r.requirementId)}`, `claim ${r.requirementId}`)}
              </li>
            );
          })}
          {view.noClaimIds.map((id) => (
            <li key={`n:${id}`} className="rounded-md border border-dashed border-border-default p-2" data-testid="debrief-claim-none">
              <div className="text-xs break-words">
                <span className="font-medium text-text-primary">{id}</span>
                <span className="text-text-muted"> · {CLAIM_COPY.noClaim}</span>
              </div>
              {grain(`debrief:claim:${claimSectionKey(id)}`, `requirement ${id}`)}
            </li>
          ))}
        </ul>
      )}
      {view.idlessRequirementRows > 0 && (
        <p className="text-2xs text-text-muted" data-testid="debrief-claims-idless">{view.idlessRequirementRows} {CLAIM_COPY.idlessRows}</p>
      )}
      {grain("debrief:claims", "the agent's account")}
    </>
  );
}
