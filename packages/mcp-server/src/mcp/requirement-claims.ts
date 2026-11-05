import {
  BRIEF_REF_DIAGNOSTIC_KEY,
  CLAIMS_ORIGIN_KEY,
  SERVER_SET_DEBRIEF_KEYS,
  matchBriefGrain,
  readRequirementClaims,
  resolveDebriefPin,
  type Artifact,
  type BriefRef,
  type RequirementClaim,
} from "@deeppairing/shared";
import { hasRawBriefRef, normalizeDebriefBriefRef } from "./brief-ref.js";
import { carriedBriefRef, stableStringify } from "./proposal-resolution.js";

/**
 * #572 slice B1 — the agent-facing SEMANTIC diagnostics for a debrief's
 * requirement claims (warnings: the claims are kept). Shape problems never get
 * here: `validatePresentDebriefInput` already refused the call.
 *  - no usable pin → every claim is unattributed (never coverage);
 *  - an id the pinned version doesn't have → unknown; 2+ rows → ambiguous.
 * Exact explicit-id matching only (matchBriefGrain): no position fallback.
 */
export function claimWriteNotes(claims: readonly RequirementClaim[], ref: BriefRef | undefined, artifacts: readonly Artifact[], sessionId: string): string[] {
  if (claims.length === 0) return [];
  const n = `${claims.length} requirement claim${claims.length === 1 ? "" : "s"}`;
  const pin = ref ? resolveDebriefPin(ref, artifacts, sessionId) : { state: "none" as const };
  if (pin.state !== "ready") {
    return [`${n} saved with no usable brief link, so ${claims.length === 1 ? "it shows" : "they show"} as unattributed, never as coverage. Pin the brief (briefRef) on a revision to attribute them.`];
  }
  const rows = (pin.brief.content as { requirements?: unknown }).requirements;
  const notes = [`${n} saved as your account against ${pin.artifactId} v${pin.view.version}. Your pair sees them as agent-reported claims, not acceptance.`];
  for (const c of claims) {
    const match = matchBriefGrain(rows, c.requirementId);
    if (match === "unknown") notes.push(`requirement ${JSON.stringify(c.requirementId)} isn't in ${pin.artifactId} v${pin.view.version}. The claim is kept and marked unknown.`);
    if (match === "ambiguous") notes.push(`requirement ${JSON.stringify(c.requirementId)} matches more than one row in ${pin.artifactId} v${pin.view.version} (a legacy duplicate id). The claim is kept and marked ambiguous.`);
  }
  return notes;
}

// --- revise_artifact (debrief) -------------------------------------------------

/** An explicit, admitted pin on a debrief revision (absent → the pin carries). */
export interface DebriefPinRevision {
  ref?: BriefRef;
  /** True when the explicit pin differs from the predecessor's saved pin. */
  changed: boolean;
  notes: string[];
}

const own = (o: unknown, k: string): boolean => !!o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);

const NOTHING_CHANGED = "Nothing was created and the earlier version is unchanged.";

/**
 * #572 B1 — decide a debrief revision's pin BEFORE anything is written.
 * Returns `{error}` for every unsupported combination:
 *  - `briefRef` / a server-set key inside `content` (the pin is the top-level
 *    `briefRef` argument; origin and diagnostics are server-set);
 *  - `briefRef: null` (removing a pin is unsupported);
 *  - an explicit pin the canonical admission would DROP (on a revision that
 *    rejects, so old claims are never carried after a dropped new pin);
 *  - a CHANGED pin without supplied replacement `requirementClaims`.
 * Returns `{changed:false, notes:[]}` with no ref when no pin was given.
 */
export function reviseDebriefPin(old: Artifact, args: unknown, supplied: Record<string, unknown>, artifacts: readonly Artifact[]): DebriefPinRevision | { error: string } {
  const reserved = ["briefRef", ...SERVER_SET_DEBRIEF_KEYS].filter((k) => own(supplied, k));
  if (reserved.length > 0) {
    return { error: `revise_artifact: ${reserved.map((k) => `content.${k}`).join(", ")} can't be set in content. A debrief's brief pin is the top-level \`briefRef\` argument; claim origin and link diagnostics are set by the server (don't echo them from the earlier version). ${NOTHING_CHANGED}` };
  }
  if (!hasRawBriefRef(args)) return { changed: false, notes: [] };
  const raw = (args as { briefRef: unknown }).briefRef;
  if (raw === null) {
    return { error: `revise_artifact: removing a debrief's brief pin (briefRef: null) is unsupported. Omit briefRef to keep the pin, or pass a new {artifactId} with replacement requirementClaims. ${NOTHING_CHANGED}` };
  }
  const n = normalizeDebriefBriefRef(raw, [...artifacts], old.sessionId);
  if (!n.ref) {
    return { error: `revise_artifact: the new briefRef can't be admitted, so the revision was refused (a revision never keeps old claims after dropping a new pin). ${n.notes.join(" ")} ${NOTHING_CHANGED}` };
  }
  const changed = stableStringify(n.ref) !== stableStringify(carriedBriefRef(old) ?? null);
  if (changed && !own(supplied, "requirementClaims")) {
    return { error: `revise_artifact: changing a debrief's brief pin (to ${n.ref.artifactId}) needs replacement requirementClaims in content (an empty array is fine), so claims made against the old version never attach to the new one. ${NOTHING_CHANGED}` };
  }
  return { ref: n.ref, changed, notes: n.notes };
}

/**
 * #572 B1 — apply the claim half of a debrief revision to `content` (mutated):
 *  - claims OMITTED → the predecessor's exact saved list and its origin carry
 *    unchanged (raw, even when unreadable: carry is not presentation);
 *  - claims SUPPLIED → the validated list replaces them whole, with `newId`
 *    as origin; `[]` clears (no list, no origin);
 *  - the dropped-pin diagnostic follows the PIN: it carries only when the pin
 *    carries (no explicit pin on this revision).
 */
export function carryDebriefClaims(old: Artifact, content: Record<string, unknown>, newId: string, pin: DebriefPinRevision | undefined, validated: unknown): void {
  const prior = (old.content ?? {}) as Record<string, unknown>;
  if (own(content, "requirementClaims")) {
    const list = (validated as { requirementClaims?: unknown[] } | undefined)?.requirementClaims ?? content.requirementClaims;
    if (Array.isArray(list) && list.length > 0) {
      content.requirementClaims = list;
      content[CLAIMS_ORIGIN_KEY] = newId;
    } else {
      delete content.requirementClaims;
    }
  } else if (prior.requirementClaims !== undefined) {
    content.requirementClaims = structuredClone(prior.requirementClaims);
    if (prior[CLAIMS_ORIGIN_KEY] !== undefined) content[CLAIMS_ORIGIN_KEY] = structuredClone(prior[CLAIMS_ORIGIN_KEY]);
  }
  if (!pin?.ref && prior[BRIEF_REF_DIAGNOSTIC_KEY] !== undefined) content[BRIEF_REF_DIAGNOSTIC_KEY] = structuredClone(prior[BRIEF_REF_DIAGNOSTIC_KEY]);
}

/** The revise response's B1 lines, from the SAVED successor. */
export function debriefReviseNotes(saved: Artifact, pin: DebriefPinRevision | undefined, artifacts: readonly Artifact[]): string {
  const c = (saved.content ?? {}) as Record<string, unknown>;
  const notes = [...(pin?.notes ?? [])];
  const read = readRequirementClaims(c.requirementClaims);
  if (read.kind === "ok" && c[CLAIMS_ORIGIN_KEY] === saved.id) {
    notes.push(...claimWriteNotes(read.claims, saved.briefRef as BriefRef | undefined, artifacts, saved.sessionId));
  } else if (c.requirementClaims !== undefined) {
    notes.push(`Requirement claims carried unchanged from ${typeof c[CLAIMS_ORIGIN_KEY] === "string" ? c[CLAIMS_ORIGIN_KEY] : "an earlier report (origin unknown)"}; they keep their original report provenance.`);
  }
  return notes.length > 0 ? `\n\n${notes.join("\n")}` : "";
}
