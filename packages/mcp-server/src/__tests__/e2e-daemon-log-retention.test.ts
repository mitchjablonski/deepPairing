/**
 * #341 — the e2e harness must retain the REAL daemon's diagnostics.
 *
 * The daemon writes almost nothing to stdout/stderr; its durable channel is
 * `<projectRoot>/.deeppairing/daemon.log`, which lives in a mkdtemp root the
 * specs delete at teardown. This boots the real daemon from source through the
 * same `spawnDiagnosticProcess` seam the e2e specs use and proves that the
 * failure-time attachment carries a bounded, redacted tail of that file —
 * alive, and again after SIGTERM but before the root is removed — without the
 * daemon's bearer token.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import type { TestInfo } from "@playwright/test";
import { attachDaemonOutput, spawnDiagnosticProcess, teardownDaemon } from "../../e2e/daemon-harness.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const daemonEntry = path.resolve(__dir, "../daemon/index.ts");
const tsxBin = path.resolve(__dir, "../../node_modules/.bin/tsx");
const sharedDist = path.resolve(__dir, "../../../shared/dist/index.js");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function waitForDaemon(projectRoot: string): Promise<{ port: number; token: string }> {
  const infoPath = path.join(projectRoot, ".deeppairing", "daemon.json");
  for (let i = 0; i < 350; i++) {
    try {
      const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
      if (info.port && info.authToken) {
        const res = await fetch(`http://127.0.0.1:${info.port}/api/daemon-info`);
        if (res.ok) return { port: info.port, token: info.authToken };
      }
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error("daemon did not become reachable within 35s");
}

function failedTestInfo(dir: string, attached: Record<string, string>): TestInfo {
  return {
    status: "failed",
    expectedStatus: "passed",
    outputPath: (name: string) => path.join(dir, name),
    attach: async (name: string, value: { path: string }) => {
      attached[name] = fs.readFileSync(value.path, "utf8");
    },
  } as unknown as TestInfo;
}

describe("#341 real daemon.log retention through the e2e harness", () => {
  it("attaches the real daemon's redacted log tail while alive and after SIGTERM", async () => {
    if (!fs.existsSync(sharedDist)) {
      throw new Error(`Missing ${sharedDist}; run \`pnpm build\` before this real-daemon test`);
    }
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-341-log-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dp-341-home-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-341-out-"));
    for (const dir of [projectRoot, home, outputDir]) {
      cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    }
    const proc: ChildProcess = spawnDiagnosticProcess(tsxBin, [daemonEntry], {
      env: { ...process.env, HOME: home, DEEPPAIRING_PROJECT_ROOT: projectRoot, DEEPPAIRING_NO_OPEN: "1" },
    });
    cleanups.push(() => teardownDaemon(proc, undefined, { timeoutMs: 3000 }));
    const { port, token } = await waitForDaemon(projectRoot);

    const alive: Record<string, string> = {};
    await attachDaemonOutput(proc, failedTestInfo(outputDir, alive));
    expect(Object.keys(alive)).toContain("daemon-log-diagnostics");
    const aliveLog = alive["daemon-log-diagnostics"];
    expect(aliveLog).toMatch(/\[daemon\] Daemon starting \(PID \d+\)/); // tsx wraps the daemon, so not proc.pid
    expect(aliveLog).toContain(`[daemon] Daemon running on http://localhost:${port}/`);
    expect(aliveLog).not.toContain("[daemon.log]"); // no missing/skipped/withheld notes on the happy path
    expect(aliveLog).not.toContain(token);
    expect(fs.existsSync(path.join(outputDir, "daemon-log-diagnostics.txt"))).toBe(true);

    await teardownDaemon(proc, port);
    const down: Record<string, string> = {};
    await attachDaemonOutput(proc, failedTestInfo(outputDir, down), { force: true });
    expect(down["daemon-log-diagnostics"]).toContain("[daemon] Shutting down (SIGTERM)");
    expect(down["daemon-log-diagnostics"]).not.toContain(token);
  }, 60_000);
});
