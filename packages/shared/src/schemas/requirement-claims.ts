import { z } from "zod";
import { EvidenceInputSchema } from "./evidence.js";
import { MAX_SPEC_ID_LENGTH, describeBriefPin, readBriefRef, type BriefLookupArtifact, type BriefPinView, type BriefRef } from "./brief-ref.js";

/**
 * #572 slice B1 — the agent's REQUIREMENT CLAIMS on a debrief, pinned to one
 * exact brief version (the artifact-level `briefRef`, `{artifactId}` only).
 *
 * A claim is the agent's ACCOUNT ("I handled REQ-1, here is what I ran"), not
 * acceptance, not verification and not authority: nothing here closes a
 * question, a review, a gate or a merge. Every string is agent-reported; a
 * `sourceRevision` / `runId` is a label the agent typed, never an
 * authenticated runner identity.
 *
 * Two policies, kept apart on purpose:
 *  - ADMISSION (`RequirementClaimsSchema`): strict objects (unknown keys
 *    reject), nonblank bounded strings, ≤32 claims, ≤8 evidence items each,
 *    no duplicate raw requirement ids, ≤64 KiB serialized. A supplied list is
 *    accepted whole or the call fails; nothing is truncated, trimmed, merged
 *    or partially kept.
 *  - READING (`readRequirementClaims`): a saved list is never rewritten. One
 *    that no longer meets the admission policy (a legacy or foreign writer) is
 *    reported as UNREADABLE (or duplicate), never shown as valid-looking rows.
 *
 * Pure and dependency-light: the MCP tools, the daemon and the web all read it.
 */

/** At most this many claims on one debrief. */
export const MAX_REQUIREMENT_CLAIMS = 32;
/** At most this many evidence items on one claim. */
export const MAX_CLAIM_EVIDENCE = 8;
/** Raw requirement / evidence-artifact ids: 1–64 UTF-16 units. */
export const MAX_CLAIM_ID_LENGTH = MAX_SPEC_ID_LENGTH;
/** UTF-8 bytes of `JSON.stringify(requirementClaims)` (nested evidence included). */
export const MAX_REQUIREMENT_CLAIMS_BYTES = 65_536;
/** String maxima in UTF-16 units (`String#length`). */
export const CLAIM_STRING_LIMITS = {
  ran: 512,
  sourceRevision: 256,
  runId: 256,
  excerpt: 4096,
  text: 4096,
  note: 1024,
  explanation: 2048,
  notRun: 2048,
} as const;

const nonblank = (max: number) =>
  z.string().min(1).max(max).refine((s) => s.trim().length > 0, { message: "must not be blank" });

const CheckEvidenceSchema = z.object({
  kind: z.literal("check"),
  ran: nonblank(CLAIM_STRING_LIMITS.ran).describe("What you ran (command or check name)"),
  outcome: z.enum(["passed", "failed", "errored", "partial"]),
  sourceRevision: nonblank(CLAIM_STRING_LIMITS.sourceRevision).optional()
    .describe("The commit / revision you ran it against, if you know it. Omit when you don't: it shows as 'source version unknown'."),
  runId: nonblank(CLAIM_STRING_LIMITS.runId).optional().describe("A CI run id or similar, if any"),
  excerpt: nonblank(CLAIM_STRING_LIMITS.excerpt).optional().describe("A short excerpt of the output"),
}).strict();

const SourceEvidenceSchema = z.object({
  kind: z.literal("source"),
  /** Where the work lives. Not whether it works. */
  evidence: EvidenceInputSchema,
}).strict();

const ArtifactEvidenceSchema = z.object({
  kind: z.literal("artifact"),
  artifactId: nonblank(MAX_CLAIM_ID_LENGTH).describe("An artifact in this session (e.g. the changeset): shows the code changed, nothing more"),
  note: nonblank(CLAIM_STRING_LIMITS.note).optional(),
}).strict();

const ObservationEvidenceSchema = z.object({
  kind: z.literal("observation"),
  text: nonblank(CLAIM_STRING_LIMITS.text).describe("What you observed"),
  sourceRevision: nonblank(CLAIM_STRING_LIMITS.sourceRevision).optional(),
}).strict();

export const ClaimEvidenceSchema = z.discriminatedUnion("kind", [
  CheckEvidenceSchema,
  SourceEvidenceSchema,
  ArtifactEvidenceSchema,
  ObservationEvidenceSchema,
]);
export type ClaimEvidence = z.infer<typeof ClaimEvidenceSchema>;

export const RequirementClaimSchema = z.object({
  requirementId: nonblank(MAX_CLAIM_ID_LENGTH)
    .describe("The pinned brief's requirements[].id, exactly as written (no trimming; matched exactly, never by position)"),
  claim: z.enum(["met", "unmet", "unknown"])
    .describe("Your account: met = you believe you handled it (needs evidence); unmet = you didn't; unknown = you can't tell"),
  evidence: z.array(ClaimEvidenceSchema).max(MAX_CLAIM_EVIDENCE).optional(),
  notRun: nonblank(CLAIM_STRING_LIMITS.notRun).optional()
    .describe("What you did NOT run and why. May sit next to evidence (a partial run). Never replaces evidence on a met claim."),
  explanation: nonblank(CLAIM_STRING_LIMITS.explanation).optional(),
}).strict().superRefine((c, ctx) => {
  const hasEvidence = (c.evidence?.length ?? 0) > 0;
  if (c.claim === "met" && !hasEvidence) {
    ctx.addIssue({ code: "custom", path: ["evidence"], message: "a met claim needs at least one evidence item (notRun or explanation never substitutes)" });
  }
  if (c.claim !== "met" && !hasEvidence && c.notRun === undefined && c.explanation === undefined) {
    ctx.addIssue({ code: "custom", path: ["claim"], message: `an ${c.claim} claim needs evidence, notRun or explanation` });
  }
});
export type RequirementClaim = z.infer<typeof RequirementClaimSchema>;

/** UTF-8 byte length of the serialized list (TextEncoder: Node and browsers). */
export function requirementClaimsByteLength(raw: unknown): number {
  const json = JSON.stringify(raw);
  return json === undefined ? 0 : new TextEncoder().encode(json).length;
}

export const RequirementClaimsSchema = z.array(RequirementClaimSchema).max(MAX_REQUIREMENT_CLAIMS).superRefine((list, ctx) => {
  const seen = new Map<string, number>();
  list.forEach((c, i) => {
    const first = seen.get(c.requirementId);
    if (first !== undefined) {
      ctx.addIssue({ code: "custom", path: [i, "requirementId"], message: `duplicate requirementId (also claim ${first}); one claim per requirement` });
    } else seen.set(c.requirementId, i);
  });
  const bytes = requirementClaimsByteLength(list);
  if (bytes > MAX_REQUIREMENT_CLAIMS_BYTES) {
    ctx.addIssue({ code: "custom", path: [], message: `requirementClaims is ${bytes} bytes serialized (at most ${MAX_REQUIREMENT_CLAIMS_BYTES})` });
  }
}).describe("Your account against the pinned brief (briefRef): one entry per requirement you are reporting on. Claims, not acceptance.");

// --- server-set debrief content keys ----------------------------------------

/** Server-set: the artifact whose report supplied the current claim set. */
export const CLAIMS_ORIGIN_KEY = "claimsOriginArtifactId";
/** Server-set: why a supplied pin was dropped at creation. */
export const BRIEF_REF_DIAGNOSTIC_KEY = "briefRefDiagnostic";
/** Content keys a caller may never set (present_debrief or revise_artifact). */
export const SERVER_SET_DEBRIEF_KEYS: readonly string[] = [CLAIMS_ORIGIN_KEY, BRIEF_REF_DIAGNOSTIC_KEY];

export const DROPPED_PIN_REASONS = [
  "invalid_ref",
  "grain_ids_not_allowed",
  "artifacts_unreadable",
  "not_in_session",
  "not_a_spec",
  "ambiguous_target",
] as const;
export type DroppedPinReason = (typeof DROPPED_PIN_REASONS)[number];

export interface BriefRefDiagnostic {
  /** The attempted string artifactId, when it was a string of ≤64 units. */
  attemptedArtifactId?: string;
  reason: DroppedPinReason;
}

/** Build the bounded, server-set diagnostic for a dropped pin. */
export function briefRefDiagnosticFor(raw: unknown, reason: DroppedPinReason): BriefRefDiagnostic {
  const id = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { artifactId?: unknown }).artifactId : undefined;
  return typeof id === "string" && id.length > 0 && id.length <= MAX_CLAIM_ID_LENGTH
    ? { attemptedArtifactId: id, reason }
    : { reason };
}

/** Read a saved diagnostic without trusting it (unknown reason → undefined reason). */
export function readBriefRefDiagnostic(raw: unknown): { attemptedArtifactId?: string; reason?: DroppedPinReason } | undefined {
  if (raw === undefined) return undefined;
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const id = typeof o.attemptedArtifactId === "string" && o.attemptedArtifactId.length <= MAX_CLAIM_ID_LENGTH ? o.attemptedArtifactId : undefined;
  const reason = (DROPPED_PIN_REASONS as readonly unknown[]).includes(o.reason) ? o.reason as DroppedPinReason : undefined;
  return { ...(id !== undefined ? { attemptedArtifactId: id } : {}), ...(reason ? { reason } : {}) };
}

// --- reading ------------------------------------------------------------------

export type ReadClaims =
  | { kind: "none" }
  | { kind: "ok"; claims: RequirementClaim[] }
  | { kind: "duplicate"; ids: string[] }
  | { kind: "unreadable" };

/**
 * Classify a SAVED `requirementClaims` value. Never rewrites it. A list that
 * fails the admission policy is unreadable (duplicate raw ids get their own
 * diagnostic): never first/last winner, never partial rows.
 */
export function readRequirementClaims(raw: unknown): ReadClaims {
  if (raw === undefined) return { kind: "none" };
  const parsed = RequirementClaimsSchema.safeParse(raw);
  if (parsed.success) return { kind: "ok", claims: parsed.data };
  if (Array.isArray(raw)) {
    const ids = raw.map((c) => (c && typeof c === "object" ? (c as { requirementId?: unknown }).requirementId : undefined));
    const dup = [...new Set(ids.filter((id, i): id is string => typeof id === "string" && ids.indexOf(id) !== i))];
    // Duplicate only: every row reads on its own, only the ids collide.
    if (dup.length > 0 && raw.every((c) => RequirementClaimSchema.safeParse(c).success)) return { kind: "duplicate", ids: dup };
  }
  return { kind: "unreadable" };
}

/**
 * A comment-safe key for a raw requirement id (`debrief:claim:<key>`): every
 * UTF-16 unit outside [A-Za-z0-9._~-] becomes `%XXXX` (4 hex digits), so ids
 * with colons, spaces or lone surrogates map to one unambiguous key.
 */
export function claimSectionKey(requirementId: string): string {
  let out = "";
  for (let i = 0; i < requirementId.length; i++) {
    const ch = requirementId[i]!;
    out += /[A-Za-z0-9._~-]/.test(ch) ? ch : `%${requirementId.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return out;
}

/** Inverse of `claimSectionKey` (unknown escapes stay literal). */
export function decodeClaimSectionKey(key: string): string {
  return key.replace(/%([0-9A-F]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

// --- the debrief pin (B1 local guard) ------------------------------------------

export type DebriefPinState =
  | { state: "none" }
  /** A stored pin that is unreadable, out of policy, or carries grain lists. */
  | { state: "unreadable"; rawId?: string }
  /** Readable, but not exactly one same-session spec with that id. */
  | { state: "unavailable"; artifactId: string; why: "missing" | "duplicate" | "not_a_spec" }
  | { state: "ready"; artifactId: string; view: BriefPinView; brief: BriefLookupArtifact };

/**
 * Resolve a debrief's saved pin. Stricter than `describeBriefPin` (which takes
 * the first match): exactly ONE artifact in the debrief's own session may
 * carry the id, across all types, and it must be a spec. No successor walk.
 */
export function resolveDebriefPin(rawRef: unknown, artifacts: readonly BriefLookupArtifact[], sessionId: string): DebriefPinState {
  const read = readBriefRef(rawRef);
  if (read === undefined) return { state: "none" };
  if (!read.ok) return { state: "unreadable", ...(read.rawId !== undefined ? { rawId: read.rawId } : {}) };
  const ref: BriefRef = read.ref;
  if (ref.requirementIds !== undefined || ref.edgePathIds !== undefined) return { state: "unreadable", rawId: ref.artifactId };
  const matches = artifacts.filter((a) => a.sessionId === sessionId && a.id === ref.artifactId);
  if (matches.length === 0) return { state: "unavailable", artifactId: ref.artifactId, why: "missing" };
  if (matches.length > 1) return { state: "unavailable", artifactId: ref.artifactId, why: "duplicate" };
  const brief = matches[0]!;
  if (brief.type !== "spec") return { state: "unavailable", artifactId: ref.artifactId, why: "not_a_spec" };
  return { state: "ready", artifactId: ref.artifactId, view: describeBriefPin(ref, [brief], sessionId), brief };
}

/** Exactly one same-session artifact with this id (any type), else null. */
export function uniqueSessionArtifact<T extends { id: string; sessionId: string }>(artifacts: readonly T[], id: string, sessionId: string): T | null {
  const matches = artifacts.filter((a) => a.sessionId === sessionId && a.id === id);
  return matches.length === 1 ? matches[0]! : null;
}
