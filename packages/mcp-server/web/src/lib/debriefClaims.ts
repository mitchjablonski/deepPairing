import {
  BRIEF_REF_DIAGNOSTIC_KEY,
  CLAIMS_ORIGIN_KEY,
  matchBriefGrain,
  readBriefRef,
  readBriefRefDiagnostic,
  readRequirementClaims,
  resolveDebriefPin,
  uniqueSessionArtifact,
  type Artifact,
  type BriefGrainMatch,
  type ClaimEvidence,
  type DebriefPinState,
  type DroppedPinReason,
  type RequirementClaim,
} from "@deeppairing/shared";

/**
 * #572 slice B1 — the pure classifier behind a debrief's "agent's account"
 * table. It reads only the SAVED debrief (its `briefRef` pin, its
 * `requirementClaims`, the server-set origin and dropped-pin diagnostic) and
 * the artifacts in the debrief's OWN session. Nothing here infers acceptance:
 * a claim is the agent's account, a missing claim is "no claim", and a brief
 * that can't be resolved to exactly one same-session spec gives NO coverage
 * rows (never a false zero).
 *
 * All authored copy lives in CLAIM_COPY so the copy-scan test can hold it to
 * the "claims, not acceptance" vocabulary. Agent text (evidence, explanation,
 * notRun) is never scanned or rewritten.
 */
export const CLAIM_COPY = {
  heading: "Agent's account",
  notAcceptance: "claims, not acceptance",
  claimLabel: { met: "agent claims handled", unmet: "agent claims not handled", unknown: "agent unsure" },
  noClaim: "no claim",
  agentReported: "agent-reported",
  sourceUnknown: "source version unknown",
  noCheck: "no check reported",
  notRunPrefix: "not run:",
  explanationPrefix: "why:",
  unknownId: "requirement id not in the pinned brief",
  ambiguousId: "requirement id matches 2+ rows in the pinned brief",
  unattributed: "unattributed (no usable brief link)",
  loading: "Loading the agent's account…",
  unavailableSnapshot: "Agent's account unavailable (the session snapshot did not load).",
  pinUnreadable: "brief link unreadable or out of policy (version unknown)",
  pinUnavailable: "brief unavailable here (version unknown)",
  pinDuplicate: "brief id is not unique in this session (version unknown)",
  pinNotSpec: "linked artifact is not a brief (version unknown)",
  pinRejected: "brief link was rejected when the debrief was presented",
  noPin: "no brief link",
  claimsUnreadable: "The saved claims can't be read (malformed or out of policy). Shown raw below; no rows are derived from them.",
  claimsDuplicate: "The saved claims name the same requirement more than once, so no row is shown for them:",
  originUnknown: "report origin unknown",
  originUnavailable: "report origin unavailable here",
  agentUnknown: "agent unknown",
  idlessRows: "requirement rows on the pinned brief have no unique id, so they can't carry a claim",
  artifactUnavailable: "artifact unavailable here",
} as const;

const REJECT_REASON_TEXT: Record<DroppedPinReason, string> = {
  invalid_ref: "malformed link",
  grain_ids_not_allowed: "link listed requirement ids (claims belong in requirementClaims)",
  artifacts_unreadable: "session artifacts couldn't be read",
  not_in_session: "not an artifact in this session",
  not_a_spec: "not a brief",
  ambiguous_target: "id not unique in this session",
};

export type PinView =
  | { kind: "none" }
  | { kind: "rejected"; attemptedId?: string; reason: string }
  | { kind: "unreadable"; rawId?: string }
  | { kind: "unavailable"; artifactId: string; text: string }
  | { kind: "ready"; artifactId: string; title: string; version: number; status: string; closed: boolean };

export interface EvidenceView {
  kind: ClaimEvidence["kind"];
  /** Always "agent-reported". */
  tag: string;
  /** The declared source revision / run, or "source version unknown". */
  source?: string;
  item: ClaimEvidence;
  /** For artifact evidence: exactly one same-session artifact, else null. */
  target?: { id: string; title: string } | null;
}

export interface ClaimRow {
  requirementId: string;
  claim: RequirementClaim["claim"];
  label: string;
  /** known / unknown / ambiguous against the ready pin; "unattributed" without one. */
  match: BriefGrainMatch | "unattributed";
  evidence: EvidenceView[];
  /** True when the evidence holds no check or observation (source/artifact only, or none). */
  noCheckReported: boolean;
  notRun?: string;
  explanation?: string;
}

export interface OriginView {
  kind: "self" | "carried" | "unknown" | "unavailable";
  originId?: string;
  version?: number;
  presentedBy?: string;
}

export interface DebriefClaimsView {
  /** False when the debrief carries no pin, no claims and no diagnostic (legacy: render nothing). */
  present: boolean;
  /** Raw pin id for the loading/unavailable notice. */
  rawPinId?: string;
  pin: PinView;
  claims: { kind: "none" } | { kind: "unreadable"; raw: string } | { kind: "duplicate"; ids: string[]; raw: string } | { kind: "rows"; rows: ClaimRow[] };
  /** Requirements on the READY pin with no claim (empty unless the pin is ready and claims are readable). */
  noClaimIds: string[];
  /** Requirement rows on the ready pin that have no unique explicit id. */
  idlessRequirementRows: number;
  origin: OriginView;
}

const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});

function evidenceSource(e: ClaimEvidence): string | undefined {
  if (e.kind === "check") return e.sourceRevision ? `source ${e.sourceRevision}${e.runId ? ` · run ${e.runId}` : ""}` : `${CLAIM_COPY.sourceUnknown}${e.runId ? ` · run ${e.runId}` : ""}`;
  if (e.kind === "observation") return e.sourceRevision ? `source ${e.sourceRevision}` : CLAIM_COPY.sourceUnknown;
  return undefined;
}

function pinView(state: DebriefPinState): PinView {
  switch (state.state) {
    case "none": return { kind: "none" };
    case "unreadable": return { kind: "unreadable", ...(state.rawId !== undefined ? { rawId: state.rawId } : {}) };
    case "unavailable":
      return {
        kind: "unavailable",
        artifactId: state.artifactId,
        text: state.why === "duplicate" ? CLAIM_COPY.pinDuplicate : state.why === "not_a_spec" ? CLAIM_COPY.pinNotSpec : CLAIM_COPY.pinUnavailable,
      };
    case "ready": {
      const v = state.view;
      return { kind: "ready", artifactId: state.artifactId, title: v.title ?? "", version: v.version ?? 1, status: v.status ?? "unknown", closed: v.closed };
    }
  }
}

/** Unique explicit string ids in a spec's requirement rows, in order, plus the count of rows that can't carry a claim. */
function requirementIds(rows: unknown): { ids: string[]; idless: number } {
  if (!Array.isArray(rows)) return { ids: [], idless: 0 };
  const counts = new Map<string, number>();
  for (const r of rows) {
    const id = record(r).id;
    if (typeof id === "string") counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const ids: string[] = [];
  let idless = 0;
  for (const r of rows) {
    const id = record(r).id;
    if (typeof id === "string" && counts.get(id) === 1) ids.push(id);
    else idless++;
  }
  return { ids, idless };
}

/** Does the debrief carry anything B1 renders? (Legacy debriefs: no.) */
export function hasDebriefClaims(debrief: Pick<Artifact, "briefRef" | "content">): boolean {
  const c = record(debrief.content);
  return debrief.briefRef !== undefined || c.requirementClaims !== undefined || c[BRIEF_REF_DIAGNOSTIC_KEY] !== undefined;
}

/** The saved pin's raw id (readable or not), for the not-ready notice. */
export function rawPinId(debrief: Pick<Artifact, "briefRef">): string | undefined {
  const read = readBriefRef(debrief.briefRef);
  return read === undefined ? undefined : read.ok ? read.ref.artifactId : read.rawId;
}

/**
 * Classify a debrief's B1 block against `artifacts` (filtered to the
 * debrief's own session inside). Call only once the current binding has
 * hydrated; before that the component shows the loading notice instead.
 */
export function classifyDebriefClaims(debrief: Artifact, artifacts: readonly Artifact[]): DebriefClaimsView {
  const c = record(debrief.content);
  const sessionId = debrief.sessionId;
  const pinState = resolveDebriefPin(debrief.briefRef, artifacts, sessionId);
  let pin = pinView(pinState);
  if (pin.kind === "none") {
    const diag = readBriefRefDiagnostic(c[BRIEF_REF_DIAGNOSTIC_KEY]);
    if (diag) pin = { kind: "rejected", ...(diag.attemptedArtifactId !== undefined ? { attemptedId: diag.attemptedArtifactId } : {}), reason: diag.reason ? REJECT_REASON_TEXT[diag.reason] : "reason unknown" };
  }
  const rows = pinState.state === "ready" ? (pinState.brief.content as { requirements?: unknown }).requirements : undefined;

  const read = readRequirementClaims(c.requirementClaims);
  let claims: DebriefClaimsView["claims"];
  if (read.kind === "none") claims = { kind: "none" };
  else if (read.kind === "unreadable") claims = { kind: "unreadable", raw: safeJson(c.requirementClaims) };
  else if (read.kind === "duplicate") claims = { kind: "duplicate", ids: read.ids, raw: safeJson(c.requirementClaims) };
  else {
    claims = {
      kind: "rows",
      rows: read.claims.map((cl) => {
        const evidence = (cl.evidence ?? []).map((e): EvidenceView => {
          const src = evidenceSource(e);
          const target = e.kind === "artifact"
            ? (() => { const t = uniqueSessionArtifact(artifacts, e.artifactId, sessionId); return t ? { id: t.id, title: t.title } : null; })()
            : undefined;
          return { kind: e.kind, tag: CLAIM_COPY.agentReported, item: e, ...(src !== undefined ? { source: src } : {}), ...(target !== undefined ? { target } : {}) };
        });
        return {
          requirementId: cl.requirementId,
          claim: cl.claim,
          label: CLAIM_COPY.claimLabel[cl.claim],
          match: pinState.state === "ready" ? matchBriefGrain(rows, cl.requirementId) : "unattributed",
          evidence,
          noCheckReported: !evidence.some((e) => e.kind === "check" || e.kind === "observation"),
          ...(cl.notRun !== undefined ? { notRun: cl.notRun } : {}),
          ...(cl.explanation !== undefined ? { explanation: cl.explanation } : {}),
        };
      }),
    };
  }

  // Coverage only against a READY pin and READABLE claims: never a false zero.
  let noClaimIds: string[] = [];
  let idlessRequirementRows = 0;
  if (pinState.state === "ready" && (claims.kind === "rows" || claims.kind === "none")) {
    const { ids, idless } = requirementIds(rows);
    const claimed = new Set(claims.kind === "rows" ? claims.rows.map((r) => r.requirementId) : []);
    noClaimIds = ids.filter((id) => !claimed.has(id));
    idlessRequirementRows = idless;
  }

  return {
    present: hasDebriefClaims(debrief),
    ...(rawPinId(debrief) !== undefined ? { rawPinId: rawPinId(debrief) } : {}),
    pin,
    claims,
    noClaimIds,
    idlessRequirementRows,
    origin: originOf(debrief, artifacts),
  };
}

function originOf(debrief: Artifact, artifacts: readonly Artifact[]): OriginView {
  const raw = record(debrief.content)[CLAIMS_ORIGIN_KEY];
  if (typeof raw !== "string") return { kind: "unknown" };
  if (raw === debrief.id) return { kind: "self", originId: raw, version: debrief.version, ...(debrief.presentedBy ? { presentedBy: debrief.presentedBy } : {}) };
  const origin = uniqueSessionArtifact(artifacts, raw, debrief.sessionId);
  if (!origin || origin.type !== "debrief") return { kind: "unavailable", originId: raw };
  return { kind: "carried", originId: raw, version: origin.version, ...(origin.presentedBy ? { presentedBy: origin.presentedBy } : {}) };
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v, null, 2) ?? String(v); } catch { return String(v); }
}
