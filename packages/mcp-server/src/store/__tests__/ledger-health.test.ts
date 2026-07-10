import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GlobalStore } from "../global-store.js";
import { buildLedgerHealthReport } from "../ledger-health.js";

/**
 * H2-1 (#144) — the fact-gathering behind `dp doctor`'s ledger-health check.
 * Report-only by design: the ledger is the single most precious file
 * deepPairing owns (months of taste, no other copy), so doctor NEVER
 * deletes/truncates it — it computes the exact non-destructive `mv` command and
 * the file's real shape for the human to run themselves. Fake, not mock: a real
 * GlobalStore over a tmp ledger.
 */
let tmpDir: string;
let ledgerPath: string;
let store: GlobalStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-ledger-health-"));
  ledgerPath = path.join(tmpDir, "philosophy.json");
  store = new GlobalStore(ledgerPath);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildLedgerHealthReport", () => {
  it("reports parses:true / state ok on a healthy ledger", () => {
    store.recordInstance("argon2id", { project: "p", sessionId: "s", verdict: "approved" });
    const report = buildLedgerHealthReport(store);
    expect(report.state).toBe("ok");
    expect(report.parses).toBe(true);
    expect(report.ledgerPath).toBe(ledgerPath);
    expect(report.remedyCommand).toBeUndefined();
  });

  it("on a frozen ledger: reports the size, a non-destructive mv remedy, and any .corrupt snapshots", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fs.writeFileSync(ledgerPath, "{ corrupt bytes ");
    const report = buildLedgerHealthReport(store);
    expect(report.state).toBe("frozen");
    expect(report.parses).toBe(false);
    expect(report.sizeBytes).toBe(fs.statSync(ledgerPath).size);
    // The remedy MOVES the file aside (never rm/truncate) and preserves it.
    expect(report.asidePath).toMatch(/\.unreadable-\d+$/);
    expect(report.remedyCommand).toContain("mv ");
    expect(report.remedyCommand).toContain(ledgerPath);
    expect(report.remedyCommand).not.toMatch(/\brm\b|>|truncate/);
    // markCorrupt left a `.corrupt-<ts>` snapshot next to it — the scan finds it.
    expect(report.corruptSnapshots.length).toBeGreaterThanOrEqual(1);
    expect(report.corruptSnapshots.every((p) => path.basename(p).startsWith("philosophy.json.corrupt-"))).toBe(true);
    errSpy.mockRestore();
  });
});
