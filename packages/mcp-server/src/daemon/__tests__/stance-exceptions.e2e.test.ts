/**
 * #470 slice 1 — one-proposal stance exceptions, end to end: real MCP server →
 * real DaemonClient → real daemon composition → real FileStore. See the
 * harness for the fakes. Section refs are to docs/design/stance-exceptions.md.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StanceWorld, holdStance, registrationTokenOf, TOKEN } from "./stance-exceptions.harness.js";
import { callFingerprint } from "../../mcp/proposal-resolution.js";
import { projectHashOf } from "../../project-root.js";
import { ALLOWANCE_CEILING_MS } from "../stance-exceptions.js";

let world: StanceWorld;
afterEach(async () => { await world?.dispose(); });

const STANCE = "global mutable state";
const codeArgs = (over: Record<string, unknown> = {}) => ({
  filePath: "src/config.ts",
  changeType: "modify",
  before: "let config = {};",
  after: "export function loadConfig() { return {}; }",
  reasoning: "Remove global mutable state from the config loader",
  ...over,
});
const OPTIONS = [
  { id: "a", title: "Inject config", description: "pass config explicitly", pros: ["testable"], cons: ["churn"], effort: "low", risk: "low", recommendation: true },
  { id: "b", title: "Keep the module", description: "status quo", pros: ["no churn"], cons: ["hard to test"], effort: "low", risk: "low", recommendation: false },
];
const optionArgs = (over: Record<string, unknown> = {}) => ({
  context: "How do we remove global mutable state from config?", title: "Config ownership", options: OPTIONS, ...over,
});

async function blockedThenAllowed(args = codeArgs(), tool = "present_code_change", sessionId?: string) {
  const w = await world.wrapper(sessionId);
  holdStance(world.store(w.sessionId), STANCE);
  const first = await w.call(tool, args);
  expect(first.isError).toBe(true);
  const allowanceId = await world.allowNewest();
  return { w, allowanceId };
}

const stateOf = async (id: string) => (await world.allowances()).find((a) => a.id === id)?.state;
const artifactsOf = (sid: string) => world.store(sid).getArtifacts();

describe("#470 admission (§6) — the allowed proposal, exactly once", () => {
  it("block → human grant → the IDENTICAL retry is admitted; the artifact is byte-equal to the snapshot apart from minted ids (§10 5a control)", async () => {
    world = new StanceWorld();
    const { w, allowanceId } = await blockedThenAllowed();
    const block = (await world.blocks())[0]!;
    expect(block.eligible).toBe(true);
    expect(block.seenAt).toBeTruthy(); // §4a — a grant marks the hold seen
    expect(block.allowance).toMatchObject({ id: allowanceId, state: "allowed", grantedVia: "ui" });

    const admitted = await w.call("present_code_change", codeArgs());
    expect(admitted.isError).toBeFalsy();
    expect(admitted.text).toContain("Admitted once under an allowance your pair granted (UI)");
    expect(admitted.text).toContain(`stance "${STANCE}"`);
    const created = artifactsOf(w.sessionId);
    expect(created).toHaveLength(1);
    const art = created[0]!;
    const snapshot = block.snapshot!;
    expect(art.title).toBe(snapshot.title);
    expect(JSON.parse(JSON.stringify(art.content))).toEqual(snapshot.content);
    expect(art.agentReasoning).toBe(snapshot.agentReasoning);
    expect(art.admission).toMatchObject({ kind: "create", exceptionIds: [allowanceId], grantedVia: "ui", effectiveDigest: block.effectiveDigest });
    expect(art.admission!.completedAt).toBeTruthy();
    expect(world.store(w.sessionId).getPreflightTrace(art.id)?.exception?.allowanceIds).toEqual([allowanceId]);
    expect(await stateOf(allowanceId)).toBe("used");
    expect((await world.blocks())[0]!.allowance).toMatchObject({ state: "used", artifactId: art.id });

    // Single-use: the stance still applies — the same call replays, nothing new.
    const again = await w.call("present_code_change", codeArgs());
    expect(again.text).toContain(`Already admitted. Returning the original result for ${art.id}`);
    expect(artifactsOf(w.sessionId)).toHaveLength(1);
  });

  it("present_options: admitted with a FRESH decision id and exactly one decision record", async () => {
    world = new StanceWorld();
    const { w } = await blockedThenAllowed(optionArgs(), "present_options");
    const res = await w.call("present_options", optionArgs());
    expect(res.isError).toBeFalsy();
    const art = artifactsOf(w.sessionId)[0]!;
    const decisionId = (art.content as { decisionId: string }).decisionId;
    expect(decisionId).toMatch(/^dec_/);
    expect(res.structuredContent).toMatchObject({ artifactId: art.id, decisionId, admitted: true });
    expect(world.store(w.sessionId).getDecision(decisionId)).toMatchObject({ artifactId: art.id, context: optionArgs().context });
  });

  it("revise_artifact: one new version, one supersede, one carryover comment (cmt_op_<operationId>)", async () => {
    world = new StanceWorld();
    const w = await world.wrapper();
    await w.call("present_options", { context: "Which config owner?", title: "Config owner", options: OPTIONS });
    const v1 = artifactsOf(w.sessionId)[0]!;
    holdStance(world.store(w.sessionId), STANCE);
    const revise = { artifactId: v1.id, mode: "supersede", reason: "Name the removal", content: { context: "Remove global mutable state: which owner?", options: OPTIONS } };
    expect((await w.call("revise_artifact", revise)).isError).toBe(true);
    const allowanceId = await world.allowNewest();
    const res = await w.call("revise_artifact", revise);
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain(`Superseded ${v1.id}`);
    const arts = artifactsOf(w.sessionId);
    const v2 = arts.find((a) => a.parentId === v1.id)!;
    expect(arts).toHaveLength(2);
    expect(v2.version).toBe(2);
    expect(v2.title).toBe("Config owner"); // inherited
    expect(arts.find((a) => a.id === v1.id)!.status).toBe("superseded");
    const comments = world.store(w.sessionId).getCommentsForArtifact(v1.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.id).toBe(`cmt_op_${v2.admission!.operationId}`);
    expect(comments[0]!.content).toBe(`Superseded by ${v2.id}: Name the removal`);
    expect(await stateOf(allowanceId)).toBe("used");
  });

  it("#499 review — the admitted create path says what the normal path says (review URL + close-note)", async () => {
    world = new StanceWorld();
    const { w } = await blockedThenAllowed();
    const res = await w.call("present_code_change", codeArgs());
    expect(res.text).toContain("Human can review at localhost:");
    expect(res.text).toContain("If this single-file change is the whole task");
  });
});

describe("#470 authority (§3, A1) and adversarial 1 — self-grant", () => {
  it("the grant route: 401 without bearer, 400 for extra fields, 404 unknown block, 400 short reason, 403 from a registered wrapper", async () => {
    world = new StanceWorld();
    const w = await world.wrapper();
    holdStance(world.store(w.sessionId), STANCE);
    await w.call("present_code_change", codeArgs());
    const block = await world.newestBlock();
    const noBearer = await world.daemon.app.request(`/api/preflight-blocks/${block.id}/exception`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Project-Hash": projectHashOf(world.dir) }, body: JSON.stringify({ reason: "valid reason" }),
    });
    expect(noBearer.status).toBe(401);
    const wrongHash = await world.grant(block.id, "valid", { headers: { "X-Project-Hash": "nope" } });
    expect(wrongHash.status).toBe(403);
    expect((await world.grant(block.id, "", { body: { reason: "valid reason", scope: "everything" } })).status).toBe(400);
    expect((await world.grant("blk_unknown")).status).toBe(404);
    const short = await world.grant(block.id, "  a ");
    expect(short.status).toBe(400);
    expect((await short.json()).code).toBe("stance_exception_reason_required");
    // The agent's own door: DaemonClient stamps its registration header.
    const agent = await world.grant(block.id, "valid reason", { headers: { "X-DeepPairing-Registration": registrationTokenOf(w) } });
    expect(agent.status).toBe(403);
    expect((await agent.json()).code).toBe("stance_exception_interactive_required");
    expect(await world.allowances()).toEqual([]);
  });

  it("no internal route grants: posting to the internal side or forging block fields arms nothing", async () => {
    world = new StanceWorld();
    const w = await world.wrapper();
    holdStance(world.store(w.sessionId), STANCE);
    await w.call("present_code_change", codeArgs());
    const block = await world.newestBlock();
    const internal = await world.daemon.app.request(`/api/internal/sessions/${w.sessionId}/preflight-blocks/${block.id}/exception`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`, "X-Project-Hash": projectHashOf(world.dir) }, body: JSON.stringify({ reason: "valid reason" }),
    });
    expect(internal.status).toBe(404);
    // A forged eligible block without the issued registration token is NOT eligible.
    const forged = await world.daemon.app.request(`/api/internal/sessions/${w.sessionId}/preflight-block`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`, "X-Project-Hash": projectHashOf(world.dir) },
      body: JSON.stringify({ type: "preflight_blocked", toolName: "present_code_change", source: "session", match: { description: STANCE, concept: STANCE },
        eligible: true, registrationId: "reg_forged", effectiveDigest: "f".repeat(64), callFingerprint: "a".repeat(64), snapshot: block.snapshot, preconditions: [] }),
    });
    expect(forged.status).toBe(200);
    const entry = await world.newestBlock();
    expect(entry).toMatchObject({ eligible: false, ineligibleReason: "no_registration" });
    expect(entry.registrationId).toBeUndefined();
    expect(entry.effectiveDigest).toBeUndefined();
    expect((await world.grant(entry.id)).status).toBe(409);
  });

  it("team rules, demo sessions, retired stances and ended sessions are refused (D4)", async () => {
    world = new StanceWorld();
    const w = await world.wrapper();
    const store = world.store(w.sessionId);
    // Team rule (committed team.json) — D4: own stances only.
    fs.writeFileSync(path.join(world.dir, ".deeppairing", "team.json"), JSON.stringify({ version: 1, preferences: [{ id: "team-1", concept: "singleton registry", kind: "avoid", rationale: "team policy", addedBy: "ops" }] }));
    const teamWorld = await world.wrapper("sx_team");
    await teamWorld.call("present_code_change", codeArgs({ reasoning: "Add a singleton registry for plugins" }));
    const teamBlock = await world.newestBlock();
    expect(teamBlock.source).toBe("team");
    expect(teamBlock).toMatchObject({ eligible: false, ineligibleReason: "team_rule" });
    const teamRes = await world.grant(teamBlock.id);
    expect(teamRes.status).toBe(409);
    expect((await teamRes.json()).reason).toBe("team_rule");
    // Retired stance.
    holdStance(store, STANCE);
    await w.call("present_code_change", codeArgs());
    const block = await world.newestBlock();
    store.overrideRejectedApproach({ description: STANCE });
    const retired = await world.grant(block.id);
    expect(retired.status).toBe(409);
    expect((await retired.json()).reason).toBe("stance_retired");
    // Ended session.
    holdStance(store, STANCE);
    await w.call("present_code_change", codeArgs({ after: "export const v2 = 1;" }));
    const block2 = await world.newestBlock();
    await w.client.unregister();
    const ended = await world.grant(block2.id);
    expect(ended.status).toBe(409);
    expect((await ended.json()).reason).toBe("session_ended");
    // Demo sessions are never recorded, so there is no block to allow.
    expect((await world.blocks()).every((b) => !b.sessionId.startsWith("demo_"))).toBe(true);
  });

  it("inspect never consumes: 100 inspects leave the allowance active", async () => {
    world = new StanceWorld();
    const { w, allowanceId } = await blockedThenAllowed();
    const fp = callFingerprint("present_code_change", codeArgs());
    for (let i = 0; i < 100; i++) {
      const seen = await w.client.inspectStanceExceptions(fp);
      expect(seen.candidates).toHaveLength(1);
    }
    expect(await stateOf(allowanceId)).toBe("allowed");
  });
});

describe("#470 binding (§2) — adversarial 2 and 3", () => {
  it("changes to NON-projected content are blocked and P stays active (after, before, concept.description)", async () => {
    world = new StanceWorld();
    const { w, allowanceId } = await blockedThenAllowed(codeArgs({ concept: { name: "config", description: "first" } }));
    for (const over of [
      { after: "export function loadConfig() { return { x: 1 }; }" },
      { before: "let config = { a: 1 };" },
      { concept: { name: "config", description: "second" } },
    ]) {
      const res = await w.call("present_code_change", codeArgs({ concept: { name: "config", description: "first" }, ...over }));
      expect(res.isError).toBe(true);
      expect(res.text).toContain("REJECTED_APPROACH_BLOCKED");
    }
    expect(artifactsOf(w.sessionId)).toHaveLength(0);
    expect(await stateOf(allowanceId)).toBe("allowed");
  });

  it("a decision's pros and a research evidence snippet are bound too", async () => {
    world = new StanceWorld();
    const { w, allowanceId } = await blockedThenAllowed(optionArgs(), "present_options");
    const changedPros = optionArgs({ options: [{ ...OPTIONS[0], pros: ["testable", "also faster"] }, OPTIONS[1]] });
    expect((await w.call("present_options", changedPros)).isError).toBe(true);
    expect(await stateOf(allowanceId)).toBe("allowed");

    // A research evidence snippet: findings can't be allowed once — not via
    // present_findings, and (fail closed, #499 review) not via revise_artifact.
    const store = world.store(w.sessionId);
    store.overrideRejectedApproach({ description: STANCE });
    await w.call("present_findings", { title: "F", summary: "Inspect", findings: [{ category: "A", detail: "d", significance: "low" }] });
    holdStance(store, STANCE);
    const target = artifactsOf(w.sessionId).find((a) => a.type === "research")!;
    const revise = { artifactId: target.id, mode: "supersede", reason: "r", content: { summary: "Remove global mutable state", findings: [{ category: "A", detail: "d", significance: "low", evidence: [{ filePath: "src/a.ts", lineStart: 1, lineEnd: 1, snippet: "let a = 1;", explanation: "where it lives" }] }] } };
    expect((await w.call("revise_artifact", revise)).isError).toBe(true);
    const block = await world.newestBlock();
    expect(block).toMatchObject({ toolName: "revise_artifact", eligible: false, ineligibleReason: "unsupported_tool" });
    expect((await world.grant(block.id)).status).toBe(409);
  });

  it("#499 review — revise eligibility matches the create tools: findings, spec and plan revisions are not eligible", async () => {
    world = new StanceWorld();
    const w = await world.wrapper();
    await w.call("present_spec", { title: "Spec", objective: "ship", requirements: [{ id: "R1", statement: "works", rationale: "core", acceptanceCriteria: ["ok"] }] });
    await w.call("present_plan", { title: "Plan", steps: [{ description: "extract", reasoning: "reuse" }], estimatedChanges: 1 });
    holdStance(world.store(w.sessionId), STANCE);
    const [spec, plan] = ["spec", "plan"].map((t) => artifactsOf(w.sessionId).find((a) => a.type === t)!);
    await w.call("revise_artifact", { artifactId: spec!.id, mode: "supersede", reason: "r", content: { title: "Spec", objective: "remove global mutable state", requirements: [{ id: "R1", statement: "works", rationale: "core", acceptanceCriteria: ["ok"] }] } });
    expect(await world.newestBlock()).toMatchObject({ eligible: false, ineligibleReason: "unsupported_tool" });
    await w.call("revise_artifact", { artifactId: plan!.id, mode: "supersede", reason: "r", content: { title: "Plan", steps: [{ description: "remove global mutable state", reasoning: "testability" }], estimatedChanges: 1 } });
    expect(await world.newestBlock()).toMatchObject({ eligible: false, ineligibleReason: "unsupported_tool" });
  });

  it("paraphrase: a one-character change, a reworded clause, a trailing clause and a different tool are each blocked; P stays active", async () => {
    world = new StanceWorld();
    const { w, allowanceId } = await blockedThenAllowed();
    for (const args of [
      codeArgs({ reasoning: "Remove global mutable state from the config loader." }),
      codeArgs({ reasoning: "From the config loader, remove global mutable state" }),
      codeArgs({ reasoning: "Remove global mutable state from the config loader and the cache" }),
      codeArgs({ reasoning: "remove global mutable state from the config loader" }),
    ]) {
      expect((await w.call("present_code_change", args)).isError).toBe(true);
    }
    expect((await w.call("present_options", optionArgs())).isError).toBe(true);
    expect(await stateOf(allowanceId)).toBe("allowed");
    expect(artifactsOf(w.sessionId)).toHaveLength(0);
  });

  it("transport _meta does not change the call fingerprint (the retry still finds the allowance)", async () => {
    world = new StanceWorld();
    const { w } = await blockedThenAllowed();
    const res = await w.call("present_code_change", { ...codeArgs(), _meta: { progressToken: 7 } });
    expect(res.isError).toBeFalsy();
  });
});

describe("#470 multiple stances (§6 step 3)", () => {
  it("an allowance for A on a proposal that also matches B blocks on B (A stays active); allowing both consumes both in one claim", async () => {
    world = new StanceWorld();
    const w = await world.wrapper();
    const store = world.store(w.sessionId);
    holdStance(store, STANCE);
    holdStance(store, "singleton registry");
    const args = codeArgs({ reasoning: "Remove global mutable state and the singleton registry" });
    expect((await w.call("present_code_change", args)).isError).toBe(true);
    const a = await world.allowNewest();
    const second = await w.call("present_code_change", args);
    expect(second.isError).toBe(true);
    expect(second.text).toContain("singleton registry");
    expect(await stateOf(a)).toBe("allowed");
    const b = await world.allowNewest();
    expect((await w.call("present_code_change", args)).isError).toBeFalsy();
    expect(await stateOf(a)).toBe("used");
    expect(await stateOf(b)).toBe("used");
    expect(artifactsOf(w.sessionId)[0]!.admission!.exceptionIds.sort()).toEqual([a, b].sort());
  });
});

describe("#470 revisions need a new allowance (§6)", () => {
  it("an admitted proposal revised so it still matches is blocked; a revision that no longer matches passes without one", async () => {
    world = new StanceWorld();
    const { w } = await blockedThenAllowed();
    await w.call("present_code_change", codeArgs());
    const admitted = artifactsOf(w.sessionId)[0]!;
    const still = await w.call("revise_artifact", { artifactId: admitted.id, mode: "supersede", reason: "tweak", content: codeArgs({ after: "export const tweak = 1;" }) });
    expect(still.isError).toBe(true);
    const clean = await w.call("revise_artifact", { artifactId: admitted.id, mode: "supersede", reason: "tweak", content: codeArgs({ reasoning: "Load config through an injected reader" }) });
    expect(clean.isError).toBeFalsy();
    expect(artifactsOf(w.sessionId).find((a) => a.parentId === admitted.id)!.admission).toBeUndefined();
  });
});

describe("#470 session end and expiry (§5)", () => {
  it("unregister ends the allowance: the retry is refused as ended", async () => {
    world = new StanceWorld();
    const { w, allowanceId } = await blockedThenAllowed();
    await w.client.unregister();
    expect(await stateOf(allowanceId)).toBe("ended");
    const res = await w.call("present_code_change", codeArgs());
    expect(res.isError).toBe(true);
    expect(res.text).toContain("ended with its Claude session");
  });

  it("a SIGKILLed wrapper's registration lingers: admitted one millisecond before ceilingAt", async () => {
    world = new StanceWorld();
    const { w } = await blockedThenAllowed();
    world.now += ALLOWANCE_CEILING_MS - 1;
    expect((await w.call("present_code_change", codeArgs())).isError).toBeFalsy();
  });

  it("at ceilingAt the allowance is expired even though the registration is live", async () => {
    world = new StanceWorld();
    const { w, allowanceId } = await blockedThenAllowed();
    world.now += ALLOWANCE_CEILING_MS;
    expect(await stateOf(allowanceId)).toBe("expired");
    const res = await w.call("present_code_change", codeArgs());
    expect(res.isError).toBe(true);
    expect(res.text).toContain("expired");
  });

  it("#499 review — the cap also runs on a monotonic clock: stepping the wall clock BACK can't extend it", async () => {
    world = new StanceWorld();
    const { w, allowanceId } = await blockedThenAllowed();
    world.now -= 10 * 24 * 3600_000; // the wall clock steps back ten days
    world.mono += ALLOWANCE_CEILING_MS - 1;
    expect(await stateOf(allowanceId)).toBe("allowed");
    world.mono += 1;
    expect(await stateOf(allowanceId)).toBe("expired");
    const res = await w.call("present_code_change", codeArgs());
    expect(res.isError).toBe(true);
    expect(artifactsOf(w.sessionId)).toHaveLength(0);
  });

  it("#499 review P2 — a late unregister from an EVICTED wrapper is a no-op: the live replacement and its allowance survive", async () => {
    world = new StanceWorld();
    const a = await world.wrapper("sx_split", { split: true });
    const b = await world.wrapper("sx_split", { split: true }); // evicts A
    holdStance(world.store("sx_split"), STANCE);
    await b.call("present_code_change", codeArgs());
    const allowanceId = await world.allowNewest();
    await a.client.unregister(); // A's late shutdown, with A's (now unknown) token
    expect(world.daemon.activeSessions.has("sx_split")).toBe(true);
    expect(await stateOf(allowanceId)).toBe("allowed");
    expect((await b.call("present_code_change", codeArgs())).isError).toBeFalsy();
  });

  it("#499 review P2 — fallback mode: one of two wrappers leaving keeps the session live for the other", async () => {
    world = new StanceWorld();
    const one = await world.wrapper("sx_fb");
    const two = await world.wrapper("sx_fb");
    holdStance(world.store("sx_fb"), STANCE);
    await two.call("present_code_change", codeArgs());
    const allowanceId = await world.allowNewest();
    await one.client.unregister();
    expect(world.daemon.activeSessions.has("sx_fb")).toBe(true);
    expect(await stateOf(allowanceId)).toBe("allowed");
    await two.client.unregister();
    expect(world.daemon.activeSessions.has("sx_fb")).toBe(false);
    expect(await stateOf(allowanceId)).toBe("ended");
  });

  it("split mode: a newer registration for the same session evicts the older one; fallback mode does not, and wrapper 2 can't claim wrapper 1's allowance", async () => {
    world = new StanceWorld();
    const split1 = await world.wrapper("sx_split", { split: true });
    holdStance(world.store("sx_split"), STANCE);
    await split1.call("present_code_change", codeArgs());
    const splitAllowance = await world.allowNewest();
    await world.wrapper("sx_split", { split: true }); // /mcp reconnect or --resume
    expect(await stateOf(splitAllowance)).toBe("ended");

    const fb1 = await world.wrapper("sx_fallback");
    await fb1.call("present_code_change", codeArgs());
    const fbAllowance = await world.allowNewest();
    const fb2 = await world.wrapper("sx_fallback");
    expect(await stateOf(fbAllowance)).toBe("allowed");
    expect((await fb2.call("present_code_change", codeArgs())).isError).toBe(true);
    expect(await stateOf(fbAllowance)).toBe("allowed");
    expect((await fb1.call("present_code_change", codeArgs())).isError).toBeFalsy();
  });

  it("a daemon restart ends the allowance; its receipt reads ended (not used)", async () => {
    world = new StanceWorld();
    await blockedThenAllowed();
    await world.restart();
    const w = await world.wrapper();
    const res = await w.call("present_code_change", codeArgs());
    expect(res.isError).toBe(true);
    expect(res.text).toContain("ended with its Claude session");
    expect((await world.blocks()).find((b) => b.allowance)!.allowance!.state).toBe("ended");
  });

  it("registration resolution: a missing or unknown registration token cannot claim", async () => {
    world = new StanceWorld();
    const { w, allowanceId } = await blockedThenAllowed();
    const block = (await world.blocks()).find((b) => b.allowance)!;
    const body = { callFingerprint: block.callFingerprint, admission: { exceptionIds: [allowanceId], toolName: "present_code_change", snapshot: block.snapshot, preconditions: block.preconditions } };
    for (const token of [undefined, "not-a-token"]) {
      const res = await world.operation(w.sessionId, `op_forge_${token ?? "none"}`, body, token);
      expect(await res.json()).toMatchObject({ status: "refused", reason: "not_this_registration" });
    }
    expect(await stateOf(allowanceId)).toBe("allowed");
  });
});

describe("#470 idempotency, revocation and leakage (§10 adversarial 11)", () => {
  it("a double grant returns the same id; revoking a used allowance reports it was already used", async () => {
    world = new StanceWorld();
    const { w, allowanceId } = await blockedThenAllowed();
    const block = (await world.blocks()).find((b) => b.allowance)!;
    const again = await world.grant(block.id, "a different reason");
    expect(again.status).toBe(200);
    expect((await again.json()).allowance.id).toBe(allowanceId);
    await w.call("present_code_change", codeArgs());
    const revoke = await world.revoke(allowanceId);
    expect(revoke.status).toBe(409);
    expect((await revoke.json()).error).toContain("Already used by");
  });

  it("revoke turns an active allowance off and the retry is refused as revoked", async () => {
    world = new StanceWorld();
    const { w, allowanceId } = await blockedThenAllowed();
    expect((await world.revoke(allowanceId)).status).toBe(200);
    expect((await world.blocks()).find((b) => b.allowance)!.allowance!.state).toBe("revoked");
    const res = await w.call("present_code_change", codeArgs());
    expect(res.isError).toBe(true);
    expect(res.text).toContain("revoked");
  });

  it("nothing reaches the cross-project ledger and approvedPatterns is unchanged, even with publishing on", async () => {
    world = new StanceWorld();
    const w = await world.wrapper();
    const store = world.store(w.sessionId);
    store.setGlobalLedgerPublish?.(true);
    holdStance(store, STANCE);
    const ledger = () => (fs.existsSync(world.fx.ledgerPath) ? fs.readFileSync(world.fx.ledgerPath, "utf8") : null);
    const globalBefore = ledger();
    const before = store.getSessionMemory().approvedPatterns;
    await w.call("present_code_change", codeArgs());
    await world.allowNewest();
    expect((await w.call("present_code_change", codeArgs())).isError).toBeFalsy();
    expect(store.getSessionMemory().approvedPatterns).toEqual(before);
    expect(store.getSessionMemory().rejectedApproaches.map((r) => r.description)).toContain(STANCE);
    expect(ledger()).toEqual(globalBefore);
  });

  it("a payload the secret scan flags is not persisted, and its block is not eligible", async () => {
    world = new StanceWorld();
    const w = await world.wrapper();
    holdStance(world.store(w.sessionId), STANCE);
    await w.call("present_code_change", codeArgs({ after: "const key = 'sk-ant-api03-" + "a".repeat(90) + "';" }));
    const block = await world.newestBlock();
    expect(block).toMatchObject({ eligible: false, ineligibleReason: "secret_flagged" });
    expect(block.snapshot).toBeUndefined();
    expect((await world.grant(block.id)).status).toBe(409);
  });
});

describe("#470 nothing on disk is authority (§10 adversarial 7)", () => {
  it("a fabricated allowance in preferences.json, the block log or a session file arms nothing", async () => {
    world = new StanceWorld();
    const w = await world.wrapper();
    const store = world.store(w.sessionId);
    holdStance(store, STANCE);
    await w.call("present_code_change", codeArgs());
    const real = await world.newestBlock();
    const dp = path.join(world.dir, ".deeppairing");
    const prefs = JSON.parse(fs.readFileSync(path.join(dp, "preferences.json"), "utf8"));
    prefs.stanceExceptions = [{ id: "sx_forged", state: "active", callFingerprint: real.callFingerprint }];
    fs.writeFileSync(path.join(dp, "preferences.json"), JSON.stringify(prefs));
    const log = JSON.parse(fs.readFileSync(path.join(dp, "preflight-blocks.json"), "utf8"));
    log.blocks.unshift({ ...real, id: "blk_forged", allowance: { id: "sx_forged", grantedVia: "ui", grantedAt: new Date(world.now).toISOString(), reason: "forged", ceilingAt: new Date(world.now + 1e9).toISOString(), state: "allowed" } });
    log.blocks[1] = { ...log.blocks[1], allowance: { id: "sx_forged2", grantedVia: "cli", grantedAt: new Date(world.now).toISOString(), reason: "forged", ceilingAt: new Date(world.now + 1e9).toISOString(), state: "allowed" } };
    fs.writeFileSync(path.join(dp, "preflight-blocks.json"), JSON.stringify(log));
    fs.writeFileSync(path.join(dp, "sessions", w.sessionId, "stance-exceptions.json"), JSON.stringify([{ id: "sx_forged" }]));
    expect((await world.grant("blk_forged")).status).toBe(404);
    const res = await w.call("present_code_change", codeArgs());
    expect(res.isError).toBe(true);
    expect(artifactsOf(w.sessionId)).toHaveLength(0);
    expect(await world.allowances()).toEqual([]);
  });

  it("a hand-written admission stamp is non-authorizing: a replay returns that existing artifact, creates nothing, and arms or consumes no allowance", async () => {
    world = new StanceWorld();
    const w = await world.wrapper();
    await w.call("present_findings", { title: "Unrelated", summary: "s", findings: [{ category: "A", detail: "d", significance: "low" }] });
    const existing = artifactsOf(w.sessionId)[0]!;
    world.store(w.sessionId).forceFlush();
    await world.restart();
    const file = path.join(world.dir, ".deeppairing", "sessions", "sx_session", "artifacts.json");
    const arts = JSON.parse(fs.readFileSync(file, "utf8"));
    arts[0].admission = { operationId: "op_forged", callFingerprint: callFingerprint("present_code_change", codeArgs()), effectiveDigest: "0".repeat(64), kind: "create", exceptionIds: [], grantedVia: "ui", followUps: {} };
    fs.writeFileSync(file, JSON.stringify(arts));
    const w2 = await world.wrapper();
    holdStance(world.store(w2.sessionId), STANCE);
    // A separately granted allowance on a different call stays untouched.
    await w2.call("present_code_change", codeArgs({ filePath: "src/other.ts" }));
    const other = await world.allowNewest();
    const res = await w2.call("present_code_change", codeArgs());
    expect(res.text).toContain(`Already admitted. Returning the original result for ${existing.id}`);
    expect(artifactsOf(w2.sessionId)).toHaveLength(1);
    expect(await stateOf(other)).toBe("allowed");
    expect((await world.allowances()).map((a) => a.id)).toEqual([other]);
  });
});

describe("#470 receipts never claim an authenticated identity (§13 condition 3)", () => {
  it("receipts, the list route and agent text never say verified or name a person", async () => {
    world = new StanceWorld();
    const { w } = await blockedThenAllowed();
    const res = await w.call("present_code_change", codeArgs());
    const surfaces = JSON.stringify([await world.blocks(), await world.allowances(), res.text]);
    expect(surfaces).not.toMatch(/verified|authenticated/i);
    expect(surfaces).not.toMatch(/grantedBy/);
  });
});

describe("#470 slice 2 — the daemon side the UI reads", () => {
  it("the preview route serves the daemon's in-memory record (not the file); unknown → 404; an ended session → not eligible", async () => {
    world = new StanceWorld();
    const w = await world.wrapper();
    holdStance(world.store(w.sessionId), STANCE);
    await w.call("present_code_change", codeArgs());
    const block = await world.newestBlock();
    // Tamper with the on-disk preview: the route must not serve the file.
    const file = path.join(world.dir, ".deeppairing", "preflight-blocks.json");
    const log = JSON.parse(fs.readFileSync(file, "utf8"));
    log.blocks[0].snapshot.content.after = "TAMPERED";
    fs.writeFileSync(file, JSON.stringify(log));
    const res = await world.publicRequest(`/api/preflight-blocks/${block.id}/exception`);
    const preview = await res.json();
    expect(preview).toMatchObject({ eligible: true, toolName: "present_code_change", stance: { description: STANCE } });
    expect(preview.snapshot.content.after).toBe(codeArgs().after);
    expect((await world.publicRequest("/api/preflight-blocks/blk_nope/exception")).status).toBe(404);
    await w.client.unregister();
    expect(await (await world.publicRequest(`/api/preflight-blocks/${block.id}/exception`)).json()).toMatchObject({ eligible: false, ineligibleReason: "session_ended" });
  });

  it("a grant broadcasts seenAt; a use broadcasts the `used` receipt with the artifact's title, once", async () => {
    world = new StanceWorld();
    const { w } = await blockedThenAllowed();
    expect(world.events.find((e) => e.type === "stance_exception_granted")).toMatchObject({ seenAt: expect.any(String) });
    await w.call("present_code_change", codeArgs());
    await w.call("present_code_change", codeArgs()); // a replay
    const used = world.events.filter((e) => e.type === "stance_exception_updated" && (e.allowance as { state: string }).state === "used");
    expect(used).toHaveLength(1);
    expect(used[0]).toMatchObject({ artifactTitle: "modify src/config.ts" });
  });
});
