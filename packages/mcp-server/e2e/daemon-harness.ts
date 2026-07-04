import type { ChildProcess } from "node:child_process";
import net from "node:net";

/**
 * Shared e2e teardown barrier.
 *
 * Diagnosis (I1): each spec boots its own daemon (`node dist/daemon/index.js`
 * against a mkdtemp projectRoot) in beforeAll and tore it down in afterAll with
 * a FIRE-AND-FORGET `proc.kill()` — no wait for the process to actually exit or
 * for its port to be released. The daemon's SIGTERM handler runs cleanup
 * (forceFlush every session + unlink daemon.json) and only THEN process.exit(0),
 * all asynchronous relative to the test runner; the sole backstop if the signal
 * is missed is the 60s idle auto-shutdown. So a killed daemon keeps LISTENING
 * for a while after afterAll returns.
 *
 * Confirmed empirically on WSL: sampling `pgrep daemon/index.js` across a single
 * `workers:1` suite run showed 3-4 daemons ALIVE AT ONCE (should be <=1), and an
 * isolated a11y run spent ~20s in beforeAll waiting for a slow-to-bind daemon.
 * Because every daemon picks its port deterministically inside the shared
 * [3847, 3974] window (preferredPortFor -> forward-scan on EADDRINUSE), the next
 * spec's daemon contends with the still-dying previous one: EADDRINUSE rescans,
 * inflated startup latency, and an occasional degraded first render/connection
 * that trips the following spec's 15s selector/poll waits. Always green in
 * isolation or on rerun (the zombie has idle-shut by then); never on CI (the
 * suite is the whole job, one run, cold ports).
 *
 * The fix: block afterAll until the daemon is provably DOWN - the process has
 * exited AND the port refuses connections - before the next spec spawns. Bounded
 * so a wedged daemon can't hang the suite: SIGTERM, poll ~5s, then SIGKILL + a
 * short final wait.
 */

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
    socket.once("error", () => done(false)); // ECONNREFUSED etc. -> port is free
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

/** Has `pid` exited? kill(pid, 0) throws ESRCH once the process is gone/reaped. */
function pidGone(pid: number | undefined): boolean {
  if (pid === undefined) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Signal the daemon and BLOCK until it is fully down: the process has exited
 * AND its port no longer accepts connections. Hard timeout falls back to
 * SIGKILL, then waits a little longer. Safe to call with an undefined proc.
 *
 * @param port the daemon's bound port (parsed from the spec's baseURL), or
 *   undefined to wait on process-exit only.
 */
export async function teardownDaemon(
  proc: ChildProcess | undefined,
  port: number | undefined,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  if (!proc) return;
  const pid = proc.pid;
  const timeoutMs = opts.timeoutMs ?? 5000;

  // Latch the real exit even if kill(pid,0) is racy around reaping.
  let exited = false;
  proc.once("exit", () => {
    exited = true;
  });

  const isDown = async (): Promise<boolean> => {
    if (!(exited || pidGone(pid))) return false;
    if (port !== undefined && (await portAccepts(port))) return false;
    return true;
  };

  proc.kill("SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isDown()) return;
    await sleep(50);
  }

  // Wedged daemon - escalate and give the kernel a moment to reap + release.
  try {
    if (pid !== undefined) process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  const killDeadline = Date.now() + 2000;
  while (Date.now() < killDeadline) {
    if (await isDown()) return;
    await sleep(50);
  }
}

/** Parse the daemon port out of a `http://localhost:PORT` base URL. */
export function portOf(baseURL: string | undefined): number | undefined {
  if (!baseURL) return undefined;
  const p = Number(new URL(baseURL).port);
  return Number.isFinite(p) && p > 0 ? p : undefined;
}
