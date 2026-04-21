/**
 * Daemon lifecycle management — detect, spawn, and connect to the
 * shared deepPairing HTTP daemon process.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __thisDir = path.dirname(fileURLToPath(import.meta.url));

export interface DaemonInfo {
  pid: number;
  port: number;
  startedAt: string;
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
    return JSON.parse(fs.readFileSync(infoPath, "utf-8"));
  } catch {
    return null;
  }
}

function writeDaemonInfo(projectRoot: string, info: DaemonInfo): void {
  const infoPath = daemonInfoPath(projectRoot);
  try {
    fs.mkdirSync(path.dirname(infoPath), { recursive: true });
    fs.writeFileSync(infoPath, JSON.stringify(info, null, 2));
  } catch {
    // Best-effort — daemon will rewrite on its heartbeat
  }
}

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

/** Ask a running daemon who it is. Returns null if unreachable or not a deepPairing daemon. */
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
    const adopted: DaemonInfo = {
      pid: identity.pid,
      port,
      startedAt: identity.startedAt,
    };
    writeDaemonInfo(projectRoot, adopted);
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
export async function ensureDaemon(projectRoot: string): Promise<number> {
  // A1: probe before spawn — adopts a live daemon even if daemon.json is missing.
  const existing = await isDaemonRunning(projectRoot);
  if (existing) return existing.port;

  // Spawn daemon
  const { stderrTail } = spawnDaemon(projectRoot);

  // Wait for it to be ready
  try {
    const info = await waitForDaemon(projectRoot);
    return info.port;
  } catch (err: any) {
    const tail = stderrTail().trim();
    if (tail) {
      throw new Error(`${err.message}\nDaemon stderr:\n${tail}`);
    }
    throw err;
  }
}
