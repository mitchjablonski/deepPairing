// #206 (I1) — the project-level feature-overrides store: atomic write-through,
// salvage-tolerant reads, and the slug-normalizing assign path. Persistence is
// asserted by re-reading from disk (the "daemon restart" round-trip) with a
// SEPARATE call — the module holds no cache, so a fresh read is the disk truth.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readFeatureOverridesFile,
  readFeatureOverrides,
  setFeatureGroupTitle,
  assignArtifactToFeature,
} from "../feature-overrides.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-feature-ov-"));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const overridesPath = () => path.join(tmpDir, ".deeppairing", "feature-overrides.json");

describe("readFeatureOverrides — old stores load clean", () => {
  it("a store with NO overrides file degrades to empty (never throws)", () => {
    expect(readFeatureOverridesFile(tmpDir)).toEqual({
      version: 1,
      groupTitles: {},
      artifactAssignments: {},
    });
    expect(readFeatureOverrides(tmpDir)).toEqual({ groupTitles: {}, artifactAssignments: {} });
  });

  it("a CORRUPT overrides file degrades to empty (salvage, not crash)", () => {
    fs.mkdirSync(path.dirname(overridesPath()), { recursive: true });
    fs.writeFileSync(overridesPath(), "{ not json");
    expect(readFeatureOverridesFile(tmpDir).groupTitles).toEqual({});
  });

  it("a FUTURE version file is ignored (empty), not down-sanitized (#206 Fix 2)", () => {
    // A v2 file written by a newer daemon may carry a shape this reader doesn't
    // understand; coercing it through the v1 shape would corrupt/drop newer data
    // on the next write. Gate on version → treat unknown as empty.
    fs.mkdirSync(path.dirname(overridesPath()), { recursive: true });
    fs.writeFileSync(
      overridesPath(),
      JSON.stringify({ version: 99, groupTitles: { "milestone-6": "from the future" }, artifactAssignments: { a1: "milestone-6" } }),
    );
    expect(readFeatureOverridesFile(tmpDir)).toEqual({ version: 1, groupTitles: {}, artifactAssignments: {} });
  });

  it("drops malformed entries but keeps well-shaped ones", () => {
    fs.mkdirSync(path.dirname(overridesPath()), { recursive: true });
    fs.writeFileSync(
      overridesPath(),
      JSON.stringify({
        version: 1,
        groupTitles: { "milestone-6": "Quota", "": "bad-empty-key", "milestone-7": 42 },
        artifactAssignments: { a1: "milestone-6", a2: null, a3: "" },
      }),
    );
    const file = readFeatureOverridesFile(tmpDir);
    expect(file.groupTitles).toEqual({ "milestone-6": "Quota" });
    expect(file.artifactAssignments).toEqual({ a1: "milestone-6" });
  });
});

describe("setFeatureGroupTitle — rename round-trip (survives 'restart')", () => {
  it("persists a rename and a fresh read sees it", () => {
    setFeatureGroupTitle(tmpDir, "milestone-6", "Quota backfill");
    // Fresh read = the disk truth after a daemon restart (no in-module cache).
    expect(readFeatureOverridesFile(tmpDir).groupTitles["milestone-6"]).toBe("Quota backfill");
    expect(fs.existsSync(overridesPath())).toBe(true);
  });

  it("an empty title CLEARS the rename", () => {
    setFeatureGroupTitle(tmpDir, "milestone-6", "Quota");
    setFeatureGroupTitle(tmpDir, "milestone-6", "   ");
    expect(readFeatureOverridesFile(tmpDir).groupTitles["milestone-6"]).toBeUndefined();
  });

  it("caps an absurdly long title", () => {
    setFeatureGroupTitle(tmpDir, "milestone-6", "x".repeat(500));
    expect(readFeatureOverridesFile(tmpDir).groupTitles["milestone-6"]!.length).toBeLessThanOrEqual(120);
  });
});

describe("assignArtifactToFeature — move round-trip + slug normalization", () => {
  it("normalizes a human-typed target through the same slug family", () => {
    // A human types "Milestone 7"; it must land on the SAME key an agent tag or
    // a title prefix produces — the convergence guarantee, at the write path.
    assignArtifactToFeature(tmpDir, "a1", "Milestone 7");
    expect(readFeatureOverridesFile(tmpDir).artifactAssignments.a1).toBe("milestone-7");
  });

  it("passes the reserved __ungrouped__ target through verbatim", () => {
    assignArtifactToFeature(tmpDir, "a1", "__ungrouped__");
    expect(readFeatureOverridesFile(tmpDir).artifactAssignments.a1).toBe("__ungrouped__");
  });

  it("an empty target CLEARS the assignment (reverts to derived)", () => {
    assignArtifactToFeature(tmpDir, "a1", "milestone-6");
    assignArtifactToFeature(tmpDir, "a1", "");
    expect(readFeatureOverridesFile(tmpDir).artifactAssignments.a1).toBeUndefined();
  });

  it("accumulates independent lanes (a rename and a move coexist)", () => {
    setFeatureGroupTitle(tmpDir, "milestone-6", "Quota");
    assignArtifactToFeature(tmpDir, "a1", "milestone-6");
    const file = readFeatureOverridesFile(tmpDir);
    expect(file.groupTitles["milestone-6"]).toBe("Quota");
    expect(file.artifactAssignments.a1).toBe("milestone-6");
  });

  it("writes atomically (no leftover .tmp files in .deeppairing)", () => {
    assignArtifactToFeature(tmpDir, "a1", "milestone-6");
    const dir = path.join(tmpDir, ".deeppairing");
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp."));
    expect(leftovers).toEqual([]);
  });
});
