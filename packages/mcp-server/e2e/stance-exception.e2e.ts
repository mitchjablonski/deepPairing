import { test, daemonBeforeAll, expect } from "./test.js";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { teardownDaemon, portOf, spawnDiagnosticProcess, withSetupDiagnostics } from "./daemon-harness.js";

/**
 * #470 slice 2 — "Allow this proposal once", end to end in a real headless
 * browser against a real daemon on an isolated temp project (HOME isolated,
 * NO_OPEN, the Playwright port window — never the product's 3847-3974).
 *
 * The agent side is driven over the internal API exactly as a wrapper would:
 * register (keeping the daemon-ISSUED registration token), record a block for
 * a held stance, and later claim the allowance through the operation route.
 * The human side is the companion UI: the hero toast's primary button, the
 * dialog, a typed reason, Enter.
 */
const __dir = path.dirname(fileURLToPath(import.meta.url));
const daemonJs = path.resolve(__dir, "../dist/daemon/index.js");

let proc: ChildProcess | undefined;
let projectRoot: string;
let home: string;
let baseURL: string;
let token: string;
let projectHash: string;
let registrationToken: string;
const SID = "stance";
const STANCE = "global mutable state";
const FINGERPRINT = "a".repeat(64);
const SNAPSHOT = {
  kind: "create", type: "code_change", title: "modify src/config.ts",
  content: { filePath: "src/config.ts", changeType: "modify", before: "let config = {};", after: "export function loadConfig() { return {}; }", reasoning: "Remove global mutable state from the config loader" },
  agentReasoning: "Remove global mutable state from the config loader",
};

async function waitForDaemon(root: string): Promise<{ base: string; token: string; hash: string }> {
  const daemonJson = path.join(root, ".deeppairing", "daemon.json");
  for (let i = 0; i < 120; i++) {
    try {
      const info = JSON.parse(fs.readFileSync(daemonJson, "utf-8"));
      if (info.port) {
        const res = await fetch(`http://localhost:${info.port}/api/daemon-info`);
        if (res.ok && info.authToken) {
          const di = (await res.json()) as { projectHash?: string };
          return { base: `http://localhost:${info.port}`, token: info.authToken, hash: di.projectHash ?? "" };
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("daemon did not come up");
}

const internal = (p: string, body: unknown) => fetch(`${baseURL}/api/internal/sessions/${SID}${p}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Project-Hash": projectHash, "X-DeepPairing-Registration": registrationToken },
  body: JSON.stringify(body),
});

daemonBeforeAll(() => [proc], async (testInfo) => {
  if (!fs.existsSync(daemonJs)) throw new Error(`dist/daemon/index.js missing at ${daemonJs} — run \`pnpm build\` first.`);
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dp-stance-home-"));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-stance-"));
  proc = spawnDiagnosticProcess(process.execPath, [daemonJs], {
    env: { ...process.env, HOME: home, DEEPPAIRING_PROJECT_ROOT: projectRoot, DEEPPAIRING_NO_OPEN: "1", BROWSER: "none" },
  });
  const daemon = await withSetupDiagnostics(proc, testInfo, () => waitForDaemon(projectRoot));
  baseURL = daemon.base;
  token = daemon.token;
  projectHash = daemon.hash;
  const port = Number(new URL(baseURL).port);
  if (port >= 3847 && port <= 3974) throw new Error(`refusing the product port window: ${port}`);

  const reg = await fetch(`${baseURL}/api/internal/sessions/${SID}/register`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Project-Hash": projectHash }, body: "{}",
  });
  if (!reg.ok) throw new Error(`register failed: ${reg.status}`);
  registrationToken = ((await reg.json()) as { registrationToken: string }).registrationToken;
  const rej = await internal("/memory/rejected", { description: STANCE, concept: STANCE, reason: "hard to test" });
  if (!rej.ok) throw new Error(`stance seed failed: ${rej.status}`);
});

test.afterAll(async () => {
  await teardownDaemon(proc, portOf(baseURL));
  try { fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
});

test("allow once: the hero toast's primary button → dialog → reason + Enter → the agent's claim admits exactly the allowed snapshot", async ({ page }) => {
  await page.goto(`${baseURL}/?session=${SID}`);
  await page.waitForLoadState("networkidle");

  // The agent's refused call reaches the daemon (as preflightRejectedApproaches sends it).
  const prefs = JSON.parse(fs.readFileSync(path.join(projectRoot, ".deeppairing", "preferences.json"), "utf8"));
  const row = prefs.rejectedApproaches.find((r: { description: string }) => r.description === STANCE);
  const blocked = await internal("/preflight-block", {
    type: "preflight_blocked", toolName: "present_code_change", source: "session",
    match: { proposal: SNAPSHOT.content.reasoning, description: STANCE, concept: STANCE, reason: "hard to test", via: "surface", rejectedAt: row.rejectedAt },
    callFingerprint: FINGERPRINT, snapshot: SNAPSHOT, preconditions: [],
  });
  expect(blocked.ok).toBe(true);

  // Human side: the primary action is a real ≥32px target, and Retire is not on the toast.
  const allow = page.getByRole("button", { name: "Allow this proposal once" });
  await allow.waitFor({ timeout: 15_000 });
  const box = await allow.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(32);
  expect(box!.height).toBeGreaterThanOrEqual(32);
  await expect(page.getByRole("button", { name: /retire/i })).toHaveCount(0);
  await allow.click();

  const dialog = page.getByRole("dialog", { name: `Allow one proposal past '${STANCE}'` });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("heading", { name: `Allow one proposal past '${STANCE}'` })).toBeFocused();
  await expect(dialog.getByTestId("allow-once-diff")).toContainText("+ export function loadConfig() { return {}; }");
  // Enter with no reason does nothing.
  await dialog.getByRole("textbox").focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox").fill("this removes the global state");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);

  const list = async () => ((await (await fetch(`${baseURL}/api/stance-exceptions`, { headers: { "X-Project-Hash": projectHash } })).json()) as { allowances: Array<{ id: string; state: string; grantedVia: string }> }).allowances;
  await expect.poll(async () => (await list())[0]?.state, { timeout: 10_000 }).toBe("allowed");
  const allowance = (await list())[0]!;
  expect(allowance.grantedVia).toBe("ui");

  // Agent side: the identical retry claims it through the operation route.
  const op = await internal("/operations/op_e2e_1", {
    callFingerprint: FINGERPRINT,
    admission: { exceptionIds: [allowance.id], toolName: "present_code_change", snapshot: SNAPSHOT, preconditions: [] },
  });
  const outcome = (await op.json()) as { status: string; artifactId: string };
  expect(outcome.status).toBe("admitted");

  // The admitted artifact carries its persistent badge in the UI.
  await page.waitForSelector(`[data-artifact-id="${outcome.artifactId}"]`, { timeout: 15_000 }).catch(async () => {
    await page.getByRole("button", { name: /^modify src\/config\.ts/ }).first().click();
  });
  await expect(page.getByTestId("allowed-once-badge")).toHaveText("Allowed once (UI)", { timeout: 15_000 });
  await expect.poll(async () => (await list())[0]?.state, { timeout: 10_000 }).toBe("used");
  await expect(page.locator("body")).not.toContainText(/verified/i);
});
