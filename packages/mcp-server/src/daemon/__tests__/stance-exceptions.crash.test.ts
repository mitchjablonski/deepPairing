/**
 * #470 slice 1 — the §13 acceptance conditions and the §10 (4)/(5b) matrices:
 * dropped responses, daemon restarts, simulated crashes at every follow-up
 * point, real flush-lock failures, disk errors, and overlapping requests.
 * Real daemon + DaemonClient + MCP server + FileStore (see the harness).
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Artifact } from "@deeppairing/shared";
import { StanceWorld, holdStance, registrationTokenOf, type Wrapper } from "./stance-exceptions.harness.js";
import type { StanceFaultPoint } from "../stance-exceptions.js";
import { ownLockIdentity } from "../../store/file-lock.js";

let world: StanceWorld;
afterEach(async () => {
  vi.restoreAllMocks();
  await world?.dispose();
});

const STANCE = "global mutable state";
const SID = "sx_session";
const codeArgs = () => ({
  filePath: "src/config.ts", changeType: "modify", before: "let config = {};",
  after: "export function loadConfig() { return {}; }", reasoning: "Remove global mutable state from the config loader",
});
const OPTIONS = [
  { id: "a", title: "Inject config", description: "pass config explicitly", pros: ["testable"], cons: ["churn"], effort: "low", risk: "low", recommendation: true },
  { id: "b", title: "Keep the module", description: "status quo", pros: ["no churn"], cons: ["hard to test"], effort: "low", risk: "low", recommendation: false },
];
const sessionDir = () => path.join(world.dir, ".deeppairing", "sessions", SID);
const onDisk = (file: string) => {
  const p = path.join(sessionDir(), file);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : [];
};
const liveLockOwner = () => JSON.stringify({ ...ownLockIdentity()!, pid: process.ppid, processStartTime: null, createdAt: new Date().toISOString(), nonce: "live" });
const stateOf = async (id: string) => (await world.allowances()).find((a) => a.id === id)?.state;

type Kind = "decision-revise" | "plan-revise" | "options-create";

/** Set up a blocked-then-allowed call of the given kind; returns the call. */
async function allowed(kind: Kind): Promise<{ w: Wrapper; tool: string; args: Record<string, unknown>; parentId?: string; allowanceId: string }> {
  const w = await world.wrapper(SID);
  let tool: string;
  let args: Record<string, unknown>;
  let parentId: string | undefined;
  if (kind === "options-create") {
    holdStance(world.store(SID), STANCE);
    tool = "present_options";
    args = { context: "How do we remove global mutable state from config?", title: "Config ownership", options: OPTIONS };
  } else if (kind === "decision-revise") {
    await w.call("present_options", { context: "Which config owner?", title: "Config owner", options: OPTIONS, stakes: "high" });
    parentId = world.store(SID).getArtifacts()[0]!.id;
    holdStance(world.store(SID), STANCE);
    tool = "revise_artifact";
    args = { artifactId: parentId, mode: "supersede", reason: "name the removal", content: { context: "Remove global mutable state from config: which owner?", options: OPTIONS } };
  } else {
    await w.call("present_plan", { title: "Config plan", steps: [{ description: "extract a loader", reasoning: "reuse" }], estimatedChanges: 1 });
    parentId = world.store(SID).getArtifacts()[0]!.id;
    holdStance(world.store(SID), STANCE);
    tool = "revise_artifact";
    args = { artifactId: parentId, mode: "supersede", reason: "name the removal", content: { title: "Config plan", steps: [{ description: "remove global mutable state from the loader", reasoning: "testability" }], estimatedChanges: 1 } };
  }
  expect((await w.call(tool, args)).isError).toBe(true);
  const allowanceId = await world.allowNewest();
  return { w, tool, args, parentId, allowanceId };
}

/** Every successful replay leaves exactly this (§10 5b). */
function expectCompleted(kind: Kind, parentId?: string): Artifact {
  const store = world.store(SID);
  const children = store.getArtifacts().filter((a) => a.admission);
  expect(children).toHaveLength(1);
  const child = children[0]!;
  expect(child.admission!.completedAt).toBeTruthy();
  expect(store.getPreflightTrace(child.id)?.exception).toBeTruthy();
  if (parentId) {
    expect(child.parentId).toBe(parentId);
    expect(store.getArtifacts().find((a) => a.id === parentId)!.status).toBe("superseded");
    const opComments = store.getCommentsForArtifact(parentId).filter((c) => c.id.startsWith("cmt_op_"));
    expect(opComments.map((c) => c.id)).toEqual([`cmt_op_${child.admission!.operationId}`]);
    // On disk too: the whole operation is durable, not just in memory.
    expect((onDisk("comments.json") as Array<{ id: string }>).filter((c) => c.id.startsWith("cmt_op_"))).toHaveLength(1);
  }
  const decisionId = (child.content as { decisionId?: string }).decisionId;
  if (kind !== "plan-revise") {
    expect(decisionId).toMatch(/^dec_/);
    expect(store.getFullState().decisions.filter((d) => d.artifactId === child.id)).toHaveLength(1);
  } else {
    expect(store.hasPlanReview(child.id)).toBe(true);
  }
  const persisted = (onDisk("artifacts.json") as Artifact[]).filter((a) => a.admission);
  expect(persisted).toHaveLength(1);
  expect(persisted[0]!.admission!.completedAt).toBeTruthy();
  return child;
}

describe("#470 §10 (4) — a dropped response after commit", () => {
  it("both attempts fail: the tool errors, the allowance stays consumed, and the identical retry gets the ORIGINAL artifact", async () => {
    world = new StanceWorld();
    const { w, allowanceId } = await allowed("options-create");
    world.drop = (url, init) => url.includes("/operations/") && String(init?.body).includes("\"admission\"");
    const lost = await w.call("present_options", { context: "How do we remove global mutable state from config?", title: "Config ownership", options: OPTIONS });
    expect(lost.isError).toBe(true);
    expect(await stateOf(allowanceId)).toBe("used");
    const child = world.store(SID).getArtifacts()[0]!;
    const retry = await w.call("present_options", { context: "How do we remove global mutable state from config?", title: "Config ownership", options: OPTIONS });
    expect(retry.text).toContain(`Already admitted. Returning the original result for ${child.id}`);
    expect(retry.structuredContent).toMatchObject({ artifactId: child.id, replayed: true });
    expectCompleted("options-create");
  });

  it("the transparent retry (same operationId) replays: one artifact, the receipt says used", async () => {
    world = new StanceWorld();
    const { w, allowanceId } = await allowed("options-create");
    world.drop = (url, init) => url.includes("/operations/") && String(init?.body).includes("\"admission\"");
    await w.call("present_options", { context: "How do we remove global mutable state from config?", title: "Config ownership", options: OPTIONS });
    const claim = world.lastClaim();
    const res = await world.operation(SID, claim.operationId, claim.body, registrationTokenOf(w));
    expect(await res.json()).toMatchObject({ status: "replayed", replayed: true });
    expectCompleted("options-create");
    expect((await world.blocks()).find((b) => b.allowance?.id === allowanceId)!.allowance!.state).toBe("used");
  });

  it("commit, drop, daemon restart, retry: the stamp replays the original result; nothing is re-armed", async () => {
    world = new StanceWorld();
    const { w, tool, args, parentId } = await allowed("decision-revise");
    world.drop = (url, init) => url.includes("/operations/") && String(init?.body).includes("\"admission\"");
    expect((await w.call(tool, args)).isError).toBe(true);
    await world.restart();
    const w2 = await world.wrapper(SID);
    const retry = await w2.call(tool, args);
    expect(retry.text).toContain("Already admitted");
    expectCompleted("decision-revise", parentId);
    expect(await world.allowances()).toEqual([]);
  });

  it("daemon killed between claim and create: no artifact; after restart the retry is blocked as ended and the receipt shows ended (not used)", async () => {
    world = new StanceWorld();
    const { w, tool, args, allowanceId } = await allowed("options-create");
    world.crashAt("after_claim");
    expect((await w.call(tool, args)).isError).toBe(true);
    await world.restart();
    expect(world.daemon.sessions.size).toBe(0);
    const w2 = await world.wrapper(SID);
    expect(world.store(SID).getArtifacts()).toHaveLength(0);
    const retry = await w2.call(tool, args);
    expect(retry.isError).toBe(true);
    expect(retry.text).toContain("ended with its Claude session");
    expect((await world.blocks()).find((b) => b.allowance?.id === allowanceId)!.allowance!.state).toBe("ended");
  });

  it("a throw inside the section before anything is buffered reverts the claim; the retry is admitted", async () => {
    world = new StanceWorld();
    const { w, tool, args, allowanceId } = await allowed("options-create");
    world.crashAt("create_throws");
    expect((await w.call(tool, args)).isError).toBe(true);
    expect(world.store(SID).getArtifacts()).toHaveLength(0);
    expect(await stateOf(allowanceId)).toBe("allowed");
    expect((await w.call(tool, args)).isError).toBeFalsy();
    expectCompleted("options-create");
  });
});

// §10 (5b) — kill at each point, then each recovery path. Every point flushes
// before it fires, so "crash here" leaves exactly what a SIGKILL would.
const MATRIX: Array<[Kind, StanceFaultPoint]> = [
  ["decision-revise", "after_child_flush"],
  ["decision-revise", "after_supersede"],
  ["decision-revise", "after_comment"],
  ["decision-revise", "after_decision"],
  ["decision-revise", "before_completed"],
  ["plan-revise", "after_child_flush"],
  ["plan-revise", "after_plan_review"],
  ["plan-revise", "before_completed"],
  ["options-create", "after_child_flush"],
  ["options-create", "after_decision"],
  ["options-create", "before_completed"],
];

describe("#470 §10 (5b) — crash mid-operation, three recovery paths", () => {
  it.each(MATRIX)("%s, crash %s → the transparent retry (same operationId) completes it", async (kind, point) => {
    world = new StanceWorld();
    const { w, tool, args, parentId } = await allowed(kind);
    world.crashAt(point);
    expect((await w.call(tool, args)).isError).toBe(true);
    const claim = world.lastClaim();
    const res = await world.operation(SID, claim.operationId, claim.body, registrationTokenOf(w));
    expect(await res.json()).toMatchObject({ status: "replayed" });
    expectCompleted(kind, parentId);
  });

  it.each(MATRIX)("%s, crash %s → the agent-level retry (new operationId, parent already superseded) completes it", async (kind, point) => {
    world = new StanceWorld();
    const { w, tool, args, parentId } = await allowed(kind);
    world.crashAt(point);
    expect((await w.call(tool, args)).isError).toBe(true);
    const original = world.lastClaim().operationId;
    const parentStatus = parentId ? world.store(SID).getArtifacts().find((a) => a.id === parentId)!.status : undefined;
    const retry = await w.call(tool, args);
    expect(retry.isError).toBeFalsy();
    expect(retry.text).toContain("Already admitted");
    // A NEW operationId found the stamp by fingerprint — before revise's
    // closed-parent check (the parent may already be superseded) and N2.
    const probe = [...world.requests].reverse().find((r) => r.method === "POST" && r.url.includes("/operations/"))!;
    expect(probe.url).not.toContain(original);
    if (point !== "after_child_flush" && parentId) expect(parentStatus).toBe("superseded");
    expectCompleted(kind, parentId);
  });

  it.each(MATRIX)("%s, crash %s → startup reconciliation completes it with no retry at all", async (kind, point) => {
    world = new StanceWorld();
    const { w, tool, args, parentId } = await allowed(kind);
    world.crashAt(point);
    expect((await w.call(tool, args)).isError).toBe(true);
    await world.restart();
    await world.wrapper(SID); // the daemon loads the session → reconciliation
    await world.daemon.stanceExceptions.reconcile(SID, world.store(SID)); // drain the queue
    expectCompleted(kind, parentId);
  });
});

describe("#470 §13 condition 1 — the per-session operation queue", () => {
  it("overlapping IDENTICAL requests: exactly one child and one of each follow-up; the loser replays", async () => {
    world = new StanceWorld();
    const { w, tool, args, parentId } = await allowed("decision-revise");
    const results = await Promise.all([w.call(tool, args), w.call(tool, args)]);
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(results.filter((r) => r.text.includes("Already admitted"))).toHaveLength(1);
    expectCompleted("decision-revise", parentId);
  });

  it("overlapping DIFFERENT requests on one session: each admitted once, no cross-talk", async () => {
    world = new StanceWorld();
    const w = await world.wrapper(SID);
    holdStance(world.store(SID), STANCE);
    const a = { ...codeArgs(), filePath: "src/a.ts" };
    const b = { ...codeArgs(), filePath: "src/b.ts" };
    await w.call("present_code_change", a);
    await world.allowNewest();
    await w.call("present_code_change", b);
    await world.allowNewest();
    const results = await Promise.all([w.call("present_code_change", a), w.call("present_code_change", b)]);
    expect(results.every((r) => !r.isError && r.text.includes("Admitted once"))).toBe(true);
    const children = world.store(SID).getArtifacts().filter((x) => x.admission);
    expect(children.map((c) => (c.content as { filePath: string }).filePath).sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("startup reconciliation racing a live retry: exactly one child and one of each follow-up", async () => {
    world = new StanceWorld();
    const { w, tool, args, parentId } = await allowed("decision-revise");
    world.crashAt("after_child_flush");
    expect((await w.call(tool, args)).isError).toBe(true);
    const claim = world.lastClaim();
    await world.restart();
    const w2 = await world.wrapper(SID); // reconciliation queued
    const [, transparent, agent] = await Promise.all([
      world.daemon.stanceExceptions.reconcile(SID, world.store(SID)),
      world.operation(SID, claim.operationId, claim.body, registrationTokenOf(w2)).then((r) => r.json()),
      w2.call(tool, args),
    ]);
    expect(transparent).toMatchObject({ status: "replayed" });
    expect(agent.text).toContain("Already admitted");
    expectCompleted("decision-revise", parentId);
  });
});

describe("#470 §13 condition 2 — a failed flush is not proof that nothing happened", () => {
  it("a REAL live flush lock: 503, child buffered, allowance NOT re-armed; unlock → retry replays; one child, one announcement", async () => {
    world = new StanceWorld();
    const { w, tool, args, allowanceId } = await allowed("options-create");
    const lock = path.join(sessionDir(), ".flush.lock");
    fs.writeFileSync(lock, liveLockOwner());
    const failed = await w.call(tool, args);
    expect(failed.isError).toBe(true);
    expect(await stateOf(allowanceId)).toBe("used");
    const buffered = world.store(SID).getArtifacts().find((a) => a.admission)!;
    expect(buffered).toBeTruthy();
    expect((onDisk("artifacts.json") as Artifact[]).some((a) => a.id === buffered.id)).toBe(false);
    expect(world.events.filter((e) => e.type === "artifact_created")).toHaveLength(0);
    // Still locked: another retry neither creates a twin nor reports success.
    expect((await w.call(tool, args)).isError).toBe(true);
    fs.unlinkSync(lock);
    const ok = await w.call(tool, args);
    expect(ok.text).toContain(`Already admitted. Returning the original result for ${buffered.id}`);
    expectCompleted("options-create");
    expect(world.events.filter((e) => e.type === "artifact_created" && (e.artifact as Artifact).id === buffered.id)).toHaveLength(1);
    await w.call(tool, args); // a later replay announces nothing new
    expect(world.events.filter((e) => e.type === "artifact_created")).toHaveLength(1);
  });

  it.each(["ENOSPC", "EIO"])("%s writing artifacts.json: the claim stays consumed; the retry commits exactly once", async (code) => {
    world = new StanceWorld();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { w, tool, args, allowanceId } = await allowed("options-create");
    const realRename = fs.renameSync;
    let failed = false;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (!failed && String(to).endsWith(path.join(SID, "artifacts.json"))) {
        failed = true;
        throw Object.assign(new Error(`injected ${code}`), { code });
      }
      return realRename(from, to);
    });
    expect((await w.call(tool, args)).isError).toBe(true);
    expect(failed).toBe(true);
    expect(await stateOf(allowanceId)).toBe("used");
    expect((await w.call(tool, args)).text).toContain("Already admitted");
    expectCompleted("options-create");
  });

  it("EIO on a LATER collection mid-revision (comments.json): follow-ups complete exactly once on retry", async () => {
    world = new StanceWorld();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { w, tool, args, parentId } = await allowed("decision-revise");
    const realRename = fs.renameSync;
    let failures = 0;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (failures === 0 && String(to).endsWith("comments.json")) {
        failures++;
        throw Object.assign(new Error("injected EIO"), { code: "EIO" });
      }
      return realRename(from, to);
    });
    expect((await w.call(tool, args)).isError).toBe(true);
    expect(failures).toBe(1);
    const retry = await w.call(tool, args);
    expect(retry.text).toContain("Already admitted");
    expectCompleted("decision-revise", parentId);
  });
});

describe("#470 §13 condition 3 — a completed-operation replay is read-only", () => {
  it("the human rejects the parent between the crash and the replay: the replay leaves it rejected and records why", async () => {
    world = new StanceWorld();
    const { w, tool, args, parentId } = await allowed("decision-revise");
    world.crashAt("after_child_flush");
    expect((await w.call(tool, args)).isError).toBe(true);
    world.store(SID).updateArtifactStatus(parentId!, "rejected", "ui_reject_button");
    const replay = await w.call(tool, args);
    expect(replay.text).toContain("Already admitted");
    expect(replay.text).toContain("was left rejected");
    const store = world.store(SID);
    expect(store.getArtifacts().find((a) => a.id === parentId)!.status).toBe("rejected");
    const child = store.getArtifacts().find((a) => a.admission)!;
    expect(child.admission!.followUps.supersede).toMatchObject({ parentId, skipped: "rejected" });
    expect(child.admission!.completedAt).toBeTruthy();
  });

  it("a follow-up target edited in the stamp to point elsewhere: the replay refuses and touches nothing", async () => {
    world = new StanceWorld();
    const { w, tool, args, parentId } = await allowed("decision-revise");
    const bystander = await w.call("present_options", { context: "Unrelated fork?", title: "Unrelated", options: OPTIONS });
    expect(bystander.isError).toBeFalsy();
    const bystanderId = world.store(SID).getArtifacts().find((a) => a.title === "Unrelated")!.id;
    world.crashAt("after_child_flush");
    expect((await w.call(tool, args)).isError).toBe(true);
    const claim = world.lastClaim();
    await world.restart();
    const file = path.join(sessionDir(), "artifacts.json");
    const arts = JSON.parse(fs.readFileSync(file, "utf8")) as Artifact[];
    const child = arts.find((a) => a.admission)!;
    child.admission!.followUps.supersede!.parentId = bystanderId;
    child.admission!.followUps.comment!.artifactId = bystanderId;
    fs.writeFileSync(file, JSON.stringify(arts));
    const w2 = await world.wrapper(SID); // reconciliation also refuses
    await world.daemon.stanceExceptions.reconcile(SID, world.store(SID));
    const res = await world.operation(SID, claim.operationId, claim.body, registrationTokenOf(w2));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ status: "inconsistent", code: "stance_exception_operation_inconsistent" });
    const store = world.store(SID);
    expect(store.getArtifacts().find((a) => a.id === bystanderId)!.status).toBe("draft");
    expect(store.getArtifacts().find((a) => a.id === parentId)!.status).not.toBe("superseded");
    expect(store.getCommentsForArtifact(bystanderId)).toHaveLength(0);
    expect(store.getArtifacts().find((a) => a.admission)!.admission!.completedAt).toBeUndefined();
  });

  it("replay skips re-authorization: commit, change a dependency, retry → the original result, no refusal", async () => {
    world = new StanceWorld();
    const { w, tool, args, parentId } = await allowed("decision-revise");
    world.drop = (url, init) => url.includes("/operations/") && String(init?.body).includes("\"admission\"");
    expect((await w.call(tool, args)).isError).toBe(true);
    world.store(SID).renameArtifact(parentId!, "Renamed after commit");
    const res = await w.call(tool, args);
    expect(res.text).toContain("Already admitted");
    expect(res.structuredContent).toMatchObject({ replayed: true });
  });
});
