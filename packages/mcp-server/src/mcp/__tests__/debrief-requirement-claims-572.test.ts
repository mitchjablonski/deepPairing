/**
 * #572 slice B1 — requirement claims with evidence on a debrief, pinned to one
 * brief. Contract: issue #572 comments 6546521744 (Opus) as amended by
 * 6546678897 (Sol's addendum; the addendum wins). One describe per addendum
 * clause plus Sol's adversarial matrix rows that live server-side (the
 * display rows are in web/src/components/__tests__/DebriefClaims572.test.tsx).
 *
 * Fakes, not mocks: a real FileStore on a temp dir and the real MCP server
 * over an in-memory transport.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { Artifact } from "@deeppairing/shared";
import { claimSectionKey } from "@deeppairing/shared";
import { FileStore } from "../../store/file-store.js";
import { setupServerTest, makeCallTool } from "./server-test-harness.js";

const ctx = setupServerTest();
const callTool = makeCallTool(ctx);
let store: FileStore;
beforeEach(() => { store = ctx.store; });

const SPEC = {
  objective: "Ship the auth flow",
  requirements: [
    { id: "REQ-1", statement: "Login works", rationale: "r", acceptanceCriteria: ["a"] },
    { id: "REQ-2", statement: "Reset works", rationale: "r", acceptanceCriteria: ["a"] },
  ],
};
const seedSpec = (id: string, over: Record<string, unknown> = {}) =>
  store.createArtifact({ id, type: "spec", title: "Auth brief", content: SPEC, ...over });

const CHECK = { kind: "check", ran: "pnpm vitest run auth", outcome: "passed", sourceRevision: "abc1234" } as const;
const MET = (requirementId: string, extra: Record<string, unknown> = {}) => ({ requirementId, claim: "met", evidence: [CHECK], ...extra });
const BASE = { title: "Debrief — auth flow", summary: "We shipped the login and reset flow; here is my account against the brief." };

const debriefs = (): Artifact[] => store.getArtifacts().filter((a) => a.type === "debrief");
const only = (): Artifact => { const d = debriefs(); expect(d).toHaveLength(1); return d[0]!; };
const content = (a: Artifact) => a.content as Record<string, unknown>;

async function presentPinned(claims: unknown[] = [MET("REQ-1")], extra: Record<string, unknown> = {}) {
  seedSpec("art_brief1");
  const res = await callTool("present_debrief", { ...BASE, briefRef: { artifactId: "art_brief1" }, requirementClaims: claims, ...extra });
  expect(res.isError).toBeFalsy();
  return { res, debrief: only() };
}

describe("legacy parity — absent new fields", () => {
  it("a debrief without briefRef/requirementClaims stores exactly the pre-B1 shape", async () => {
    const res = await callTool("present_debrief", { ...BASE, deferred: [{ what: "x", why: "y" }] });
    expect(res.isError).toBeFalsy();
    const d = only();
    expect(Object.keys(content(d)).sort()).toEqual(["deferred", "summary"]);
    expect("briefRef" in d).toBe(false);
    expect(res.text).not.toMatch(/requirement claim|briefRef dropped|account against/);
  });

  it("revising a legacy debrief adds no B1 keys", async () => {
    await callTool("present_debrief", BASE);
    const v1 = only();
    const r = await callTool("revise_artifact", { artifactId: v1.id, mode: "supersede", reason: "tighten", content: { summary: "Tighter account of the auth work." } });
    expect(r.isError).toBeFalsy();
    const v2 = store.getArtifacts().find((a) => a.parentId === v1.id)!;
    expect(Object.keys(content(v2))).toEqual(["summary"]);
    expect("briefRef" in v2).toBe(false);
  });
});

describe("clause 1 — strict whole-list admission", () => {
  const refused = async (claims: unknown, match?: RegExp) => {
    seedSpec("art_brief1");
    const res = await callTool("present_debrief", { ...BASE, briefRef: { artifactId: "art_brief1" }, requirementClaims: claims });
    expect(res.isError).toBe(true);
    expect(res._meta?.code).toBe("INPUT_VALIDATION_FAILED");
    expect(debriefs()).toHaveLength(0);
    if (match) expect(res.text).toMatch(match);
  };

  it("valid pin + known requirement + met with a check: saved with server-set origin", async () => {
    const { debrief, res } = await presentPinned();
    expect(debrief.briefRef).toEqual({ artifactId: "art_brief1" });
    expect(content(debrief).requirementClaims).toEqual([MET("REQ-1")]);
    expect(content(debrief).claimsOriginArtifactId).toBe(debrief.id);
    expect(res.text).toContain(`Linked: Agent's account against "Auth brief" v1 (draft)`);
    expect(res.text).toContain("not acceptance");
  });

  it("unknown claim keys reject (strict), nested in evidence too", async () => {
    await refused([{ ...MET("REQ-1"), confidence: "high" }]);
    await refused([{ requirementId: "REQ-1", claim: "met", evidence: [{ ...CHECK, verifiedBy: "ci" }] }]);
  });

  it("optional means omitted, never null", async () => {
    await refused([{ ...MET("REQ-1"), notRun: null }]);
  });

  it("duplicate raw requirement ids reject the whole call even when the claims agree", async () => {
    await refused([MET("REQ-1"), MET("REQ-1")], /duplicate requirementId/);
  });

  it("met needs evidence; notRun or explanation never substitute", async () => {
    await refused([{ requirementId: "REQ-1", claim: "met" }], /met claim needs at least one evidence/);
    await refused([{ requirementId: "REQ-1", claim: "met", notRun: "no CI" }]);
    await refused([{ requirementId: "REQ-1", claim: "met", explanation: "trust me" }]);
  });

  it("unmet/unknown need evidence, notRun or explanation", async () => {
    await refused([{ requirementId: "REQ-1", claim: "unmet" }]);
    await refused([{ requirementId: "REQ-1", claim: "unknown" }]);
  });

  it("blank strings reject (no trimming)", async () => {
    await refused([{ requirementId: "REQ-1", claim: "unknown", notRun: "   " }]);
    await refused([{ requirementId: "   ", claim: "unknown", notRun: "no env" }]);
    await refused([{ requirementId: "REQ-1", claim: "met", evidence: [{ ...CHECK, ran: " " }] }]);
  });

  it("bad enum, claim count, evidence count and byte caps reject atomically", async () => {
    await refused([{ ...MET("REQ-1"), claim: "done" }]);
    await refused([{ requirementId: "REQ-1", claim: "met", evidence: [{ ...CHECK, outcome: "green" }] }]);
    await refused(Array.from({ length: 33 }, (_, i) => MET(`R${i}`)));
    await refused([{ requirementId: "REQ-1", claim: "met", evidence: Array.from({ length: 9 }, () => CHECK) }]);
    // 20 × a 4,000-unit observation: each string is in range, the list is not.
    await refused(Array.from({ length: 20 }, (_, i) => ({ requirementId: `R${i}`, claim: "met", evidence: [{ kind: "observation", text: "o".repeat(4000) }] })), /bytes serialized/);
  });

  it("32 claims and 8 evidence items each are admitted", async () => {
    const claims = Array.from({ length: 32 }, (_, i) => ({ requirementId: `R${i}`, claim: "met", evidence: Array.from({ length: 8 }, () => ({ kind: "observation", text: "ok" })) }));
    await presentPinned(claims);
    expect((content(only()).requirementClaims as unknown[]).length).toBe(32);
  });

  it("a semantically unknown requirement is NOT malformed: kept, with a warning", async () => {
    const { debrief, res } = await presentPinned([MET("REQ-9")]);
    expect(content(debrief).requirementClaims).toEqual([MET("REQ-9")]);
    expect(res.text).toContain(`requirement "REQ-9" isn't in art_brief1 v1. The claim is kept and marked unknown.`);
  });

  it("an id-less or duplicate requirement row: ambiguous/unknown, never positional", async () => {
    seedSpec("art_dup", { content: { objective: "o", requirements: [{ id: "REQ-1", statement: "a" }, { id: "REQ-1", statement: "b" }, { statement: "id-less" }] } });
    const res = await callTool("present_debrief", { ...BASE, briefRef: { artifactId: "art_dup" }, requirementClaims: [MET("REQ-1"), MET("2")] });
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain(`requirement "REQ-1" matches more than one row`);
    expect(res.text).toContain(`requirement "2" isn't in art_dup v1`);
  });

  it("callers can never set origin provenance or the pin diagnostic", async () => {
    seedSpec("art_brief1");
    for (const forged of [{ claimsOriginArtifactId: "art_other" }, { briefRefDiagnostic: { reason: "not_a_spec" } }]) {
      const res = await callTool("present_debrief", { ...BASE, requirementClaims: [MET("REQ-1")], ...forged });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/set by the server, never by the caller/);
    }
    expect(debriefs()).toHaveLength(0);
  });

  it("an empty list records nothing (no claims, no origin)", async () => {
    const { debrief } = await presentPinned([]);
    expect("requirementClaims" in content(debrief)).toBe(false);
    expect("claimsOriginArtifactId" in content(debrief)).toBe(false);
    expect(debrief.briefRef).toEqual({ artifactId: "art_brief1" });
  });
});

describe("clause 2 — a dropped pin leaves a durable, bounded diagnostic", () => {
  const presentWith = async (briefRef: unknown) => {
    const res = await callTool("present_debrief", { ...BASE, briefRef, requirementClaims: [MET("REQ-1")] });
    expect(res.isError).toBeFalsy();
    return { res, d: only() };
  };

  it("unknown target: debrief survives, claims kept unattributed, reason saved and reloaded", async () => {
    const { res, d } = await presentWith({ artifactId: "art_nope" });
    expect("briefRef" in d).toBe(false);
    expect(content(d).briefRefDiagnostic).toEqual({ attemptedArtifactId: "art_nope", reason: "not_in_session" });
    expect(content(d).requirementClaims).toEqual([MET("REQ-1")]);
    expect(res.text).toContain("briefRef dropped, so this debrief has no brief link");
    expect(res.text).toContain("unattributed, never as coverage");
    store.forceFlush();
    const reloaded = ctx.fx.track(new FileStore(ctx.tmpDir, "test_session")).getArtifacts().find((a) => a.id === d.id)!;
    expect((reloaded.content as Record<string, unknown>).briefRefDiagnostic).toEqual({ attemptedArtifactId: "art_nope", reason: "not_in_session" });
  });

  it("requirementIds/edgePathIds on a debrief pin drop it whole, pointing at requirementClaims", async () => {
    seedSpec("art_brief1");
    const { res, d } = await presentWith({ artifactId: "art_brief1", requirementIds: ["REQ-1"] });
    expect("briefRef" in d).toBe(false);
    expect(content(d).briefRefDiagnostic).toEqual({ attemptedArtifactId: "art_brief1", reason: "grain_ids_not_allowed" });
    expect(res.text).toContain("requirementClaims");
  });

  it("non-spec target", async () => {
    store.createArtifact({ id: "art_cs", type: "changeset", title: "cs", content: { files: [] } });
    const { d } = await presentWith({ artifactId: "art_cs" });
    expect(content(d).briefRefDiagnostic).toEqual({ attemptedArtifactId: "art_cs", reason: "not_a_spec" });
  });

  it("cross-session spec: no bucket search", async () => {
    const foreign = { ...seedSpec("art_tmp"), id: "art_foreign", sessionId: "other_session" };
    store.getArtifacts().push(foreign as Artifact);
    const { d } = await presentWith({ artifactId: "art_foreign" });
    expect(content(d).briefRefDiagnostic).toEqual({ attemptedArtifactId: "art_foreign", reason: "not_in_session" });
  });

  it("an id shared by two same-session artifacts (cross-type) is ambiguous, never first-match", async () => {
    seedSpec("art_twin");
    store.createArtifact({ id: "art_twin", type: "decision", title: "twin", content: { context: "c", options: [] } });
    const { d } = await presentWith({ artifactId: "art_twin" });
    expect("briefRef" in d).toBe(false);
    expect(content(d).briefRefDiagnostic).toEqual({ attemptedArtifactId: "art_twin", reason: "ambiguous_target" });
  });

  it("ambiguity does not depend on order (decision first, spec second)", async () => {
    store.createArtifact({ id: "art_twin2", type: "decision", title: "twin", content: { context: "c", options: [] } });
    seedSpec("art_twin2");
    const { d } = await presentWith({ artifactId: "art_twin2" });
    expect(content(d).briefRefDiagnostic).toEqual({ attemptedArtifactId: "art_twin2", reason: "ambiguous_target" });
  });

  it("malformed / over-cap / non-object refs: the attempted id is kept only when a string of ≤64 units", async () => {
    const long = "a".repeat(65);
    expect(content((await presentWith({ artifactId: long })).d).briefRefDiagnostic).toEqual({ reason: "invalid_ref" });
  });

  it("null and non-object refs drop with no attempted id", async () => {
    const { d } = await presentWith(null);
    expect(content(d).briefRefDiagnostic).toEqual({ reason: "invalid_ref" });
  });

  it("a closed (superseded) pinned brief stays pinned historically", async () => {
    seedSpec("art_v1");
    seedSpec("art_v2", { parentId: "art_v1", version: 2 });
    store.updateArtifactStatus("art_v1", "superseded", "agent_supersede");
    const res = await callTool("present_debrief", { ...BASE, briefRef: { artifactId: "art_v1" }, requirementClaims: [MET("REQ-1")] });
    expect(only().briefRef).toEqual({ artifactId: "art_v1" });
    expect(res.text).toContain("is superseded. The link stays on that exact version");
  });
});

describe("clause 4 — atomic revision and original provenance", () => {
  const revise = (artifactId: string, body: Record<string, unknown>) =>
    callTool("revise_artifact", { artifactId, mode: "supersede", reason: "update the account", ...body });
  const successor = (id: string) => store.getArtifacts().find((a) => a.parentId === id);
  const SUMMARY = { summary: "Updated account of the auth work." };

  it("omitted claims carry pin, full claims and the ORIGINAL origin unchanged", async () => {
    const { debrief: v1 } = await presentPinned([MET("REQ-1"), { requirementId: "REQ-2", claim: "unknown", notRun: "no staging env" }]);
    const r = await revise(v1.id, { content: SUMMARY });
    expect(r.isError).toBeFalsy();
    const v2 = successor(v1.id)!;
    expect(v2.briefRef).toEqual({ artifactId: "art_brief1" });
    expect(content(v2).requirementClaims).toEqual(content(v1).requirementClaims);
    expect(content(v2).claimsOriginArtifactId).toBe(v1.id);
    expect(r.text).toContain(`Requirement claims carried unchanged from ${v1.id}`);
  });

  it("supplied claims replace the whole list with this revision as origin; omitted pin is kept", async () => {
    const { debrief: v1 } = await presentPinned([MET("REQ-1"), MET("REQ-2")]);
    const r = await revise(v1.id, { content: { ...SUMMARY, requirementClaims: [{ requirementId: "REQ-2", claim: "unmet", explanation: "reset email bounced" }] } });
    expect(r.isError).toBeFalsy();
    const v2 = successor(v1.id)!;
    expect(content(v2).requirementClaims).toEqual([{ requirementId: "REQ-2", claim: "unmet", explanation: "reset email bounced" }]);
    expect(content(v2).claimsOriginArtifactId).toBe(v2.id);
    expect(v2.briefRef).toEqual({ artifactId: "art_brief1" });
  });

  it("[] clears claims and origin", async () => {
    const { debrief: v1 } = await presentPinned();
    await revise(v1.id, { content: { ...SUMMARY, requirementClaims: [] } });
    const v2 = successor(v1.id)!;
    expect("requirementClaims" in content(v2)).toBe(false);
    expect("claimsOriginArtifactId" in content(v2)).toBe(false);
    expect(v2.briefRef).toEqual({ artifactId: "art_brief1" });
  });

  it("an explicit re-pin WITHOUT claims is rejected; nothing written, v1 unchanged", async () => {
    const { debrief: v1 } = await presentPinned();
    seedSpec("art_brief2");
    const before = JSON.stringify(v1);
    const r = await revise(v1.id, { briefRef: { artifactId: "art_brief2" }, content: SUMMARY });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("needs replacement requirementClaims");
    expect(successor(v1.id)).toBeUndefined();
    expect(JSON.stringify(store.getArtifacts().find((a) => a.id === v1.id))).toBe(before);
  });

  it("an explicit re-pin with replacement claims (even []) saves the new pin", async () => {
    const { debrief: v1 } = await presentPinned();
    seedSpec("art_brief2");
    const r = await revise(v1.id, { briefRef: { artifactId: "art_brief2" }, content: { ...SUMMARY, requirementClaims: [] } });
    expect(r.isError).toBeFalsy();
    const v2 = successor(v1.id)!;
    expect(v2.briefRef).toEqual({ artifactId: "art_brief2" });
    expect("requirementClaims" in content(v2)).toBe(false);
  });

  it("the same pin stated explicitly is not a change: claims carry", async () => {
    const { debrief: v1 } = await presentPinned();
    const r = await revise(v1.id, { briefRef: { artifactId: "art_brief1" }, content: SUMMARY });
    expect(r.isError).toBeFalsy();
    expect(content(successor(v1.id)!).claimsOriginArtifactId).toBe(v1.id);
  });

  it("briefRef: null (remove pin) is unsupported and rejects", async () => {
    const { debrief: v1 } = await presentPinned();
    const r = await revise(v1.id, { briefRef: null, content: { ...SUMMARY, requirementClaims: [] } });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("unsupported");
    expect(successor(v1.id)).toBeUndefined();
  });

  it("a malformed / unadmissible explicit pin on a revision rejects instead of carrying old claims", async () => {
    const { debrief: v1 } = await presentPinned();
    for (const briefRef of [{ artifactId: "art_nope" }, { artifactId: "art_brief1", requirementIds: ["REQ-1"] }, { artifactId: "" }]) {
      const r = await revise(v1.id, { briefRef, content: { ...SUMMARY, requirementClaims: [] } });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("can't be admitted");
    }
    expect(successor(v1.id)).toBeUndefined();
    expect(store.getArtifacts().find((a) => a.id === v1.id)!.status).toBe("draft");
  });

  it("server-set keys or a pin inside content reject; malformed supplied claims reject atomically", async () => {
    const { debrief: v1 } = await presentPinned();
    for (const bad of [{ claimsOriginArtifactId: v1.id }, { briefRefDiagnostic: { reason: "invalid_ref" } }, { briefRef: { artifactId: "art_brief1" } }, { requirementClaims: [MET("REQ-1"), MET("REQ-1")] }, { requirementClaims: [{ requirementId: "REQ-1", claim: "met" }] }]) {
      const r = await revise(v1.id, { content: { ...SUMMARY, ...bad } });
      expect(r.isError).toBe(true);
    }
    expect(successor(v1.id)).toBeUndefined();
    expect(store.getArtifacts().find((a) => a.id === v1.id)!.status).toBe("draft");
  });

  it("an echoed predecessor content (with its server-set origin) is refused with a fix-it message", async () => {
    const { debrief: v1 } = await presentPinned();
    const r = await revise(v1.id, { content: { ...content(v1) } });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/server/);
  });

  it("legacy malformed saved claims carry byte-identical on an omitted-claims revision (carry ≠ admission)", async () => {
    await callTool("present_debrief", BASE);
    const v1 = only();
    const legacy = [{ requirementId: "REQ-1", claim: "met" }, { requirementId: "REQ-1", claim: "maybe", extra: 1 }];
    (v1.content as Record<string, unknown>).requirementClaims = legacy;
    const r = await revise(v1.id, { content: SUMMARY });
    expect(r.isError).toBeFalsy();
    const v2 = successor(v1.id)!;
    expect(JSON.stringify(content(v2).requirementClaims)).toBe(JSON.stringify(legacy));
    expect("claimsOriginArtifactId" in content(v2)).toBe(false);
  });

  it("the dropped-pin diagnostic follows the pin: carried with an omitted pin, cleared by an admitted one", async () => {
    await callTool("present_debrief", { ...BASE, briefRef: { artifactId: "art_nope" }, requirementClaims: [MET("REQ-1")] });
    const v1 = only();
    await revise(v1.id, { content: SUMMARY });
    const v2 = successor(v1.id)!;
    expect(content(v2).briefRefDiagnostic).toEqual({ attemptedArtifactId: "art_nope", reason: "not_in_session" });
    seedSpec("art_brief1");
    const r = await revise(v2.id, { briefRef: { artifactId: "art_brief1" }, content: { ...SUMMARY, requirementClaims: [MET("REQ-1")] } });
    expect(r.isError).toBeFalsy();
    const v3 = successor(v2.id)!;
    expect(v3.briefRef).toEqual({ artifactId: "art_brief1" });
    expect("briefRefDiagnostic" in content(v3)).toBe(false);
    expect(content(v3).claimsOriginArtifactId).toBe(v3.id);
  });

  it("an inherited set keeps its exact origin across a second revision", async () => {
    const { debrief: v1 } = await presentPinned();
    await revise(v1.id, { content: { ...SUMMARY, requirementClaims: [MET("REQ-2")] } });
    const v2 = successor(v1.id)!;
    await revise(v2.id, { content: SUMMARY });
    const v3 = successor(v2.id)!;
    expect(content(v3).requirementClaims).toEqual([MET("REQ-2")]);
    expect(content(v3).claimsOriginArtifactId).toBe(v2.id);
  });
});

describe("clause 5 — dedup and admission boundaries (the paths that exist)", () => {
  it("present_debrief raw-args dedup returns the SAME saved debrief; it has no inherited set to drift", async () => {
    seedSpec("art_brief1");
    const args = { ...BASE, briefRef: { artifactId: "art_brief1" }, requirementClaims: [MET("REQ-1")] };
    await callTool("present_debrief", args);
    const first = only();
    const saved = JSON.stringify(first);
    const again = await callTool("present_debrief", args);
    expect(again.isError).toBeFalsy();
    expect(debriefs()).toHaveLength(1);
    expect(JSON.stringify(only())).toBe(saved);
  });

  it("retrying an identical revise after it committed never recalculates from the live successor", async () => {
    const { debrief: v1 } = await presentPinned();
    const body = { artifactId: v1.id, mode: "supersede", reason: "update", content: { summary: "Updated account." } };
    expect((await callTool("revise_artifact", body)).isError).toBeFalsy();
    const v2 = store.getArtifacts().find((a) => a.parentId === v1.id)!;
    const retry = await callTool("revise_artifact", body);
    expect(retry.isError).toBe(true);
    expect(store.getArtifacts().filter((a) => a.parentId === v1.id || a.parentId === v2.id)).toHaveLength(1);
    expect(content(v2).claimsOriginArtifactId).toBe(v1.id);
  });

  it("a debrief revision matching a recorded stance stays advisory (no admission snapshot) and still carries the claims", async () => {
    const { debrief: v1 } = await presentPinned();
    store.recordRejectedApproach({ description: "in-memory LRU cache", concept: "in-memory LRU cache", reason: "diverges per process" });
    const r = await callTool("revise_artifact", { artifactId: v1.id, mode: "supersede", reason: "record it", content: { summary: "We shipped after you rejected the in-memory LRU cache." } });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("advisory, not a block");
    const v2 = store.getArtifacts().find((a) => a.parentId === v1.id)!;
    expect(v2.admission).toBeUndefined();
    expect(content(v2).requirementClaims).toEqual(content(v1).requirementClaims);
    expect(content(v2).claimsOriginArtifactId).toBe(v1.id);
  });
});

describe("clause 7 / matrix — comments, hostile input, authority floors", () => {
  it("a claim-row comment reaches check_feedback named by its raw id, never as a 'claim item #n'", async () => {
    const { debrief } = await presentPinned([MET("12")]);
    store.addComment({ id: "c_claim", artifactId: debrief.id, author: "human", content: "I don't believe 12 passed", target: { artifactId: debrief.id, sectionId: `debrief:claim:${claimSectionKey("12")}` } } as Parameters<FileStore["addComment"]>[0]);
    store.addComment({ id: "c_colon", artifactId: debrief.id, author: "human", content: "and this one?", target: { artifactId: debrief.id, sectionId: `debrief:claim:${claimSectionKey("REQ:1 a")}` } } as Parameters<FileStore["addComment"]>[0]);
    const res = await callTool("check_feedback");
    expect(res.text).toContain(`requirement claim "12"`);
    expect(res.text).toContain(`requirement claim "REQ:1 a"`);
    expect(res.text).not.toContain("claim item #13");
  });

  it("claims are content: the single secret scan covers evidence excerpts", async () => {
    const { debrief } = await presentPinned([{ requirementId: "REQ-1", claim: "met", evidence: [{ ...CHECK, excerpt: "token FAKE-CANARY ghp_FAKECANARY572B1000000000000000" }] }]);
    expect((debrief.secretWarnings ?? []).map((w) => w.pattern)).toContain("ghp_");
  });

  it("claim met + an unresolved open question: the question and the debrief's own status are untouched", async () => {
    const { debrief } = await presentPinned([MET("REQ-1")], { openQuestions: ["Should reset emails expire in 1h?"] });
    expect(debrief.status).toBe("draft");
    expect(content(debrief).openQuestions).toEqual(["Should reset emails expire in 1h?"]);
    const spec = store.getArtifacts().find((a) => a.id === "art_brief1")!;
    expect(spec.status).toBe("draft");
  });

  it("the advertised present_debrief schema carries briefRef {artifactId} and requirementClaims, never origin or diagnostics", async () => {
    const list = await ctx.client.listTools();
    const schema = list.tools.find((t) => t.name === "present_debrief")!.inputSchema as { properties: Record<string, any> };
    expect(Object.keys(schema.properties.briefRef.properties)).toEqual(["artifactId"]);
    expect(schema.properties.requirementClaims.maxItems).toBe(32);
    expect(JSON.stringify(schema)).not.toMatch(/claimsOriginArtifactId|briefRefDiagnostic/);
  });
});
