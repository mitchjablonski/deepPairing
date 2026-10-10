/**
 * #470 slice 1 — §10 (5a): the effective proposal changes after the grant while
 * the raw args stay identical. The allowance must never admit a different
 * effective proposal: the claim is refused (stance_exception_dependencies_changed),
 * nothing is created, the old allowance becomes `changed` for good, and the
 * call's NEW block is recorded with the two-way linkage (§4 "changed").
 */
import { afterEach, describe, expect, it } from "vitest";
import { StanceWorld, holdStance, registrationTokenOf } from "./stance-exceptions.harness.js";

let world: StanceWorld;
afterEach(async () => { await world?.dispose(); });

const STANCE = "global mutable state";
const SID = "sx_session";
const blockedArgs = { filePath: "src/config.ts", changeType: "modify", after: "export function loadConfig() { return {}; }", reasoning: "Remove global mutable state from the config loader" };
const clean = (after: string) => ({ filePath: "src/config.ts", changeType: "modify", before: "x", after, reasoning: "tidy the loader" });
const stateOf = async (id: string) => (await world.allowances()).find((a) => a.id === id)?.state;
const admitted = () => world.store(SID).getArtifacts().filter((a) => a.admission);

async function setup(withPrior: boolean) {
  const w = await world.wrapper(SID);
  if (withPrior) expect((await w.call("present_code_change", clean("let config = {};"))).isError).toBeFalsy();
  holdStance(world.store(SID), STANCE);
  expect((await w.call("present_code_change", blockedArgs)).isError).toBe(true);
  const allowanceId = await world.allowNewest();
  return { w, allowanceId };
}

async function expectChanged(allowanceId: string) {
  expect(admitted()).toHaveLength(0);
  expect(await stateOf(allowanceId)).toBe("changed");
  const blocks = await world.blocks();
  const oldEntry = blocks.find((b) => b.allowance?.id === allowanceId)!;
  const newEntry = blocks.find((b) => b.supersedesAllowanceId === allowanceId)!;
  expect(newEntry).toBeTruthy();
  expect(newEntry.eligible).toBe(true);
  expect(newEntry.seenAt).toBeUndefined(); // §4a — Held rises by one
  expect(oldEntry.allowance).toMatchObject({ state: "changed", supersededByBlockId: newEntry.id });
  return newEntry;
}

describe("#470 §10 (5a) — present_code_change with `before` omitted", () => {
  it("a newer code_change for the same file lands after the grant → refused, changed, new block linked; allowing the NEW block admits the new snapshot", async () => {
    world = new StanceWorld();
    const { w, allowanceId } = await setup(true);
    const firstPrior = world.store(SID).getArtifacts()[0]!.id;
    expect((await w.call("present_code_change", clean("let config = { v: 2 };"))).isError).toBeFalsy();
    const res = await w.call("present_code_change", blockedArgs);
    expect(res.isError).toBe(true);
    expect(res.text).toContain(`depended on ${firstPrior}, which changed. Ask your pair to allow the new version.`);
    const newEntry = await expectChanged(allowanceId);
    expect((newEntry.snapshot!.content as { before: string }).before).toBe("let config = { v: 2 };");
    // The human allows the new block; the identical call is now admitted.
    const grant = await world.grant(newEntry.id);
    expect(grant.status).toBe(201);
    expect((await w.call("present_code_change", blockedArgs)).isError).toBeFalsy();
    expect((admitted()[0]!.content as { before: string }).before).toBe("let config = { v: 2 };");
  });

  it("the prior's `after` is edited after the grant → refused; restoring it does NOT revive the changed allowance", async () => {
    world = new StanceWorld();
    const { w, allowanceId } = await setup(true);
    const prior = world.store(SID).getArtifacts()[0]!;
    const original = (prior.content as { after: string }).after;
    (prior.content as { after: string }).after = "let config = { edited: true };";
    expect((await w.call("present_code_change", blockedArgs)).isError).toBe(true);
    await expectChanged(allowanceId);
    (prior.content as { after: string }).after = original;
    const again = await w.call("present_code_change", blockedArgs);
    expect(again.isError).toBe(true);
    expect(admitted()).toHaveLength(0);
    expect(await stateOf(allowanceId)).toBe("changed");
  });

  it("no prior at grant time, one appears before the claim (changeType would flip create → modify) → refused", async () => {
    world = new StanceWorld();
    const w = await world.wrapper(SID);
    holdStance(world.store(SID), STANCE);
    const createArgs = { ...blockedArgs, changeType: "create" };
    expect((await w.call("present_code_change", createArgs)).isError).toBe(true);
    const block = await world.newestBlock();
    expect(block.snapshot!.content).toMatchObject({ changeType: "create", before: "" });
    expect(block.preconditions).toEqual([{ kind: "code_change_prior", filePath: "src/config.ts", priorCodeChangeId: null, priorAfterHash: null }]);
    const allowanceId = await world.allowNewest();
    expect((await w.call("present_code_change", clean("let config = {};"))).isError).toBeFalsy();
    const res = await w.call("present_code_change", createArgs);
    expect(res.text).toContain("depended on there being no earlier change to this file");
    const newEntry = await expectChanged(allowanceId);
    expect(newEntry.snapshot!.content).toMatchObject({ changeType: "modify" });
  });
});

describe("#470 §10 (5a) — revise_artifact", () => {
  const OPTIONS = [
    { id: "a", title: "Inject config", description: "pass config", pros: ["testable"], cons: ["churn"], effort: "low", risk: "low", recommendation: true },
    { id: "b", title: "Keep it", description: "status quo", pros: ["none"], cons: ["hard to test"], effort: "low", risk: "low", recommendation: false },
  ];
  async function reviseSetup() {
    const w = await world.wrapper(SID);
    await w.call("present_options", { context: "Which config owner?", title: "Config audit", options: OPTIONS });
    const target = world.store(SID).getArtifacts()[0]!;
    holdStance(world.store(SID), STANCE);
    const args = { artifactId: target.id, mode: "supersede", reason: "r", content: { context: "Remove global mutable state: which owner?", options: OPTIONS } };
    expect((await w.call("revise_artifact", args)).isError).toBe(true);
    const allowanceId = await world.allowNewest();
    return { w, target, args, allowanceId };
  }

  it("the title was omitted and the target's title changes after the grant → refused", async () => {
    world = new StanceWorld();
    const { w, target, args, allowanceId } = await reviseSetup();
    world.store(SID).renameArtifact(target.id, "Config audit (renamed)");
    const res = await w.call("revise_artifact", args);
    expect(res.text).toContain(`depended on the state of ${target.id}, which changed`);
    const newEntry = await expectChanged(allowanceId);
    expect(newEntry.snapshot!.title).toBe("Config audit (renamed)");
    expect(world.store(SID).getArtifacts().find((a) => a.id === target.id)!.status).toBe("draft");
  });

  it("the human approves the target after the grant (its status moved) → refused", async () => {
    world = new StanceWorld();
    const { w, target, args, allowanceId } = await reviseSetup();
    world.store(SID).updateArtifactStatus(target.id, "approved", "ui_approve_button");
    expect((await w.call("revise_artifact", args)).isError).toBe(true);
    await expectChanged(allowanceId);
  });

  it("the target is revised or closed by the human after the grant → the claim never admits (tool gate or daemon backstop)", async () => {
    world = new StanceWorld();
    const { w, target, args, allowanceId } = await reviseSetup();
    const block = (await world.blocks()).find((b) => b.allowance?.id === allowanceId)!;
    // Revised by someone else: v2 lands, the target is superseded.
    expect((await w.call("revise_artifact", { artifactId: target.id, mode: "supersede", reason: "other", content: { context: "Which owner, again?", options: OPTIONS } })).isError).toBeFalsy();
    // The tool refuses before the gate (closed parent) — and the daemon's own
    // re-resolution is the backstop for a direct claim.
    expect((await w.call("revise_artifact", args)).isError).toBe(true);
    const direct = await world.operation(SID, "op_direct", {
      callFingerprint: block.callFingerprint,
      admission: { exceptionIds: [allowanceId], toolName: "revise_artifact", snapshot: block.snapshot, preconditions: block.preconditions },
    }, registrationTokenOf(w));
    expect(await direct.json()).toMatchObject({ status: "refused", code: "stance_exception_dependencies_changed", reason: "target_revised" });
    expect(admitted()).toHaveLength(0);
  });
});

describe("#470 §10 (5a) — created from the snapshot, never the client's content", () => {
  it("a client whose resolved content differs (same fingerprint) is refused; nothing it resolved is persisted; the allowance stays active", async () => {
    world = new StanceWorld();
    const { w, allowanceId } = await setup(false);
    const block = (await world.blocks()).find((b) => b.allowance?.id === allowanceId)!;
    const tampered = { ...block.snapshot!, content: { ...block.snapshot!.content, after: "rm -rf everything" } };
    const res = await world.operation(SID, "op_tampered", {
      callFingerprint: block.callFingerprint,
      admission: { exceptionIds: [allowanceId], toolName: "present_code_change", snapshot: tampered, preconditions: block.preconditions },
    }, registrationTokenOf(w));
    expect(await res.json()).toMatchObject({ status: "refused", code: "stance_exception_dependencies_changed", reason: "client_snapshot_mismatch" });
    expect(admitted()).toHaveLength(0);
    expect(await stateOf(allowanceId)).toBe("allowed");
    // The honest identical call still gets exactly the allowed snapshot.
    expect((await w.call("present_code_change", blockedArgs)).isError).toBeFalsy();
    expect((admitted()[0]!.content as { after: string }).after).toBe(blockedArgs.after);
  });
});
