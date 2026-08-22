import { test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { teardownDaemon, portOf } from "./daemon-harness.js";

/**
 * O2 (#230) — SCREENSHOT CAPTURE (+ selector-integrity check) for the batch's
 * three surfaces: the "Walk me through this" affordance on a changeset, the
 * debrief walk's progressive disclosure (collapsed vs expanded), and the
 * hover-reveal comment gutter. Boots a real daemon (HOME isolated), seeds a
 * changeset + debrief, and — when CAPTURE_O2=1 — writes PNGs to test-results/o2/
 * for both themes + a 900px width. Always runs the navigation so a selector that
 * rots fails the build; only the PNG writes are gated on the flag.
 *
 * Refresh: CAPTURE_O2=1 npx playwright test o2-capture.e2e.ts
 */
const __dir = path.dirname(fileURLToPath(import.meta.url));
const daemonJs = path.resolve(__dir, "../dist/daemon/index.js");
const OUT = path.resolve(__dir, "../test-results/o2");

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

test.beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dp-o2-home-"));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-o2-"));
  if (process.env.CAPTURE_O2) fs.mkdirSync(OUT, { recursive: true });
  proc = spawn(process.execPath, [daemonJs], {
    env: { ...process.env, HOME: home, DEEPPAIRING_PROJECT_ROOT: projectRoot, DEEPPAIRING_NO_OPEN: "1" },
    stdio: "ignore",
  });
  const daemon = await waitForDaemon(projectRoot);
  baseURL = daemon.base;
  const h = { "Content-Type": "application/json", Authorization: `Bearer ${daemon.token}` };

  await fetch(`${baseURL}/api/internal/sessions/o2/register`, { method: "POST", headers: h, body: "{}" })
    .then((r) => { if (!r.ok) throw new Error(`register failed: ${r.status}`); });

  // A changeset — the walk-me-through affordance sits in each file header; the
  // hover-reveal gutter lives on its diff rows.
  await fetch(`${baseURL}/api/internal/sessions/o2/artifacts`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "cs_o2", type: "changeset", title: "Move session-TTL refresh into middleware",
      content: {
        summary: "Centralize the sliding-window TTL refresh so every authenticated route inherits it.",
        risks: ["touches auth"],
        files: [
          {
            path: "auth/middleware.ts", changeType: "modified", stats: { additions: 4, deletions: 2 },
            hunks: [{
              header: "@@ -24,6 +24,8 @@ export function requireSession(store: SessionStore) {",
              lines: [
                { kind: "ctx", content: "    const sid = readSessionCookie(req);", oldLine: 25, newLine: 25 },
                { kind: "del", content: "    const session = await store.get(sid);", oldLine: 26 },
                { kind: "add", content: "    const session = await store.getAndTouch(sid); // refreshes TTL", newLine: 26 },
                { kind: "add", content: "    if (!session || session.expiresAt < Date.now()) {", newLine: 27 },
                { kind: "ctx", content: "    req.session = session;", oldLine: 27, newLine: 28 },
              ],
            }],
          },
          {
            path: "auth/session.ts", changeType: "modified", stats: { additions: 1, deletions: 0 },
            hunks: [{ header: "@@ -10,2 +10,3 @@", lines: [{ kind: "add", content: "  expiresAt: number;", newLine: 12 }] }],
          },
        ],
      },
    }),
  }).then((r) => { if (!r.ok) throw new Error(`seed changeset failed: ${r.status}`); });

  // A debrief — the walk collapses behind the disclosure; needs-your-eyes carries
  // the walk-me-through affordance.
  await fetch(`${baseURL}/api/internal/sessions/o2/artifacts`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "debrief_o2", type: "debrief", title: "Debrief — sliding-window session TTL",
      content: {
        summary: "We moved the sliding-window session-TTL refresh into the auth middleware so every authenticated route inherits it for free.",
        sections: [
          {
            title: "Centralized the TTL refresh in middleware",
            body: "`requireSession` now calls `store.getAndTouch(sid)`, which refreshes the expiry as a side effect of the lookup.",
            concepts: [{ name: "sliding-window expiration", oneLineExplanation: "each request pushes the session's expiry forward" }],
            evidence: [{ filePath: "auth/middleware.ts", lineStart: 26, lineEnd: 28, snippet: "const session = await store.getAndTouch(sid); // refreshes TTL\nif (!session || session.expiresAt < Date.now()) {\n  return res.status(401).end();", explanation: "The single choke point every authenticated route flows through." }],
          },
          { title: "Widened the Session type + added a test", body: "`Session` gained an `expiresAt` field." },
        ],
        decisionsMade: [
          { what: "Return 401 and clear the cookie on an expired session.", why: "Failing closed is the safer default." },
        ],
        needsYourEyes: [
          { what: "The expiry check in the middleware diff", why: "It changes the auth failure path for every route at once.", artifactRef: "cs_o2" },
        ],
        deferred: [{ what: "Refresh-token rotation", why: "Out of scope for this change." }],
      },
    }),
  }).then((r) => { if (!r.ok) throw new Error(`seed debrief failed: ${r.status}`); });
});

test.afterAll(async () => {
  await teardownDaemon(proc, portOf(baseURL));
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const CAPTURE = !!process.env.CAPTURE_O2;

async function newPage(browser: import("@playwright/test").Browser, theme: "dark" | "light", width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2, colorScheme: theme });
  const page = await context.newPage();
  await page.addInitScript((t) => localStorage.setItem("dp-theme", t), theme);
  return { context, page };
}

async function shot(page: import("@playwright/test").Page, name: string) {
  if (CAPTURE) await page.screenshot({ path: path.join(OUT, name), fullPage: true });
}

for (const theme of ["dark", "light"] as const) {
  test(`O2 changeset — walk-me-through affordance + gutter (${theme})`, async ({ browser }) => {
    const { context, page } = await newPage(browser, theme);
    await page.goto(`${baseURL}/?session=o2`);
    await page.click('[data-artifact-item="cs_o2"]');
    await page.waitForSelector('[data-artifact-id="cs_o2"]', { timeout: 15000 });
    // The affordance renders in the active file header.
    await page.locator("[data-walk-grain]").first().waitFor({ timeout: 15000 });
    await shot(page, `changeset-walk-affordance-${theme}.png`);
    // Hover a diff row to reveal the comment gutter, then capture.
    const row = page.locator('[data-comment-anchor^="line:auth/middleware.ts"]').first();
    await row.hover();
    await shot(page, `changeset-gutter-hover-${theme}.png`);
    await context.close();
  });

  test(`O2 debrief — expanded by default then collapsible walk (${theme})`, async ({ browser }) => {
    const { context, page } = await newPage(browser, theme);
    await page.goto(`${baseURL}/?session=o2`);
    await page.click('[data-artifact-item="debrief_o2"]');
    await page.waitForSelector('[data-artifact-id="debrief_o2"]', { timeout: 15000 });
    // S2 (round-14) — EXPANDED by default: the toggle is present AND the walk
    // sections are already on screen (deep-by-default).
    const toggle = page.getByTestId("debrief-walk-toggle");
    await toggle.waitFor({ timeout: 15000 });
    await page.getByText("Centralized the TTL refresh in middleware").waitFor({ timeout: 15000 });
    await page.getByTestId("debrief-needs-eyes").first().waitFor({ timeout: 15000 });
    await page.locator("[data-walk-grain]").first().waitFor({ timeout: 15000 });
    await shot(page, `debrief-expanded-${theme}.png`);
    // The O2 toggle still collapses it (the skimmer's escape hatch survives).
    await toggle.click();
    await page.getByText("Centralized the TTL refresh in middleware").waitFor({ state: "hidden", timeout: 15000 });
    await shot(page, `debrief-collapsed-${theme}.png`);
    await context.close();
  });
}

async function open900(page: import("@playwright/test").Page, id: string) {
  await page.goto(`${baseURL}/?session=o2`);
  // At 900px the sidebar collapses to an icon rail; wait for it to hydrate.
  await page.locator("[data-artifact-item]").first().waitFor({ state: "visible", timeout: 20000 });
  await page.locator(`[data-artifact-item="${id}"]`).click({ timeout: 15000 });
  await page.waitForSelector(`[data-artifact-id="${id}"]`, { timeout: 15000 });
}

test("O2 changeset — affordance at 900px (dark)", async ({ browser }) => {
  const { context, page } = await newPage(browser, "dark", 900);
  await open900(page, "cs_o2");
  await page.locator("[data-walk-grain]").first().waitFor({ timeout: 15000 });
  await shot(page, "changeset-walk-affordance-900px.png");
  await context.close();
});

test("O2 debrief — collapsed at 900px (dark)", async ({ browser }) => {
  const { context, page } = await newPage(browser, "dark", 900);
  await open900(page, "debrief_o2");
  await page.getByTestId("debrief-walk-toggle").waitFor({ timeout: 15000 });
  await shot(page, "debrief-collapsed-900px.png");
  await context.close();
});
