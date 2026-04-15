import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FileStore } from "../file-store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;
const stores: FileStore[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-test-"));
  stores.length = 0;
});

afterEach(() => {
  // Force flush all stores to prevent timer writes after dir cleanup
  for (const s of stores) s.forceFlush();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Create a FileStore and track it for cleanup */
function createStore(sessionId: string): FileStore {
  const s = new FileStore(tmpDir, sessionId);
  stores.push(s);
  return s;
}

describe("FileStore", () => {
  it("creates session directory on construction", () => {
    const store = createStore( "test_session");
    const sessionDir = path.join(tmpDir, ".deeppairing", "sessions", "test_session");
    expect(fs.existsSync(sessionDir)).toBe(true);
  });

  it("rejects sessionId with path traversal characters", () => {
    expect(() => createStore( "../../etc")).toThrow("Invalid session ID");
    expect(() => createStore( "foo/bar")).toThrow("Invalid session ID");
    expect(() => createStore( "foo\\bar")).toThrow("Invalid session ID");
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

  it("stores and retrieves autonomy level", () => {
    const store = createStore( "autonomy");
    store.setAutonomyLevel("balanced");

    const store2 = createStore( "autonomy2");
    expect(store2.getAutonomyLevel()).toBe("balanced");
  });

  it("records and retrieves session memory", () => {
    const store = createStore( "memory");
    store.recordApprovedPattern("Service pattern");
    store.recordRejectedApproach("Inline refactor");

    const memory = store.getSessionMemory();
    expect(memory.approvedPatterns).toContain("Service pattern");
    expect(memory.rejectedApproaches).toContain("Inline refactor");
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
