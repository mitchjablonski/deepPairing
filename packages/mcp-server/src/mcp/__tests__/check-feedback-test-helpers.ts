import { expect } from "vitest";
import { createHash } from "node:crypto";

/**
 * #188 (PAYDOWN) — ONE shared assertion for the HEALTHY check_feedback
 * structuredContent contract. The canonical key-set assertion used to be
 * copy-pasted across the lane test files (ledger-health, secret-warning,
 * render-failure, …); each lane test then hand-asserted "my lane's key is NOT
 * present on a clean payload." This centralizes the contract so a future field
 * addition is caught in exactly one place, and each lane test asserts only its
 * own delta.
 *
 * "Healthy" = no lane-specific spread fired: `suggestions`, `renderFailures`,
 * and `ledgerHealth` are all ABSENT, `companionUrl` present (port > 0). The base
 * arrays (comments/questions/decisions/pendingArtifacts/rejected/statusChanges)
 * are always present — they may be non-empty (a plain comment/pending draft) and
 * the top-level key set is unchanged by that.
 */
export const HEALTHY_CHECK_FEEDBACK_KEYS = [
  "comments",
  "companionUrl",
  "decisions",
  "pendingArtifacts",
  "questions",
  "rejected",
  "serverVersion",
  "statusChanges",
  "status",
  "suggestedAction",
  "summary",
] as const;

/**
 * Assert `sc` carries EXACTLY the canonical healthy top-level key set — no
 * lane-specific spread (suggestions / renderFailures / ledgerHealth) leaked in.
 *
 * M3 — `suggestedAction` rides structuredContent ONLY on the 'proceed' hot path.
 * On a BUSY poll (status 'waiting'/'feedback') the verbatim echo is dropped (the
 * prose preamble still carries it), so the expected key set excludes it there.
 * The base arrays are always present regardless (they may be non-empty).
 */
export function expectHealthyCheckFeedbackPayload(sc: Record<string, unknown>): void {
  const expected = [...HEALTHY_CHECK_FEEDBACK_KEYS];
  const wanted =
    sc.status === "proceed" ? expected : expected.filter((k) => k !== "suggestedAction");
  expect(Object.keys(sc).sort()).toEqual([...wanted].sort());
}

/**
 * GOLDEN pin of the canonical fully-empty healthy payload (port 4000, no
 * artifacts/comments → pure "proceed"), captured against the PRE-refactor tree.
 * `serverVersion` is normalized to "<version>" before hashing (see
 * `normalizedHealthyStructSha`) so the pin is release-stable — a version bump
 * does not churn it, but any drift in the healthy payload's SHAPE or wording
 * does. Modeled on advisory-recall-byte-identity.test.ts's GOLDEN_SHA256.
 */
export const GOLDEN_HEALTHY_STRUCT_SHA256 =
  "e2bd0b9559c88cb3a4a6bb303b4b3ce005fdc806e14b52880423527d5ec83736";

/** sha256 of the canonical healthy structuredContent with serverVersion
 *  normalized (object-spread keeps the key in its original position, so only the
 *  value changes — the hash stays order-stable and release-stable). */
export function normalizedHealthyStructSha(sc: Record<string, unknown>): string {
  const normalized = { ...sc, serverVersion: "<version>" };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}
