import { test, expect } from "./test.js";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { teardownDaemon, portOf } from "./daemon-harness.js";

/**
 * P2 (round-11) — SCREENSHOT CAPTURE + live assertions for the walk-me-through
 * truth-up and the honest controls:
 *
 *   1. the HUNK affordance exists in every hunk header (round 11 measured 5 hunk
 *      headers, 0 buttons);
 *   2. the file-path header stays ONE row on a deep path (round 11 measured 67px
 *      vs 41px at 1440 because the button wrapped and inherited font-mono);
 *   3. the debrief disclosure reads as a control, not a heading;
 *   4. the search affordance is labeled at 900px (the VS Code webview width).
 *
 * Boots a real daemon (HOME isolated), seeds a deep-path changeset + a debrief,
 * and — when CAPTURE_P2=1 — writes PNGs to test-results/p2/ for both themes at
 * 1440 and 900. The assertions ALWAYS run, so a regression fails the build even
 * without the capture flag.
 *
 * Refresh: CAPTURE_P2=1 npx playwright test p2-capture.e2e.ts
 */
const __dir = path.dirname(fileURLToPath(import.meta.url));
const daemonJs = path.resolve(__dir, "../dist/daemon/index.js");
const OUT = path.resolve(__dir, "../test-results/p2");

let proc: ChildProcess | undefined;
let projectRoot: string;
let home: string;
let baseURL: string;

/** A deliberately DEEP path — the round-11 second-header-row repro. */
const DEEP = "packages/mcp-server/src/mcp/tools/check-feedback-delivery.ts";

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
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dp-p2-home-"));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-p2-"));
  if (process.env.CAPTURE_P2) fs.mkdirSync(OUT, { recursive: true });
  proc = spawn(process.execPath, [daemonJs], {
    env: { ...process.env, HOME: home, DEEPPAIRING_PROJECT_ROOT: projectRoot, DEEPPAIRING_NO_OPEN: "1" },
    stdio: "ignore",
  });
  const daemon = await waitForDaemon(projectRoot);
  baseURL = daemon.base;
  const h = { "Content-Type": "application/json", Authorization: `Bearer ${daemon.token}` };

  await fetch(`${baseURL}/api/internal/sessions/p2/register`, { method: "POST", headers: h, body: "{}" })
    .then((r) => { if (!r.ok) throw new Error(`register failed: ${r.status}`); });

  // A deep-path changeset with TWO hunks in the active file — the hunk-grain
  // affordance renders once per hunk header.
  await fetch(`${baseURL}/api/internal/sessions/p2/artifacts`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "cs_p2", type: "changeset", title: "Deliver request scope to the agent",
      content: {
        summary: "Carry the walk-me-through scope as data, not only prose.",
        risks: ["touches the check_feedback delivery line"],
        files: [
          {
            path: DEEP, changeType: "modified", stats: { additions: 6, deletions: 1 },
            hunks: [
              {
                header: "@@ -60,4 +60,10 @@ export function requestSecretNote(r: Request) {",
                lines: [
                  { kind: "ctx", content: "  return r.secretWarnings?.length ? \" ⚠ possible secret\" : \"\";", oldLine: 61, newLine: 61 },
                  { kind: "add", content: "export function requestScopeNote(r: Pick<Request, \"scope\">): string {", newLine: 62 },
                  { kind: "add", content: "  const scope = describeRequestScope(r.scope);", newLine: 63 },
                  { kind: "add", content: "  return scope ? `→ SCOPE: ${scope}` : \"\";", newLine: 64 },
                ],
              },
              {
                header: "@@ -700,3 +706,4 @@ const lines = pendingRequests.map(",
                lines: [
                  { kind: "del", content: "  (r) => `- 📨 REQUEST [${r.id}] — ${r.text}`,", oldLine: 701 },
                  { kind: "add", content: "  (r) => `- 📨 REQUEST [${r.id}] — ${r.text}${requestScopeNote(r)}`,", newLine: 707 },
                  { kind: "ctx", content: ");", oldLine: 702, newLine: 708 },
                ],
              },
            ],
          },
          {
            path: "packages/shared/src/schemas/request.ts", changeType: "modified", stats: { additions: 3, deletions: 0 },
            hunks: [{ header: "@@ -24,2 +24,5 @@", lines: [{ kind: "add", content: "  scope: RequestScopeSchema.optional(),", newLine: 48 }] }],
          },
        ],
      },
    }),
  }).then((r) => { if (!r.ok) throw new Error(`seed changeset failed: ${r.status}`); });

  await fetch(`${baseURL}/api/internal/sessions/p2/artifacts`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "debrief_p2", type: "debrief", title: "Debrief — request scope as data",
      content: {
        summary: "The walk-me-through affordance now sends WHERE it was fired from, not just what it says.",
        sections: [
          { title: "Scope rides the request as data", body: "`source` + `scope` are optional additions to the shared Request schema." },
          { title: "The hunk grain is reachable", body: "Every hunk header carries its own Explain-this-hunk affordance." },
          { title: "The disclosure reads as a control", body: "No longer byte-identical to a static section heading." },
        ],
        decisionsMade: [{ what: "Keep the prose primary; the data is additive.", why: "The prose is what works today." }],
        needsYourEyes: [
          { what: "The check_feedback delivery line", why: "It is the one place the agent reads the scope.", artifactRef: "cs_p2" },
        ],
        deferred: [{ what: "Embedding the scope in the explainer itself", why: "Out of scope for P2." }],
      },
    }),
  }).then((r) => { if (!r.ok) throw new Error(`seed debrief failed: ${r.status}`); });
});

test.afterAll(async () => {
  await teardownDaemon(proc, portOf(baseURL));
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// The daemon + first hydration can be slow on WSL /mnt/c (9P latency); the
// assertions here are about layout, not timing, so a retry keeps a cold-start
// straggler from reading as a regression.
test.describe.configure({ retries: 2, timeout: 90_000 });

const CAPTURE = !!process.env.CAPTURE_P2;

async function newPage(browser: import("@playwright/test").Browser, theme: "dark" | "light", width = 1440) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2, colorScheme: theme });
  const page = await context.newPage();
  await page.addInitScript((t) => localStorage.setItem("dp-theme", t), theme);
  return { context, page };
}

async function shot(page: import("@playwright/test").Page, name: string) {
  if (CAPTURE) await page.screenshot({ path: path.join(OUT, name), fullPage: true });
}

async function open(page: import("@playwright/test").Page, id: string) {
  await page.goto(`${baseURL}/?session=p2`);
  await page.locator("[data-artifact-item]").first().waitFor({ state: "visible", timeout: 40000 });
  await page.locator(`[data-artifact-item="${id}"]`).click({ timeout: 15000 });
  await page.waitForSelector(`[data-artifact-id="${id}"]`, { timeout: 15000 });
}

for (const theme of ["dark", "light"] as const) {
  for (const width of [1440, 900] as const) {
    test(`P2 changeset — hunk affordance + single-row header (${theme}, ${width})`, async ({ browser }) => {
      const { context, page } = await newPage(browser, theme, width);
      await open(page, "cs_p2");

      // 1. the HUNK grain is reachable — one per hunk header of the active file.
      const hunkBtns = page.locator('[data-walk-grain="hunk"]');
      await hunkBtns.first().waitFor({ timeout: 15000 });
      expect(await hunkBtns.count()).toBe(2);
      await expect(hunkBtns.first()).toHaveText(/Explain this hunk/);
      // …and the file grain still stands, labeled honestly.
      await expect(page.locator('[data-walk-grain="file"]').first()).toHaveText(/Explain this file's changes/);

      // P2 review F3 — the one-row header must not eat the FILENAME: the
      // directory ellipsizes, the basename survives at every width.
      const basename = page.getByTestId("changeset-file-basename").first();
      await expect(basename).toHaveText("check-feedback-delivery.ts");
      expect((await basename.boundingBox())!.width).toBeGreaterThan(20);

      // 2. the file-path header stays ONE row on a deep path at review widths
      //    (round-11 measured 67px vs 41px at 1440). Below 1100px the row
      //    genuinely cannot hold path + stats + three actions, so it wraps
      //    again — deliberately, rather than overlapping them.
      const header = page.locator(`[data-artifact-id="cs_p2"] .font-mono`, { hasText: DEEP }).first();
      const box = await header.boundingBox();
      if (width >= 1100) expect(box!.height).toBeLessThanOrEqual(48);

      // 3. the button reads as an action, not file metadata (UI font, not mono).
      const fileBtn = page.locator('[data-walk-grain="file"]').first();
      const family = await fileBtn.evaluate((el) => getComputedStyle(el).fontFamily);
      expect(family.toLowerCase()).not.toMatch(/mono/);

      await shot(page, `changeset-hunk-affordance-${theme}-${width}.png`);
      await context.close();
    });

    test(`P2 debrief — disclosure as a control (${theme}, ${width})`, async ({ browser }) => {
      const { context, page } = await newPage(browser, theme, width);
      await open(page, "debrief_p2");
      const toggle = page.getByTestId("debrief-walk-toggle");
      await toggle.waitFor({ timeout: 15000 });
      // S2 (round-14) — deep-by-default: the walk is EXPANDED by default, so the
      // control offers to HIDE it and the sections are already on screen.
      await expect(toggle).toHaveText(/Hide the walk \(3 sections\)/);
      await page.getByText("Scope rides the request as data").waitFor({ timeout: 15000 });
      // It still reads as interactive: pointer cursor + a visible border box.
      expect(await toggle.evaluate((el) => getComputedStyle(el).cursor)).toBe("pointer");
      expect(await toggle.evaluate((el) => getComputedStyle(el).borderTopWidth)).not.toBe("0px");
      // It is NOT the uppercase heading treatment any more.
      expect(await toggle.evaluate((el) => getComputedStyle(el).textTransform)).toBe("none");
      await shot(page, `debrief-disclosure-expanded-${theme}-${width}.png`);
      // The O2 collapse still works — one click hides the walk.
      await toggle.click();
      await page.getByText("Scope rides the request as data").waitFor({ state: "hidden", timeout: 15000 });
      await shot(page, `debrief-disclosure-collapsed-${theme}-${width}.png`);
      await context.close();
    });

    test(`P2 header — labeled search (${theme}, ${width})`, async ({ browser }) => {
      const { context, page } = await newPage(browser, theme, width);
      // The header is app-chrome — no artifact selection needed (and none is
      // waited on, so this spec can't inherit the artifact list's hydration).
      await page.goto(`${baseURL}/?session=p2`);
      // Round-10's ask, finished: the WORD is visible at 900px too.
      const label = page.getByTestId("search-label");
      await expect(label).toBeVisible();
      await shot(page, `header-search-${theme}-${width}.png`);
      await context.close();
    });
  }
}
