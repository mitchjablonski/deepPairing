import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DecisionOption } from "@deeppairing/shared";
import { FileStore } from "../file-store.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-decisions-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const OPTS: DecisionOption[] = [
  { id: "o1", title: "Redis", description: "external cache", pros: ["fast"], cons: ["ops"], effort: "low", risk: "low", recommendation: true },
  { id: "o2", title: "In-proc", description: "in memory", pros: ["simple"], cons: ["cold"], effort: "low", risk: "low", recommendation: false },
];

/** Seed a session (via the REAL FileStore) with a decision artifact + a decision
 *  record, optionally resolved. Fakes-not-mocks: real store, real filesystem. */
function seedDecision(
  sessionId: string,
  opts: {
    decisionId: string;
    artifactId: string;
    context: string;
    title?: string;
    stakes?: "low" | "medium" | "high";
    resolveWith?: { optionId: string; reasoning?: string };
  },
): FileStore {
  const store = new FileStore(tmpDir, sessionId);
  store.createArtifact({
    id: opts.artifactId,
    type: "decision",
    title: opts.title ?? opts.context,
    content: { decisionId: opts.decisionId, context: opts.context, options: OPTS },
  });
  store.recordDecisionRequest({
    decisionId: opts.decisionId,
    artifactId: opts.artifactId,
    context: opts.context,
    options: OPTS,
    stakes: opts.stakes,
  });
  if (opts.resolveWith) {
    store.resolveDecision(opts.decisionId, opts.resolveWith.optionId, opts.resolveWith.reasoning);
  }
  store.forceFlush();
  return store;
}

describe("FileStore.listAllDecisions", () => {
  it("returns the empty shape when no sessions dir exists", () => {
    const result = FileStore.listAllDecisions(tmpDir);
    expect(result).toEqual({ decisions: [], failedSessions: [] });
  });

  it("flattens decisions across every session, newest-first", () => {
    seedDecision("s1", {
      decisionId: "d1", artifactId: "a1", context: "Which cache?",
      resolveWith: { optionId: "o1", reasoning: "lowest latency" },
    });
    seedDecision("s2", {
      decisionId: "d2", artifactId: "a2", context: "Which queue?",
      resolveWith: { optionId: "o2", reasoning: "already deployed" },
    });

    const { decisions, failedSessions } = FileStore.listAllDecisions(tmpDir);
    expect(failedSessions).toEqual([]);
    expect(decisions).toHaveLength(2);
    // Both sessions represented.
    expect(decisions.map((d) => d.sessionId).sort()).toEqual(["s1", "s2"]);
    // Newest-first: d2 was resolved after d1.
    expect(decisions[0].resolvedAt! >= decisions[1].resolvedAt!).toBe(true);

    const d1 = decisions.find((d) => d.decisionId === "d1")!;
    expect(d1.resolved).toBe(true);
    expect(d1.chosenOptionId).toBe("o1");
    expect(d1.chosenOptionTitle).toBe("Redis");
    expect(d1.reasoning).toBe("lowest latency");
    expect(d1.context).toBe("Which cache?");
    expect(d1.optionCount).toBe(2);
  });

  it("marks an unresolved decision as such (no chosen option)", () => {
    seedDecision("s1", { decisionId: "d1", artifactId: "a1", context: "Pending choice" });
    const { decisions } = FileStore.listAllDecisions(tmpDir);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].resolved).toBe(false);
    expect(decisions[0].chosenOptionId).toBeUndefined();
    expect(decisions[0].chosenOptionTitle).toBeUndefined();
  });

  it("resolves a superseded decision artifact to its live successor's title", () => {
    const store = seedDecision("s1", {
      decisionId: "d1", artifactId: "a1", context: "Which cache?", title: "Cache decision v1",
      resolveWith: { optionId: "o1" },
    });
    // Supersede a1 with a2 (parentId=a1), then mark a1 superseded — the exact
    // chain the web store's resolveToLiveId walks.
    store.createArtifact({
      id: "a2", type: "decision", title: "Cache decision v2",
      content: { decisionId: "d1" }, parentId: "a1", version: 2,
    });
    store.updateArtifactStatus("a1", "superseded", "agent_supersede");
    store.forceFlush();

    const { decisions } = FileStore.listAllDecisions(tmpDir);
    const d1 = decisions.find((d) => d.decisionId === "d1")!;
    // The decision still appears (never vanishes) and points at a sensible title.
    expect(d1).toBeDefined();
    expect(d1.artifactMissing).toBe(false);
    expect(d1.artifactTitle).toBe("Cache decision v2");
    // Nav target stays the record's artifactId; the web selectArtifact resolves
    // it to the live successor.
    expect(d1.artifactId).toBe("a1");
  });

  it("still lists other sessions AND reports the failure when one decisions.json is corrupt", () => {
    // A healthy session.
    seedDecision("s_good", {
      decisionId: "d_good", artifactId: "a_good", context: "Healthy decision",
      resolveWith: { optionId: "o1" },
    });
    // A session whose decisions.json is unparseable garbage.
    const badDir = path.join(tmpDir, ".deeppairing", "sessions", "s_bad");
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, "artifacts.json"), JSON.stringify([
      { id: "a_bad", type: "decision", title: "Bad", status: "draft", createdAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z" },
    ]));
    const badDecPath = path.join(badDir, "decisions.json");
    fs.writeFileSync(badDecPath, "{ this is not valid json ]");

    // Silence the expected salvage/parse console.error noise.
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { decisions, failedSessions } = FileStore.listAllDecisions(tmpDir);
    // The good session's decision is still present — never silently truncated.
    expect(decisions.map((d) => d.decisionId)).toContain("d_good");
    // The bad session is REPORTED, not dropped in silence.
    expect(failedSessions).toHaveLength(1);
    expect(failedSessions[0].sessionId).toBe("s_bad");
    // A .corrupt backup was written (the salvage pattern).
    expect(fs.existsSync(badDecPath + ".corrupt")).toBe(true);
  });

  it("salvages malformed ELEMENTS inside a parseable array without failing the session", () => {
    seedDecision("s1", {
      decisionId: "d_ok", artifactId: "a1", context: "Good one",
      resolveWith: { optionId: "o1" },
    });
    // Inject a null element alongside the good record — salvageArray drops it.
    const decPath = path.join(tmpDir, ".deeppairing", "sessions", "s1", "decisions.json");
    const arr = JSON.parse(fs.readFileSync(decPath, "utf-8"));
    arr.push(null);
    arr.push({ notADecision: true }); // missing decisionId → dropped
    fs.writeFileSync(decPath, JSON.stringify(arr));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { decisions, failedSessions } = FileStore.listAllDecisions(tmpDir);
    // A parseable-but-partially-bad file is NOT a whole-session failure.
    expect(failedSessions).toEqual([]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decisionId).toBe("d_ok");
  });

  it("ignores sessions that never recorded a decision", () => {
    // A session with only an artifact, no decisions.json.
    const store = new FileStore(tmpDir, "s_noda");
    store.createArtifact({ id: "a1", type: "research", title: "Audit", content: {} });
    store.forceFlush();

    const { decisions, failedSessions } = FileStore.listAllDecisions(tmpDir);
    expect(decisions).toEqual([]);
    expect(failedSessions).toEqual([]);
  });

  // Fix 1 — salvageArray only guarantees a string decisionId, NOT createdAt. A
  // dateless-but-salvage-passing record used to reach the sort and throw
  // `(undefined ?? undefined).localeCompare(...)`, escaping the per-session
  // try/catch and 500ing the whole view.
  it("does not throw on a dateless (salvage-passing) record, and sorts it last", () => {
    seedDecision("s1", {
      decisionId: "d_dated", artifactId: "a1", context: "Dated",
      resolveWith: { optionId: "o1" },
    });
    // A record with a string decisionId (passes salvage) but NO createdAt/resolvedAt.
    const decPath = path.join(tmpDir, ".deeppairing", "sessions", "s1", "decisions.json");
    const arr = JSON.parse(fs.readFileSync(decPath, "utf-8"));
    arr.push({ decisionId: "d_dateless", artifactId: "a1", context: "Dateless", options: OPTS });
    fs.writeFileSync(decPath, JSON.stringify(arr));
    vi.spyOn(console, "error").mockImplementation(() => {});

    let result: ReturnType<typeof FileStore.listAllDecisions> | undefined;
    expect(() => { result = FileStore.listAllDecisions(tmpDir); }).not.toThrow();
    const ids = result!.decisions.map((d) => d.decisionId);
    // Both survive — the dateless one is never dropped...
    expect(ids).toContain("d_dated");
    expect(ids).toContain("d_dateless");
    // ...but an unknown date is NOT "newest" — it sorts to the bottom.
    expect(ids[ids.length - 1]).toBe("d_dateless");
    expect(result!.failedSessions).toEqual([]);
  });

  // Fix 2 — a valid-JSON-but-not-an-array decisions.json is unusable; it must
  // be REPORTED, not silently dropped (decRecords.length===0 can't tell it from
  // a legitimately empty []).
  it("reports a non-array decisions.json in failedSessions (not silently dropped)", () => {
    seedDecision("s_good", {
      decisionId: "d_good", artifactId: "a1", context: "Good",
      resolveWith: { optionId: "o1" },
    });
    const badDir = path.join(tmpDir, ".deeppairing", "sessions", "s_obj");
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, "decisions.json"), JSON.stringify({ decisionId: "x" }));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { decisions, failedSessions } = FileStore.listAllDecisions(tmpDir);
    expect(decisions.map((d) => d.decisionId)).toContain("d_good");
    expect(failedSessions.map((f) => f.sessionId)).toContain("s_obj");
  });

  it("reports an all-elements-malformed decisions.json in failedSessions", () => {
    const badDir = path.join(tmpDir, ".deeppairing", "sessions", "s_garbage");
    fs.mkdirSync(badDir, { recursive: true });
    // Valid JSON array, but every element fails salvage (no string decisionId).
    fs.writeFileSync(path.join(badDir, "decisions.json"), JSON.stringify([null, { notADecision: true }]));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { failedSessions } = FileStore.listAllDecisions(tmpDir);
    expect(failedSessions.map((f) => f.sessionId)).toContain("s_garbage");
  });

  it("stays silent for a legitimately empty decisions array (no false failure)", () => {
    const dir = path.join(tmpDir, ".deeppairing", "sessions", "s_empty");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "decisions.json"), "[]");

    const { decisions, failedSessions } = FileStore.listAllDecisions(tmpDir);
    expect(decisions).toEqual([]);
    expect(failedSessions).toEqual([]);
  });

  // #151 — the flush-lag hole: a decision recorded/resolved moments ago lives
  // only in the session's in-memory FileStore until the debounced flush lands.
  // The disk-only scan missed it; the live merge must not.
  describe("live-session merge (#151)", () => {
    /** Snapshot a real FileStore's in-memory state as a LiveDecisionSource. */
    const liveSourceOf = (store: FileStore) => {
      const state = store.getFullState();
      return { sessionId: state.sessionId, decisions: state.decisions, artifacts: state.artifacts };
    };

    it("includes a decision recorded+resolved in a live store BEFORE any flush lands", () => {
      // Real store, real filesystem — but the debounced flush never fires:
      // everything below is synchronous, so the 100ms timer can't run.
      const store = new FileStore(tmpDir, "s_live");
      store.createArtifact({ id: "a1", type: "decision", title: "Which cache?", content: {} });
      store.recordDecisionRequest({ decisionId: "d_live", artifactId: "a1", context: "Which cache?", options: OPTS });
      store.resolveDecision("d_live", "o1", "lowest latency");
      // Deliberately NO forceFlush — decisions.json on disk is still absent.
      expect(fs.existsSync(path.join(tmpDir, ".deeppairing", "sessions", "s_live", "decisions.json"))).toBe(false);

      const { decisions, failedSessions } = FileStore.listAllDecisions(tmpDir, [liveSourceOf(store)]);
      expect(failedSessions).toEqual([]);
      expect(decisions).toHaveLength(1);
      expect(decisions[0].decisionId).toBe("d_live");
      expect(decisions[0].resolved).toBe(true);
      expect(decisions[0].chosenOptionTitle).toBe("Redis");
      expect(decisions[0].reasoning).toBe("lowest latency");
      // Title enrichment comes from the live artifacts too.
      expect(decisions[0].artifactTitle).toBe("Which cache?");
      store.dispose(); // discard the pending debounced flush (tmpDir is removed in afterEach)
    });

    it("does NOT duplicate a session that exists on disk AND live — live wins by sessionId", () => {
      // Flushed (on disk) as unresolved…
      const store = seedDecision("s_both", { decisionId: "d_both", artifactId: "a1", context: "Which queue?" });
      // …then resolved in memory only (no flush): the seam where a naive
      // disk+live concat would produce two rows (one stale, one fresh).
      store.resolveDecision("d_both", "o2", "already deployed");

      const { decisions } = FileStore.listAllDecisions(tmpDir, [liveSourceOf(store)]);
      const rows = decisions.filter((d) => d.decisionId === "d_both");
      expect(rows).toHaveLength(1);
      // And the surviving row is the LIVE one (resolved), not the stale disk one.
      expect(rows[0].resolved).toBe(true);
      expect(rows[0].chosenOptionTitle).toBe("In-proc");
      store.dispose();
    });

    it("still lists a dead session from disk when only OTHER sessions are live", () => {
      seedDecision("s_dead", {
        decisionId: "d_dead", artifactId: "a1", context: "Old decision",
        resolveWith: { optionId: "o1" },
      });
      const liveStore = new FileStore(tmpDir, "s_live2");
      liveStore.createArtifact({ id: "a2", type: "decision", title: "New", content: {} });
      liveStore.recordDecisionRequest({ decisionId: "d_new", artifactId: "a2", context: "New", options: OPTS });

      const { decisions } = FileStore.listAllDecisions(tmpDir, [liveSourceOf(liveStore)]);
      expect(decisions.map((d) => d.decisionId).sort()).toEqual(["d_dead", "d_new"]);
      liveStore.dispose();
    });
  });

  // #153 — session re-open must not silently close the honest-partial window:
  // FileStore's fall-back-and-rewrite leaves a VALID decisions.json whose
  // pre-corruption decisions survive only in the .corrupt sidecar.
  describe("recovered-corruption sidecar reporting (#153)", () => {
    it("STILL reports the session after a re-open rewrote a fresh valid decisions.json", () => {
      // 1. Corrupt decisions.json → scan reports it + writes the sidecar (honest).
      const dir = path.join(tmpDir, ".deeppairing", "sessions", "s_reopen");
      fs.mkdirSync(dir, { recursive: true });
      const decPath = path.join(dir, "decisions.json");
      fs.writeFileSync(decPath, "{ not valid json ]");
      vi.spyOn(console, "error").mockImplementation(() => {});

      const before = FileStore.listAllDecisions(tmpDir);
      expect(before.failedSessions.map((f) => f.sessionId)).toEqual(["s_reopen"]);
      expect(fs.existsSync(decPath + ".corrupt")).toBe(true);

      // 2. Session re-opened by a live FileStore (daemon restart): loadJsonFile
      // falls back to [] and the next flush rewrites a fresh VALID file with
      // only new records.
      const store = new FileStore(tmpDir, "s_reopen");
      store.createArtifact({ id: "a1", type: "decision", title: "Post-recovery", content: {} });
      store.recordDecisionRequest({ decisionId: "d_after", artifactId: "a1", context: "Post-recovery", options: OPTS });
      store.resolveDecision("d_after", "o1");
      store.forceFlush();
      expect(JSON.parse(fs.readFileSync(decPath, "utf-8"))).toHaveLength(1); // file parses fine now

      // 3. The view must keep telling the truth: the session stays in
      // failedSessions (distinct "recovered" reason), new decisions list, no dup rows.
      const after = FileStore.listAllDecisions(tmpDir);
      expect(after.decisions.map((d) => d.decisionId)).toEqual(["d_after"]);
      const failed = after.failedSessions.filter((f) => f.sessionId === "s_reopen");
      expect(failed).toHaveLength(1);
      expect(failed[0].kind).toBe("recovered");
      expect(failed[0].reason).toMatch(/recovered from corruption/);
      expect(failed[0].reason).toMatch(/\.corrupt/);
    });

    it("does not double-report a session that is corrupt RIGHT NOW (sidecar dedupe)", () => {
      const dir = path.join(tmpDir, ".deeppairing", "sessions", "s_still_bad");
      fs.mkdirSync(dir, { recursive: true });
      const decPath = path.join(dir, "decisions.json");
      fs.writeFileSync(decPath, "not json ]");
      vi.spyOn(console, "error").mockImplementation(() => {});

      // First scan writes the sidecar; second scan sees BOTH the parse failure
      // and the sidecar — one row, the live parse failure.
      FileStore.listAllDecisions(tmpDir);
      const { failedSessions } = FileStore.listAllDecisions(tmpDir);
      expect(failedSessions).toHaveLength(1);
      expect(failedSessions[0].sessionId).toBe("s_still_bad");
      expect(failedSessions[0].kind).toBe("unreadable");
    });

    it("reports the sidecar for a LIVE session too (re-open is exactly the live case)", () => {
      const dir = path.join(tmpDir, ".deeppairing", "sessions", "s_live_recovered");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "decisions.json") + ".corrupt", "old corrupt bytes");
      const store = new FileStore(tmpDir, "s_live_recovered");
      store.recordDecisionRequest({ decisionId: "d1", artifactId: "a1", context: "Fresh", options: OPTS });

      const state = store.getFullState();
      const { decisions, failedSessions } = FileStore.listAllDecisions(tmpDir, [
        { sessionId: "s_live_recovered", decisions: state.decisions, artifacts: state.artifacts },
      ]);
      expect(decisions.map((d) => d.decisionId)).toEqual(["d1"]);
      expect(failedSessions.map((f) => f.kind)).toEqual(["recovered"]);
      store.dispose();
    });
  });

  // #153 (S5) — a decision whose artifact was superseded while unresolved can
  // never resolve; flag it so the view doesn't show a permanent awaiting pill.
  describe("closedUnresolved (S5)", () => {
    it("flags an UNRESOLVED decision whose origin artifact was superseded", () => {
      const store = seedDecision("s1", {
        decisionId: "d_stuck", artifactId: "a1", context: "Which cache?", title: "Cache v1",
      });
      store.createArtifact({
        id: "a2", type: "decision", title: "Cache v2",
        content: {}, parentId: "a1", version: 2,
      });
      store.updateArtifactStatus("a1", "superseded", "agent_supersede");
      store.forceFlush();

      const { decisions } = FileStore.listAllDecisions(tmpDir);
      const d = decisions.find((x) => x.decisionId === "d_stuck")!;
      expect(d.resolved).toBe(false);
      expect(d.closedUnresolved).toBe(true);
    });

    it("does NOT flag a genuinely-open decision, nor a resolved one on a superseded artifact", () => {
      const store = seedDecision("s1", {
        decisionId: "d_open", artifactId: "a1", context: "Still open",
      });
      // A RESOLVED decision whose artifact was later superseded — resolved
      // rows keep their chosen-option rendering, never the closed flag.
      store.createArtifact({ id: "b1", type: "decision", title: "Resolved v1", content: {} });
      store.recordDecisionRequest({ decisionId: "d_done", artifactId: "b1", context: "Done", options: OPTS });
      store.resolveDecision("d_done", "o1");
      store.createArtifact({ id: "b2", type: "decision", title: "Resolved v2", content: {}, parentId: "b1", version: 2 });
      store.updateArtifactStatus("b1", "superseded", "agent_supersede");
      store.forceFlush();

      const { decisions } = FileStore.listAllDecisions(tmpDir);
      expect(decisions.find((x) => x.decisionId === "d_open")!.closedUnresolved).toBeUndefined();
      expect(decisions.find((x) => x.decisionId === "d_done")!.closedUnresolved).toBeUndefined();
    });
  });
});
