import { test, expect } from "./test.js";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { teardownDaemon, portOf, spawnDiagnosticProcess, withSetupDiagnostics } from "./daemon-harness.js";

/**
 * U1 (round-15) — THE WHERE-OVERLAY: findings pinned to the changeset FILE RAIL.
 *
 * Round-15 found WHERE is the weakest comprehension axis — findings, the file
 * rail and the shape diagrams all exist but don't LINK. This capture drives a
 * REAL browser against a REAL daemon to prove the derived join renders: a
 * changeset whose files are cross-referenced against a findings ("research")
 * artifact's evidence[].filePath badges each changed file with the count +
 * severity of the findings that live there.
 *
 * BEFORE/AFTER in one frame (the q4-capture idiom): screenshot the shipped rail
 * (with the overlay), then strip the overlay badges in-page and screenshot
 * again — the same fixture, browser and frame, so the diff is exactly the
 * feature and can't rot into a stale baseline. PNGs write only under
 * CAPTURE_U1=1; the assertions always run.
 *
 * Refresh: CAPTURE_U1=1 npx playwright test u1-where-overlay.e2e.ts
 */
const __dir = path.dirname(fileURLToPath(import.meta.url));
const daemonJs = path.resolve(__dir, "../dist/daemon/index.js");
const OUT = path.resolve(__dir, "../test-results/u1");

let proc: ChildProcess | undefined;
let projectRoot: string;
let home: string;
let baseURL: string;

async function waitForDaemon(root: string): Promise<{ base: string; token: string }> {
  const daemonJson = path.join(root, ".deeppairing", "daemon.json");
  for (let i = 0; i < 120; i++) {
    try {
      const info = JSON.parse(fs.readFileSync(daemonJson, "utf-8"));
      if (info.port) {
        const res = await fetch(`http://localhost:${info.port}/api/daemon-info`);
        if (res.ok && info.authToken) return { base: `http://localhost:${info.port}`, token: info.authToken };
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("daemon did not start");
}

test.beforeAll(async ({}, testInfo) => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dp-u1-home-"));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-u1-"));
  if (process.env.CAPTURE_U1) fs.mkdirSync(OUT, { recursive: true });
  proc = spawnDiagnosticProcess(process.execPath, [daemonJs], {
    env: { ...process.env, HOME: home, DEEPPAIRING_PROJECT_ROOT: projectRoot, DEEPPAIRING_NO_OPEN: "1" },
  });
  const daemon = await withSetupDiagnostics(proc, testInfo, () => waitForDaemon(projectRoot));
  baseURL = daemon.base;
  const h = { "Content-Type": "application/json", Authorization: `Bearer ${daemon.token}` };

  await fetch(`${baseURL}/api/internal/sessions/u1/register`, { method: "POST", headers: h, body: "{}" })
    .then((r) => { if (!r.ok) throw new Error(`register failed: ${r.status}`); });

  // A findings artifact whose evidence anchors to TWO of the changed files —
  // one high-severity (auth/login.ts, 2 findings incl. 1 high), one medium
  // (auth/session.ts) — and one whose evidence has NO filePath (a U2-style
  // doc-anchored finding) that must badge nothing.
  await fetch(`${baseURL}/api/internal/sessions/u1/artifacts`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "findings_u1", type: "research", title: "What I found reviewing the TTL change",
      content: {
        summary: "Two risks concentrate on the login path.",
        findings: [
          {
            category: "security", title: "Session fixation on refresh", detail: "The refreshed session reuses the old id.",
            significance: "high", severity: "high",
            evidence: [{ filePath: "auth/login.ts", lineStart: 22, lineEnd: 26, snippet: "session.id = old.id", explanation: "id survives the refresh" }],
          },
          {
            category: "style", title: "Confusing helper name", detail: "getAndTouch reads like a getter.",
            significance: "low", severity: "low",
            evidence: [{ filePath: "auth/login.ts", lineStart: 40, lineEnd: 40, snippet: "store.getAndTouch(sid)", explanation: "side effect hidden in a getter" }],
          },
          {
            category: "correctness", title: "expiresAt not persisted", detail: "The bumped TTL never reaches the store.",
            significance: "medium", severity: "medium",
            evidence: [{ filePath: "auth/session.ts", lineStart: 12, lineEnd: 12, snippet: "expiresAt: number;", explanation: "type only, no write" }],
          },
          {
            category: "process", title: "Undefined rollout owner", detail: "The runbook doesn't say who flips the flag.",
            significance: "high",
            // U2 seam: doc-anchored evidence with NO filePath — badges no file.
            evidence: [{ lineStart: 3, snippet: "TBD", explanation: "runbook gap" }],
          },
        ],
      },
    }),
  }).then((r) => { if (!r.ok) throw new Error(`seed findings failed: ${r.status}`); });

  await fetch(`${baseURL}/api/internal/sessions/u1/artifacts`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "cs_u1", type: "changeset", title: "Move TTL refresh into the login path",
      content: {
        summary: "Centralize the sliding-window refresh on the login path.",
        risks: ["touches auth"],
        files: [
          { path: "auth/login.ts", changeType: "modified", stats: { additions: 6, deletions: 2 },
            hunks: [{ header: "@@ -20,4 +20,8 @@", lines: [
              { kind: "ctx", content: "const sid = readSessionCookie(req);", oldLine: 21, newLine: 21 },
              { kind: "add", content: "const s = await store.getAndTouch(sid);", newLine: 22 },
            ] }] },
          { path: "auth/session.ts", changeType: "modified", stats: { additions: 1, deletions: 0 },
            hunks: [{ lines: [{ kind: "add", content: "expiresAt: number;", newLine: 12 }] }] },
          { path: "db/pool.ts", changeType: "modified", stats: { additions: 1, deletions: 1 },
            hunks: [{ lines: [{ kind: "add", content: "max: 20,", newLine: 8 }] }] },
        ],
      },
    }),
  }).then((r) => { if (!r.ok) throw new Error(`seed changeset failed: ${r.status}`); });
});

test.afterAll(async () => {
  await teardownDaemon(proc, portOf(baseURL));
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// Cold daemon + hydration on WSL /mnt/c is slow (9P); these are about presence,
// not timing.
test.describe.configure({ retries: 2, timeout: 120_000 });

const CAPTURE = !!process.env.CAPTURE_U1;

async function newPage(browser: import("@playwright/test").Browser, theme: "dark" | "light", width: number) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2, colorScheme: theme });
  const page = await context.newPage();
  await page.addInitScript((t) => localStorage.setItem("dp-theme", t), theme);
  return { context, page };
}

async function open(page: import("@playwright/test").Page, id: string) {
  await page.goto(`${baseURL}/?session=u1`);
  await page.locator("[data-artifact-item]").first().waitFor({ state: "visible", timeout: 60000 });
  await page.locator(`[data-artifact-item="${id}"]`).click({ timeout: 15000 });
  await page.waitForSelector(`[data-artifact-id="${id}"]`, { timeout: 15000 });
}

for (const theme of ["dark", "light"] as const) {
  test(`U1 — the file rail badges findings by count + severity (${theme})`, async ({ browser }) => {
    const { context, page } = await newPage(browser, theme, 1000);
    try {
      await open(page, "cs_u1");
      const badges = page.locator('[data-testid="finding-overlay-badge"]');
      // Exactly TWO files carry findings (login.ts, session.ts); db/pool.ts and
      // the filePath-less finding badge nothing.
      await expect(badges).toHaveCount(2, { timeout: 15000 });

      // The login-path badge: 2 findings, and its accessible name spells out the
      // severity (NOT color-only) and lists the finding titles.
      const loginBadge = page.locator('li', { has: page.getByTitle("modified auth/login.ts") })
        .locator('[data-testid="finding-overlay-badge"]');
      await expect(loginBadge).toHaveText("2");
      const label = await loginBadge.getAttribute("aria-label");
      expect(label).toContain("high risk");
      expect(label).toContain("Session fixation");

      // AFTER (shipped) screenshot of the rail.
      const rail = page.locator('[data-artifact-id="cs_u1"]').getByRole("list").first();
      if (CAPTURE) await rail.screenshot({ path: path.join(OUT, `rail-after-${theme}.png`) });

      // Clicking the badge navigates to the pinned finding (selects the research
      // artifact + scrolls the finding into view).
      await loginBadge.click();
      await expect(page.locator('[data-artifact-id="findings_u1"]')).toBeVisible({ timeout: 15000 });

      // Re-open the changeset and recreate the BEFORE state (strip the overlay).
      await open(page, "cs_u1");
      await expect(badges.first()).toBeVisible({ timeout: 15000 });
      if (CAPTURE) {
        await page.evaluate(() => {
          document.querySelectorAll('[data-testid="finding-overlay-badge"]').forEach((el) => el.remove());
        });
        const rail2 = page.locator('[data-artifact-id="cs_u1"]').getByRole("list").first();
        await rail2.screenshot({ path: path.join(OUT, `rail-before-${theme}.png`) });
      }
    } finally {
      await context.close();
    }
  });
}
