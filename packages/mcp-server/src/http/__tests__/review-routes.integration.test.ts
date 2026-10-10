/** #433 integration: the extracted transport keeps main's #484/#491/#493
 * atomicity, persistence/settlement and closed-card contracts. Real stores and
 * real filesystem faults; no mocked persistence or independently copied handler. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { FileStore } from "../../store/file-store.js";
import { ownLockIdentity } from "../../store/file-lock.js";
import { withGlobalStore } from "../../__tests__/global-store-fixture.js";
import { createReviewRoutes } from "../review-routes.js";
import { createHttpRoutes } from "../routes.js";
import { withHash } from "./routes.harness.js";

const SID = "session_boundary";
const DID = "decision_boundary";
const AID = "artifact_boundary";
const options = ["a", "b"].map(id => ({
  id, title: id, description: "d", pros: [], cons: [],
  effort: "low" as const, risk: "low" as const, recommendation: false,
}));
class SettlingStore extends FileStore {
  settlements: boolean[] = [];
  override settleResolution(decisionId: string, committed: boolean): void {
    this.settlements.push(committed);
    return super.settleResolution(decisionId, committed);
  }
}
function seed(store: FileStore): void {
  store.createArtifact({ id: AID, type: "decision", title: "Choose", content: { decisionId: DID, context: "Choose", options } });
  store.recordDecisionRequest({ decisionId: DID, artifactId: AID, context: "Choose", options });
  store.forceFlush();
}
function request(optionId: string, reasoning = optionId) {
  return { method: "POST", headers: { "content-type": "application/json", "X-Session-Id": SID }, body: JSON.stringify({ optionId, reasoning }) };
}
function diskResponse(root: string): { optionId: string; reasoning?: string } | null {
  const rows = JSON.parse(fs.readFileSync(path.join(root, ".deeppairing", "sessions", SID, "decisions.json"), "utf8")) as Array<{ decisionId: string; response?: { optionId: string; reasoning?: string } }>;
  return rows.find(row => row.decisionId === DID)?.response ?? null;
}

describe("review boundary — current-main integration", () => {
  it("concurrent picks commit one winner, announce once AFTER disk/task callback, and make retries no-ops", async () => {
    const fx = withGlobalStore("dp-boundary-atomic-");
    const store = fx.track(new SettlingStore(fx.dir, SID));
    const events: Array<{ event: Record<string, unknown>; sid?: string }> = [];
    const order: string[] = [];
    let taskCalls = 0;
    seed(store);
    const app = createReviewRoutes({
      getStore: sid => sid === SID ? store : null,
      log: () => undefined,
      broadcast: (event, sid) => {
        const value = event as Record<string, unknown>;
        events.push({ event: value, sid }); order.push(String(value.type));
      },
      updateTaskStatus: (artifactId, selected) => {
        expect(selected).toBe(store); expect(artifactId).toBe(AID);
        expect(diskResponse(fx.dir)?.optionId).toBe(store.getDecisionResponse(DID)?.optionId);
        taskCalls++; order.push("task");
      },
    });
    try {
      const responses = await Promise.all([app.request(`/api/decisions/${DID}`, request("a")), app.request(`/api/decisions/${DID}`, request("b"))]);
      expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
      const winner = responses[0].status === 200 ? "a" : "b";
      const loser = responses.find(r => r.status === 409)!;
      expect(await loser.json()).toMatchObject({ code: "verdict_already_final", resolution: { optionId: winner } });
      expect(diskResponse(fx.dir)).toMatchObject({ optionId: winner, reasoning: winner });
      expect(store.settlements).toEqual([true]);
      expect(taskCalls).toBe(1);
      expect(order).toEqual(["task", "decision_resolved", "artifact_updated"]);
      expect(events.every(e => e.sid === SID)).toBe(true);
      expect(events.filter(e => e.event.type === "decision_resolved")).toHaveLength(1);
      const before = store.getDecision(DID)?.resolvedAt;
      const retry = await app.request(`/api/decisions/${DID}`, request(winner, "do not replace"));
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({ alreadyResolved: true });
      expect(store.getDecision(DID)?.resolvedAt).toBe(before);
      expect(diskResponse(fx.dir)?.reasoning).toBe(winner);
      expect(taskCalls).toBe(1); expect(events).toHaveLength(2);
    } finally { fx.dispose(); }
  });

  it("mounted flush-lock refusal is 503, rolls back, emits nothing; a different retry commits once", async () => {
    const fx = withGlobalStore("dp-boundary-rollback-");
    const store = fx.track(new SettlingStore(fx.dir, SID));
    const events: Array<Record<string, unknown>> = [];
    seed(store);
    const app = withHash(createHttpRoutes(store, fx.dir, event => events.push(event as Record<string, unknown>)), fx.dir);
    const lock = path.join(fx.dir, ".deeppairing", "sessions", SID, ".flush.lock");
    fs.writeFileSync(lock, JSON.stringify({ ...ownLockIdentity()!, pid: process.ppid, processStartTime: null, createdAt: new Date().toISOString(), nonce: "boundary-holder" }));
    try {
      const failed = await app.request(`/api/decisions/${DID}`, request("a"));
      expect(failed.status).toBe(503);
      expect(await failed.json()).toMatchObject({ code: "lock_busy" });
      expect(store.settlements).toEqual([false]);
      expect(store.getDecisionResponse(DID)).toBeNull(); expect(diskResponse(fx.dir)).toBeNull();
      expect(store.getArtifacts().find(a => a.id === AID)?.status).toBe("draft");
      expect(events).toEqual([]);
      fs.unlinkSync(lock);
      expect((await app.request(`/api/decisions/${DID}`, request("b"))).status).toBe(200);
      expect(store.settlements).toEqual([false, true]);
      expect(diskResponse(fx.dir)?.optionId).toBe("b");
      expect(events.filter(e => e.type === "decision_resolved")).toHaveLength(1);
    } finally { try { fs.unlinkSync(lock); } catch { /* released */ } fx.dispose(); }
  });

  it("a later-collection fault after the answer lands commits, invokes the selected callback, and announces only once", async () => {
    const fx = withGlobalStore("dp-boundary-partial-");
    const store = fx.track(new SettlingStore(fx.dir, SID));
    const events: Array<Record<string, unknown>> = [];
    let taskCalls = 0;
    seed(store);
    const broken = path.join(fx.dir, ".deeppairing", "sessions", SID, "plan-reviews.json");
    fs.mkdirSync(broken); store.recordPlanReview("other_plan");
    const app = createReviewRoutes({
      getStore: () => store, log: () => undefined,
      broadcast: event => events.push(event as Record<string, unknown>),
      updateTaskStatus: (_id, selected) => { expect(selected).toBe(store); expect(diskResponse(fx.dir)?.optionId).toBe("a"); taskCalls++; },
    });
    try {
      expect((await app.request(`/api/decisions/${DID}`, request("a"))).status).toBe(200);
      expect(store.settlements).toEqual([true]); expect(taskCalls).toBe(1);
      expect(diskResponse(fx.dir)?.optionId).toBe("a");
      expect(events.filter(e => e.type === "decision_resolved")).toHaveLength(1);
      fs.rmdirSync(broken);
      expect((await app.request(`/api/decisions/${DID}`, request("a"))).status).toBe(200);
      expect(taskCalls).toBe(1); expect(events).toHaveLength(1);
    } finally { fx.dispose(); }
  });

  it("a closed card refuses even an invalid option without writes, settlement, callback or refresh/success events", async () => {
    const fx = withGlobalStore("dp-boundary-closed-");
    const store = fx.track(new SettlingStore(fx.dir, SID));
    const events: unknown[] = [];
    let taskCalls = 0;
    seed(store); store.updateArtifactStatus(AID, "obsolete", "ui_dismiss_obsolete"); store.forceFlush();
    const decisions = path.join(fx.dir, ".deeppairing", "sessions", SID, "decisions.json");
    const before = fs.readFileSync(decisions, "utf8");
    const app = createReviewRoutes({ getStore: () => store, log: () => undefined, broadcast: event => events.push(event), updateTaskStatus: () => { taskCalls++; } });
    try {
      const response = await app.request(`/api/decisions/${DID}`, request("not-an-option"));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "decision_closed", currentStatus: "obsolete" });
      expect(store.getDecisionResponse(DID)).toBeNull(); expect(fs.readFileSync(decisions, "utf8")).toBe(before);
      expect(store.settlements).toEqual([]); expect(taskCalls).toBe(0); expect(events).toEqual([]);
    } finally { fx.dispose(); }
  });
});
