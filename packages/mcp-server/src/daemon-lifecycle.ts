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
const DEFAULT_PORT = 3847;

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

/**
 * Check if the daemon is running. Unlike the old version, this probes the
 * actual HTTP port rather than relying solely on the info file — if the
 * daemon is healthy but daemon.json is missing/stale, we still adopt it.
 */
export async function isDaemonRunning(projectRoot: string): Promise<DaemonInfo | null> {
  const info = readDaemonInfo(projectRoot);

  // Fast path: info file present — verify PID and probe port.
  if (info) {
    let pidAlive = false;
    try { process.kill(info.pid, 0); pidAlive = true; } catch {}
    if (pidAlive && await probeDaemon(info.port)) return info;
  }

  // Probe the default port even if info file is missing or stale.
  if (await probeDaemon(DEFAULT_PORT)) {
    const adopted: DaemonInfo = {
      pid: info?.pid ?? 0,
      port: DEFAULT_PORT,
      startedAt: info?.startedAt ?? new Date().toISOString(),
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

  // A4: informative timeout — include the port + anything we can observe about
  // what might be holding it.
  const hint = await describePortHolder(DEFAULT_PORT, projectRoot);
  throw new Error(
    `deepPairing daemon did not become ready within ${timeoutMs}ms on port ${DEFAULT_PORT}.\n${hint}\n` +
    `Run 'npx deeppairing doctor' to diagnose, or check .deeppairing/daemon.log.`,
  );
}

/** Best-effort port-holder description for the timeout error. */
async function describePortHolder(port: number, projectRoot: string): Promise<string> {
  const parts: string[] = [];
  const info = readDaemonInfo(projectRoot);
  if (info) {
    let pidAlive = false;
    try { process.kill(info.pid, 0); pidAlive = true; } catch {}
    parts.push(
      pidAlive
        ? `daemon.json reports PID ${info.pid} (started ${info.startedAt}) but it is not responding on /api/state`
        : `daemon.json reports PID ${info.pid} but that process is gone`,
    );
  } else {
    parts.push("No daemon.json found.");
  }
  const responsive = await probeDaemon(port);
  parts.push(
    responsive
      ? `Port ${port} IS responding — something may have raced the readiness check. Retry.`
      : `Port ${port} is not accepting connections — the daemon either failed to bind or crashed on startup.`,
  );
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
