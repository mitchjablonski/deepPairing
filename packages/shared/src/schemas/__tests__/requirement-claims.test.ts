/**
 * #572 slice B1 — the requirement-claim admission policy, the non-destructive
 * reader, the comment-safe key and the unique same-session pin resolver.
 * Contract: #572 comments 6546521744 + 6546678897 (addendum wins).
 */
import { describe, it, expect } from "vitest";
import {
  CLAIM_STRING_LIMITS,
  MAX_REQUIREMENT_CLAIMS_BYTES,
  RequirementClaimsSchema,
  briefRefDiagnosticFor,
  claimSectionKey,
  decodeClaimSectionKey,
  readBriefRefDiagnostic,
  readRequirementClaims,
  requirementClaimsByteLength,
  resolveDebriefPin,
} from "../requirement-claims.js";
import { DebriefContentSchema } from "../content-types.js";
import { describeBriefPin, formatBriefPin, type BriefLookupArtifact } from "../brief-ref.js";

const check = { kind: "check", ran: "pnpm test", outcome: "passed" } as const;
const met = (requirementId: string) => ({ requirementId, claim: "met", evidence: [check] });
const ok = (list: unknown) => RequirementClaimsSchema.safeParse(list).success;
/** U+1D49C (𝒜) is 2 UTF-16 units: 32 of them are 64 units, 33 are 66. */
const SUPP = "\u{1D49C}";

describe("admission caps (UTF-16 units)", () => {
  it("requirement ids: 64/65 ASCII and 32/33 supplementary-plane characters", () => {
    expect(ok([met("a".repeat(64))])).toBe(true);
    expect(ok([met("a".repeat(65))])).toBe(false);
    expect(ok([met(SUPP.repeat(32))])).toBe(true);
    expect(ok([met(SUPP.repeat(33))])).toBe(false);
  });

  it("every new string maximum holds at its boundary", () => {
    const at = (field: string, n: number, build: (s: string) => unknown) => {
      expect(ok([build("x".repeat(n))]), `${field} @${n}`).toBe(true);
      expect(ok([build("x".repeat(n + 1))]), `${field} @${n + 1}`).toBe(false);
    };
    at("ran", CLAIM_STRING_LIMITS.ran, (s) => ({ requirementId: "R", claim: "met", evidence: [{ ...check, ran: s }] }));
    at("sourceRevision", CLAIM_STRING_LIMITS.sourceRevision, (s) => ({ requirementId: "R", claim: "met", evidence: [{ ...check, sourceRevision: s }] }));
    at("runId", CLAIM_STRING_LIMITS.runId, (s) => ({ requirementId: "R", claim: "met", evidence: [{ ...check, runId: s }] }));
    at("excerpt", CLAIM_STRING_LIMITS.excerpt, (s) => ({ requirementId: "R", claim: "met", evidence: [{ ...check, excerpt: s }] }));
    at("observation text", CLAIM_STRING_LIMITS.text, (s) => ({ requirementId: "R", claim: "met", evidence: [{ kind: "observation", text: s }] }));
    at("note", CLAIM_STRING_LIMITS.note, (s) => ({ requirementId: "R", claim: "met", evidence: [{ kind: "artifact", artifactId: "art_x", note: s }] }));
    at("explanation", CLAIM_STRING_LIMITS.explanation, (s) => ({ requirementId: "R", claim: "unknown", explanation: s }));
    at("notRun", CLAIM_STRING_LIMITS.notRun, (s) => ({ requirementId: "R", claim: "unknown", notRun: s }));
    at("artifactId", 64, (s) => ({ requirementId: "R", claim: "met", evidence: [{ kind: "artifact", artifactId: s }] }));
  });

  it("32 claims / 8 evidence items admit; 33 / 9 reject", () => {
    expect(ok(Array.from({ length: 32 }, (_, i) => met(`R${i}`)))).toBe(true);
    expect(ok(Array.from({ length: 33 }, (_, i) => met(`R${i}`)))).toBe(false);
    expect(ok([{ requirementId: "R", claim: "met", evidence: Array.from({ length: 8 }, () => check) }])).toBe(true);
    expect(ok([{ requirementId: "R", claim: "met", evidence: Array.from({ length: 9 }, () => check) }])).toBe(false);
  });

  it("the 64 KiB cap counts UTF-8 bytes of the whole list, nested EvidenceInput included", () => {
    const snippet = "é".repeat(2000); // 2 bytes each in UTF-8
    const list = Array.from({ length: 20 }, (_, i) => ({ requirementId: `R${i}`, claim: "met", evidence: [{ kind: "source", evidence: { snippet, explanation: "e" } }] }));
    expect(requirementClaimsByteLength(list)).toBeGreaterThan(MAX_REQUIREMENT_CLAIMS_BYTES);
    expect(ok(list)).toBe(false);
    expect(ok(list.slice(0, 10))).toBe(true);
  });
});

describe("shape rules", () => {
  it("strict objects, no nulls, no blank, enums only", () => {
    expect(ok([{ ...met("R"), extra: 1 }])).toBe(false);
    expect(ok([{ requirementId: "R", claim: "met", evidence: [{ ...check, extra: 1 }] }])).toBe(false);
    expect(ok([{ requirementId: "R", claim: "met", evidence: [{ kind: "source", evidence: "a.ts:1", extra: 1 }] }])).toBe(false);
    expect(ok([{ ...met("R"), explanation: null }])).toBe(false);
    expect(ok([{ requirementId: "R", claim: "unknown", notRun: " \t" }])).toBe(false);
    expect(ok([{ requirementId: "R", claim: "verified", evidence: [check] }])).toBe(false);
    expect(ok([{ requirementId: "R", claim: "met", evidence: [{ kind: "proof", text: "x" }] }])).toBe(false);
  });

  it("met needs evidence; unmet/unknown need evidence, notRun or explanation; notRun may sit beside evidence", () => {
    expect(ok([{ requirementId: "R", claim: "met", evidence: [] }])).toBe(false);
    expect(ok([{ requirementId: "R", claim: "met", notRun: "x" }])).toBe(false);
    expect(ok([{ requirementId: "R", claim: "unmet" }])).toBe(false);
    expect(ok([{ requirementId: "R", claim: "unmet", explanation: "broke" }])).toBe(true);
    expect(ok([{ requirementId: "R", claim: "unknown", notRun: "no env" }])).toBe(true);
    expect(ok([{ requirementId: "R", claim: "met", evidence: [{ ...check, outcome: "partial" }], notRun: "e2e not run" }])).toBe(true);
  });

  it("duplicate raw ids reject even when identical; ids are raw (no trim, case-sensitive)", () => {
    expect(ok([met("R"), met("R")])).toBe(false);
    expect(ok([met("R"), met("r"), met(" R")])).toBe(true);
  });

  it("the debrief schema keeps requirementClaims optional (legacy content parses unchanged)", () => {
    expect(DebriefContentSchema.safeParse({ summary: "s" }).success).toBe(true);
    expect(DebriefContentSchema.safeParse({ summary: "s", requirementClaims: [met("R")] }).success).toBe(true);
  });
});

describe("readRequirementClaims — classification only, never rewrites", () => {
  it("none / ok / duplicate / unreadable", () => {
    expect(readRequirementClaims(undefined)).toEqual({ kind: "none" });
    expect(readRequirementClaims([met("R")])).toEqual({ kind: "ok", claims: [met("R")] });
    const dup = [met("R"), met("R")];
    const before = JSON.stringify(dup);
    expect(readRequirementClaims(dup)).toEqual({ kind: "duplicate", ids: ["R"] });
    expect(JSON.stringify(dup)).toBe(before);
    expect(readRequirementClaims("nope")).toEqual({ kind: "unreadable" });
    expect(readRequirementClaims([{ requirementId: "R", claim: "met" }])).toEqual({ kind: "unreadable" });
    // Over-cap saved data is unreadable, never truncated into partial rows.
    expect(readRequirementClaims(Array.from({ length: 33 }, (_, i) => met(`R${i}`)))).toEqual({ kind: "unreadable" });
    // A duplicate list that ALSO has a malformed row is plain unreadable.
    expect(readRequirementClaims([met("R"), met("R"), { requirementId: "Q" }])).toEqual({ kind: "unreadable" });
  });
});

describe("claimSectionKey — unambiguous comment keys", () => {
  it("escapes everything outside [A-Za-z0-9._~-] and round-trips, lone surrogates included", () => {
    for (const id of ["REQ-1", "12", "a:b", "x y", "%0041", "\uD800", SUPP, "debrief:claim:REQ"]) {
      const key = claimSectionKey(id);
      expect(key).toMatch(/^[A-Za-z0-9._~%-]*$/);
      expect(decodeClaimSectionKey(key)).toBe(id);
    }
    expect(claimSectionKey("a:b")).not.toBe(claimSectionKey("a%003Ab"));
    expect(claimSectionKey("REQ-1")).toBe("REQ-1");
  });
});

describe("dropped-pin diagnostic", () => {
  it("keeps only a string attempted id of ≤64 units and a known reason", () => {
    expect(briefRefDiagnosticFor({ artifactId: "art_x" }, "not_a_spec")).toEqual({ attemptedArtifactId: "art_x", reason: "not_a_spec" });
    expect(briefRefDiagnosticFor({ artifactId: "a".repeat(65) }, "invalid_ref")).toEqual({ reason: "invalid_ref" });
    expect(briefRefDiagnosticFor({ artifactId: 5 }, "invalid_ref")).toEqual({ reason: "invalid_ref" });
    expect(briefRefDiagnosticFor(null, "invalid_ref")).toEqual({ reason: "invalid_ref" });
    expect(readBriefRefDiagnostic({ attemptedArtifactId: "a".repeat(99), reason: "who-knows" })).toEqual({});
    expect(readBriefRefDiagnostic(undefined)).toBeUndefined();
  });
});

describe("resolveDebriefPin — exactly one same-session spec", () => {
  const a = (over: Partial<BriefLookupArtifact>): BriefLookupArtifact => ({ id: "b1", sessionId: "s1", type: "spec", title: "Brief", version: 1, status: "approved", content: {}, ...over });

  it("ready only for one same-session spec; duplicates (any type), foreign sessions and non-specs are unavailable", () => {
    expect(resolveDebriefPin({ artifactId: "b1" }, [a({})], "s1").state).toBe("ready");
    expect(resolveDebriefPin({ artifactId: "b1" }, [a({}), a({ type: "decision" })], "s1")).toMatchObject({ state: "unavailable", why: "duplicate" });
    expect(resolveDebriefPin({ artifactId: "b1" }, [a({ sessionId: "s2" })], "s1")).toMatchObject({ state: "unavailable", why: "missing" });
    expect(resolveDebriefPin({ artifactId: "b1" }, [a({ sessionId: "s2" }), a({})], "s1").state).toBe("ready");
    expect(resolveDebriefPin({ artifactId: "b1" }, [a({ type: "plan" })], "s1")).toMatchObject({ state: "unavailable", why: "not_a_spec" });
  });

  it("a stored pin with grain lists, or out of policy, is unreadable (raw id kept)", () => {
    expect(resolveDebriefPin({ artifactId: "b1", requirementIds: ["R"] }, [a({})], "s1")).toEqual({ state: "unreadable", rawId: "b1" });
    expect(resolveDebriefPin({ artifactId: "" }, [a({})], "s1")).toEqual({ state: "unreadable", rawId: "" });
    expect(resolveDebriefPin(undefined, [a({})], "s1")).toEqual({ state: "none" });
  });

  it("a superseded pinned version stays that version (no successor walk)", () => {
    const pin = resolveDebriefPin({ artifactId: "b1" }, [a({ status: "superseded" }), a({ id: "b2", version: 2 })], "s1");
    expect(pin).toMatchObject({ state: "ready", view: { version: 1, closed: true, status: "superseded" } });
  });
});

describe("formatBriefPin role", () => {
  const view = describeBriefPin({ artifactId: "b1" }, [{ id: "b1", sessionId: "s1", type: "spec", title: "Brief", version: 2, status: "approved", content: {} }], "s1");
  it("exception copy is unchanged; a debrief reads as the agent's account with its status", () => {
    expect(formatBriefPin(view)).toBe(`Exception to "Brief" v2`);
    expect(formatBriefPin(view, "account")).toBe(`Agent's account against "Brief" v2 (approved)`);
    expect(formatBriefPin({ ...view, available: false }, "account")).toBe("Agent's account against brief b1 (version unknown, brief unavailable)");
  });
});
