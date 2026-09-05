import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { FileStore } from "../file-store.js";
import { mergeSessionRecords, withSessionFlushLock } from "../session-records.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";

let fx: GlobalStoreFixture;
beforeEach(() => { fx = withGlobalStore("dp-writer-ownership-"); });
afterEach(() => fx.dispose());
const open = () => fx.track(new FileStore(fx.dir, "shared"));
const file = (name: string) => path.join(fx.dir, ".deeppairing/sessions/shared", name);
function seed() {
  const a = open();
  a.createArtifact({ id: "a", type: "research", title: "original", content: {} });
  a.recordDecisionRequest({ decisionId: "d", artifactId: "a", context: "why", options: [] });
  a.recordPlanReview("a");
  a.forceFlush();
  return a;
}

describe("writer-owned deltas", () => {
  it.each([false, true])("does not combine an approval with concurrently changed content (contentFirst=%s)", (contentFirst) => {
    const seedStore = open();
    seedStore.createArtifact({
      id: "plan",
      type: "plan",
      title: "Review this plan",
      content: { steps: [{ title: "Original step", status: "pending" }], estimatedChanges: 1 },
    });
    seedStore.forceFlush();

    const contentWriter = open();
    const reviewer = open();
    const changed = contentWriter.getArtifacts()[0]!;
    changed.content = {
      steps: [{ title: "Replace the reviewed approach", action: "delete production data", status: "pending" }],
      estimatedChanges: 12,
    };
    changed.version = 2;
    // getArtifacts exposes the live record for historical callers. Rename to
    // schedule this substantive proposal rewrite through the normal writer.
    contentWriter.renameArtifact("plan", changed.title);
    reviewer.updateArtifactStatus("plan", "approved", "ui_approve_button");

    const first = contentFirst ? contentWriter : reviewer;
    const second = contentFirst ? reviewer : contentWriter;
    first.forceFlush();
    expect(() => second.forceFlush()).toThrow(/changed content.*review verdict|review verdict.*changed content/i);
    expect(() => second.getArtifacts()).toThrow(/changed content.*review verdict|review verdict.*changed content/i);
    expect(() => second.getFullState()).toThrow(/changed content.*review verdict|review verdict.*changed content/i);

    const persisted = open().getArtifacts()[0]!;
    expect(persisted.status === "approved" && persisted.version === 2).toBe(false);
  });

  it("allows one writer to change content and then review that same content", () => {
    const writer = open();
    writer.createArtifact({
      id: "plan",
      type: "plan",
      title: "Review this plan",
      content: { steps: [{ title: "Original step", status: "pending" }], estimatedChanges: 1 },
    });
    writer.forceFlush();

    const artifact = writer.getArtifacts()[0]!;
    artifact.content = { steps: [{ title: "Replacement step", status: "pending" }], estimatedChanges: 2 };
    artifact.version = 2;
    writer.renameArtifact("plan", artifact.title);
    writer.updateArtifactStatus("plan", "approved", "ui_approve_button");
    expect(() => writer.forceFlush()).not.toThrow();
    expect(open().getArtifacts()[0]).toMatchObject({ status: "approved", version: 2 });
  });

  it("allows progress updates to an artifact that was already approved in the writer baseline", () => {
    const reviewer = open();
    reviewer.createArtifact({
      id: "plan",
      type: "plan",
      title: "Approved plan",
      content: { steps: [{ title: "Execute", status: "pending" }], estimatedChanges: 1 },
    });
    reviewer.updateArtifactStatus("plan", "approved", "ui_approve_button");
    reviewer.forceFlush();

    const progressWriter = open();
    progressWriter.updatePlanProgress("plan", [{ stepIndex: 0, status: "done" }]);
    expect(() => progressWriter.forceFlush()).not.toThrow();
    expect((open().getArtifacts()[0]!.content as any).steps[0].status).toBe("done");
  });

  it.each([false, true])("unrelated stale comment cannot revert review state (reverse=%s)", (reverse) => {
    const a = seed();
    const b = open();
    a.updateArtifactStatus("a", "approved", "ui_approve_button");
    a.resolveDecision("d", "yes");
    a.acknowledgeDecisions(["d"]);
    a.resolvePlanReview("a", "approved");
    b.addComment({ id: "c", artifactId: "a", content: "hello", author: "human" });
    for (const s of reverse ? [b, a] : [a, b]) s.forceFlush();
    const loaded = open();
    expect(loaded.getArtifacts().find((r) => r.id === "a")?.status).toBe("approved");
    expect(loaded.getDecision("d")?.acknowledged).toBe(true);
    expect(loaded.getDecisionResponse("d")?.optionId).toBe("yes");
    expect(loaded.getPlanReviewVerdict("a")?.verdict).toBe("approved");
    expect(loaded.getCommentsForArtifact("a")).toHaveLength(1);
  });

  it("merges same-file additions and independent fields without restoring stale status", () => {
    const a = seed();
    const b = open();
    a.updateArtifactStatus("a", "superseded", "agent_supersede");
    a.forceFlush();
    b.renameArtifact("a", "renamed");
    b.createArtifact({ id: "b", type: "research", title: "new", content: {} });
    b.forceFlush();
    const loaded = open();
    expect(loaded.getArtifacts().find((r) => r.id === "a")).toMatchObject({ title: "renamed", status: "superseded" });
    expect(loaded.getArtifacts().find((r) => r.id === "b")).toBeDefined();
  });

  it("detects equal-size external writes even with identical mtimes", () => {
    const a = seed();
    const stamp = fs.statSync(file("artifacts.json"));
    const disk = JSON.parse(fs.readFileSync(file("artifacts.json"), "utf8"));
    disk[0].title = "external"; // same length as original
    fs.writeFileSync(file("artifacts.json"), JSON.stringify(disk, null, 2));
    fs.utimesSync(file("artifacts.json"), stamp.atime, stamp.mtime);
    a.createArtifact({ id: "b", type: "research", title: "new", content: {} });
    a.forceFlush();
    expect(open().getArtifacts().find((r) => r.id === "a")?.title).toBe("external");
  });

  it("does not resurrect a removed record even if a stale writer renamed it", () => {
    const a = seed();
    fs.writeFileSync(file("artifacts.json"), "[]");
    a.renameArtifact("a", "stale rename");
    a.forceFlush();
    expect(open().getArtifacts().find((r) => r.id === "a")).toBeUndefined();
  });

  it("merges requests and keeps another writer's served link", () => {
    const a = seed();
    const req = a.addRequest({ text: "first", intent: "explain" });
    a.forceFlush();
    const b = open();
    a.markRequestServed(req.id, "a");
    a.forceFlush();
    const second = b.addRequest({ text: "second", intent: "explain" });
    b.forceFlush();
    const loaded = open();
    expect(loaded.getRequests()).toHaveLength(2);
    expect(loaded.getPendingRequests().map((r) => r.id)).toEqual([second.id]);
  });

  it("clearing the last render failure persists an empty array", () => {
    const a = seed();
    a.recordRenderFailure({ artifactId: "a", visualId: "v", error: "bad" });
    a.forceFlush();
    a.updateArtifactStatus("a", "superseded", "agent_supersede");
    a.forceFlush();
    a.createArtifact({ id: "a2", parentId: "a", type: "research", title: "revised", content: {} });
    a.forceFlush();
    expect(open().getUnacknowledgedRenderFailures()).toEqual([]);
  });

  it("failed writes retain the local delta for retry", () => {
    const a = seed();
    a.renameArtifact("a", "retry");
    const saved = fs.readFileSync(file("artifacts.json"), "utf8");
    fs.writeFileSync(file("artifacts.json"), "broken json");
    expect(() => a.forceFlush()).toThrow();
    expect(fs.existsSync(file(".flush.lock"))).toBe(false);
    fs.writeFileSync(file("artifacts.json"), saved);
    a.forceFlush();
    expect(open().getArtifacts().find((r) => r.id === "a")?.title).toBe("retry");
  });

  it("a disposed store cannot write into a replacement session directory", () => {
    const stale = open();
    stale.createArtifact({ id: "stale", type: "research", title: "Stale", content: {} });
    stale.dispose();
    const sessionDir = path.dirname(file("artifacts.json"));
    fs.rmSync(sessionDir, { recursive: true });

    const replacement = open();
    replacement.createArtifact({ id: "fresh", type: "research", title: "Fresh", content: {} });
    replacement.forceFlush();

    expect(() => stale.forceFlush()).toThrow(/disposed/i);
    expect(open().getArtifacts().map((artifact) => artifact.id)).toEqual(["fresh"]);
  });

  it.each([false, true])("preserves concurrent status audit entries (reverse=%s)", (reverse) => {
    const a = seed();
    const b = open();
    a.updateArtifactStatus("a", "approved", "ui_approve_button");
    b.updateArtifactStatus("a", "superseded", "agent_supersede");
    for (const s of reverse ? [b, a] : [a, b]) s.forceFlush();
    const artifact = open().getArtifacts()[0];
    expect(artifact.statusHistory?.map((r) => r.status)).toEqual(reverse
      ? ["draft", "superseded", "approved"] : ["draft", "approved", "superseded"]);
  });

  it("retries a contended final mutation without waiting for another mutation", () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const a = seed();
      a.renameArtifact("a", "eventual");
      fs.writeFileSync(file(".flush.lock"), "held");
      vi.advanceTimersByTime(100);
      expect(JSON.parse(fs.readFileSync(file("artifacts.json"), "utf8"))[0].title).toBe("original");
      fs.unlinkSync(file(".flush.lock"));
      vi.advanceTimersByTime(200);
      expect(open().getArtifacts()[0].title).toBe("eventual");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      errors.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("merge and lock contract", () => {
  it("preserves independent nested changes and uses last-flush for a conflicting field", () => {
    const base = [{ id: "a", content: { left: 1, right: 1 }, status: "draft" }];
    const local = [{ id: "a", content: { left: 2, right: 1 }, status: "rejected" }];
    const disk = [{ id: "a", content: { left: 1, right: 3 }, status: "approved" }];
    expect(mergeSessionRecords(base, local, disk, (r) => r.id)).toEqual([
      { id: "a", content: { left: 2, right: 3 }, status: "rejected" },
    ]);
  });

  it("does not permit prototype keys to change object prototypes", () => {
    const base = [{ id: "a", content: {} }];
    const local = JSON.parse('[{"id":"a","content":{"__proto__":{"polluted":true}}}]');
    const result = mergeSessionRecords(base, local, base, (r) => r.id);
    expect(Object.getPrototypeOf(result[0].content)).toBe(Object.prototype);
    expect(Object.hasOwn(result[0].content, "__proto__")).toBe(true);
  });

  it("defines field deletions: unchanged local deletion stays deleted; a conflicting local edit wins", () => {
    const base = [{ id: "a", content: { x: 1, y: 1 } }];
    const local = [{ id: "a", content: { x: 2, y: 1 } }];
    const disk = [{ id: "a", content: {} }];
    expect(mergeSessionRecords(base, local, disk, (r) => r.id)).toEqual([
      { id: "a", content: { x: 2 } },
    ]);
  });

  it("a held lock times out without running an unlocked write or breaking the owner", () => {
    seed();
    fs.writeFileSync(file(".flush.lock"), "another owner");
    expect(() => withSessionFlushLock(file(".flush.lock"), () => { throw new Error("entered"); })).toThrow("Session flush lock busy");
    expect(fs.readFileSync(file(".flush.lock"), "utf8")).toBe("another owner");
    fs.unlinkSync(file(".flush.lock"));
  });

  it("non-contention filesystem failures throw immediately and release on callback failure", () => {
    expect(() => withSessionFlushLock(path.join(fx.dir, "missing/lock"), () => 1)).toThrow();
    const lock = path.join(fx.dir, "lock");
    expect(() => withSessionFlushLock(lock, () => { throw new Error("original"); })).toThrow("original");
    expect(fs.existsSync(lock)).toBe(false);
    expect(withSessionFlushLock(lock, () => 42)).toBe(42);
  });

  it("cleanup failure does not mask the original callback error", () => {
    const lock = path.join(fx.dir, "removed-lock");
    expect(() => withSessionFlushLock(lock, () => {
      fs.unlinkSync(lock); // simulate an external cleanup racing this writer
      throw new Error("primary error");
    })).toThrow("primary error");
    expect(() => withSessionFlushLock(lock, () => fs.unlinkSync(lock))).toThrow();
  });
});
