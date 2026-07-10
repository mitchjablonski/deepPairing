/**
 * #136 — the REAL daemon must advertise its SERVER_VERSION on both surfaces a
 * wrapper's ensureDaemon can read it from:
 *   1. .deeppairing/daemon.json (so a probe reads it with no HTTP call), and
 *   2. GET /api/daemon-info (authoritative).
 *
 * Spawns the actual daemon from source under tsx (same approach as
 * daemon-sigterm-port-release.test.ts), so a regression that drops the version
 * stamp from either surface fails here — not just in a unit test against a fake.
 */
import { describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_VERSION } from "../version.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const daemonEntry = path.resolve(__dir, "../daemon/index.ts");
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

async function startDaemon(): Promise<{ proc: ChildProcess; port: number; projectRoot: string }> {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-136-"));
  const proc = spawn(tsxBin, [daemonEntry], {
    env: { ...process.env, DEEPPAIRING_PROJECT_ROOT: projectRoot, DEEPPAIRING_OPEN_BROWSER: "0" },
    stdio: "ignore",
  });
  const infoPath = path.join(projectRoot, ".deeppairing", "daemon.json");
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
  if (!port) {
    try { proc.kill("SIGKILL"); } catch { /* gone */ }
    fs.rmSync(projectRoot, { recursive: true, force: true });
    throw new Error("daemon did not become reachable within 20s");
  }
  return { proc, port, projectRoot };
}

describe("#136 — daemon advertises its version", () => {
  it("writes version into daemon.json AND returns it on /api/daemon-info", async () => {
    const { proc, port, projectRoot } = await startDaemon();
    try {
      // 1. daemon.json carries the version (no-HTTP probe path).
      const info = JSON.parse(
        fs.readFileSync(path.join(projectRoot, ".deeppairing", "daemon.json"), "utf-8"),
      );
      expect(info.version).toBe(SERVER_VERSION);

      // 2. /api/daemon-info is authoritative and agrees.
      const res = await fetch(`http://localhost:${port}/api/daemon-info`);
      expect(res.ok).toBe(true);
      const body = (await res.json()) as { version?: string; projectRoot?: string };
      expect(body.version).toBe(SERVER_VERSION);
      expect(body.projectRoot).toBe(projectRoot);
    } finally {
      try { proc.kill("SIGKILL"); } catch { /* gone */ }
      fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 40_000);
});
