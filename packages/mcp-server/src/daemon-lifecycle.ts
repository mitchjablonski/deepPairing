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

function daemonInfoPath(projectRoot: string): string {
  return path.join(projectRoot, ".deeppairing", DAEMON_FILE);
}

/** Check if the daemon is running for this project */
export function isDaemonRunning(projectRoot: string): DaemonInfo | null {
  const infoPath = daemonInfoPath(projectRoot);
  try {
    if (!fs.existsSync(infoPath)) return null;
    const info: DaemonInfo = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
    // Verify PID is alive
    try {
      process.kill(info.pid, 0);
      return info;
    } catch {
      // PID is dead — stale file
      fs.unlinkSync(infoPath);
      return null;
    }
  } catch {
    return null;
  }
}

/** Wait for the daemon info file to appear (polls every 200ms) */
async function waitForDaemon(projectRoot: string, timeoutMs = 10000): Promise<DaemonInfo> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = isDaemonRunning(projectRoot);
    if (info) {
      // Verify the HTTP server is actually responding
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(`http://localhost:${info.port}/api/state`, {
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (res.ok) return info;
      } catch {
        // Not ready yet — keep waiting
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Daemon failed to start within ${timeoutMs}ms`);
}

/** Spawn the daemon as a detached background process */
function spawnDaemon(projectRoot: string): void {
  const daemonScript = path.join(__thisDir, "../dist/daemon.js");
  // Fallback: try relative to this file (for ts-node / tsx dev mode)
  const scriptPath = fs.existsSync(daemonScript)
    ? daemonScript
    : path.join(__thisDir, "daemon.js");

  const child = spawn("node", [scriptPath], {
    cwd: projectRoot,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, DEEPPAIRING_PROJECT_ROOT: projectRoot },
  });
  child.unref();
}

/**
 * Ensure the daemon is running. If not, spawn it and wait for readiness.
 * Returns the daemon's port number.
 */
export async function ensureDaemon(projectRoot: string): Promise<number> {
  // Check if already running
  const existing = isDaemonRunning(projectRoot);
  if (existing) {
    // Verify it's actually responding
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`http://localhost:${existing.port}/api/state`, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) return existing.port;
    } catch {
      // PID alive but not responding — stale, clean up and respawn
      try { fs.unlinkSync(daemonInfoPath(projectRoot)); } catch {}
    }
  }

  // Spawn daemon
  spawnDaemon(projectRoot);

  // Wait for it to be ready
  const info = await waitForDaemon(projectRoot);
  return info.port;
}
