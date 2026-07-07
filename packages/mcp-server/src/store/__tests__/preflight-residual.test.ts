import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PreflightTrace } from "@deeppairing/shared";
import { detectAndRecordGateEscape } from "../preflight-residual.js";
import { readMetrics, __resetMetricsCacheForTests } from "../metrics-store.js";

/**
 * Phase-1 (D) — gate-escape instrumentation. Proves the zero-lexical-overlap
 * signal (the strongest justification for Phase-2 embeddings) is detected and
 * persisted, and that the guard cases (blocked / bootstrap / any overlap) are
 * NOT counted.
 */

let dir: string;
const residualPath = () => path.join(dir, ".deeppairing", "preflight-residual.json");
const readResidual = () => JSON.parse(fs.readFileSync(residualPath(), "utf-8"));

function admittedTrace(consideredConcepts: string[], nearMisses: string[] = []): PreflightTrace {
  return {
    version: 1,
    at: "2026-06-01T00:00:00Z",
    artifactId: "art_x",
    toolName: "present_code_change",
    decision: "admitted",
    consideredCount: consideredConcepts.length,
    consideredConcepts: consideredConcepts.map((concept) => ({ source: "session", concept })),
    nearMisses: nearMisses.map((concept) => ({ source: "session", concept })),
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-residual-"));
  __resetMetricsCacheForTests();
});
afterEach(() => {
  __resetMetricsCacheForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("detectAndRecordGateEscape", () => {
  it("RECORDS a zero-overlap escape: admitted trace + newly-rejected concept sharing no stemmed token", () => {
    const hit = detectAndRecordGateEscape({
      projectRoot: dir,
      rejectedConcept: "eventual consistency",
      reason: "we always want strong reads here",
      trace: admittedTrace(["pay-per-request hosting", "global mutable state"]),
    });
    expect(hit).toBe(true);
    expect(readResidual().escapes).toHaveLength(1);
    expect(readResidual().escapes[0].concept).toBe("eventual consistency");
    expect(readMetrics(dir).counts.gateEscapes).toBe(1);
  });

  it("does NOT record when ANY stemmed token overlaps a considered concept (lexical signal existed)", () => {
    const hit = detectAndRecordGateEscape({
      projectRoot: dir,
      rejectedConcept: "mutable global registry",
      trace: admittedTrace(["global mutable state"]), // shares "global"/"mutable"
    });
    expect(hit).toBe(false);
    expect(fs.existsSync(residualPath())).toBe(false);
    expect(readMetrics(dir).counts.gateEscapes).toBe(0);
  });

  it("does NOT record when the trace was BLOCKED (the gate did its job)", () => {
    const trace = { ...admittedTrace(["x concept"]), decision: "blocked" as const };
    expect(detectAndRecordGateEscape({ projectRoot: dir, rejectedConcept: "unrelated thing", trace })).toBe(false);
  });

  it("does NOT record on a bootstrap admit (nothing was considered → no residual signal)", () => {
    expect(detectAndRecordGateEscape({ projectRoot: dir, rejectedConcept: "unrelated thing", trace: admittedTrace([]) })).toBe(false);
  });

  it("does NOT record when there is no trace", () => {
    expect(detectAndRecordGateEscape({ projectRoot: dir, rejectedConcept: "x", trace: null })).toBe(false);
  });

  it("caps the residual log (keeps the most recent entries)", () => {
    for (let i = 0; i < 105; i++) {
      detectAndRecordGateEscape({
        projectRoot: dir,
        rejectedConcept: `distinct concept number ${i} zulu`,
        trace: admittedTrace(["pay-per-request hosting"]),
      });
    }
    expect(readResidual().escapes.length).toBe(100);
  });
});
