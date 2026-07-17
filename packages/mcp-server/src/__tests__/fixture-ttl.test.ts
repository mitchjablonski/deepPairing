/**
 * Leak-proofing for fixtures/old-version-daemon.fixture.ts: the TTL
 * self-destruct must fire EVEN WHILE THE FIXTURE IS SERVING. An aborted vitest
 * run (Ctrl-C, OOM, killed worker) skips the suite's finally-block SIGKILL —
 * four zombie fixtures from exactly that were found squatting the product's
 * canonical 3847-3974 window on a dev machine (pre-fix they also bound INSIDE
 * that window; see test-port-window.setup.ts).
 *
 * REAL spawn, short-TTL variant (DEEPPAIRING_FIXTURE_TTL_MS is a fixture env
 * knob): fake timers can't reach into a child process. The test proves the
 * exact leak-critical sequence — fixture binds, serves, writes daemon.json,
 * nobody kills it, and it still exits 0 on its own.
 *
 * Verified failing pre-fix: without the TTL the fixture serves forever and
 * waitExit times out.
 */
import { describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const fixtureEntry = path.resolve(__dir, "fixtures/old-version-daemon.fixture.ts");
const tsxBin = path.resolve(__dir, "../../node_modules/.bin/tsx");

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

function waitExit(proc: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (proc.exitCode !== null) return Promise.resolve(proc.exitCode);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("fixture did not exit in time — TTL leak")), timeoutMs);
    proc.once("exit", (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
}

describe("old-version-daemon fixture — TTL self-destruct", () => {
  it("exits 0 on its own after the TTL, even while actively serving", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-ttl-"));
    const infoPath = path.join(projectRoot, ".deeppairing", "daemon.json");
    // Long enough for a tsx cold start under WSL /mnt/c contention to come up
    // INSIDE the TTL (so the exit provably happens while serving), short
    // enough to keep the test quick.
    const TTL_MS = 25_000;
    const proc = spawn(tsxBin, [fixtureEntry], {
      env: {
        ...process.env,
        DEEPPAIRING_PROJECT_ROOT: projectRoot,
        DEEPPAIRING_FIXTURE_TTL_MS: String(TTL_MS),
      },
      stdio: "ignore",
    });

    try {
      // 1. It really came up and served (daemon.json + accepting socket) —
      //    i.e. the server handle is holding the event loop when the TTL fires.
      let port = 0;
      for (let i = 0; i < 200 && !port; i++) {
        if (fs.existsSync(infoPath)) {
          try {
            const info = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
            if (info.port && (await portAccepts(info.port))) port = info.port;
          } catch { /* mid-write — retry */ }
        }
        if (!port) await sleep(100);
      }
      expect(port, "fixture did not come up before the TTL").toBeGreaterThan(0);
      expect(proc.exitCode).toBeNull(); // still serving — TTL hasn't fired yet

      // 2. Nobody signals it — the TTL alone must take it down, cleanly.
      const code = await waitExit(proc, TTL_MS + 15_000);
      expect(code).toBe(0);

      // 3. The port it held is actually gone (no lingering listener).
      expect(await portAccepts(port)).toBe(false);
    } finally {
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      // Belt: SIGKILL on the tsx WRAPPER is not forwarded to its node child
      // (SIGKILL is uncatchable), which orphans the real daemon — the exact
      // zombie class this TTL exists for. Kill by the pid the daemon itself
      // wrote into daemon.json too.
      try {
        const info = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
        if (info.pid) process.kill(info.pid, "SIGKILL");
      } catch { /* no daemon.json or already gone */ }
      fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 60_000);
});
