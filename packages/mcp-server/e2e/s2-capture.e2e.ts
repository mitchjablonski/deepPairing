import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { teardownDaemon, portOf } from "./daemon-harness.js";

/**
 * S2 (round-14 "THE DEFAULTS") — screenshot capture, chrome page-y MEASUREMENT,
 * and selector-integrity for the deep-by-default batch:
 *   1. the comprehension-first debrief (summary → diagrams → walk EXPANDED →
 *      decisions → needs-your-eyes → deferred), with the toggle still collapsing;
 *   2. the changeset.summary prose line rendered above the file list;
 *   3. the slimmed first-screen chrome — the y-position of the FIRST line of code
 *      as a fraction of the viewport (round-14 verified before = 49.7%).
 *
 * Boots a real daemon (HOME isolated), seeds a changeset + debrief, and — when
 * CAPTURE_S2=1 — writes PNGs to test-results/s2/<phase>/ (phase = S2_PHASE, default
 * "after") for both themes at 1440 and 900. The navigation + the page-y assertion
 * always run so a rotted selector or a chrome regression fails the build; only the
 * PNG writes are gated on the flag.
 *
 * Refresh: CAPTURE_S2=1 S2_PHASE=after npx playwright test s2-capture.e2e.ts
 */
const __dir = path.dirname(fileURLToPath(import.meta.url));
const daemonJs = path.resolve(__dir, "../dist/daemon/index.js");
const PHASE = process.env.S2_PHASE ?? "after";
const OUT = path.resolve(__dir, "../test-results/s2", PHASE);

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
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dp-s2-home-"));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-s2-"));
  if (process.env.CAPTURE_S2) fs.mkdirSync(OUT, { recursive: true });
  proc = spawn(process.execPath, [daemonJs], {
    env: { ...process.env, HOME: home, DEEPPAIRING_PROJECT_ROOT: projectRoot, DEEPPAIRING_NO_OPEN: "1" },
    stdio: "ignore",
  });
  const daemon = await waitForDaemon(projectRoot);
  baseURL = daemon.base;
  const h = { "Content-Type": "application/json", Authorization: `Bearer ${daemon.token}` };

  await fetch(`${baseURL}/api/internal/sessions/s2/register`, { method: "POST", headers: h, body: "{}" })
    .then((r) => { if (!r.ok) throw new Error(`register failed: ${r.status}`); });

  // A changeset with a SUMMARY (the round-14 WHAT-in-prose gap) + real code, left
  // DRAFT so the PendingBanner shows (chrome under measurement).
  await fetch(`${baseURL}/api/internal/sessions/s2/artifacts`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "cs_s2", type: "changeset", title: "Move session-TTL refresh into middleware",
      content: {
        summary: "Centralize the sliding-window TTL refresh so every authenticated route inherits it — no per-route touch-ups.",
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

  // A SUMMARY-LESS changeset for the pure-chrome page-y measurement: isolates the
  // app-shell band reduction from the (desirable) new summary prose line, so the
  // before/after is apples-to-apples (on main, cs_s2 rendered no summary line
  // either — the field was shown nowhere). Same code so the first line matches.
  await fetch(`${baseURL}/api/internal/sessions/s2/artifacts`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "cs_s2_plain", type: "changeset", title: "Move session-TTL refresh into middleware (plain)",
      content: {
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
  }).then((r) => { if (!r.ok) throw new Error(`seed plain changeset failed: ${r.status}`); });

  // A debrief, left DRAFT (the second pending item → banner stays up). Carries a
  // visual so the comprehension-first order (summary → diagrams → walk) is visible.
  await fetch(`${baseURL}/api/internal/sessions/s2/artifacts`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "debrief_s2", type: "debrief", title: "Debrief — sliding-window session TTL",
      content: {
        summary: "We moved the sliding-window session-TTL refresh into the auth middleware so every authenticated route inherits it for free.",
        visuals: [
          {
            kind: "diagram",
            title: "Where the refresh now lives",
            source: "flowchart LR\n  req[Request] --> mw[requireSession]\n  mw --> touch[store.getAndTouch]\n  touch --> route[Route handler]",
          },
        ],
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
          { what: "The expiry check in the middleware diff", why: "It changes the auth failure path for every route at once.", artifactRef: "cs_s2" },
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

const CAPTURE = !!process.env.CAPTURE_S2;

async function newPage(browser: import("@playwright/test").Browser, theme: "dark" | "light", width = 1440) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2, colorScheme: theme });
  const page = await context.newPage();
  await page.addInitScript((t) => localStorage.setItem("dp-theme", t), theme);
  return { context, page };
}

async function shot(page: import("@playwright/test").Page, name: string) {
  if (CAPTURE) await page.screenshot({ path: path.join(OUT, name), fullPage: true });
}

/** viewport-relative page-y (%) of the first element matching `selector`. */
async function pageYPct(page: import("@playwright/test").Page, selector: string): Promise<number> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no bounding box for ${selector}`);
  const vh = page.viewportSize()!.height;
  return (box.y / vh) * 100;
}

for (const width of [1440, 900] as const) {
  for (const theme of ["dark", "light"] as const) {
    test(`S2 debrief — comprehension-first order, walk EXPANDED by default (${theme} ${width})`, async ({ browser }) => {
      const { context, page } = await newPage(browser, theme, width);
      await page.goto(`${baseURL}/?session=s2`);
      await page.locator('[data-artifact-item="debrief_s2"]').click({ timeout: 20000 });
      await page.waitForSelector('[data-artifact-id="debrief_s2"]', { timeout: 15000 });

      // Walk EXPANDED by default (round-14 deep-by-default): its sections are on
      // screen with NO click; the toggle offers to HIDE it.
      const toggle = page.getByTestId("debrief-walk-toggle");
      await toggle.waitFor({ timeout: 15000 });
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByText("Centralized the TTL refresh in middleware")).toBeVisible();

      await shot(page, `debrief-comprehension-first-${theme}-${width}.png`);

      // The toggle STILL collapses (the skimmer is served): one click hides the walk.
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByText("Centralized the TTL refresh in middleware")).toHaveCount(0);
      await context.close();
    });

    test(`S2 changeset — the summary prose line renders (${theme} ${width})`, async ({ browser }) => {
      const { context, page } = await newPage(browser, theme, width);
      await page.goto(`${baseURL}/?session=s2`);
      await page.locator('[data-artifact-item="cs_s2"]').click({ timeout: 20000 });
      await page.waitForSelector('[data-artifact-id="cs_s2"]', { timeout: 15000 });

      // The changeset.summary prose line renders (round-14: stored but shown nowhere).
      await expect(page.getByTestId("changeset-summary")).toBeVisible();
      await expect(page.getByTestId("changeset-summary")).toContainText(/inherits it/i);

      await shot(page, `changeset-summary-${theme}-${width}.png`);
      await context.close();
    });

    test(`S2 chrome — first-code-line page-y, slimmed bands (${theme} ${width})`, async ({ browser }) => {
      const { context, page } = await newPage(browser, theme, width);
      await page.goto(`${baseURL}/?session=s2`);
      // A summary-LESS changeset so this measures the app-shell chrome band
      // reduction ONLY, not the (desirable) new WHAT-in-prose line — apples to
      // apples with the BEFORE run on main (which rendered no summary line).
      await page.locator('[data-artifact-item="cs_s2_plain"]').click({ timeout: 20000 });
      await page.waitForSelector('[data-artifact-id="cs_s2_plain"]', { timeout: 15000 });

      // The waiting banner is up (3 pending drafts) → realistic first-screen chrome.
      // TWO metrics: the app-shell chrome height (the top of <main> — everything
      // above the first byte of content: header + session nav + waiting banner +
      // ask-bar) is DETERMINISTIC and is exactly what S2 trimmed; the holistic
      // first-line-of-code y is logged too (render-timing sensitive → not pinned).
      const mainY = await pageYPct(page, "main");
      const codeY = await pageYPct(page, '[data-comment-anchor^="line:"]');
      console.log(`[S2] ${PHASE} app-shell chrome (main top) (${theme} ${width}): ${mainY.toFixed(1)}% | first-code-line: ${codeY.toFixed(1)}%`);

      await shot(page, `chrome-first-code-${theme}-${width}.png`);

      // Regression floor on the DETERMINISTIC chrome metric. Pre-S2 (measured on
      // main, same methodology) the app-shell chrome stood at 15.1–15.9%; the
      // slimmed bands bring it to 13.8–14.6%. Pin the reduction — the bands must
      // never grow back past the pre-S2 stack, and a new full-width band would
      // trip this too. (First-code-line sits ~41%, well under the round-14
      // qualitative 49.7% "chrome before code" ceiling.)
      expect(mainY).toBeLessThan(15.0);
      await context.close();
    });
  }
}
