/**
 * R1 — metrics store: atomic counts per project, resilient to missing /
 * corrupt files. Proves the hook is quantifiably firing for the user.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readMetrics, recordMetricEvent, type MetricsFile } from "../metrics-store.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-metrics-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("readMetrics", () => {
  it("returns a zeroed shape when metrics.json is missing", () => {
    const m = readMetrics(tmpDir);
    expect(m.version).toBe(1);
    expect(m.counts.preflightBlocks.total).toBe(0);
    expect(m.counts.ledgerWrites.total).toBe(0);
    expect(m.counts.retrospectives.total).toBe(0);
    expect(m.counts.questions.asked).toBe(0);
    expect(m.sessions).toBe(0);
  });

  it("returns a zeroed shape when metrics.json is corrupt", () => {
    fs.mkdirSync(path.join(tmpDir, ".deeppairing"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".deeppairing", "metrics.json"), "{not valid json");
    const m = readMetrics(tmpDir);
    expect(m.counts.preflightBlocks.total).toBe(0);
  });

  it("returns a zeroed shape when the version is wrong (future-proofs schema changes)", () => {
    fs.mkdirSync(path.join(tmpDir, ".deeppairing"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".deeppairing", "metrics.json"),
      JSON.stringify({ version: 99, counts: { preflightBlocks: { total: 5 } } }),
    );
    const m = readMetrics(tmpDir);
    expect(m.counts.preflightBlocks.total).toBe(0);
  });
});

describe("recordMetricEvent", () => {
  it("increments preflight_block counters by source", () => {
    recordMetricEvent(tmpDir, { kind: "preflight_block", source: "session" });
    recordMetricEvent(tmpDir, { kind: "preflight_block", source: "session" });
    recordMetricEvent(tmpDir, { kind: "preflight_block", source: "team" });
    const m = readMetrics(tmpDir);
    expect(m.counts.preflightBlocks.total).toBe(3);
    expect(m.counts.preflightBlocks.bySource.session).toBe(2);
    expect(m.counts.preflightBlocks.bySource.team).toBe(1);
  });

  it("splits ledger_writes into rejected and approved", () => {
    recordMetricEvent(tmpDir, { kind: "ledger_write", verdict: "rejected" });
    recordMetricEvent(tmpDir, { kind: "ledger_write", verdict: "rejected" });
    recordMetricEvent(tmpDir, { kind: "ledger_write", verdict: "approved" });
    const m = readMetrics(tmpDir);
    expect(m.counts.ledgerWrites.total).toBe(3);
    expect(m.counts.ledgerWrites.rejected).toBe(2);
    expect(m.counts.ledgerWrites.approved).toBe(1);
  });

  it("tallies retrospectives by verdict", () => {
    recordMetricEvent(tmpDir, { kind: "retrospective", verdict: "right" });
    recordMetricEvent(tmpDir, { kind: "retrospective", verdict: "wrong" });
    recordMetricEvent(tmpDir, { kind: "retrospective", verdict: "mixed" });
    const m = readMetrics(tmpDir);
    expect(m.counts.retrospectives.total).toBe(3);
    expect(m.counts.retrospectives.right).toBe(1);
    expect(m.counts.retrospectives.wrong).toBe(1);
    expect(m.counts.retrospectives.mixed).toBe(1);
  });

  it("tracks questions asked and answered independently", () => {
    recordMetricEvent(tmpDir, { kind: "question_asked" });
    recordMetricEvent(tmpDir, { kind: "question_asked" });
    recordMetricEvent(tmpDir, { kind: "question_answered" });
    const m = readMetrics(tmpDir);
    expect(m.counts.questions.asked).toBe(2);
    expect(m.counts.questions.answered).toBe(1);
  });

  it("tracks horizon_check_requested and session_started totals", () => {
    recordMetricEvent(tmpDir, { kind: "horizon_check_requested" });
    recordMetricEvent(tmpDir, { kind: "horizon_check_requested" });
    recordMetricEvent(tmpDir, { kind: "session_started" });
    const m = readMetrics(tmpDir);
    expect(m.counts.horizonChecksRequested).toBe(2);
    expect(m.sessions).toBe(1);
  });

  it("updates lastActivityAt on every event but preserves firstSeenAt", async () => {
    recordMetricEvent(tmpDir, { kind: "session_started" });
    const first = readMetrics(tmpDir);
    // ensure the clock advances
    await new Promise((r) => setTimeout(r, 5));
    recordMetricEvent(tmpDir, { kind: "preflight_block", source: "session" });
    const second = readMetrics(tmpDir);
    expect(second.firstSeenAt).toBe(first.firstSeenAt);
    expect(second.lastActivityAt >= first.lastActivityAt).toBe(true);
  });

  it("persists atomically (re-read returns written values)", () => {
    recordMetricEvent(tmpDir, { kind: "preflight_block", source: "team" });
    const fileContent = fs.readFileSync(path.join(tmpDir, ".deeppairing", "metrics.json"), "utf-8");
    const parsed = JSON.parse(fileContent) as MetricsFile;
    expect(parsed.counts.preflightBlocks.bySource.team).toBe(1);
  });
});
