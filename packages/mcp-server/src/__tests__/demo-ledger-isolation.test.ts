/**
 * Demo-ledger isolation — field bug: `POST /api/demo/run` walked its scripted
 * rejection through a REAL FileStore on the REAL project root, so
 * recordRejectedApproach mirrored the demo's example stance into the user's
 * actual ~/.deeppairing/philosophy/v1.json (when the project had ledger
 * publish on) — and non-idempotently: every demo run minted a fresh
 * demo_<ts> sessionId, so the II6 (project, sessionId)-scoped dedupe never
 * matched and N runs stacked N duplicate instances of the same fake stance.
 * The advisory tier then cited this fake taste in real cross-project
 * sessions. The demo also wrote its scripted rejection into the project's
 * .deeppairing/preferences.json, arming the REAL preflight gate with
 * demo-fiction.
 *
 * These tests drive the REAL demo route on a full createDaemon composition
 * against scratch dirs (never the real HOME — the global-store singleton is
 * redirected to a scratch ledger path) and pin:
 *   1. two demo runs leave the scratch global ledger byte-identical (absent
 *      when it never existed);
 *   2. the project's preferences.json is untouched by a demo run;
 *   3. the demo UI still SHOWS the example stance — the drawer + digest
 *      payloads for a demo-scoped request carry it from demo/session state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDaemon, type Daemon } from "../daemon/create-daemon.js";
import { projectHashOf } from "../project-root.js";
import { setGlobalStoreForTests } from "../store/global-store.js";
import { __resetMetricsCacheForTests } from "../store/metrics-store.js";
import { DEFAULT_REJECTION_CONCEPT } from "../demo-script.js";

let tmpDir: string;
let ledgerPath: string;
let prefsPath: string;
let daemon: Daemon;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-demo-iso-"));
  ledgerPath = path.join(tmpDir, "scratch-home-philosophy.json");
  setGlobalStoreForTests(ledgerPath);
  // The field configuration under which the pollution happened: this project
  // has opted IN to publishing rejections into the cross-project ledger.
  prefsPath = path.join(tmpDir, ".deeppairing", "preferences.json");
  fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
  fs.writeFileSync(prefsPath, JSON.stringify({ globalLedgerPublish: true }, null, 2));
  daemon = createDaemon({
    projectRoot: tmpDir,
    authToken: "test-token",
    log: () => {},
    exitProcess: () => {},
    releaseListenSocket: () => {},
    env: {},
  });
});

afterEach(() => {
  vi.useRealTimers();
  for (const store of daemon.sessions.values()) store.dispose();
  daemon.dispose();
  __resetMetricsCacheForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  setGlobalStoreForTests(null);
});

/** POST /api/demo/run and play the whole scripted timeline out (fake time). */
async function runDemoToCompletion(): Promise<string> {
  vi.useFakeTimers();
  const res = await daemon.app.request("/api/demo/run", { method: "POST" });
  expect(res.status).toBe(200);
  const { sessionId } = await res.json();
  // The script's last step fires at t=5000ms; run well past it.
  await vi.advanceTimersByTimeAsync(6000);
  vi.useRealTimers();
  return sessionId as string;
}

describe("demo-ledger isolation — a demo run must never mutate the real ledger", () => {
  it("two demo runs leave the (absent) global ledger absent — no pollution, no duplication", async () => {
    expect(fs.existsSync(ledgerPath)).toBe(false);

    await runDemoToCompletion();
    await runDemoToCompletion();

    // Pre-fix failure mode: the file EXISTS and holds one duplicate instance
    // of the demo's example stance per run (distinct demo_<ts> sessionIds
    // defeat the II6 window dedupe).
    expect(fs.existsSync(ledgerPath)).toBe(false);
  });

  it("two demo runs leave an EXISTING global ledger byte-identical", async () => {
    // A real user's ledger with genuine history.
    const { GlobalStore } = await import("../store/global-store.js");
    new GlobalStore(ledgerPath).recordInstance("external cache service", {
      project: "real-project",
      sessionId: "s_real",
      verdict: "rejected",
      reason: "ops burden",
    });
    const before = fs.readFileSync(ledgerPath);

    await runDemoToCompletion();
    await runDemoToCompletion();

    const after = fs.readFileSync(ledgerPath);
    expect(after.equals(before)).toBe(true);
  });

  it("a demo run leaves the project's preferences.json untouched (no fake rejectedApproaches for the real preflight)", async () => {
    const before = fs.readFileSync(prefsPath, "utf-8");
    await runDemoToCompletion();
    // Flush any debounced writers so a pending write can't hide the mutation.
    for (const store of daemon.sessions.values()) store.forceFlush();
    expect(fs.readFileSync(prefsPath, "utf-8")).toBe(before);
  });

  it("the demo drawer payload still carries the example stance (served from demo/session state)", async () => {
    const sessionId = await runDemoToCompletion();

    const res = await daemon.app.request("/api/philosophy?limit=200", {
      headers: {
        "X-Project-Hash": projectHashOf(tmpDir),
        "X-Session-Id": sessionId,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const concepts = (body.entries as Array<{ concept: string; stance: string }>).map((e) => e.concept);
    expect(concepts).toContain(DEFAULT_REJECTION_CONCEPT);
    const demoEntry = (body.entries as Array<{ concept: string; stance: string; rejected: number }>).find(
      (e) => e.concept === DEFAULT_REJECTION_CONCEPT,
    )!;
    expect(demoEntry.stance).toBe("avoid");
    expect(demoEntry.rejected).toBe(1);

    // ...while the on-disk global ledger never learned it.
    expect(fs.existsSync(ledgerPath)).toBe(false);
  });

  it("the demo digest payload carries the example stance without touching the ledger", async () => {
    const sessionId = await runDemoToCompletion();

    const res = await daemon.app.request("/api/philosophy/digest?sinceDays=7", {
      headers: {
        "X-Project-Hash": projectHashOf(tmpDir),
        "X-Session-Id": sessionId,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const newConcepts = (body.newThisPeriod as Array<{ concept: string }>).map((e) => e.concept);
    expect(newConcepts).toContain(DEFAULT_REJECTION_CONCEPT);
    expect(fs.existsSync(ledgerPath)).toBe(false);
  });

  it("a NON-demo request does not see the demo overlay", async () => {
    await runDemoToCompletion();
    const res = await daemon.app.request("/api/philosophy?limit=200", {
      headers: { "X-Project-Hash": projectHashOf(tmpDir) },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const concepts = (body.entries as Array<{ concept: string }>).map((e) => e.concept);
    expect(concepts).not.toContain(DEFAULT_REJECTION_CONCEPT);
  });
});
