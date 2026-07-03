import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FileStore } from "../file-store.js";
import { setGlobalStoreForTests, getGlobalStore } from "../global-store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;
const stores: FileStore[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-test-"));
  stores.length = 0;
  // Redirect the global philosophy ledger into tmpDir so test writes don't
  // leak into the real ~/.deeppairing/.
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
});

afterEach(() => {
  for (const s of stores) s.forceFlush();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  setGlobalStoreForTests(null);
});

/** Create a FileStore and track it for cleanup */
function createStore(sessionId: string): FileStore {
  const s = new FileStore(tmpDir, sessionId);
  stores.push(s);
  return s;
}

describe("FileStore", () => {
  it("creates session directory on construction", () => {
    createStore("test_session");
    const sessionDir = path.join(tmpDir, ".deeppairing", "sessions", "test_session");
    expect(fs.existsSync(sessionDir)).toBe(true);
  });

  it("PP1 — writes a last-code-change marker only for code_change artifacts (for the checkpoint hook)", () => {
    const store = createStore("pp1_marker");
    const markerPath = path.join(tmpDir, ".deeppairing", "last-code-change.json");

    store.createArtifact({ id: "r1", type: "research", title: "t", content: {} });
    expect(fs.existsSync(markerPath)).toBe(false); // non-code_change doesn't touch it

    store.createArtifact({ id: "c1", type: "code_change", title: "edit", content: { filePath: "x", changeType: "modify", before: "a", after: "b", reasoning: "r" } });
    expect(fs.existsSync(markerPath)).toBe(true);
    const at1 = JSON.parse(fs.readFileSync(markerPath, "utf-8")).at;
    expect(typeof at1).toBe("string");

    // last-write-wins = most-recent code_change (the property the checkpoint relies on)
    const at2 = JSON.parse(fs.readFileSync(markerPath, "utf-8")).at;
    store.createArtifact({ id: "c2", type: "code_change", title: "edit2", content: { filePath: "y", changeType: "modify", before: "a", after: "b", reasoning: "r" } });
    const at3 = JSON.parse(fs.readFileSync(markerPath, "utf-8")).at;
    expect(at3 >= at2).toBe(true); // advanced (or equal within the same ms)
  });

  it("rejects sessionId with path traversal characters", () => {
    expect(() => createStore( "../../etc")).toThrow("Invalid session ID");
    expect(() => createStore( "foo/bar")).toThrow("Invalid session ID");
    expect(() => createStore( "foo\\bar")).toThrow("Invalid session ID");
  });

  it("PP2 — a comment-only change skips rewriting the unchanged artifacts.json", () => {
    const store = createStore("pp2-skip");
    store.createArtifact({ id: "a1", type: "research", title: "t", content: { summary: "s" } });
    store.forceFlush();
    const artPath = path.join(tmpDir, ".deeppairing", "sessions", "pp2-skip", "artifacts.json");
    const commentsPath = path.join(tmpDir, ".deeppairing", "sessions", "pp2-skip", "comments.json");

    // Backdate artifacts.json so a (skipped) flush is unambiguously distinguishable
    // from a rewrite, independent of filesystem mtime resolution.
    const OLD = new Date("2020-01-01T00:00:00Z").getTime() / 1000;
    fs.utimesSync(artPath, OLD, OLD);

    store.addComment({ id: "c1", artifactId: "a1", content: "hi", author: "human" });
    store.forceFlush();

    // artifacts.json untouched (still 2020) — only comments.json was rewritten.
    expect(fs.statSync(artPath).mtime.getUTCFullYear()).toBe(2020);
    expect(JSON.parse(fs.readFileSync(commentsPath, "utf-8"))).toHaveLength(1);

    // ...but a status change DOES rewrite artifacts.json (skip isn't over-eager).
    store.updateArtifactStatus("a1", "approved", "ui_approve_button");
    store.forceFlush();
    expect(fs.statSync(artPath).mtime.getUTCFullYear()).toBeGreaterThan(2020);
  });

  it("PP2 — skip does NOT defeat the U1 external-merge self-heal (no data loss)", () => {
    const store = createStore("pp2-merge");
    store.createArtifact({ id: "A", type: "research", title: "A", content: {} });
    store.createArtifact({ id: "B", type: "research", title: "B", content: {} });
    store.forceFlush(); // disk = [A, B], lastSerialized = S([A,B])
    const artPath = path.join(tmpDir, ".deeppairing", "sessions", "pp2-merge", "artifacts.json");

    // A stale external writer clobbers the file back to just [A] (B survives
    // only in our RAM). The next flush must merge B back AND actually rewrite —
    // a naive skip-cache would see in-memory still serializes to S([A,B]) and
    // skip, leaving B lost on disk.
    fs.writeFileSync(artPath, JSON.stringify([{ id: "A", type: "research", title: "A", content: {} }]));

    // touch the store so it flushes; the comment change is unrelated to artifacts
    store.addComment({ id: "c1", artifactId: "A", content: "hi", author: "human" });
    store.forceFlush();

    // B must be back on disk (self-heal preserved despite the skip-cache).
    const onDisk = JSON.parse(fs.readFileSync(artPath, "utf-8")).map((a: any) => a.id).sort();
    expect(onDisk).toEqual(["A", "B"]);
  });

  it("round-trips artifacts through flush + reload", () => {
    const store = createStore( "roundtrip");
    store.createArtifact({
      id: "art_1",
      type: "research",
      title: "Test Finding",
      content: { summary: "test" },
    });

    // Force flush to disk
    store.forceFlush();

    // Reload in a new instance
    const store2 = createStore( "roundtrip");
    const artifacts = store2.getArtifacts();
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].id).toBe("art_1");
    expect(artifacts[0].title).toBe("Test Finding");
  });

  it("dedupes a comment with identical content/artifact/author within 5s (U0.1)", () => {
    // Field bug: a single comment got posted ~13 times because the client
    // had no sync send-guard. The server-side window collapses any duplicate
    // within 5s into one record and returns the original comment so the
    // caller's response/broadcast wiring still has a valid reference.
    const store = createStore("dedupe-window");
    const c1 = store.addComment({
      id: "cmt_1",
      artifactId: "art_X",
      content: "duplicate me",
      author: "human",
    });
    const c2 = store.addComment({
      id: "cmt_2_different_id",
      artifactId: "art_X",
      content: "duplicate me",
      author: "human",
    });
    expect(store.getCommentsForArtifact("art_X")).toHaveLength(1);
    // Returned comment is the ORIGINAL — id is cmt_1, not the new id we passed.
    expect(c2.id).toBe(c1.id);
    expect(c2.id).toBe("cmt_1");
  });

  it("does NOT dedupe across different authors / artifacts / parents", () => {
    const store = createStore("dedupe-scope");
    store.addComment({ id: "c1", artifactId: "art_X", content: "hi", author: "human" });
    // Same content, different author → not a duplicate
    store.addComment({ id: "c2", artifactId: "art_X", content: "hi", author: "agent" });
    // Same content, different artifact → not a duplicate
    store.addComment({ id: "c3", artifactId: "art_Y", content: "hi", author: "human" });
    // Same content, different parentCommentId → not a duplicate (it's a reply)
    store.addComment({ id: "c4", artifactId: "art_X", content: "hi", author: "human", parentCommentId: "c1" });
    expect(store.getCommentsForArtifact("art_X")).toHaveLength(3);
    expect(store.getCommentsForArtifact("art_Y")).toHaveLength(1);
  });

  it("F3 — does NOT dedupe same-content comments on DIFFERENT targets of one artifact", () => {
    const store = createStore("dedupe-target");
    // Same content/author/artifact, but anchored to different lines / findings —
    // these are distinct human input and must all survive (pre-F3 they collapsed).
    store.addComment({ id: "c1", artifactId: "art_X", content: "why?", author: "human", target: { lineStart: 10, filePath: "a.ts" } });
    store.addComment({ id: "c2", artifactId: "art_X", content: "why?", author: "human", target: { lineStart: 20, filePath: "a.ts" } });
    store.addComment({ id: "c3", artifactId: "art_X", content: "why?", author: "human", target: { findingIndex: 0 } });
    store.addComment({ id: "c4", artifactId: "art_X", content: "why?", author: "human", target: { findingIndex: 1 } });
    // decision-option and reasoning-alternative anchors ("ask why" per option) —
    // these distinguish only by optionId / alternativeIndex / sectionId.
    store.addComment({ id: "c5", artifactId: "art_X", content: "why?", author: "human", target: { optionId: "opt_a" } });
    store.addComment({ id: "c6", artifactId: "art_X", content: "why?", author: "human", target: { optionId: "opt_b" } });
    store.addComment({ id: "c7", artifactId: "art_X", content: "why?", author: "human", target: { alternativeIndex: 0 } });
    store.addComment({ id: "c8", artifactId: "art_X", content: "why?", author: "human", target: { sectionId: "horizon_check:request:1y" } });
    expect(store.getCommentsForArtifact("art_X")).toHaveLength(8);

    // ...but a genuine duplicate on the SAME anchor within the window still collapses.
    const d = store.addComment({ id: "c9", artifactId: "art_X", content: "why?", author: "human", target: { optionId: "opt_a" } });
    expect(d.id).toBe("c5");
    expect(store.getCommentsForArtifact("art_X")).toHaveLength(8);
  });

  it("FN4 — agent self-supersede of a draft is NOT counted as a human review; a UI approve is", () => {
    const store = createStore("fn4-review");
    store.createArtifact({ id: "a1", type: "plan", title: "t", content: { steps: [], estimatedChanges: 0 } });
    store.updateArtifactStatus("a1", "superseded", "agent_supersede");
    expect(Object.keys(store.getEngagementMetrics().reviewsByType)).toHaveLength(0);

    store.createArtifact({ id: "a2", type: "plan", title: "t", content: { steps: [], estimatedChanges: 0 } });
    store.updateArtifactStatus("a2", "approved", "ui_approve_button");
    expect(store.getEngagementMetrics().reviewsByType.plan?.count).toBe(1);
  });

  it("FN4 — approvalRate excludes agent-driven terminal states (retracted/obsolete)", () => {
    const store = createStore("fn4-rate");
    store.createArtifact({ id: "a1", type: "plan", title: "t", content: { steps: [], estimatedChanges: 0 } });
    store.updateArtifactStatus("a1", "approved", "ui_approve_button");
    store.createArtifact({ id: "a2", type: "plan", title: "t", content: { steps: [], estimatedChanges: 0 } });
    store.updateArtifactStatus("a2", "retracted", "agent_retract");
    // retracted is excluded from the denominator → 1/1, not 1/2
    expect(store.getEngagementMetrics().approvalRate).toBe(1);
  });

  it("FN1 — addComment persists codeReferences (answer_question evidence)", () => {
    const store = createStore("coderefs");
    store.addComment({
      id: "a1", artifactId: "art_1", content: "see here", author: "agent",
      codeReferences: [{ filePath: "src/x.ts", lineStart: 1, lineEnd: 3, snippet: "const x = 1;" }],
    });
    store.forceFlush();
    const reread = createStore("coderefs");
    const c = reread.getCommentsForArtifact("art_1")[0];
    expect((c as any).codeReferences).toEqual([{ filePath: "src/x.ts", lineStart: 1, lineEnd: 3, snippet: "const x = 1;" }]);
  });

  it("round-trips comments", () => {
    const store = createStore( "comments");
    store.addComment({
      id: "cmt_1",
      artifactId: "art_1",
      content: "Great finding",
      author: "human",
    });

    store.forceFlush();

    const store2 = createStore( "comments");
    const comments = store2.getCommentsForArtifact("art_1");
    expect(comments).toHaveLength(1);
    expect(comments[0].content).toBe("Great finding");
  });

  it("markCommentHumanResolved sets humanResolvedAt + persists", () => {
    const store = createStore("human-resolved");
    store.addComment({
      id: "q1",
      artifactId: "art_1",
      content: "Why this approach?",
      author: "human",
      intent: "question",
    });

    // Before: no humanResolvedAt.
    expect(store.getComment("q1")?.humanResolvedAt).toBeUndefined();

    const at = "2026-05-31T12:00:00.000Z";
    store.markCommentHumanResolved("q1", at);
    expect(store.getComment("q1")?.humanResolvedAt).toBe(at);
    // The agent's drain queue is untouched — acknowledged stays false.
    expect(store.getComment("q1")?.acknowledged).toBe(false);

    // No-op on an unknown id (must not throw).
    expect(() => store.markCommentHumanResolved("does_not_exist")).not.toThrow();

    // Persists across reload.
    store.forceFlush();
    const store2 = createStore("human-resolved");
    expect(store2.getComment("q1")?.humanResolvedAt).toBe(at);
  });

  it("markCommentHumanResolved defaults resolvedAt to now when omitted", () => {
    const store = createStore("human-resolved-default");
    store.addComment({ id: "q2", artifactId: "art_1", content: "Q?", author: "human", intent: "question" });
    store.markCommentHumanResolved("q2");
    const resolved = store.getComment("q2")?.humanResolvedAt;
    expect(typeof resolved).toBe("string");
    expect(Number.isNaN(Date.parse(resolved as string))).toBe(false);
  });

  it("pending plan-reviews / decisions exclude CLOSED artifacts (F1 orphan guard)", () => {
    const store = createStore("orphan_guard");
    store.createArtifact({ id: "p1", type: "plan", title: "Plan", content: { steps: [], estimatedChanges: 0 } });
    store.recordPlanReview("p1");
    expect(store.getPendingPlanReviews().map((p) => p.artifactId)).toContain("p1");

    store.createArtifact({ id: "d1", type: "decision", title: "Decide", content: { context: "c", options: [] } });
    store.recordDecisionRequest({ decisionId: "dec1", artifactId: "d1", context: "c", options: [] });
    expect(store.getPendingDecisions().map((d) => d.artifactId)).toContain("d1");

    // Closing the artifacts (superseded / terminal) retires their pending records,
    // so check_feedback stops reporting them as WAITING forever.
    store.updateArtifactStatus("p1", "superseded");
    store.updateArtifactStatus("d1", "rejected");
    expect(store.getPendingPlanReviews().map((p) => p.artifactId)).not.toContain("p1");
    expect(store.getPendingDecisions().map((d) => d.artifactId)).not.toContain("d1");
  });

  it("a pending review with no backing artifact stays pending (artifacts are never deleted, only closed)", () => {
    const store = createStore("ghost_review");
    store.recordPlanReview("nonexistent");
    expect(store.getPendingPlanReviews().map((p) => p.artifactId)).toContain("nonexistent");
  });

  it("round-trips decisions", () => {
    const store = createStore( "decisions");
    store.recordDecisionRequest({
      decisionId: "dec_1",
      artifactId: "art_1",
      context: "Which approach?",
      options: [{ id: "a", title: "Option A" }],
    });
    store.resolveDecision("dec_1", "a", "Seems best");

    store.forceFlush();

    const store2 = createStore( "decisions");
    const resp = store2.getDecisionResponse("dec_1");
    expect(resp?.optionId).toBe("a");
    expect(resp?.reasoning).toBe("Seems best");
  });

  it("F2 — resolveDecision ignores an optionId not among the decision's options (stays pending, not silently consumed)", () => {
    const store = createStore("resolve-guard");
    store.recordDecisionRequest({
      decisionId: "dec_g",
      artifactId: "art_g",
      context: "Which?",
      options: [{ id: "a", title: "A" }, { id: "b", title: "B" }],
    });
    store.resolveDecision("dec_g", "nonexistent", "oops");
    expect(store.getDecisionResponse("dec_g")).toBeFalsy(); // not set → re-surfaces, no ledger drop
    // a valid option still resolves normally
    store.resolveDecision("dec_g", "b", "ok");
    expect(store.getDecisionResponse("dec_g")?.optionId).toBe("b");
  });

  it("backs up corrupted JSON files", () => {
    // Create a session with valid data
    const store = createStore( "corrupt");
    store.createArtifact({
      id: "art_1",
      type: "research",
      title: "Test",
      content: {},
    });
    store.forceFlush();

    // Corrupt the artifacts file
    const artFile = path.join(tmpDir, ".deeppairing", "sessions", "corrupt", "artifacts.json");
    fs.writeFileSync(artFile, "{ invalid json !!!");

    // Reload — should not throw, should create .corrupt backup
    const store2 = createStore( "corrupt");
    expect(store2.getArtifacts()).toHaveLength(0); // Falls back to empty
    expect(fs.existsSync(artFile + ".corrupt")).toBe(true);
  });

  it("tracks engagement metrics on status changes", () => {
    const store = createStore( "metrics");
    store.createArtifact({
      id: "art_1",
      type: "research",
      title: "Test",
      content: {},
    });
    store.updateArtifactStatus("art_1", "approved");

    const metrics = store.getEngagementMetrics();
    expect(metrics.approvalRate).toBe(1);
    expect(metrics.avgReviewLatencyMs).toBeGreaterThanOrEqual(0);
  });

  // AA3 — reviewLatencies persist across daemon restarts. Pre-AA3 they
  // were in-memory only; an idle-shutdown silently reset all metrics.
  it("AA3: reviewLatencies persist on flush + rehydrate on reload", () => {
    const sid = "metrics_persist";
    const store = createStore(sid);
    store.createArtifact({ id: "art_aa3", type: "research", title: "x", content: {} });
    // Trigger a review-latency record. updateArtifactStatus calls
    // recordArtifactReviewed under the hood.
    store.updateArtifactStatus("art_aa3", "approved");
    store.forceFlush();

    // metrics.json should exist next to the other session JSONs.
    const metricsPath = path.join(tmpDir, ".deeppairing", "sessions", sid, "metrics.json");
    expect(fs.existsSync(metricsPath)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(metricsPath, "utf-8"));
    expect(Array.isArray(onDisk)).toBe(true);
    expect(onDisk.length).toBe(1);
    expect(onDisk[0].type).toBe("research");

    // Rehydrate by constructing a fresh FileStore — the new instance must
    // see the same metrics. Pre-AA3 this assertion would fail.
    const reloaded = createStore(sid);
    const metrics = reloaded.getEngagementMetrics();
    expect(metrics.avgReviewLatencyMs).toBeGreaterThanOrEqual(0);
    expect(metrics.reviewsByType.research?.count).toBe(1);
  });

  it("AA3: skips writing metrics.json when reviewLatencies is empty (keep session dir tidy)", () => {
    const sid = "metrics_empty";
    const store = createStore(sid);
    store.createArtifact({ id: "art_x", type: "research", title: "x", content: {} });
    store.forceFlush();
    const metricsPath = path.join(tmpDir, ".deeppairing", "sessions", sid, "metrics.json");
    expect(fs.existsSync(metricsPath)).toBe(false);
  });

  it("stores and retrieves autonomy level", () => {
    const store = createStore( "autonomy");
    store.setAutonomyLevel("balanced");

    const store2 = createStore( "autonomy2");
    expect(store2.getAutonomyLevel()).toBe("balanced");
  });

  it("records and retrieves session memory", () => {
    const store = createStore( "memory");
    store.recordApprovedPattern({ description: "Service pattern" });
    store.recordRejectedApproach({ description: "Inline refactor" });

    const memory = store.getSessionMemory();
    expect(memory.approvedPatterns).toContain("Service pattern");
    expect(memory.rejectedApproaches.map((r) => r.description)).toContain("Inline refactor");
  });

  describe("overrideRejectedApproach (scope-down a false-positive block)", () => {
    const ledgerStance = (concept: string) =>
      getGlobalStore()
        .query({ limit: 100 })
        .find((e) => e.concept.toLowerCase() === concept)?.stance;

    it("retires the local stance AND flips the derived ledger stance off 'avoid'", () => {
      const store = createStore("override");
      store.setGlobalLedgerPublish(true);
      store.recordRejectedApproach({
        description: "Deploy: Railway",
        concept: "pay-per-request hosting",
        reason: "vendor lock-in",
      });
      // Before: blocks locally and derives "avoid" cross-project.
      expect(store.getSessionMemory().rejectedApproaches.map((r) => r.concept)).toContain(
        "pay-per-request hosting",
      );
      expect(ledgerStance("pay-per-request hosting")).toBe("avoid");

      // Override: retire the local entry + record an approved counter-instance.
      const { retired } = store.overrideRejectedApproach({ concept: "pay-per-request hosting" });
      expect(retired).toBe(1);
      // After: gone locally (block clears now) and the derived stance shifted
      // to "mixed" (1 reject + 1 approve) so future projects stop tripping.
      expect(store.getSessionMemory().rejectedApproaches.map((r) => r.concept)).not.toContain(
        "pay-per-request hosting",
      );
      expect(ledgerStance("pay-per-request hosting")).toBe("mixed");
    });

    it("clears the local block even with publish OFF (nothing to counter globally)", () => {
      const store = createStore("override-nopub");
      store.recordRejectedApproach({ description: "Inline refactor" }); // publish off by default
      expect(store.getSessionMemory().rejectedApproaches).toHaveLength(1);
      const { retired } = store.overrideRejectedApproach({ description: "Inline refactor" });
      expect(retired).toBe(1);
      expect(store.getSessionMemory().rejectedApproaches).toHaveLength(0);
    });

    it("returns retired:0 when nothing matches (no crash)", () => {
      const store = createStore("override-miss");
      expect(store.overrideRejectedApproach({ concept: "never recorded" })).toEqual({ retired: 0 });
    });
  });

  describe("findPastPredictions — concept-token matching (N3.3)", () => {
    function seedPrediction(sessionId: string, title: string, context: string, predicted: string) {
      const store = createStore(sessionId);
      store.createArtifact({ id: `dart_${sessionId}`, type: "decision", title, content: {} });
      store.recordDecisionRequest({
        decisionId: `dec_${sessionId}`,
        artifactId: `dart_${sessionId}`,
        context,
        options: [{ id: "o1", title: "Redis", description: "in-memory" }],
        stakes: "high",
      });
      store.resolveDecision(`dec_${sessionId}`, "o1", "go", { predictedOutcome: predicted, confidence: "high" });
      store.forceFlush();
    }

    it("surfaces a past prediction sharing ≥2 concept tokens, even with a differently-worded query", () => {
      seedPrediction("past", "Choose a cache layer for hot reads", "API latency", "Redis will hold up");
      // Shares exactly two distinctive tokens (cache, layer). The OLD majority
      // rule needed ceil(5/2)=3 of the query's tokens, so this missed; the
      // token-floor rule surfaces it.
      const hits = FileStore.findPastPredictions(tmpDir, "which cache layer should we pick");
      expect(hits).toHaveLength(1);
      expect(hits[0].predictedOutcome).toBe("Redis will hold up");
    });

    it("does NOT surface on a single incidental token overlap (floor is 2)", () => {
      seedPrediction("past2", "Choose a cache layer for hot reads", "API latency", "Redis");
      // Only "choose" overlaps — one shared token isn't a concept match.
      const hits = FileStore.findPastPredictions(tmpDir, "which database should we choose");
      expect(hits).toHaveLength(0);
    });
  });

  describe("project guardrails (J6)", () => {
    it("detects migrations directory", () => {
      fs.mkdirSync(path.join(tmpDir, "migrations"), { recursive: true });
      const store = createStore("guard1");
      const guardrails = store.getProjectGuardrails();
      const migrationsRail = guardrails.find((g) => g.category === "migrations");
      expect(migrationsRail).toBeDefined();
      expect(migrationsRail?.paths).toContain("migrations");
    });

    it("detects .github/workflows", () => {
      fs.mkdirSync(path.join(tmpDir, ".github", "workflows"), { recursive: true });
      const store = createStore("guard2");
      const guardrails = store.getProjectGuardrails();
      expect(guardrails.some((g) => g.category === "workflows")).toBe(true);
    });

    it("detects infrastructure files", () => {
      fs.writeFileSync(path.join(tmpDir, "Dockerfile"), "FROM node");
      const store = createStore("guard3");
      const guardrails = store.getProjectGuardrails();
      expect(guardrails.some((g) => g.category === "infrastructure")).toBe(true);
    });

    it("detects .env files as secrets", () => {
      fs.writeFileSync(path.join(tmpDir, ".env"), "SECRET=foo");
      const store = createStore("guard4");
      const guardrails = store.getProjectGuardrails();
      expect(guardrails.some((g) => g.category === "secrets")).toBe(true);
    });

    it("returns empty for a bare project", () => {
      const store = createStore("guard5");
      expect(store.getProjectGuardrails()).toEqual([]);
    });
  });

  describe("team preferences (N6.2)", () => {
    function writeTeamJson(content: unknown): void {
      fs.mkdirSync(path.join(tmpDir, ".deeppairing"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".deeppairing", "team.json"),
        typeof content === "string" ? content : JSON.stringify(content),
      );
    }

    it("returns empty when team.json is missing", () => {
      const store = createStore("team1");
      expect(store.getTeamPreferences()).toEqual([]);
    });

    it("loads a well-formed team.json on construction", () => {
      writeTeamJson({
        version: 1,
        preferences: [
          { id: "p1", kind: "require", concept: "argon2id for password hashing", rationale: "bcrypt is brute-forceable" },
          { id: "p2", kind: "avoid", concept: "global state", rationale: "breaks testability" },
        ],
      });
      const store = createStore("team2");
      const prefs = store.getTeamPreferences();
      expect(prefs).toHaveLength(2);
      expect(prefs[0].concept).toContain("argon2id");
      expect(prefs[1].kind).toBe("avoid");
    });

    it("returns empty (not throws) on malformed team.json", () => {
      writeTeamJson("{ not valid json");
      const store = createStore("team3");
      expect(store.getTeamPreferences()).toEqual([]);
    });

    it("returns empty (not throws) on schema-invalid team.json", () => {
      writeTeamJson({ version: 999, preferences: [{ nope: true }] });
      const store = createStore("team4");
      expect(store.getTeamPreferences()).toEqual([]);
    });

    it("is cached per-instance — file changes don't affect a live store", () => {
      writeTeamJson({ version: 1, preferences: [{ id: "p1", kind: "prefer", concept: "x", rationale: "y" }] });
      const store = createStore("team5");
      expect(store.getTeamPreferences()).toHaveLength(1);
      writeTeamJson({ version: 1, preferences: [] });
      // Same store — stale cache is intentional, reloaded on next construction.
      expect(store.getTeamPreferences()).toHaveLength(1);
    });

    it("picks up changes for a new store instance (next session)", () => {
      writeTeamJson({ version: 1, preferences: [{ id: "p1", kind: "prefer", concept: "x", rationale: "y" }] });
      const s1 = createStore("team6a");
      expect(s1.getTeamPreferences()).toHaveLength(1);
      writeTeamJson({ version: 1, preferences: [] });
      const s2 = createStore("team6b");
      expect(s2.getTeamPreferences()).toHaveLength(0);
    });
  });

  describe("listSessions", () => {
    it("returns sessions and includes session data", () => {
      const s1 = createStore( "session_1");
      s1.createArtifact({ id: "a1", type: "research", title: "First", content: {} });
      s1.forceFlush();

      const s2 = createStore( "session_2");
      s2.createArtifact({ id: "a2", type: "plan", title: "Second", content: {} });
      s2.forceFlush();

      const sessions = FileStore.listSessions(tmpDir);
      expect(sessions).toHaveLength(2);
      // Both sessions present with correct artifact counts
      const ids = sessions.map((s) => s.id);
      expect(ids).toContain("session_1");
      expect(ids).toContain("session_2");
      expect(sessions.every((s) => s.artifactCount === 1)).toBe(true);
    });
  });
});

// --- D1: the disk trust boundary ---

describe("D1 — salvage at the JSON.parse boundary", () => {
  it("a garbage element in artifacts.json is dropped, valid ones load, nothing crashes", () => {
    const dir = path.join(tmpDir, ".deeppairing", "sessions", "salvage_test");
    fs.mkdirSync(dir, { recursive: true });
    const valid = {
      id: "a_ok", sessionId: "salvage_test", type: "research", version: 1, parentId: null,
      title: "ok", status: "draft", content: {}, agentReasoning: null,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    // A string, a null, an object missing id, and one valid artifact — the
    // exact hand-edited/corrupted-but-parseable class that used to crash
    // downstream consumers.
    fs.writeFileSync(path.join(dir, "artifacts.json"), JSON.stringify(["garbage", null, { title: "no id" }, valid]));

    const store = createStore("salvage_test");
    const arts = store.getArtifacts();
    expect(arts).toHaveLength(1);
    expect(arts[0].id).toBe("a_ok");
  });

  it("a non-array artifacts.json (object/string) degrades to empty, not a crash", () => {
    const dir = path.join(tmpDir, ".deeppairing", "sessions", "salvage_obj");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "artifacts.json"), JSON.stringify({ not: "an array" }));
    const store = createStore("salvage_obj");
    expect(store.getArtifacts()).toEqual([]);
  });

  it("legacy-shaped elements (extra/missing OPTIONAL fields) still load — structure only, not strictness", () => {
    const dir = path.join(tmpDir, ".deeppairing", "sessions", "salvage_legacy");
    fs.mkdirSync(dir, { recursive: true });
    // No severity/confidence/agentReasoning, plus an unknown field — the
    // lenient contract: identity + objectness is enough at this boundary.
    fs.writeFileSync(path.join(dir, "decisions.json"), JSON.stringify([
      { decisionId: "d1", artifactId: "a1", context: "c", options: [], someLegacyField: true, createdAt: "2026-01-01T00:00:00.000Z" },
    ]));
    const store = createStore("salvage_legacy");
    expect(store.getPendingDecisions()).toHaveLength(1);
  });
});

describe("D1 review — flush-time external-merge salvage (the permanent-failure loop)", () => {
  it("garbage appended externally mid-session merges cleanly on forceFlush (no throw, valid records kept)", () => {
    const store = createStore("salvage_flush");
    store.createArtifact({ id: "a_mem", type: "research", title: "in memory", content: {} });
    store.forceFlush();

    // External writer appends garbage + one valid artifact, bumps mtime.
    const artPath = path.join(tmpDir, ".deeppairing", "sessions", "salvage_flush", "artifacts.json");
    const disk = JSON.parse(fs.readFileSync(artPath, "utf-8"));
    const external = {
      id: "a_ext", sessionId: "salvage_flush", type: "research", version: 1, parentId: null,
      title: "external", status: "draft", content: {}, agentReasoning: null,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    fs.writeFileSync(artPath, JSON.stringify([...disk, null, "garbage", external]));
    const future = Date.now() / 1000 + 5;
    fs.utimesSync(artPath, future, future);

    // Pre-fix: threw inside mergeArrayById; the debounced catch would swallow
    // it and the un-advanced watermark re-threw on EVERY later flush.
    expect(() => store.forceFlush()).not.toThrow();
    const ids = store.getArtifacts().map((a) => a.id);
    expect(ids).toContain("a_mem");
    expect(ids).toContain("a_ext");
  });

  it("preferences.json = null no longer crashes the constructor", () => {
    const dir = path.join(tmpDir, ".deeppairing", "sessions", "salvage_prefs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "preferences.json"), "null");
    expect(() => createStore("salvage_prefs")).not.toThrow();
  });

  it("a null decisions.json no longer hides an otherwise-healthy session from listSessions", () => {
    const dir = path.join(tmpDir, ".deeppairing", "sessions", "salvage_list");
    fs.mkdirSync(dir, { recursive: true });
    const valid = {
      id: "a_l", sessionId: "salvage_list", type: "research", version: 1, parentId: null,
      title: "t", status: "draft", content: {}, agentReasoning: null,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    fs.writeFileSync(path.join(dir, "artifacts.json"), JSON.stringify([valid]));
    fs.writeFileSync(path.join(dir, "decisions.json"), "null");
    const sessions = FileStore.listSessions(tmpDir);
    expect(sessions.map((s) => s.id)).toContain("salvage_list");
  });
});

describe("F10 (G1) — corrupt metrics.json must never break approve/reject", () => {
  it("a parseable non-array metrics.json ({}) no longer crashes updateArtifactStatus", () => {
    const dir = path.join(tmpDir, ".deeppairing", "sessions", "metrics_corrupt");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "metrics.json"), "{}");

    const store = createStore("metrics_corrupt");
    store.createArtifact({ id: "a_m", type: "research", title: "t", content: {} });
    // Pre-fix: reviewLatencies = {} → recordArtifactReviewed .push threw →
    // EVERY human approve/reject 500'd (and the corrupt file never healed).
    expect(() => store.updateArtifactStatus("a_m", "approved", "ui_approve_button")).not.toThrow();
    expect(store.getArtifacts().find((a) => a.id === "a_m")?.status).toBe("approved");
  });

  it("malformed latency elements are dropped; valid ones survive", () => {
    const dir = path.join(tmpDir, ".deeppairing", "sessions", "metrics_mixed");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "metrics.json"), JSON.stringify([
      { type: "plan", latencyMs: 1200 },
      "garbage",
      { type: "research" },          // missing latencyMs
      { type: "spec", latencyMs: "NaN-ish" },
    ]));
    const store = createStore("metrics_mixed");
    const metrics = store.getEngagementMetrics();
    expect(metrics.reviewsByType.plan?.count).toBe(1);
    expect(Object.keys(metrics.reviewsByType)).toEqual(["plan"]);
  });

  it("the corrupt file self-heals on the next review (flush writes the salvaged array)", () => {
    const dir = path.join(tmpDir, ".deeppairing", "sessions", "metrics_heal");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "metrics.json"), "{}");
    const store = createStore("metrics_heal");
    store.createArtifact({ id: "a_h", type: "plan", title: "t", content: { steps: [], estimatedChanges: 0 } });
    store.updateArtifactStatus("a_h", "approved", "ui_approve_button");
    store.forceFlush();
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "metrics.json"), "utf-8"));
    expect(Array.isArray(onDisk)).toBe(true);
    expect(onDisk).toHaveLength(1);
  });
});

describe("F11 (G6) — salvage-log suppression keys are session-scoped", () => {
  it("a second session's corrupt artifacts.json still logs (was: suppressed by the first)", () => {
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
    try {
      for (const sid of ["g6_a", "g6_b"]) {
        const dir = path.join(tmpDir, ".deeppairing", "sessions", sid);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "artifacts.json"), '{"not":"an array"}');
        createStore(sid);
      }
      const salvageLines = errors.filter((e) => e.includes("artifacts.json"));
      expect(salvageLines.some((e) => e.includes("g6_a"))).toBe(true);
      expect(salvageLines.some((e) => e.includes("g6_b"))).toBe(true);
    } finally {
      console.error = orig;
    }
  });
});
