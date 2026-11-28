/** #711 gate 1 review — a pick's ledger approval is published only after the
 * pick is proven on disk. Real FileStores and real files; the "crash" is a
 * store disposed while its resolve's flush is held (it never continues), and
 * a fresh FileStore over the same directory is the restarted process. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { FileStore } from "../../store/file-store.js";
import { ownLockIdentity } from "../../store/file-lock.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";
import { handleCheckFeedback } from "../../mcp/tools/check-feedback.js";
import type { ToolContext } from "../../mcp/tools/types.js";
import { createReviewRoutes } from "../review-routes.js";

const SID = "session_ledger";
const DID = "decision_ledger";
const AID = "artifact_ledger";
const options = ["a", "b"].map((id) => ({
  id, title: id, description: `option ${id}`, pros: [], cons: [],
  effort: "low" as const, risk: "low" as const, recommendation: false,
}));

/** A FileStore whose next forceFlush can be held at its entry (a fake gate,
 *  not a mock: the real flush runs when the gate opens). */
class HeldFlushStore extends FileStore {
  hold?: { entered: () => void; gate: Promise<void> };
  override forceFlush(): void {
    const hold = this.hold;
    if (!hold) return super.forceFlush();
    this.hold = undefined;
    hold.entered();
    return hold.gate.then(() => super.forceFlush()) as unknown as void;
  }
}

function holdNextFlush(store: HeldFlushStore) {
  let entered!: () => void;
  let open!: () => void;
  const reached = new Promise<void>((r) => { entered = r; });
  const gate = new Promise<void>((r) => { open = r; });
  store.hold = { entered, gate };
  return { reached, open };
}

function seed(store: FileStore): void {
  store.createArtifact({ id: AID, type: "decision", title: "Choose", content: { decisionId: DID, context: "Choose", options } });
  store.recordDecisionRequest({ decisionId: DID, artifactId: AID, context: "Choose", options });
  store.forceFlush();
}

function app(store: FileStore) {
  return createReviewRoutes({
    getStore: (sid) => (sid === SID ? store : null),
    log: () => undefined,
    broadcast: () => undefined,
    updateTaskStatus: () => undefined,
  });
}

function pick(store: FileStore, optionId: string) {
  return app(store).request(`/api/decisions/${DID}`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Session-Id": SID },
    body: JSON.stringify({ optionId }),
  });
}

function directCtx(store: FileStore): ToolContext {
  return {
    server: { notification: () => {} },
    store,
    broadcast: () => {},
    port: 4000,
    helpers: {} as ToolContext["helpers"],
    state: { checkFeedbackPollCount: 0, reportedRejectedVerdicts: new Set<string>(), reportedPlanVerdicts: new Set<string>() },
  } as unknown as ToolContext;
}

let fx: GlobalStoreFixture;
beforeEach(() => { fx = withGlobalStore("dp-ledger-settle-"); });
afterEach(() => { fx.dispose(); });

const approvedOnDisk = (): string[] => {
  try {
    return JSON.parse(fs.readFileSync(path.join(fx.dir, ".deeppairing", "preferences.json"), "utf8")).approvedPatterns ?? [];
  } catch { return []; }
};

describe("#711 — ledger approval publishes only after the pick is durable", () => {
  it("a process that stops before the pick's flush leaves no orphan approval; a re-pick records exactly one", async () => {
    const store = fx.track(new HeldFlushStore(fx.dir, SID));
    seed(store);
    const held = holdNextFlush(store);
    const crashed = pick(store, "b");
    void crashed.catch(() => undefined);
    await held.reached;
    // The process stops here: its flush never runs, its finally never runs.
    store.dispose();

    const restarted = fx.track(new FileStore(fx.dir, SID));
    expect(restarted.getDecision(DID)?.response).toBeUndefined();
    expect(approvedOnDisk()).toEqual([]);
    expect(restarted.getSessionMemory().approvedPatterns ?? []).toEqual([]);

    expect((await pick(restarted, "a")).status).toBe(200);
    expect(approvedOnDisk()).toEqual(["Choose: a"]);
  });

  it("a pick saved while the preferences lock is busy survives a restart and is settled exactly once", async () => {
    const store = fx.track(new FileStore(fx.dir, SID));
    seed(store);
    const lock = path.join(fx.dir, ".deeppairing", "preferences.json.lock");
    fs.writeFileSync(lock, JSON.stringify({ ...ownLockIdentity()!, pid: process.ppid, processStartTime: null, createdAt: new Date().toISOString(), nonce: "prefs-holder" }));
    try {
      const res = await pick(store, "b");
      expect(res.status).toBe(200);
    } finally {
      fs.unlinkSync(lock);
    }
    store.dispose(); // the process stops with the approval still owed
    expect(approvedOnDisk()).toEqual([]);

    const restarted = fx.track(new FileStore(fx.dir, SID));
    expect(restarted.getDecision(DID)?.response?.optionId).toBe("b");
    expect(restarted.getDecision(DID)?.ledgerPending).toBe(true); // the durable intent survived
    const result = await handleCheckFeedback(directCtx(restarted), {});
    expect(result.structuredContent).toMatchObject({ decisions: [expect.objectContaining({ decisionId: DID })] });
    expect(approvedOnDisk()).toEqual(["Choose: b"]);
    expect(restarted.getDecision(DID)?.ledgerRecordedAt).toEqual(expect.any(String));
    expect(restarted.getDecision(DID)?.acknowledged).toBe(true);
  });

  it("an early check_feedback sees no unsettled pick and publishes no approval for it", async () => {
    const store = fx.track(new HeldFlushStore(fx.dir, SID));
    seed(store);
    // Something else to deliver, so check_feedback returns immediately.
    store.addComment({ id: "c1", artifactId: AID, content: "Looking now", author: "human" });
    const held = holdNextFlush(store);
    const resolving = pick(store, "b");
    try {
      await held.reached;
      expect(store.getResolvedDecisions()).toEqual([]);
      const early = await handleCheckFeedback(directCtx(store), {});
      expect(early.content[0]?.text).toContain("Looking now");
      expect((early.structuredContent as { decisions?: unknown[] }).decisions ?? []).toEqual([]);
      expect(approvedOnDisk()).toEqual([]);
      expect(store.getDecision(DID)?.acknowledged).toBeFalsy();
    } finally {
      held.open();
    }
    expect((await resolving).status).toBe(200);
    expect(approvedOnDisk()).toEqual(["Choose: b"]);
    const late = await handleCheckFeedback(directCtx(store), {});
    expect(late.structuredContent).toMatchObject({ decisions: [expect.objectContaining({ decisionId: DID })] });
    expect(store.getDecision(DID)?.acknowledged).toBe(true);
    expect(approvedOnDisk()).toEqual(["Choose: b"]);
  });
});
