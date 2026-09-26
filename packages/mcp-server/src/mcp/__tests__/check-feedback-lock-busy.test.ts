/**
 * #408 review — check_feedback must never ack a decision whose ledger writes
 * failed. Pre-fix it acked every resolved decision FIRST, then recorded; a
 * busy preferences lock (ELOCKED) failed the tool after the ack, so the pick
 * vanished from every later check_feedback and the unchosen options'
 * rejections were never written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { FileStore } from "../../store/file-store.js";
import { setupServerTest, makeCallTool } from "./server-test-harness.js";
import { ownLockIdentity } from "../../store/file-lock.js";

const ctx = setupServerTest();
const callTool = makeCallTool(ctx);
let store: FileStore;
beforeEach(() => {
  store = ctx.store;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

const OPTIONS = [
  { id: "a", title: "Redis", description: "network cache", pros: ["fast"], cons: ["ops"], effort: "medium", risk: "medium", recommendation: true, concept: { name: "redis cache" } },
  { id: "b", title: "In-process LRU", description: "heap cache", pros: ["simple"], cons: ["cold"], effort: "low", risk: "low", recommendation: false, concept: { name: "lru cache" } },
];

describe("check_feedback under a busy preferences lock", () => {
  it("leaves the decision un-acked and re-delivers it once the lock clears", async () => {
    await callTool("present_options", { context: "Which cache backend?", title: "Cache backend", options: OPTIONS });
    const dec = store.getPendingDecisions()[0]!;
    store.resolveDecision(dec.decisionId, "a", "we already run redis");

    const lock = path.join(ctx.tmpDir, ".deeppairing", "preferences.json.lock");
    fs.writeFileSync(lock, JSON.stringify({ ...ownLockIdentity()!, pid: process.ppid, processStartTime: null, createdAt: new Date().toISOString(), nonce: "live" }));
    let first;
    try {
      first = await callTool("check_feedback");
    } finally {
      fs.unlinkSync(lock);
    }
    expect(first.isError).toBeFalsy();
    expect(first.text).toContain("deferred");
    expect(first.text).not.toContain(`- Decision "Cache backend": selected "Redis"`);
    // Still un-acked: the next call gets it again.
    expect(store.getResolvedDecisions().map((d) => d.decisionId)).toEqual([dec.decisionId]);
    expect(store.getSessionMemory().approvedPatterns).toEqual([]);

    const second = await callTool("check_feedback");
    expect(second.text).toContain(`- Decision "Cache backend": selected "Redis"`);
    expect(store.getResolvedDecisions()).toEqual([]);
    const memory = store.getSessionMemory();
    expect(memory.approvedPatterns).toEqual(["Cache backend: Redis"]);
    expect(memory.rejectedApproaches.map((r) => r.description)).toEqual(["Cache backend: In-process LRU"]);
  });
});
