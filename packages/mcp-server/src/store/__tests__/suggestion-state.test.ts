import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FileStore } from "../file-store.js";
import { setGlobalStoreForTests } from "../global-store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * #172 — the suggested-edit state machine at the STORE level (a real FileStore
 * over a tmp dir — fake, not mock). Covers every transition the routes/tool
 * drive, the ledger side-effects, and #193 demo isolation.
 */

let tmpDir: string;
const stores: FileStore[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-sugg-"));
  stores.length = 0;
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
});
afterEach(() => {
  for (const s of stores) s.forceFlush();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  setGlobalStoreForTests(null);
});

function createStore(sessionId: string): FileStore {
  const s = new FileStore(tmpDir, sessionId);
  stores.push(s);
  return s;
}

const baseSuggestion = {
  originalText: "  catch { await sleep(1000); }",
  replacementText: "  catch (err) {\n    if (!isRetryable(err)) throw err;\n  }",
  lineStart: 15,
  lineEnd: 17,
  state: "pending" as const,
};

function addSuggestion(store: FileStore, id: string, content: string) {
  return store.addComment({
    id,
    artifactId: "art_1",
    content,
    author: "human",
    target: { lineStart: 15, lineEnd: 17, filePath: "lib/upload.ts" },
    intent: "suggestion",
    suggestion: baseSuggestion,
  });
}

const prefsPath = () => path.join(tmpDir, ".deeppairing", "preferences.json");

describe("#172 suggestion state machine (store)", () => {
  it("persists the suggestion on addComment", () => {
    const store = createStore("s_persist");
    const c = addSuggestion(store, "cmt_1", "why note");
    expect(c.suggestion?.state).toBe("pending");
    expect(store.getComment("cmt_1")?.suggestion?.replacementText).toContain("isRetryable");
  });

  it("pending → applied stamps the version and records the WHY as a preference", () => {
    const store = createStore("s_apply");
    addSuggestion(store, "cmt_1", "backoff over fixed delay; don't retry client errors");
    const updated = store.updateCommentSuggestion("cmt_1", { state: "applied", appliedInVersion: 2 });
    expect(updated?.suggestion?.state).toBe("applied");
    expect(updated?.suggestion?.appliedInVersion).toBe(2);
    expect(store.getSessionMemory().approvedPatterns).toContain(
      "backoff over fixed delay; don't retry client errors",
    );
  });

  it("pending → applied with NO genuine why records NOTHING (this-edit-only guidance)", () => {
    const store = createStore("s_nowhy");
    // content == the auto summary → not a genuine why.
    addSuggestion(store, "cmt_1", "Suggested edit to lib/upload.ts:15–17");
    store.updateCommentSuggestion("cmt_1", { state: "applied", appliedInVersion: 2 });
    expect(store.getSessionMemory().approvedPatterns).toHaveLength(0);
  });

  it("pending → countered stores the agent's counter (awaiting the human)", () => {
    const store = createStore("s_counter");
    addSuggestion(store, "cmt_1", "why");
    const updated = store.updateCommentSuggestion("cmt_1", {
      state: "countered",
      counter: { reason: "null silently drops the upload", replacementText: "attach cause" },
    });
    expect(updated?.suggestion?.state).toBe("countered");
    expect(updated?.suggestion?.counter?.reason).toMatch(/drops the upload/);
    // Countering does not touch the ledger.
    expect(store.getSessionMemory().approvedPatterns).toHaveLength(0);
  });

  it("countered → take-counter → applied records NOTHING (Claude's version won)", () => {
    const store = createStore("s_take");
    addSuggestion(store, "cmt_1", "a genuine why the human gave");
    store.updateCommentSuggestion("cmt_1", { state: "countered", counter: { reason: "no", replacementText: "x" } });
    // Human takes the counter → applied (counter still present), then agent stamps.
    store.updateCommentSuggestion("cmt_1", { state: "applied", resetAcknowledged: true });
    const applied = store.updateCommentSuggestion("cmt_1", { appliedInVersion: 3 });
    expect(applied?.suggestion?.state).toBe("applied");
    expect(applied?.suggestion?.appliedInVersion).toBe(3);
    expect(store.getSessionMemory().approvedPatterns).toHaveLength(0);
  });

  it("countered → insist → applied records the OVERRIDE with the human's reason", () => {
    const store = createStore("s_insist");
    addSuggestion(store, "cmt_1", "returning early is cleaner here");
    store.updateCommentSuggestion("cmt_1", { state: "countered", counter: { reason: "no", replacementText: "x" } });
    // Human insists → insisted; agent then applies verbatim + stamps the version.
    store.updateCommentSuggestion("cmt_1", { state: "insisted", resetAcknowledged: true });
    const applied = store.updateCommentSuggestion("cmt_1", { appliedInVersion: 4 });
    // State PRESERVED as insisted (the override record), version stamped.
    expect(applied?.suggestion?.state).toBe("insisted");
    expect(applied?.suggestion?.appliedInVersion).toBe(4);
    expect(store.getSessionMemory().approvedPatterns).toContain("returning early is cleaner here");
  });

  it("resetAcknowledged re-queues the comment for check_feedback", () => {
    const store = createStore("s_ack");
    addSuggestion(store, "cmt_1", "why");
    store.acknowledgeComments(["cmt_1"]);
    expect(store.getUnacknowledgedComments().map((c) => c.id)).not.toContain("cmt_1");
    store.updateCommentSuggestion("cmt_1", { state: "insisted", resetAcknowledged: true });
    expect(store.getUnacknowledgedComments().map((c) => c.id)).toContain("cmt_1");
  });

  it("the ledger write fires ONCE — a second stamp does not re-record", () => {
    const store = createStore("s_once");
    addSuggestion(store, "cmt_1", "one durable preference");
    store.updateCommentSuggestion("cmt_1", { state: "applied", appliedInVersion: 2 });
    store.updateCommentSuggestion("cmt_1", { appliedInVersion: 2 }); // idempotent re-stamp
    expect(store.getSessionMemory().approvedPatterns.filter((p) => p === "one durable preference")).toHaveLength(1);
  });

  it("returns undefined for a comment with no suggestion", () => {
    const store = createStore("s_none");
    store.addComment({ id: "plain", artifactId: "art_1", content: "hi", author: "human" });
    expect(store.updateCommentSuggestion("plain", { state: "applied", appliedInVersion: 1 })).toBeUndefined();
  });

  it("#193 DEMO ISOLATION — a demo session records the preference IN MEMORY, never on disk", () => {
    const store = createStore("demo_isolated");
    addSuggestion(store, "cmt_1", "a demo preference that must not persist");
    store.updateCommentSuggestion("cmt_1", { state: "applied", appliedInVersion: 2 });
    store.forceFlush();
    // In-memory reflects it…
    expect(store.getSessionMemory().approvedPatterns).toContain("a demo preference that must not persist");
    // …but the real project preferences.json is never written.
    if (fs.existsSync(prefsPath())) {
      const onDisk = JSON.parse(fs.readFileSync(prefsPath(), "utf8"));
      expect(onDisk.approvedPatterns ?? []).not.toContain("a demo preference that must not persist");
    } else {
      expect(fs.existsSync(prefsPath())).toBe(false);
    }
  });

  it("a NON-demo session DOES persist the preference to disk (control for the isolation test)", () => {
    const store = createStore("s_real");
    addSuggestion(store, "cmt_1", "a real preference that persists");
    store.updateCommentSuggestion("cmt_1", { state: "applied", appliedInVersion: 2 });
    store.forceFlush();
    const onDisk = JSON.parse(fs.readFileSync(prefsPath(), "utf8"));
    expect(onDisk.approvedPatterns).toContain("a real preference that persists");
  });
});
