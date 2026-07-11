import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { teardownDaemon, portOf } from "./daemon-harness.js";

/**
 * #159 — the FULL review loop, end-to-end in a real browser. This is the
 * product's core promise (human reviews in the companion UI → agent iterates)
 * and until this spec every playwright test was boot/axe/render smoke — zero
 * clicks. One journey, four pins:
 *
 *   1. Clicking a decision option's real Select button resolves the decision
 *      (POST /api/decisions/:id through the injected hash + bearer).
 *   2. GET /api/decisions reflects the resolution IMMEDIATELY — the #151/#170
 *      live-merge regression pin (pre-#151 the project-wide view lagged the
 *      ~2-3s debounced decisions.json flush).
 *   3. Approving an artifact via the real footer button lands as
 *      status=approved in the daemon's store (the wrapper-visible truth).
 *   4. The "agent side" superseding it over the internal API (bearer-authed,
 *      exactly what revise_artifact mode='supersede' sends) is reflected live:
 *      the UI advances to v2 and v1 leaves the sidebar.
 */
const __dir = path.dirname(fileURLToPath(import.meta.url));
const daemonJs = path.resolve(__dir, "../dist/daemon/index.js");

let proc: ChildProcess | undefined;
let projectRoot: string;
// K2 — isolate HOME so nothing test-side can ever touch the real ~/.deeppairing.
let home: string;
let baseURL: string;
let token: string;
let projectHash: string;

const SID = "loop";

async function waitForDaemon(root: string): Promise<{ base: string; token: string; hash: string }> {
  const daemonJson = path.join(root, ".deeppairing", "daemon.json");
  for (let i = 0; i < 120; i++) {
    try {
      const info = JSON.parse(fs.readFileSync(daemonJson, "utf-8"));
      if (info.port) {
        const res = await fetch(`http://localhost:${info.port}/api/daemon-info`);
        // Internal seed routes are bearer-gated; on POSIX (CI + WSL dev) the
        // token lives in the project's daemon.json.
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

test.beforeAll(async () => {
  if (!fs.existsSync(daemonJs)) {
    throw new Error(`dist/daemon/index.js missing at ${daemonJs} — run \`pnpm build\` before the e2e suite.`);
  }
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dp-loop-home-"));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-loop-"));
  proc = spawn(process.execPath, [daemonJs], {
    // #152 — scripted start: never auto-open a browser from the suite.
    env: { ...process.env, HOME: home, DEEPPAIRING_PROJECT_ROOT: projectRoot, DEEPPAIRING_NO_OPEN: "1" },
    stdio: "ignore",
  });
  const daemon = await waitForDaemon(projectRoot);
  baseURL = daemon.base;
  token = daemon.token;
  projectHash = daemon.hash;

  // Seed the session the way a real wrapper does: register, then a decision
  // artifact + its DecisionRecord (present_options writes both), then a
  // reviewable research artifact.
  const h = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  const reg = await fetch(`${baseURL}/api/internal/sessions/${SID}/register`, { method: "POST", headers: h, body: "{}" });
  if (!reg.ok) throw new Error(`seed register failed: ${reg.status}`);

  const options = [
    { id: "opt_redis", title: "Redis", description: "External cache", pros: ["fast"], cons: ["ops"], effort: "low", risk: "low", recommendation: true },
    { id: "opt_inproc", title: "In-proc", description: "Process-local map", pros: ["simple"], cons: ["cold starts"], effort: "low", risk: "low", recommendation: false },
  ];
  await fetch(`${baseURL}/api/internal/sessions/${SID}/artifacts`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "dec_loop", type: "decision", title: "Pick a cache",
      content: { context: "Which cache fits?", decisionId: "d_loop", stakes: "medium", options },
    }),
  }).then((r) => { if (!r.ok) throw new Error(`seed decision artifact failed: ${r.status}`); });
  await fetch(`${baseURL}/api/internal/sessions/${SID}/decisions`, {
    method: "POST", headers: h,
    body: JSON.stringify({ decisionId: "d_loop", artifactId: "dec_loop", context: "Which cache fits?", stakes: "medium", options }),
  }).then((r) => { if (!r.ok) throw new Error(`seed decision record failed: ${r.status}`); });
  await fetch(`${baseURL}/api/internal/sessions/${SID}/artifacts`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "res_loop", type: "research", title: "Cache audit",
      content: { summary: "One hot path, no eviction policy.", findings: [{ category: "Performance", title: "Unbounded map", detail: "d", significance: "high" }] },
    }),
  }).then((r) => { if (!r.ok) throw new Error(`seed research failed: ${r.status}`); });
});

test.afterAll(async () => {
  // I1 — teardown BARRIER (see daemon-harness.ts): block until the daemon is
  // provably down so the next spec's daemon doesn't contend in [3847,3974].
  await teardownDaemon(proc, portOf(baseURL));
  try { fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
});

test("review loop: select a decision option, approve an artifact, agent supersedes to v2 — UI and persisted state agree", async ({ page }) => {
  await page.goto(`${baseURL}/?session=${SID}`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15_000 });

  // --- 1. Resolve the decision through the REAL Select button. -------------
  // The decision artifact was seeded first, so it's the auto-selected detail.
  const select = page.getByRole("button", { name: "Select Redis" });
  await select.waitFor({ timeout: 15_000 });
  await select.click();
  // The resolved card replaces the option grid once the POST succeeded.
  await expect(page.getByText("Decision Made")).toBeVisible({ timeout: 15_000 });

  // --- 2. #151/#170 pin: the project-wide decisions read is IMMEDIATE. -----
  // No waits, no reload: the live in-memory merge must already show the
  // resolution (the debounced decisions.json flush is ~2-3s away).
  const decRes = await page.request.get(`${baseURL}/api/decisions`, {
    headers: { "X-Project-Hash": projectHash },
  });
  expect(decRes.status()).toBe(200);
  const { decisions } = (await decRes.json()) as {
    decisions: Array<{ decisionId: string; resolved: boolean; chosenOptionTitle?: string }>;
  };
  const d = decisions.find((x) => x.decisionId === "d_loop");
  expect(d, "the seeded decision appears in the project-wide view").toBeTruthy();
  expect(d!.resolved, "resolved immediately after the click — the #151 live-merge pin").toBe(true);
  expect(d!.chosenOptionTitle).toBe("Redis");

  // --- 3. Approve the research artifact via the real footer button. --------
  // The sidebar row's accessible name is "<title> <status label>" — the
  // status suffix disambiguates it from the (identically-titled) pending-chip
  // buttons elsewhere in the chrome.
  await page.getByRole("button", { name: /^Cache audit Draft/ }).click();
  await page.waitForSelector('[data-artifact-id="res_loop"]', { timeout: 15_000 });
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("Approved", { exact: true })).toBeVisible({ timeout: 15_000 });
  // The wrapper-visible truth: the daemon's store now says approved.
  await expect
    .poll(async () => {
      const r = await fetch(`${baseURL}/api/internal/sessions/${SID}/artifacts`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const { artifacts } = (await r.json()) as { artifacts: Array<{ id: string; status: string }> };
      return artifacts.find((a) => a.id === "res_loop")?.status;
    }, { timeout: 10_000 })
    .toBe("approved");

  // --- 4. Agent side posts a v2 (the supersede wire sequence). -------------
  const h = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  const v2 = await fetch(`${baseURL}/api/internal/sessions/${SID}/artifacts`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "res_loop_v2", type: "research", title: "Cache audit v2",
      content: { summary: "Adds the eviction policy your note asked for.", findings: [{ category: "Performance", title: "Unbounded map", detail: "now bounded", significance: "high" }] },
      parentId: "res_loop", version: 2,
    }),
  });
  expect(v2.ok, "v2 create over the internal API").toBe(true);
  const sup = await fetch(`${baseURL}/api/internal/sessions/${SID}/artifacts/res_loop/status`, {
    method: "POST", headers: h,
    body: JSON.stringify({ status: "superseded", reason: "agent_supersede" }),
  });
  expect(sup.ok, "v1 flips to superseded").toBe(true);

  // The UI followed the WS events with no reload: selection auto-advances
  // from the superseded v1 to its v2 successor…
  await page.waitForSelector('[data-artifact-id="res_loop_v2"]', { timeout: 15_000 });
  await expect(page.locator('[data-artifact-id="res_loop"]')).toHaveCount(0);
  // …the sidebar lists the v2 draft…
  await expect(page.getByRole("button", { name: /^Cache audit v2 Draft/ })).toBeVisible();
  // …and the superseded v1 left the visible sidebar list (superseded
  // artifacts are filtered out of it; only its v2 row remains).
  await expect(page.getByRole("button", { name: /^Cache audit Draft/ })).toHaveCount(0);

  // Persisted truth for the whole loop: v1 superseded, v2 a live draft.
  const finalRes = await fetch(`${baseURL}/api/internal/sessions/${SID}/artifacts`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const { artifacts } = (await finalRes.json()) as {
    artifacts: Array<{ id: string; status: string; version: number; parentId: string | null }>;
  };
  expect(artifacts.find((a) => a.id === "res_loop")?.status).toBe("superseded");
  const v2Persisted = artifacts.find((a) => a.id === "res_loop_v2");
  expect(v2Persisted?.status).toBe("draft");
  expect(v2Persisted?.version).toBe(2);
  expect(v2Persisted?.parentId).toBe("res_loop");
});
