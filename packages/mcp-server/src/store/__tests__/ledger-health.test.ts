import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { GlobalStore } from "../global-store.js";
import { buildLedgerHealthReport, shQuote } from "../ledger-health.js";

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

describe("shQuote — the printed remedy must round-trip a hostile path", () => {
  it("wraps + escapes so a single-quote/space path can't break out of the quote", () => {
    // POSIX: 'o'\''brien' is the literal o'brien.
    expect(shQuote("o'brien ledger.json")).toBe("'o'\\''brien ledger.json'");
  });

  it.runIf(process.platform !== "win32")(
    "remedyCommand actually moves the file to asidePath even when the path has a ' and a space",
    () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      // A path with BOTH a single quote and a space — the exact shape that a
      // naive `mv '${p}'` silently retargets ($HOME=/tmp/o'brien).
      const hostilePath = path.join(tmpDir, "o'brien dir", "phil'osophy ledger.json");
      fs.mkdirSync(path.dirname(hostilePath), { recursive: true });
      fs.writeFileSync(hostilePath, "{ corrupt ");
      const hostileStore = new GlobalStore(hostilePath);
      const report = buildLedgerHealthReport(hostileStore);
      expect(report.state).toBe("frozen");
      expect(report.remedyCommand).toBeTruthy();

      // Run the emitted command verbatim through a POSIX shell.
      execFileSync("sh", ["-c", report.remedyCommand!]);

      // The file landed at the EXACT asidePath, and the original is gone —
      // proving the quoting addressed the real path, not a truncated one.
      expect(fs.existsSync(report.asidePath!)).toBe(true);
      expect(fs.existsSync(hostilePath)).toBe(false);
      expect(fs.readFileSync(report.asidePath!, "utf-8")).toBe("{ corrupt ");
      errSpy.mockRestore();
    },
  );
});
