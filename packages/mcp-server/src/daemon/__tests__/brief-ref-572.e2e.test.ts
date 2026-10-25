/**
 * #572 slice A — an exception card names its governing brief (`briefRef` on
 * present_options), end to end: real MCP server → real DaemonClient → real
 * daemon → real FileStore (the #470 harness; fakes, not mocks).
 *
 * The contract under test (Opus v2 + the B/B amendment, Sol-approved):
 *  - a new ref is normalized ONCE, at the proposed write; the pin — or its
 *    absence after a drop — is saved, snapshotted and digested;
 *  - an allowance claim reuses the FROZEN pin the human allowed: the daemon's
 *    read-only inspect hands it back, the tool claims with it, and the daemon
 *    still demands digest equality and creates from its stored snapshot;
 *  - replays and dedup serve the saved result; brief lines there are
 *    "current" advisories from the saved pin, never a re-normalization;
 *  - supersede carries the exact pin (normal and admitted), bound by the
 *    revise precondition's inherited hash; there is no retarget.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Artifact, ArtifactStatus } from "@deeppairing/shared";
import { StanceWorld, holdStance, registrationTokenOf, type Wrapper } from "./stance-exceptions.harness.js";
import { hashPresentArgs } from "../../mcp/tool-helpers.js";
import { reviseInheritedHash } from "../../mcp/proposal-resolution.js";

let world: StanceWorld;
afterEach(async () => { await world?.dispose(); });

const STANCE = "global mutable state";
const OPTIONS = [
  { id: "a", title: "Inject config", description: "pass config explicitly", pros: ["testable"], cons: ["churn"], effort: "low", risk: "low", recommendation: true },
  { id: "b", title: "Keep the module", description: "status quo", pros: ["no churn"], cons: ["hard to test"], effort: "low", risk: "low", recommendation: false },
];
/** Matches the stance (blocked once it's held). */
const blockedArgs = (over: Record<string, unknown> = {}) => ({
  context: "How do we remove global mutable state from config?", title: "Config ownership", options: OPTIONS, ...over,
});
/** Never matches the stance. */
const plainArgs = (over: Record<string, unknown> = {}) => ({
  context: "Which logger should the CLI use?", title: "CLI logger", options: OPTIONS, ...over,
});

const SPEC_CONTENT = {
  objective: "Ship auth",
  requirements: [
    { id: "REQ-1", statement: "s1", rationale: "r", acceptanceCriteria: ["a"] },
    { id: "REQ-2", statement: "s2", rationale: "r", acceptanceCriteria: ["a"] },
  ],
  edgePaths: [{ id: "wake", path: "long-poll wake", risk: "missed" }],
};

function seedSpec(sid: string, id: string, over: { content?: Record<string, unknown>; parentId?: string; version?: number; title?: string } = {}): Artifact {
  return world.store(sid).createArtifact({ id, type: "spec", title: over.title ?? "Auth brief", content: over.content ?? SPEC_CONTENT, ...(over.parentId ? { parentId: over.parentId } : {}), ...(over.version ? { version: over.version } : {}) });
}
function setStatus(sid: string, id: string, status: ArtifactStatus): void {
  world.store(sid).updateArtifactStatus(id, status, status === "superseded" ? "agent_supersede" : status === "retracted" ? "agent_retract" : "ui_reject_button");
}
const arts = (sid: string) => world.store(sid).getArtifacts();
const decisions = (sid: string) => arts(sid).filter((a) => a.type === "decision");
const newestDecision = (sid: string) => { const d = decisions(sid); return d[d.length - 1]!; };
const stateOf = async (id: string) => (await world.allowances()).find((a) => a.id === id)?.state;

async function blockThenAllow(w: Wrapper, args: Record<string, unknown>, tool = "present_options") {
  holdStance(world.store(w.sessionId), STANCE);
  const first = await w.call(tool, args);
  expect(first.isError).toBe(true);
  const block = await world.newestBlock();
  expect(block.eligible).toBe(true);
  const allowanceId = await world.allowNewest();
  return { block, allowanceId };
}

describe("#572 matrix — no ref / legacy card", () => {
  it("no briefRef: no key on the artifact or snapshot, no brief text, Threads bag untouched", async () => {
    world = new StanceWorld();
    const w = await world.wrapper();
    const res = await w.call("present_options", plainArgs());
    expect(res.isError).toBeFalsy();
    const art = newestDecision(w.sessionId);
    expect("briefRef" in art).toBe(false);
    expect(art.relatedArtifactIds).toBeUndefined();
    expect(res.text).not.toMatch(/Linked:|briefRef|Brief link/);
    const { block } = await blockThenAllow(w, blockedArgs());
    expect("briefRef" in block.snapshot!).toBe(false);
    const admitted = await w.call("present_options", blockedArgs());
    expect(admitted.isError).toBeFalsy();
    expect("briefRef" in newestDecision(w.sessionId)).toBe(false);
    expect(admitted.text).not.toMatch(/Linked:|briefRef|Brief link/);
  });
});

describe("#572 matrix — valid same-session spec and grains", () => {
  it("exact pin, a declared-link line, normal and admitted paths persist the same pin", async () => {
    world = new StanceWorld();
    const w = await world.wrapper();
    const spec = seedSpec(w.sessionId, "art_brief1");
    const briefRef = { artifactId: spec.id, requirementIds: ["REQ-2"], edgePathIds: ["wake"] };
    const normal = await w.call("present_options", plainArgs({ briefRef }));
    expect(normal.isError).toBeFalsy();
    expect(normal.text).toContain('Linked: Exception to "Auth brief" v1 · REQ-2, edge path wake. This is a declared link');
    const normalArt = newestDecision(w.sessionId);
    expect(normalArt.briefRef).toEqual(briefRef);
    // Never coupled into the causal Threads bag.
    expect(normalArt.relatedArtifactIds).toBeUndefined();

    const { block, allowanceId } = await blockThenAllow(w, blockedArgs({ briefRef }));
    expect(block.snapshot!.briefRef).toEqual(briefRef);
    const admitted = await w.call("present_options", blockedArgs({ briefRef }));
    expect(admitted.isError).toBeFalsy();
    expect(admitted.text).toContain('Linked: Exception to "Auth brief" v1 · REQ-2, edge path wake');
    const admittedArt = newestDecision(w.sessionId);
    expect(admittedArt.admission?.effectiveDigest).toBe(block.effectiveDigest);
    expect(admittedArt.briefRef).toEqual(normalArt.briefRef);
    expect(await stateOf(allowanceId)).toBe("used");
  });
});

describe("#572 matrix — unknown, non-spec or cross-session target", () => {
  it("normal path: the card survives, the link is dropped with a warning, other sessions aren't searched", async () => {
    world = new StanceWorld();
    const other = await world.wrapper("sx_other");
    seedSpec(other.sessionId, "art_elsewhere");
    const w = await world.wrapper();
    await w.call("present_options", plainArgs({ title: "seed" }));
    const nonSpec = newestDecision(w.sessionId).id;
    for (const [i, artifactId] of ["art_nope", nonSpec, "art_elsewhere"].entries()) {
      const res = await w.call("present_options", plainArgs({ title: `t${i}`, briefRef: { artifactId, requirementIds: ["REQ-1"] } }));
      expect(res.isError).toBeFalsy();
      expect(res.text).toContain("briefRef dropped, so this card has no brief link");
      expect(res.text).toContain("The card itself was presented");
      expect("briefRef" in newestDecision(w.sessionId)).toBe(false);
    }
    expect(decisions(w.sessionId)).toHaveLength(4);
  });

  it("admitted path: the dropped ref is bound as ABSENT; dedup of the same call says the original reason is unavailable", async () => {
    world = new StanceWorld();
    const w = await world.wrapper();
    const args = blockedArgs({ briefRef: { artifactId: "art_nope" } });
    const { block } = await blockThenAllow(w, args);
    expect("briefRef" in block.snapshot!).toBe(false);
    const admitted = await w.call("present_options", args);
    expect(admitted.isError).toBeFalsy();
    expect(admitted.text).toContain("briefRef dropped");
    expect("briefRef" in newestDecision(w.sessionId)).toBe(false);

    const plain = plainArgs({ briefRef: { artifactId: "art_nope" } });
    await w.call("present_options", plain);
    const dup = await w.call("present_options", plain);
    expect(dup.text).toContain("Already presented");
    expect(dup.text).toContain("No brief link was saved");
    expect(dup.text).toContain("the original reason is unavailable on replay");
  });
});

describe("#572 matrix — unknown, duplicate or legacy grain (exact lookup, no index rescue)", () => {
  it("raw ids kept exactly; unknown and ambiguous are marked; an id-less row at index 2 is not '2'", async () => {
    world = new StanceWorld();
    const w = await world.wrapper();
    // A LEGACY spec (written before #589): duplicate requirement ids, an
    // explicit numeric edge-path id, id-less edge paths. Never re-validated.
    seedSpec(w.sessionId, "art_legacy", {
      content: {
        objective: "o",
        requirements: [{ id: "REQ-1" }, { id: "REQ-1" }, { id: "REQ-3" }],
        edgePaths: [{ path: "p0" }, { path: "p1" }, { path: "p2" }, { id: "7", path: "p3" }],
      },
    });
    const briefRef = { artifactId: "art_legacy", requirementIds: ["REQ-1", "REQ-3", "req-3", " REQ-3", "REQ-9"], edgePathIds: ["2", "7"] };
    const res = await w.call("present_options", plainArgs({ briefRef }));
    expect(res.isError).toBeFalsy();
    expect(newestDecision(w.sessionId).briefRef).toEqual(briefRef);
    expect(res.text).toContain('requirement "REQ-1" matches more than one row');
    expect(res.text).toContain("marked ambiguous");
    for (const id of ["req-3", " REQ-3", "REQ-9"]) expect(res.text).toContain(`requirement ${JSON.stringify(id)} isn't in art_legacy v1`);
    expect(res.text).toContain(`edge path "2" isn't in art_legacy v1`);
    expect(res.text).not.toContain(`edge path "7" isn't`);
    expect(res.text).not.toContain(`requirement "REQ-3" isn't`);
  });
});

describe("#572 matrix — over a cap, blank or malformed: the whole ref drops", () => {
  it("never truncates, dedupes or trims; the card is still presented", async () => {
    world = new StanceWorld();
    const w = await world.wrapper();
    seedSpec(w.sessionId, "art_brief1");
    const nine = Array.from({ length: 9 }, (_, i) => `REQ-${i}`);
    const cases: unknown[] = [
      { artifactId: "art_brief1", requirementIds: nine },
      { artifactId: "art_brief1", requirementIds: ["   "] },
      { artifactId: "art_brief1", requirementIds: ["REQ-1", "REQ-1"] },
      { artifactId: "art_brief1", edgePathIds: ["a".repeat(65)] },
      { artifactId: "art_brief1", edgePathIds: ["😀".repeat(33)] },
      { artifactId: "x".repeat(65) },
      { artifactId: "art_brief1", version: 2 },
      "art_brief1",
      null,
    ];
    for (const [i, briefRef] of cases.entries()) {
      const res = await w.call("present_options", plainArgs({ title: `cap ${i}`, briefRef }));
      expect(res.isError, JSON.stringify(briefRef)).toBeFalsy();
      expect(res.text).toContain("briefRef dropped");
      expect(res.text).toContain("Nothing was truncated");
      expect("briefRef" in newestDecision(w.sessionId)).toBe(false);
    }
    // The boundary itself is accepted: 64 ASCII / 32 astral (64 UTF-16 units).
    const edge = { artifactId: "art_brief1", requirementIds: ["a".repeat(64)], edgePathIds: ["😀".repeat(32)] };
    const ok = await w.call("present_options", plainArgs({ title: "edge", briefRef: edge }));
    expect(newestDecision(w.sessionId).briefRef).toEqual(edge);
    expect(ok.text).toContain("It's kept and marked unknown");
  });
});

describe("#572 matrix — superseded, rejected or retracted brief", () => {
  it("keeps the historical exact pin with a truthful status; never moves it to the successor", async () => {
    world = new StanceWorld();
    const w = await world.wrapper();
    seedSpec(w.sessionId, "art_v1");
    seedSpec(w.sessionId, "art_v2", { parentId: "art_v1", version: 2 });
    setStatus(w.sessionId, "art_v1", "superseded");
    seedSpec(w.sessionId, "art_rej");
    setStatus(w.sessionId, "art_rej", "rejected");
    seedSpec(w.sessionId, "art_ret");
    setStatus(w.sessionId, "art_ret", "retracted");
    for (const [id, status] of [["art_v1", "superseded"], ["art_rej", "rejected"], ["art_ret", "retracted"]] as const) {
      const res = await w.call("present_options", plainArgs({ title: `pin ${id}`, briefRef: { artifactId: id, requirementIds: ["REQ-1"] } }));
      expect(res.isError).toBeFalsy();
      expect(newestDecision(w.sessionId).briefRef).toEqual({ artifactId: id, requirementIds: ["REQ-1"] });
      expect(res.text).toContain(`(${status})`);
      expect(res.text).toContain(`is ${status}. The link stays on that exact version and was not moved to a newer one`);
      expect(res.text).not.toContain("art_v2");
    }
  });
});

describe("#572 matrix — supersede, tune or replay: pin carried and hash-bound", () => {
  it("normal supersede (a tune) carries the exact pin; the predecessor is untouched; a later brief doesn't retarget", async () => {
    world = new StanceWorld();
    const w = await world.wrapper();
    seedSpec(w.sessionId, "art_brief1");
    const briefRef = { artifactId: "art_brief1", requirementIds: ["REQ-1"] };
    await w.call("present_options", plainArgs({ briefRef }));
    const v1 = newestDecision(w.sessionId);
    // A newer brief appears: the card does NOT follow it.
    seedSpec(w.sessionId, "art_brief2", { parentId: "art_brief1", version: 2 });
    setStatus(w.sessionId, "art_brief1", "superseded");
    const res = await w.call("revise_artifact", { artifactId: v1.id, mode: "supersede", reason: "tune", content: { context: "Which logger, with JSON output?", options: OPTIONS } });
    expect(res.isError).toBeFalsy();
    const v2 = decisions(w.sessionId).find((a) => a.parentId === v1.id)!;
    expect(v2.briefRef).toEqual(briefRef);
    expect(arts(w.sessionId).find((a) => a.id === v1.id)!.briefRef).toEqual(briefRef);
    expect(decisions(w.sessionId)).toHaveLength(2);
  });

  it("admitted supersede carries the same pin through the snapshot; one new version, no twin", async () => {
    world = new StanceWorld();
    const w = await world.wrapper();
    seedSpec(w.sessionId, "art_brief1");
    const briefRef = { artifactId: "art_brief1", edgePathIds: ["wake"] };
    await w.call("present_options", plainArgs({ briefRef }));
    const v1 = newestDecision(w.sessionId);
    const revise = { artifactId: v1.id, mode: "supersede", reason: "Name the removal", content: { context: "Remove global mutable state: which owner?", options: OPTIONS } };
    const { block } = await blockThenAllow(w, revise, "revise_artifact");
    expect(block.snapshot!.briefRef).toEqual(briefRef);
    const res = await w.call("revise_artifact", revise);
    expect(res.isError).toBeFalsy();
    const v2 = decisions(w.sessionId).find((a) => a.parentId === v1.id)!;
    expect(v2.briefRef).toEqual(briefRef);
    expect(v2.admission?.effectiveDigest).toBe(block.effectiveDigest);
    expect(decisions(w.sessionId)).toHaveLength(2);
  });

  it("the inherited hash binds the pin: changing the target's pin between grant and claim refuses the claim", async () => {
    world = new StanceWorld();
    const w = await world.wrapper();
    seedSpec(w.sessionId, "art_brief1");
    await w.call("present_options", plainArgs({ briefRef: { artifactId: "art_brief1" } }));
    const v1 = newestDecision(w.sessionId);
    const before = reviseInheritedHash(v1);
    const revise = { artifactId: v1.id, mode: "supersede", reason: "Name the removal", content: { context: "Remove global mutable state: which owner?", options: OPTIONS } };
    await blockThenAllow(w, revise, "revise_artifact");
    // The daemon store's own record changes underneath the allowance.
    v1.briefRef = { artifactId: "art_brief1", requirementIds: ["REQ-2"] };
    expect(reviseInheritedHash(v1)).not.toBe(before);
    const res = await w.call("revise_artifact", revise);
    expect(res.isError).toBe(true);
    expect(res.text).toContain(`depended on the state of ${v1.id}, which changed`);
    expect(decisions(w.sessionId)).toHaveLength(1);
  });

  it("the inherited hash changes with the pin and is stable without one", () => {
    const target = { id: "art_x", sessionId: "s", type: "decision", version: 1, parentId: null, title: "t", status: "draft", content: {}, agentReasoning: null, createdAt: "2026-10-24T00:00:00.000Z", updatedAt: "2026-10-24T00:00:00.000Z" } as Artifact;
    const withPin = { ...target, briefRef: { artifactId: "art_b" } } as Artifact;
    expect(reviseInheritedHash(target)).not.toBe(reviseInheritedHash(withPin));
    expect(reviseInheritedHash({ ...target })).toBe(reviseInheritedHash(target));
  });
});

describe("#572 matrix — only briefRef changed", () => {
  it("is a distinct decision identity; the identical retry still dedupes", async () => {
    world = new StanceWorld();
    const w = await world.wrapper();
    seedSpec(w.sessionId, "art_brief1");
    const a = plainArgs({ briefRef: { artifactId: "art_brief1", requirementIds: ["REQ-1"] } });
    const b = plainArgs({ briefRef: { artifactId: "art_brief1", requirementIds: ["REQ-2"] } });
    expect(hashPresentArgs(a)).not.toBe(hashPresentArgs(b));
    expect(hashPresentArgs(a)).not.toBe(hashPresentArgs(plainArgs()));
    await w.call("present_options", a);
    await w.call("present_options", b);
    expect(decisions(w.sessionId)).toHaveLength(2);
    const dup = await w.call("present_options", b);
    expect(dup.text).toContain("Already presented");
    expect(dup.text).toContain('Brief link (current, from the saved card): Exception to "Auth brief" v1 · REQ-2');
    expect(decisions(w.sessionId)).toHaveLength(2);
  });
});

describe("#572 B/B — mutable target state between block, grant and claim: the claim uses the frozen pin", () => {
  it("target APPEARS after a dropped ref: still admitted with NO link (never reconstructed); 'original reason unavailable'", async () => {
    world = new StanceWorld();
    const w = await world.wrapper();
    const args = blockedArgs({ briefRef: { artifactId: "art_future", requirementIds: ["REQ-1"] } });
    const { block, allowanceId } = await blockThenAllow(w, args);
    expect("briefRef" in block.snapshot!).toBe(false);
    seedSpec(w.sessionId, "art_future");
    const res = await w.call("present_options", args);
    expect(res.isError).toBeFalsy();
    // The concrete retrieval: the claim body carries the FROZEN (absent) pin,
    // not this call's fresh lookup (which would now find art_future).
    expect("briefRef" in (world.lastClaim().body.admission as { snapshot: Record<string, unknown> }).snapshot).toBe(false);
    expect("briefRef" in newestDecision(w.sessionId)).toBe(false);
    expect(res.text).toContain("No brief link was saved");
    expect(res.text).toContain("the original reason is unavailable on replay");
    expect(await stateOf(allowanceId)).toBe("used");
  });

  it("target DISAPPEARS after the grant: admitted with the allowed pin; the advisory is labelled current", async () => {
    world = new StanceWorld();
    const w = await world.wrapper();
    seedSpec(w.sessionId, "art_brief1");
    const briefRef = { artifactId: "art_brief1", requirementIds: ["REQ-1"] };
    const args = blockedArgs({ briefRef });
    const { block } = await blockThenAllow(w, args);
    expect(block.snapshot!.briefRef).toEqual(briefRef);
    const list = arts(w.sessionId);
    list.splice(list.findIndex((a) => a.id === "art_brief1"), 1);
    const res = await w.call("present_options", args);
    expect(res.isError).toBeFalsy();
    expect((world.lastClaim().body.admission as { snapshot: { briefRef?: unknown } }).snapshot.briefRef).toEqual(briefRef);
    const art = newestDecision(w.sessionId);
    expect(art.briefRef).toEqual(briefRef);
    expect(art.admission?.effectiveDigest).toBe(block.effectiveDigest);
    expect(res.text).toContain("Brief link (current, from the saved card): Exception to brief art_brief1 (version unknown, brief unavailable) · REQ-1");
    expect(res.text).not.toContain("briefRef dropped");

    // Early replay of the committed operation: the saved pin, labelled current.
    const again = await w.call("present_options", args);
    expect(again.text).toContain("Already admitted");
    expect(again.text).toContain("Brief link (current, from the saved card)");
    expect(decisions(w.sessionId)).toHaveLength(1);
  });

  it("target is SUPERSEDED after the grant: the claim keeps the v1 pin (no successor)", async () => {
    world = new StanceWorld();
    const w = await world.wrapper();
    seedSpec(w.sessionId, "art_v1");
    const args = blockedArgs({ briefRef: { artifactId: "art_v1" } });
    await blockThenAllow(w, args);
    seedSpec(w.sessionId, "art_v2", { parentId: "art_v1", version: 2 });
    setStatus(w.sessionId, "art_v1", "superseded");
    const res = await w.call("present_options", args);
    expect(res.isError).toBeFalsy();
    expect(newestDecision(w.sessionId).briefRef).toEqual({ artifactId: "art_v1" });
    expect(res.text).toContain('"Auth brief" v1');
    expect(res.text).toContain("(superseded)");
    expect(res.text).not.toContain("art_v2");
  });

  it("a client cannot substitute its own pin: a claim with a different briefRef is refused and the allowance stays", async () => {
    world = new StanceWorld();
    const w = await world.wrapper();
    seedSpec(w.sessionId, "art_brief1");
    const { block, allowanceId } = await blockThenAllow(w, blockedArgs({ briefRef: { artifactId: "art_brief1" } }));
    const forged = { ...block.snapshot!, briefRef: { artifactId: "art_brief1", requirementIds: ["REQ-2"] } };
    const res = await world.operation(w.sessionId, "op_forged", {
      callFingerprint: block.callFingerprint,
      admission: { exceptionIds: [allowanceId], toolName: "present_options", snapshot: forged, preconditions: [] },
    }, registrationTokenOf(w));
    expect(await res.json()).toMatchObject({ status: "refused", reason: "client_snapshot_mismatch" });
    expect(decisions(w.sessionId)).toHaveLength(0);
    expect(await stateOf(allowanceId)).toBe("allowed");
  });

  it("inspect reports the frozen pin only to the calling registration's own candidates", async () => {
    world = new StanceWorld();
    const w = await world.wrapper();
    seedSpec(w.sessionId, "art_brief1");
    const { block } = await blockThenAllow(w, blockedArgs({ briefRef: { artifactId: "art_brief1" } }));
    const mine = await w.client.inspectStanceExceptions(block.callFingerprint!);
    expect(mine.candidates[0]).toMatchObject({ frozenBriefRef: { artifactId: "art_brief1" } });
    const stranger = await world.wrapper("sx_session");
    const theirs = await stranger.client.inspectStanceExceptions(block.callFingerprint!);
    expect(theirs.candidates).toEqual([]);
  });
});

describe("#572 matrix — persistence, reload and a malformed stored ref", () => {
  it("the pin survives a flush + daemon restart; a malformed stored ref still loads", async () => {
    world = new StanceWorld();
    const w = await world.wrapper();
    seedSpec(w.sessionId, "art_brief1");
    const briefRef = { artifactId: "art_brief1", requirementIds: ["REQ-1"] };
    await w.call("present_options", plainArgs({ briefRef }));
    await w.call("present_options", plainArgs({ title: "second" }));
    const [good, other] = decisions(w.sessionId);
    other!.briefRef = { artifactId: 42, requirementIds: "REQ-1" };
    world.store(w.sessionId).forceFlush();
    await world.restart();
    const w2 = await world.wrapper();
    const reloaded = decisions(w2.sessionId);
    expect(reloaded.find((a) => a.id === good!.id)!.briefRef).toEqual(briefRef);
    expect(reloaded.find((a) => a.id === other!.id)!.briefRef).toEqual({ artifactId: 42, requirementIds: "REQ-1" });
  });
});
