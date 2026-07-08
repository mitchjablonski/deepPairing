/**
 * U1 — per-session FileStore concurrency: two stores writing the same
 * session must NOT clobber each other's mutations.
 *
 * The architecture review flagged this as the highest silent-data-loss
 * risk: atomic rename protects against torn writes (file is always valid
 * JSON), but it does NOT protect against last-writer-wins. Pre-U1, store A
 * loaded artifacts, added a finding, and flushed; store B did the same in
 * parallel with a different finding — whoever flushed second wrote ONLY
 * its own snapshot to disk, dropping the other's record.
 *
 * The U0.6 deterministic-sessionId fix already collapses intra-daemon races
 * (one daemon process holds exactly one FileStore per session, single-
 * threaded JS = no race). The remaining risk surface is:
 *   - CLI commands (sessions merge/prune/export) reading + rewriting the
 *     JSON files while a daemon is also running.
 *   - Two daemons in a brief startup-race window.
 *   - Test or tooling code that constructs multiple FileStore instances
 *     against the same session directory.
 *
 * U1's defense: before each flush, re-stat each session JSON; if mtime has
 * advanced since we loaded it, re-read and merge the disk records by id
 * before writing. In-memory wins on key collisions (those are the user's
 * latest actions); records the other writer added survive instead of being
 * dropped.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileStore } from "../file-store.js";
import { setGlobalStoreForTests } from "../global-store.js";

let tmpDir: string;
const stores: FileStore[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-concurrent-flush-"));
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
  stores.length = 0;
});

afterEach(() => {
  for (const s of stores) {
    try { s.forceFlush(); } catch {}
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  setGlobalStoreForTests(null);
});

function newStore(sessionId: string): FileStore {
  const s = new FileStore(tmpDir, sessionId);
  stores.push(s);
  return s;
}

describe("FileStore concurrent-flush merge (U1)", () => {
  it("two stores adding distinct artifacts both survive — neither clobbers the other", () => {
    const a = newStore("interleave");
    a.createArtifact({ id: "art_A", type: "research", title: "A's finding", content: {} });
    a.forceFlush();

    // B loads (sees A's artifact), then adds its own. A is still alive in
    // memory and adds another. Both flush. Pre-U1: B's flush dropped art_A2
    // (B never saw it); A's flush dropped art_B1 (A never saw it). Post-U1:
    // both writers' contributions survive via mtime-driven merge.
    const b = newStore("interleave");
    expect(b.getArtifacts().map((x) => x.id)).toEqual(["art_A"]);

    a.createArtifact({ id: "art_A2", type: "plan", title: "A's plan", content: { steps: [] } });
    b.createArtifact({ id: "art_B1", type: "decision", title: "B's decision", content: {} });

    // B flushes first; this writes [art_A, art_B1] to disk.
    b.forceFlush();
    // A flushes next. A's in-memory is [art_A, art_A2]. Disk has [art_A, art_B1].
    // U1 merge: result on disk should be [art_B1, art_A, art_A2] (any order; we assert by set).
    a.forceFlush();

    const final = newStore("interleave-reload");
    // newStore opens a NEW session id, so we need to read the session-1 dir
    // directly to verify final state.
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".deeppairing/sessions/interleave/artifacts.json"), "utf-8"),
    );
    const ids = onDisk.map((x: any) => x.id).sort();
    expect(ids).toEqual(["art_A", "art_A2", "art_B1"]);
    expect(final).toBeDefined(); // keep ref so cleanup tracks it
  });

  it("comment dedup applies even after a merge (no double-count from disk re-read)", () => {
    const a = newStore("comments-merge");
    const c1 = a.addComment({ id: "c1", artifactId: "x", content: "from A", author: "human" });
    expect(c1.id).toBe("c1");
    a.forceFlush();

    const b = newStore("comments-merge");
    // B sees c1 already on disk
    expect(b.getCommentsForArtifact("x")).toHaveLength(1);
    // B adds c2; A adds c3 in parallel
    a.addComment({ id: "c3", artifactId: "x", content: "from A again", author: "human" });
    b.addComment({ id: "c2", artifactId: "x", content: "from B", author: "human" });

    a.forceFlush();
    b.forceFlush();

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".deeppairing/sessions/comments-merge/comments.json"), "utf-8"),
    );
    expect(onDisk.map((c: any) => c.id).sort()).toEqual(["c1", "c2", "c3"]);
  });

  it("when both writers mutate the same record, in-memory wins (latest user action)", () => {
    const a = newStore("conflict-id");
    a.createArtifact({ id: "art_X", type: "research", title: "original", content: {} });
    a.forceFlush();

    const b = newStore("conflict-id");
    // Simulate A approving; B reviewing.
    a.updateArtifactStatus("art_X", "approved", "ui_approve_button");
    b.updateArtifactStatus("art_X", "rejected", "ui_reject_button");

    // A flushes first → disk says approved.
    a.forceFlush();
    // B flushes second → its in-memory `rejected` wins on the same id.
    b.forceFlush();

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".deeppairing/sessions/conflict-id/artifacts.json"), "utf-8"),
    );
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].status).toBe("rejected");
  });

  it("decisions Map merges externally-added entries instead of dropping them", () => {
    const a = newStore("decisions-merge");
    a.recordDecisionRequest({ decisionId: "dec_A", artifactId: "art_a", context: "A?", options: [] });
    a.forceFlush();

    const b = newStore("decisions-merge");
    a.recordDecisionRequest({ decisionId: "dec_A2", artifactId: "art_a2", context: "A2?", options: [] });
    b.recordDecisionRequest({ decisionId: "dec_B", artifactId: "art_b", context: "B?", options: [] });

    b.forceFlush();
    a.forceFlush();

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".deeppairing/sessions/decisions-merge/decisions.json"), "utf-8"),
    );
    const ids = onDisk.map((d: any) => d.decisionId).sort();
    expect(ids).toEqual(["dec_A", "dec_A2", "dec_B"]);
  });

  it("plan-reviews Map merges externally-added entries", () => {
    const a = newStore("plans-merge");
    a.recordPlanReview("plan_A");
    a.forceFlush();

    const b = newStore("plans-merge");
    a.recordPlanReview("plan_A2");
    b.recordPlanReview("plan_B");

    b.forceFlush();
    a.forceFlush();

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".deeppairing/sessions/plans-merge/plan-reviews.json"), "utf-8"),
    );
    const ids = onDisk.map((p: any) => p.artifactId).sort();
    expect(ids).toEqual(["plan_A", "plan_A2", "plan_B"]);
  });

  it("no merge churn when a single store flushes back-to-back (its own writes don't trigger re-read)", () => {
    // Sanity: the mtime watermark uses strict > so the store doesn't merge
    // against its own most-recent write. Two rapid flushes from the same
    // store should produce one final snapshot, not duplicated records.
    const a = newStore("self-flush");
    a.createArtifact({ id: "art_1", type: "research", title: "x", content: {} });
    a.forceFlush();
    a.createArtifact({ id: "art_2", type: "research", title: "y", content: {} });
    a.forceFlush();

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".deeppairing/sessions/self-flush/artifacts.json"), "utf-8"),
    );
    expect(onDisk.map((x: any) => x.id).sort()).toEqual(["art_1", "art_2"]);
  });
});

describe("FileStore debounced-flush teardown race (flake #134)", () => {
  it("a debounced flush racing dir removal is swallowed SILENTLY — no console.error", () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const s = newStore("teardown-race");
      // Mutating schedules a 100ms debounced flush.
      s.createArtifact({ id: "x", type: "research", title: "t", content: {} });
      // The session dir is removed out from under the pending flush (demo
      // eviction / test tmpdir cleanup) BEFORE the timer fires.
      fs.rmSync(tmpDir, { recursive: true, force: true });
      vi.advanceTimersByTime(100); // fire the debounced flush → ENOENT
      // ENOENT is the expected benign race and must NOT log — a stray
      // console.error during teardown trips vitest's rpc-teardown error.
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("dispose() cancels a pending flush so no timer fires against a removed dir", () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const s = newStore("dispose-cancels");
      s.createArtifact({ id: "y", type: "research", title: "t", content: {} });
      expect(vi.getTimerCount()).toBe(1); // the mutation scheduled one flush
      s.dispose(); // cancels the pending flush timer without writing
      // KEY assertion — dispose() actually cleared the timer. This FAILS if
      // dispose() were a no-op (review: the ENOENT-silence alone would
      // otherwise mask that), distinguishing "cancelled" from "fired then
      // swallowed".
      expect(vi.getTimerCount()).toBe(0);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      vi.advanceTimersByTime(100); // nothing scheduled → no-op, no ENOENT
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
