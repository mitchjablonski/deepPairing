import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonBeforeAll, test } from "../test.js";
import { spawnDiagnosticProcess, teardownDaemon } from "../daemon-harness.js";

const daemonJs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/daemon/index.js");
let proc: ChildProcess | undefined;
let home: string;
let projectRoot: string;

async function waitUntilReachable(): Promise<void> {
  const daemonJson = path.join(projectRoot, ".deeppairing", "daemon.json");
  for (let i = 0; i < 100; i++) {
    try {
      const info = JSON.parse(fs.readFileSync(daemonJson, "utf8"));
      if (info.port && (await fetch(`http://127.0.0.1:${info.port}/api/daemon-info`)).ok) return;
    } catch { /* daemon is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("real daemon did not become reachable for the timeout probe");
}

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(10_000);
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dp-hook-timeout-home-"));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-hook-timeout-root-"));
  proc = spawnDiagnosticProcess(process.execPath, [daemonJs], {
    env: { ...process.env, HOME: home, DEEPPAIRING_PROJECT_ROOT: projectRoot, DEEPPAIRING_NO_OPEN: "1" },
  });
  await waitUntilReachable();
});

daemonBeforeAll(() => [proc], async (testInfo) => {
  testInfo.setTimeout(1_500);
  await new Promise(() => undefined);
});

test.afterAll(async () => {
  await teardownDaemon(proc, undefined, { timeoutMs: 1_000 });
  for (const dir of [projectRoot, home]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("never starts because beforeAll times out", () => undefined);
