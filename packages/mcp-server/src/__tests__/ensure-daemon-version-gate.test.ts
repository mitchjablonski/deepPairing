/**
 * #157 / #136 — drive the REAL `ensureDaemon` against a REAL spawned
 * old-version daemon and prove the version gate replaces it.
 *
 * Why this exists: `ensureDaemon`'s call to `resolveStaleDaemon`
 * (daemon/lifecycle.ts) had ZERO test callers — a mutation audit replaced it
 * with the pre-#136 `if (existing) return existing;` and the whole suite
 * stayed green. That mutation means every plugin update silently re-adopts
 * the stale daemon and keeps serving pre-fix behavior forever.
 *
 * Shape (tsx-spawn pattern from daemon-version-exposure.test.ts): spawn a
 * REAL daemon composed by the production factory but advertising v0.0.9
 * (see fixtures/old-version-daemon.fixture.ts — the version seam exists
 * because a genuinely old build can't be spawned from current source), then
 * call the real ensureDaemon:
 *
 *   - correct code → resolveStaleDaemon confirms identity over HTTP,
 *     SIGTERMs the old pid, waits for port release, spawns a fresh daemon
 *     from dist → the OLD PID IS GONE (and, when dist exists, the returned
 *     daemon is a NEW pid on the CURRENT version);
 *   - mutated code → ensureDaemon returns the old daemon's info immediately,
 *     the old pid is still alive → the assertions below fail.
 *
 * SLOW: spawns up to two real processes (marked with a long timeout, like
 * the other tsx-spawn integration tests in this directory).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { ensureDaemon, type DaemonInfo } from "../daemon/lifecycle.js";
import { SERVER_VERSION } from "../version.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const fixtureEntry = path.resolve(__dir, "fixtures/old-version-daemon.fixture.ts");
const tsxBin = path.resolve(__dir, "../../node_modules/.bin/tsx");
// ensureDaemon's fresh spawn runs `node dist/daemon/index.js`. CI's `pnpm test`
// task depends on build (turbo.json), so dist exists there; a bare local
// `vitest run` on an unbuilt checkout degrades to the throw path, which the
// assertions below still handle (the KILL of the stale daemon is asserted in
// both worlds — that is the mutation-killing check).
const distDaemonEntry = path.resolve(__dir, "../../dist/daemon/index.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function portAccepts(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let settled = false;
    const done = (accepts: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(accepts);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await sleep(100);
  }
  return false;
}

/** Kill a daemon by pid and block until it is gone + its port refuses. */
async function killDaemon(pid: number | undefined, port: number | undefined): Promise<void> {
  if (!pid) return;
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  await waitFor(async () => !pidAlive(pid) && (port === undefined || !(await portAccepts(port))), 5000);
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

beforeEach(() => {
  // Scratch HOMEs for everything this test spawns (global-store guard rule):
  // the fresh daemon ensureDaemon spawns inherits process.env, so route any
  // HOME/XDG writes into disposable dirs and suppress the browser auto-open.
  const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), "dp-gate-home-"));
  const scratchRuntime = fs.mkdtempSync(path.join(os.tmpdir(), "dp-gate-xdg-"));
  vi.stubEnv("HOME", scratchHome);
  vi.stubEnv("XDG_RUNTIME_DIR", scratchRuntime);
  vi.stubEnv("DEEPPAIRING_NO_OPEN", "1");
  // unstubEnvs: true in the server vitest project restores these; the scratch
  // dirs live in os.tmpdir and are pruned with the projectRoot below.
});

describe("#136 — ensureDaemon version-gates adoption (REAL spawn)", () => {
  it("replaces a running old-version daemon instead of silently adopting it", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-gate-"));
    const infoPath = path.join(projectRoot, ".deeppairing", "daemon.json");
    let fixtureProc: ChildProcess | undefined;
    let oldInfo: { pid: number; port: number; version?: string } | null = null;
    let freshInfo: DaemonInfo | null = null;

    try {
      // 1. Spawn the REAL old-version daemon (v0.0.9) for this projectRoot.
      fixtureProc = spawn(tsxBin, [fixtureEntry], {
        env: {
          ...process.env,
          DEEPPAIRING_PROJECT_ROOT: projectRoot,
          DEEPPAIRING_FIXTURE_VERSION: "0.0.9",
        },
        stdio: "ignore",
      });
      const up = await waitFor(async () => {
        if (!fs.existsSync(infoPath)) return false;
        try {
          const parsed = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
          if (!parsed.port || !(await portAccepts(parsed.port))) return false;
          oldInfo = parsed;
          return true;
        } catch {
          return false; // mid-write — retry
        }
      }, 35_000); // tsx cold-start on WSL /mnt/c (9P) can exceed the old 20s under full-run contention
      expect(up, "old-version fixture daemon did not come up").toBe(true);
      expect(oldInfo!.version).toBe("0.0.9");
      const oldPid = oldInfo!.pid;
      const oldPort = oldInfo!.port;
      expect(pidAlive(oldPid)).toBe(true);

      // 2. Drive the REAL ensureDaemon. Correct code: resolveStaleDaemon
      //    re-confirms the daemon over HTTP, SIGTERMs it, waits for port
      //    release, then spawns a fresh current-version daemon.
      let threw: unknown = null;
      try {
        freshInfo = await ensureDaemon(projectRoot);
      } catch (err) {
        threw = err; // no dist on an unbuilt checkout — handled below
      }

      // 3. THE MUTATION-KILLING ASSERTION. Under the audited mutation
      //    (`if (existing) return existing;`) ensureDaemon returns the OLD
      //    daemon untouched: oldPid is still alive and freshInfo.pid ===
      //    oldPid — both checks below fail.
      expect(
        pidAlive(oldPid),
        `stale v0.0.9 daemon (pid ${oldPid}) must be terminated by the version gate`,
      ).toBe(false);

      if (fs.existsSync(distDaemonEntry)) {
        // Built checkout (CI always is — turbo test dependsOn build): the
        // full path must complete with a NEW, CURRENT-version daemon.
        expect(threw, "ensureDaemon should succeed when dist exists").toBeNull();
        expect(freshInfo).not.toBeNull();
        expect(freshInfo!.pid).not.toBe(oldPid);
        expect(freshInfo!.version).toBe(SERVER_VERSION);
      } else {
        // Unbuilt checkout: the gate still killed the stale daemon (asserted
        // above); the fresh spawn then failed to materialize, which
        // ensureDaemon surfaces as a timeout error.
        expect(threw).not.toBeNull();
      }
      // Either way the stale port must no longer be served by the old process
      // (a fresh daemon may have legitimately re-bound the same preferred port).
      if (freshInfo === null) {
        expect(await portAccepts(oldPort)).toBe(false);
      }
    } finally {
      // Kill everything we spawned: the fixture (if the gate somehow left it
      // alive — e.g. under the mutation) and the fresh daemon (if any).
      try { fixtureProc?.kill("SIGKILL"); } catch { /* gone */ }
      const oi = oldInfo as { pid: number; port: number } | null;
      if (oi) await killDaemon(oi.pid, oi.port);
      if (freshInfo) await killDaemon(freshInfo.pid, freshInfo.port);
      // Belt: whatever daemon.json points at now, take it down too.
      try {
        const last = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
        await killDaemon(last.pid, last.port);
      } catch { /* none left */ }
      fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 90_000);
});
