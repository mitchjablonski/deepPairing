import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileStore } from "../file-store.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-search-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seed(sessionId: string, artifacts: any[], opts: { rejected?: any[] } = {}) {
  const store = new FileStore(tmpDir, sessionId);
  for (const a of artifacts) {
    store.createArtifact(a);
  }
  if (opts.rejected) {
    for (const r of opts.rejected) {
      store.recordRejectedApproach({ description: r.description, reason: r.reason, sourceArtifactId: r.sourceArtifactId, concept: r.concept });
    }
  }
  store.forceFlush();
  return store;
}

describe("FileStore.searchAll", () => {
  it("returns empty for empty query", () => {
    seed("s1", [{ id: "a1", type: "research", title: "Auth", content: {} }]);
    expect(FileStore.searchAll(tmpDir, "")).toEqual([]);
    expect(FileStore.searchAll(tmpDir, "   ")).toEqual([]);
  });

  it("matches on artifact title", () => {
    seed("s1", [
      { id: "a1", type: "research", title: "Auth system review", content: {} },
      { id: "a2", type: "plan", title: "Database migration", content: {} },
    ]);
    const results = FileStore.searchAll(tmpDir, "auth");
    expect(results).toHaveLength(1);
    expect(results[0].artifactId).toBe("a1");
    expect(results[0].matchedVia).toContain("title");
  });

  it("matches on concept name (reasoning artifacts)", () => {
    seed("s1", [
      {
        id: "a1",
        type: "reasoning",
        title: "Reasoning",
        content: {
          action: "refactor",
          reasoning: "x",
          concept: { name: "dependency inversion", oneLineExplanation: "..." },
        },
      },
    ]);
    const results = FileStore.searchAll(tmpDir, "dependency inversion");
    expect(results).toHaveLength(1);
    expect(results[0].matchedVia).toContain("concept");
    expect(results[0].score).toBeGreaterThanOrEqual(3);
  });

  it("weights concept > title > content", () => {
    seed("s1", [
      // Title-only match
      { id: "a_title", type: "research", title: "Caching approach", content: {} },
      // Concept-only match (wording appears only in concept name)
      {
        id: "a_concept",
        type: "reasoning",
        title: "Refactor",
        content: { concept: { name: "Caching approach" } },
      },
      // Content-only match (buried in content blob)
      {
        id: "a_content",
        type: "plan",
        title: "Migration",
        content: { notes: "we discussed Caching approach as an aside" },
      },
    ]);
    const results = FileStore.searchAll(tmpDir, "Caching approach");
    const byId = Object.fromEntries(results.map((r) => [r.artifactId, r.score]));
    expect(byId["a_concept"]).toBeGreaterThan(byId["a_title"]);
    expect(byId["a_title"]).toBeGreaterThan(byId["a_content"]);
  });

  it("matches on rejected-approach text tied to the artifact", () => {
    seed("s1",
      [{ id: "a1", type: "research", title: "Generic title", content: {} }],
      {
        rejected: [
          { description: "Deploy: Railway", reason: "too expensive", sourceArtifactId: "a1" },
        ],
      },
    );
    const results = FileStore.searchAll(tmpDir, "Railway");
    expect(results).toHaveLength(1);
    expect(results[0].matchedVia).toContain("rejected");
  });

  it("is case-insensitive", () => {
    seed("s1", [{ id: "a1", type: "research", title: "AuthN Review", content: {} }]);
    expect(FileStore.searchAll(tmpDir, "AUTHN")).toHaveLength(1);
    expect(FileStore.searchAll(tmpDir, "authn")).toHaveLength(1);
  });

  it("aggregates matches across sessions", () => {
    seed("s1", [{ id: "a1", type: "research", title: "Cache warmup", content: {} }]);
    seed("s2", [{ id: "a2", type: "plan", title: "Cache eviction", content: {} }]);
    const results = FileStore.searchAll(tmpDir, "cache");
    expect(results.map((r) => r.sessionId).sort()).toEqual(["s1", "s2"]);
  });

  it("caps results at the requested limit", () => {
    const artifacts = Array.from({ length: 60 }, (_, i) => ({
      id: `a${i}`,
      type: "research",
      title: `Cache note ${i}`,
      content: {},
    }));
    seed("s1", artifacts);
    const results = FileStore.searchAll(tmpDir, "cache", 10);
    expect(results.length).toBe(10);
  });

  it("builds a useful excerpt around the match", () => {
    seed("s1", [
      {
        id: "a1",
        type: "plan",
        title: "Unrelated",
        content: { body: "long prose that happens to mention argon2id briefly" },
      },
    ]);
    const results = FileStore.searchAll(tmpDir, "argon2id");
    expect(results).toHaveLength(1);
    expect(results[0].excerpt).toContain("argon2id");
  });
});
