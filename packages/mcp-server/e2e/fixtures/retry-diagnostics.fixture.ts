import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonBeforeAll, test, expect } from "../test.js";
import { portOf, spawnDiagnosticProcess, teardownDaemon, withSetupDiagnostics } from "../daemon-harness.js";

// The REAL daemon from the built dist, exactly as the e2e specs boot it.
const daemonJs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/daemon/index.js");

let proc: ChildProcess | undefined;
let home: string;
let projectRoot: string;
let baseURL: string | undefined;

async function waitForDaemon(root: string): Promise<string> {
  const daemonJson = path.join(root, ".deeppairing", "daemon.json");
  for (let i = 0; i < 120; i++) {
    try {
      const info = JSON.parse(fs.readFileSync(daemonJson, "utf-8"));
      if (info.port && (await fetch(`http://localhost:${info.port}/api/daemon-info`)).ok) {
        return `http://localhost:${info.port}`;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("daemon did not start");
}

daemonBeforeAll(() => [proc], async (testInfo) => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dp-retry-home-"));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-retry-"));
  proc = spawnDiagnosticProcess(process.execPath, [daemonJs], {
    env: { ...process.env, HOME: home, DEEPPAIRING_PROJECT_ROOT: projectRoot, DEEPPAIRING_NO_OPEN: "1" },
  });
  baseURL = await withSetupDiagnostics(proc, testInfo, () => waitForDaemon(projectRoot));
});

test.afterAll(async () => {
  await teardownDaemon(proc, portOf(baseURL));
  for (const dir of [projectRoot, home]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test("retains failed-attempt evidence when retry makes the run green", async ({ page }, testInfo) => {
  await page.goto(`${baseURL}/`);
  if (testInfo.retry === 0) {
    await page.evaluate(() => console.error("Cookie: sid=fixture-browser-secret"));
  }
  expect(testInfo.retry, "deliberate first-attempt failure").toBe(1);
});
