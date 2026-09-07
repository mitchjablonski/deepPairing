import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileStore } from "../src/store/file-store.js";
import { setGlobalStoreForTests } from "../src/store/global-store.js";
import { teardownDaemon, portOf } from "./daemon-harness.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const daemonJs = path.resolve(__dir, "../dist/daemon/index.js");
const FROZEN = "frozen-browser";
const HEALTHY = "healthy-browser";

let proc: ChildProcess | undefined;
let projectRoot: string;
let home: string;
let baseURL: string;
let authToken: string;
let projectHash: string;

async function post(sessionId: string, suffix: string, body: unknown): Promise<Response> {
  return fetch(`${baseURL}/api/internal/sessions/${sessionId}/${suffix}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
      "X-Project-Hash": projectHash,
    },
    body: JSON.stringify(body),
  });
}

test.beforeAll(async () => {
  if (!fs.existsSync(daemonJs)) throw new Error(`Missing ${daemonJs}; run pnpm build first.`);
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dp-refusal-home-"));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-refusal-browser-"));
  setGlobalStoreForTests(path.join(home, "test-ledger.json"));
  proc = spawn(process.execPath, [daemonJs], {
    env: {
      ...process.env,
      HOME: home,
      DEEPPAIRING_PROJECT_ROOT: projectRoot,
      DEEPPAIRING_NO_OPEN: "1",
      DEEPPAIRING_PORT_BASE: "53000",
      DEEPPAIRING_PORT_SPAN: "1000",
    },
    stdio: "ignore",
  });

  const infoPath = path.join(projectRoot, ".deeppairing", "daemon.json");
  for (let i = 0; i < 120 && !baseURL; i++) {
    try {
      const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
      const response = await fetch(`http://localhost:${info.port}/api/daemon-info`).catch(() => null);
      if (response?.ok && info.authToken) {
        const daemonInfo = await response.json() as { projectHash: string };
        baseURL = `http://localhost:${info.port}`;
        authToken = info.authToken;
        projectHash = daemonInfo.projectHash;
      }
    } catch {}
    if (!baseURL) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!baseURL) throw new Error("daemon did not become reachable within 12s");

  for (const sessionId of [FROZEN, HEALTHY]) {
    const registered = await post(sessionId, "register", { title: sessionId });
    if (!registered.ok) throw new Error(`register ${sessionId} failed: ${registered.status}`);
  }
  const artifact = await post(FROZEN, "artifacts", {
    id: "reviewed", type: "code_change", title: "Reviewed change",
    content: { filePath: "a.ts", diff: "-a\n+b" },
  });
  if (!artifact.ok) throw new Error(`artifact seed failed: ${artifact.status}`);
  const healthyArtifact = await post(HEALTHY, "artifacts", {
    id: "healthy", type: "research", title: "Healthy session", content: {},
  });
  if (!healthyArtifact.ok) throw new Error(`healthy seed failed: ${healthyArtifact.status}`);
  const flushed = await post(FROZEN, "flush", {});
  if (!flushed.ok) throw new Error(`flush failed: ${flushed.status}`);

  const external = new FileStore(projectRoot, FROZEN);
  const changed = external.getArtifacts()[0]!;
  changed.content = { filePath: "a.ts", diff: "-a\n+external" };
  changed.version = 2;
  external.renameArtifact("reviewed", changed.title);
  external.forceFlush();
  external.dispose();

  const conflict = await post(FROZEN, "artifacts/reviewed/status", {
    status: "approved", reason: "ui_approve_button",
  });
  expect(conflict.status).toBe(409);
});

test.afterAll(async () => {
  await teardownDaemon(proc, portOf(baseURL));
  setGlobalStoreForTests(null);
  try { fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
});

test("browser shows the frozen session, does not hot-retry, and can switch healthy", async ({ page }) => {
  let sockets = 0;
  page.on("websocket", () => { sockets++; });
  await page.goto(baseURL, { waitUntil: "domcontentloaded" });

  const refusalToast = page.getByText("Session review conflict", { exact: true });
  await expect(refusalToast).toBeVisible();
  await expect(page.getByText(new RegExp(`session: ${FROZEN}`, "i"))).toBeVisible();
  await expect(page.getByText(/Reconnect attempts are paused/)).toBeVisible();
  const refusedSocketCount = sockets;
  await page.waitForTimeout(2500);
  expect(sockets).toBe(refusedSocketCount);

  await page.evaluate((sessionId) => (window as any).__dpConnectionStore.getState().switchSession(sessionId), HEALTHY);
  await expect.poll(() => page.evaluate(() => (window as any).__dpConnectionStore.getState().connected)).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__dpConnectionStore.getState().hydrated)).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__dpConnectionStore.getState().sessionId)).toBe(HEALTHY);
  await expect(page.getByRole("heading", { name: "Healthy session" })).toBeVisible();
});
