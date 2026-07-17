/**
 * #161 — the doctor's cooperative evict, end-to-end against the REAL daemon
 * composition (createDaemon, importable since #157/#178) over a real socket.
 *
 * Field bug this pins: `/api/evict` is registered on the root app AFTER the
 * public sub-app mount, so the sub-app's `use("*")` middleware — the AA4
 * X-Project-Hash gate and the SP1 bearer gate — also runs for it (evict is not
 * on the bootstrap exemption list, deliberately). `evictDaemon` used to send
 * ONLY `X-DeepPairing-Confirm-Pid`, so every cooperative evict 403'd
 * (project_hash_mismatch) and the doctor silently degraded to its SIGTERM
 * fallback — the graceful flush + `daemon_evicting` broadcast never ran in
 * production. The fix makes evictDaemon resolve the target daemon's hash +
 * bearer token (via daemonAuthHeaders, from the projectRoot the daemon itself
 * advertises on /api/daemon-info) the same way DaemonClient does.
 *
 * The unit tests in __tests__/evict-daemon.test.ts pin evictDaemon's wire
 * discriminators against a FAKE ungated daemon; this file is the one that
 * would have caught #161 — a real gated daemon, real HTTP.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { serve } from "@hono/node-server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDaemon, type Daemon } from "../create-daemon.js";
import { evictDaemon } from "../lifecycle.js";
import { setGlobalStoreForTests } from "../../store/global-store.js";
import { __resetMetricsCacheForTests } from "../../store/metrics-store.js";
import { ERROR_CODES } from "../../error-codes.js";

// port 0 — OS-assigned per test (was a hardcoded 24880; hardcoded slots raced
// parallel workers and leftover listeners for the same bind).
let TEST_PORT = 0;
const AUTH_TOKEN = "evict-e2e-token";

let tmpDir: string;
let daemon: Daemon;
let exits: number[];
let releases: Array<{ closeWs?: boolean } | undefined>;
let server: { close?: (cb?: () => void) => void } | null = null;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-evict-e2e-"));
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
  exits = [];
  releases = [];
  daemon = createDaemon({
    projectRoot: tmpDir,
    authToken: AUTH_TOKEN,
    log: () => {},
    // Recorder fakes — the evict route must exit through the SEAM, never the
    // real process.exit (which would kill the test runner on success).
    exitProcess: (code) => exits.push(code),
    releaseListenSocket: (opts) => releases.push(opts),
    env: {},
  });
  // The listeningListener resolves with the bound port — no bind race to
  // sleep over, and no hardcoded slot to collide on.
  TEST_PORT = await new Promise<number>((resolve) => {
    server = serve({ fetch: daemon.app.fetch, port: 0 }, (info) => resolve(info.port));
  });
  // The production startup step evictDaemon depends on: daemon.json (which
  // carries the bearer token on a POSIX tmpdir — the III9 in-repo placement)
  // is what daemonAuthHeaders resolves the token from.
  daemon.writeDaemonInfo(TEST_PORT);
});

afterEach(async () => {
  for (const store of daemon.sessions.values()) store.dispose();
  daemon.dispose();
  if (server) {
    await new Promise<void>((resolve) => {
      try { server!.close?.(() => resolve()); } catch { resolve(); }
    });
    server = null;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  __resetMetricsCacheForTests();
  setGlobalStoreForTests(null);
});

describe("#161 — cooperative evict against the real gated daemon", () => {
  it("evictDaemon succeeds: 200, the flush ran, the exit seam fired (not the SIGTERM fallback)", async () => {
    // Seed an UNFLUSHED artifact so "the flush ran" is observable on disk.
    const store = daemon.createSession("s_evict");
    store.createArtifact({ id: "a_evict", type: "research", title: "Pending work", content: { summary: "s" } });

    const result = await evictDaemon(TEST_PORT, process.pid);

    // Pre-#161 this was "refused": the AA4 gate 403'd the hash-less call and
    // the doctor fell through to SIGTERM every single time.
    expect(result).toBe("evicted");

    // The evict handler released the HTTP listen socket FIRST — keeping the
    // WS clients open for the daemon_evicting broadcast grace (closeWs: false).
    expect(releases).toEqual([{ closeWs: false }]);

    // cleanup() ran: the pending session state was force-flushed to disk…
    expect(
      fs.existsSync(path.join(tmpDir, ".deeppairing", "sessions", "s_evict", "artifacts.json")),
    ).toBe(true);
    // …and daemon.json was removed (only the evict path's cleanup does that).
    expect(fs.existsSync(path.join(tmpDir, ".deeppairing", "daemon.json"))).toBe(false);

    // The exit goes through the injected seam after the 250ms broadcast grace.
    await vi.waitFor(() => expect(exits).toEqual([0]), { timeout: 2000 });
  });

  it("pins the gate: a confirm-pid-only call (the pre-#161 caller) still 403s with project_hash_mismatch", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/evict`, {
      method: "POST",
      headers: { "X-DeepPairing-Confirm-Pid": String(process.pid) },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe(ERROR_CODES.project_hash_mismatch);
    // The gate fired BEFORE the handler: no exit scheduled, no socket released.
    expect(exits).toEqual([]);
    expect(releases).toEqual([]);
  });

  it("pins the second layer: hash without the bearer token is a 401 (SP1), not an evict", async () => {
    const infoRaw = fs.readFileSync(path.join(tmpDir, ".deeppairing", "daemon.json"), "utf-8");
    const projectHash = (await (await fetch(`http://localhost:${TEST_PORT}/api/daemon-info`)).json() as { projectHash: string }).projectHash;
    expect(infoRaw).toContain(AUTH_TOKEN); // sanity: token really lives in daemon.json here
    const res = await fetch(`http://localhost:${TEST_PORT}/api/evict`, {
      method: "POST",
      headers: {
        "X-DeepPairing-Confirm-Pid": String(process.pid),
        "X-Project-Hash": projectHash,
      },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code?: string }).code).toBe(ERROR_CODES.daemon_auth_required);
    expect(exits).toEqual([]);
  });
});
