/**
 * I5 — SIGTERM releases the LISTEN socket BEFORE the flush.
 *
 * Root cause this guards: the SIGINT/SIGTERM handlers (and the idle + evict
 * exit paths) used to do `cleanup(); process.exit(0)` and NEVER call
 * server.close(). The HTTP/WS accept socket therefore stayed bound through
 * cleanup()'s synchronous per-session forceFlush loop, only releasing when the
 * process actually exited — so a fast-follow binder (multi-project port window,
 * restart, doctor probe, the e2e teardown barrier) could hit EADDRINUSE and
 * rescan/degrade. gracefulShutdown() now closes the accept socket FIRST.
 *
 * This spawns the REAL daemon from source (like the e2e specs spawn
 * dist/daemon/index.js), SIGTERMs it, and asserts:
 *   1. the bound port stops accepting connections promptly, AND
 *   2. the port is immediately re-bindable (the LISTEN socket is truly gone,
 *      not lingering until process teardown), AND
 *   3. the process exits 0.
 * Plus a double-SIGTERM spec proving the `shuttingDown` guard makes the second
 * signal a no-op (still a clean exit-0, no double-close throw).
 *
 * Reuses the port-probe approach from e2e/daemon-harness.ts. Runs the daemon
 * under tsx so it needs no prior `pnpm build` (the vitest suite runs before the
 * e2e build step).
 */
import { describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
// src/__tests__ -> src/daemon/index.ts (the same entry e2e builds to dist/daemon/index.js).
const daemonEntry = path.resolve(__dir, "../daemon/index.ts");
// packages/mcp-server/node_modules/.bin/tsx — package.json's `start`/.mcp.json
// run the daemon exactly this way, so tsx resolves its .js->.ts import graph.
const tsxBin = path.resolve(__dir, "../../node_modules/.bin/tsx");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Does anything accept a TCP connection on 127.0.0.1:port right now? */
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
    // Only an active refusal proves the port is free; any other error is
    // treated as still-bound (the outer deadline bounds total wait).
    socket.once("error", (err: NodeJS.ErrnoException) =>
      done(!(err.code === "ECONNREFUSED" || err.code === "ECONNRESET")),
    );
    socket.setTimeout(timeoutMs, () => done(true));
  });
}

/** Can we bind a fresh LISTEN socket on this port right now? Proves the daemon's socket is truly released. */
function portBindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve(true));
    });
  });
}

/** Spawn the real daemon on a mkdtemp projectRoot; resolve once it's bound + reachable. */
async function startDaemon(): Promise<{ proc: ChildProcess; port: number; projectRoot: string }> {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-i5-"));
  const proc = spawn(tsxBin, [daemonEntry], {
    env: {
      ...process.env,
      DEEPPAIRING_PROJECT_ROOT: projectRoot,
      DEEPPAIRING_OPEN_BROWSER: "0",
    },
    stdio: "ignore",
  });

  const infoPath = path.join(projectRoot, ".deeppairing", "daemon.json");
  let port = 0;
  // tsx cold-start + bind: poll up to ~35s — measured WSL /mnt/c (9P) full-run
  // contention pushed cold starts past the old 20s budget.
  for (let i = 0; i < 350 && !port; i++) {
    if (fs.existsSync(infoPath)) {
      try {
        const info = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
        if (info.port && (await portAccepts(info.port))) port = info.port;
      } catch {
        /* daemon.json mid-write — retry */
      }
    }
    if (!port) await sleep(100);
  }
  if (!port) {
    try { proc.kill("SIGKILL"); } catch { /* already gone */ }
    fs.rmSync(projectRoot, { recursive: true, force: true });
    throw new Error("daemon did not become reachable within 35s");
  }
  return { proc, port, projectRoot };
}

/** Resolve once the child has exited; returns its exit code (or null on signal). */
function waitExit(proc: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (proc.exitCode !== null) return Promise.resolve(proc.exitCode);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("daemon did not exit in time")), timeoutMs);
    proc.once("exit", (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
}

describe("I5 — daemon releases the LISTEN socket on SIGTERM before flush/exit", () => {
  it("stops accepting + becomes re-bindable promptly after SIGTERM, then exits 0", async () => {
    const { proc, port, projectRoot } = await startDaemon();
    try {
      expect(await portAccepts(port)).toBe(true); // sanity: it was really listening

      const t0 = Date.now();
      proc.kill("SIGTERM");

      // The accept socket should stop accepting quickly — server.close() fires
      // as the FIRST act of the handler, before the synchronous flush. Poll up
      // to 5s so a slow WSL teardown can't flake, but this is well under the
      // old "socket bound until process teardown" latency under any real flush.
      let released = false;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (!(await portAccepts(port))) {
          released = true;
          break;
        }
        await sleep(50);
      }
      const elapsed = Date.now() - t0;
      expect(released).toBe(true);
      // And the LISTEN slot is genuinely free for the next binder, not merely
      // refusing connects while a socket lingers in the exiting process.
      expect(await portBindable(port)).toBe(true);

      const code = await waitExit(proc, 5000);
      expect(code).toBe(0);
      // Diagnostic only (no hard upper bound beyond the 5s poll above): shows
      // the port-release latency the e2e teardown barrier now benefits from.
      console.log(`[I5] port ${port} released ${elapsed}ms after SIGTERM`);
    } finally {
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 60_000);

  it("a second SIGTERM is a no-op (shuttingDown guard) — still exits 0, no double-close throw", async () => {
    const { proc, port, projectRoot } = await startDaemon();
    try {
      // Two signals back-to-back: the guard must swallow the second rather than
      // re-running releaseListenSocket()/cleanup() (which would double-close and
      // could throw, tripping the uncaughtException guard into a non-zero exit).
      proc.kill("SIGTERM");
      proc.kill("SIGTERM");

      const code = await waitExit(proc, 8000);
      expect(code).toBe(0);
      expect(await portBindable(port)).toBe(true);
    } finally {
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 60_000);
});
