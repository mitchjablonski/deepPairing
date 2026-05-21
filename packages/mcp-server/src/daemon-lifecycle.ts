/**
 * Daemon lifecycle management — detect, spawn, and connect to the
 * shared deepPairing HTTP daemon process.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTokenSidecar } from "./daemon-token.js";

const __thisDir = path.dirname(fileURLToPath(import.meta.url));

export interface DaemonInfo {
  pid: number;
  port: number;
  startedAt: string;
  /**
   * II1 — shared secret required by every `/api/internal/*` route. Optional
   * because (a) older daemons running an older build won't have minted one
   * yet, and (b) test fixtures sometimes construct DaemonInfo without it.
   * When present, DaemonClient stamps `Authorization: Bearer <token>` on
   * every internal call; absence means the wrapper can't authenticate and
   * should refuse to proceed against that daemon.
   */
  authToken?: string;
  /** Daemon's projectRoot — included for adoption checks; same value as projectHashOf source. */
  projectRoot?: string;
}

const DAEMON_FILE = "daemon.json";
export const DEFAULT_PORT = 3847;
export const MAX_PORT_ATTEMPTS = 10;

function daemonInfoPath(projectRoot: string): string {
  return path.join(projectRoot, ".deeppairing", DAEMON_FILE);
}

function readDaemonInfo(projectRoot: string): DaemonInfo | null {
  const infoPath = daemonInfoPath(projectRoot);
  try {
    if (!fs.existsSync(infoPath)) return null;
    const info: DaemonInfo = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
    // III9 — on a non-POSIX project dir (WSL /mnt/c, NFS, SMB) the daemon
    // writes daemon.json WITHOUT the token (it can't hold 0600 there) and
    // stashes the token in a 0600 per-user runtime sidecar. Merge it back so
    // the wrapper can authenticate against /api/internal/*. The pid guard
    // rejects a stale sidecar left by a dead daemon of the same project.
    if (!info.authToken) {
      const sidecar = readTokenSidecar(projectRoot);
      if (sidecar?.authToken && (sidecar.pid === undefined || sidecar.pid === info.pid)) {
        info.authToken = sidecar.authToken;
      }
    }
    return info;
  } catch {
    return null;
  }
}

// II1 — removed wrapper-side writeDaemonInfo: it was overwriting the
// daemon's own daemon.json (which carries the authToken) with a salvage
// record that had no token. The daemon writes the canonical file on
// startup + every 30s heartbeat; wrappers only read.

/** Probe a port to check if a deepPairing daemon is responding. */
async function probeDaemon(port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`http://localhost:${port}/api/state`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/** Ask a running daemon who it is. Returns null if unreachable or not a deepPairing daemon.
 *  II1 — /api/daemon-info does NOT include the authToken (that's the whole point —
 *  the token is delivered via the file-system permission boundary, not over HTTP).
 *  This probe is only for "is something there + what project does it serve". */
export async function probeDaemonIdentity(port: number, timeoutMs = 1500): Promise<{ pid: number; projectRoot: string; startedAt: string } | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`http://localhost:${port}/api/daemon-info`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data: any = await res.json();
    if (typeof data?.pid !== "number" || typeof data?.projectRoot !== "string") return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * AA3 — cooperative-shutdown call to a squatter daemon.
 *
 * Doctor uses this to ask the squatting daemon to flush + exit cleanly
 * BEFORE falling back to SIGTERM. Confirms the pid before sending the
 * request (defends against PID reuse — the original daemon may have died
 * and the OS recycled the pid into something unrelated).
 *
 * Returns:
 *   "evicted"       — daemon flushed + exited; port should be free.
 *   "pid_mismatch"  — the pid on the daemon's /api/daemon-info no longer
 *                     matches expectedPid; refuse to evict (don't kill
 *                     a recycled pid that isn't ours).
 *   "no_daemon"     — port has no daemon listening.
 *   "refused"       — daemon is running but rejected the evict (older
 *                     daemon, missing the /api/evict route).
 */
export async function evictDaemon(
  port: number,
  expectedPid: number,
  timeoutMs = 2000,
): Promise<"evicted" | "pid_mismatch" | "no_daemon" | "refused"> {
  const id = await probeDaemonIdentity(port, timeoutMs);
  if (!id) return "no_daemon";
  if (id.pid !== expectedPid) return "pid_mismatch";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`http://localhost:${port}/api/evict`, {
      method: "POST",
      headers: { "X-DeepPairing-Confirm-Pid": String(expectedPid) },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) return "evicted";
    return "refused";
  } catch {
    return "refused";
  }
}

/**
 * Check if the daemon is running. Unlike the old version, this probes the
 * actual HTTP port rather than relying solely on the info file — if the
 * daemon is healthy but daemon.json is missing/stale, we still adopt it.
 *
 * N2.1: multi-project support — each project's daemon can bind a different
 * port (3847, 3848, …), so we sweep the range when daemon.json is missing
 * and only adopt a daemon whose /api/daemon-info reports OUR projectRoot.
 */
export async function isDaemonRunning(
  projectRoot: string,
  /** Optional port range override — primarily for tests so we don't hit 3847 in CI. */
  range: { start: number; count: number } = { start: DEFAULT_PORT, count: MAX_PORT_ATTEMPTS },
): Promise<DaemonInfo | null> {
  const info = readDaemonInfo(projectRoot);

  // Fast path: info file present — verify PID and probe port.
  if (info) {
    let pidAlive = false;
    try { process.kill(info.pid, 0); pidAlive = true; } catch {}
    if (pidAlive && await probeDaemon(info.port)) return info;
  }

  // Slow path: daemon.json missing or stale. Sweep the candidate port range
  // and adopt only a daemon whose projectRoot matches ours — otherwise we'd
  // latch onto another project's daemon on port 3847.
  for (let attempt = 0; attempt < range.count; attempt++) {
    const port = range.start + attempt;
    const identity = await probeDaemonIdentity(port);
    if (!identity) continue;
    if (identity.projectRoot !== projectRoot) continue;
    // II1 — the daemon's own writeDaemonInfo on startup + heartbeat is the
    // source of truth for `authToken`. Re-read daemon.json after confirming
    // a matching live daemon: it may have appeared between our first read
    // and this point (race during daemon startup) and it carries the token
    // we need to talk to /api/internal/*. Don't OVERWRITE the file from
    // the wrapper side — pre-II1 we wrote a token-less salvage record back,
    // which silently broke wrapper auth the next time it ran.
    const fresh = readDaemonInfo(projectRoot);
    if (fresh && fresh.pid === identity.pid && fresh.port === port) {
      return fresh;
    }
    const adopted: DaemonInfo = {
      pid: identity.pid,
      port,
      startedAt: identity.startedAt,
      projectRoot: identity.projectRoot,
    };
    // No token available — the caller (waitForDaemon) will poll a few more
    // times before timing out, giving the daemon's heartbeat a window to
    // land daemon.json.
    return adopted;
  }

  // Clean up stale info file now that we've confirmed no daemon is responding.
  if (info) {
    try { fs.unlinkSync(daemonInfoPath(projectRoot)); } catch {}
  }
  return null;
}

/** Wait for the daemon info file to appear (polls every 200ms). */
async function waitForDaemon(projectRoot: string, timeoutMs = 10000): Promise<DaemonInfo> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = await isDaemonRunning(projectRoot);
    if (info) return info;
    await new Promise((r) => setTimeout(r, 200));
  }

  // A4: informative timeout — include the port range we swept + anything
  // we can observe about what might be holding it.
  const hint = await describePortHolders(projectRoot);
  const first = DEFAULT_PORT;
  const last = DEFAULT_PORT + MAX_PORT_ATTEMPTS - 1;
  throw new Error(
    `deepPairing daemon did not become ready within ${timeoutMs}ms (swept ports ${first}–${last}).\n${hint}\n` +
    `Run 'npx deeppairing doctor' to diagnose, or check .deeppairing/daemon.log.`,
  );
}

/** Best-effort port-holder description for the timeout error. */
async function describePortHolders(projectRoot: string): Promise<string> {
  const parts: string[] = [];
  const info = readDaemonInfo(projectRoot);
  if (info) {
    let pidAlive = false;
    try { process.kill(info.pid, 0); pidAlive = true; } catch {}
    parts.push(
      pidAlive
        ? `daemon.json reports PID ${info.pid} on port ${info.port} (started ${info.startedAt}) but it is not responding on /api/state`
        : `daemon.json reports PID ${info.pid} but that process is gone`,
    );
  } else {
    parts.push("No daemon.json found.");
  }
  // Report what's holding each candidate port so the user can tell if 3847
  // is a different project's daemon vs. nothing.
  const observations: string[] = [];
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    const port = DEFAULT_PORT + attempt;
    const identity = await probeDaemonIdentity(port);
    if (identity) {
      const mine = identity.projectRoot === projectRoot ? " (this project)" : ` (other project: ${identity.projectRoot})`;
      observations.push(`  :${port} — deepPairing daemon, PID ${identity.pid}${mine}`);
    }
  }
  if (observations.length) {
    parts.push("Ports holding a daemon:");
    parts.push(...observations);
  } else {
    parts.push(`No daemons responding on ${DEFAULT_PORT}–${DEFAULT_PORT + MAX_PORT_ATTEMPTS - 1}.`);
  }
  return parts.join("\n");
}

/** Spawn the daemon as a detached background process. */
function spawnDaemon(projectRoot: string): { stderrTail: () => string } {
  const daemonScript = path.join(__thisDir, "../dist/daemon.js");
  const scriptPath = fs.existsSync(daemonScript)
    ? daemonScript
    : path.join(__thisDir, "daemon.js");

  const child = spawn("node", [scriptPath], {
    cwd: projectRoot,
    detached: true,
    // A3: capture stderr so we can distinguish "starting" from "dead" and
    // include the bind-failure message in timeout errors. Keep stdin/stdout
    // ignored.
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, DEEPPAIRING_PROJECT_ROOT: projectRoot },
  });

  let stderrBuf = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stderrBuf += text;
    // Cap buffer to avoid unbounded growth.
    if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
  });

  child.unref();
  return { stderrTail: () => stderrBuf };
}

/**
 * Ensure the daemon is running. If not, spawn it and wait for readiness.
 * Returns the daemon's port number.
 */
export async function ensureDaemon(projectRoot: string): Promise<DaemonInfo> {
  // A1: probe before spawn — adopts a live daemon even if daemon.json is missing.
  // II1 — returns DaemonInfo (not just port) so the caller can pick up
  // the authToken needed to talk to /api/internal/*. Old `: number` return
  // shape was a strict subset of what wrappers need now.
  const existing = await isDaemonRunning(projectRoot);
  if (existing) return existing;

  // Spawn daemon
  const { stderrTail } = spawnDaemon(projectRoot);

  // Wait for it to be ready
  try {
    return await waitForDaemon(projectRoot);
  } catch (err: any) {
    const tail = stderrTail().trim();
    if (tail) {
      throw new Error(`${err.message}\nDaemon stderr:\n${tail}`);
    }
    throw err;
  }
}
