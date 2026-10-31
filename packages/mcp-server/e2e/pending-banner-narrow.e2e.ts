import { test, daemonBeforeAll, expect } from "./test.js";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "@playwright/test";
import { teardownDaemon, portOf, spawnDiagnosticProcess, withSetupDiagnostics } from "./daemon-harness.js";

/**
 * #430 slice 1 (Sol a341 review) — narrow-layout evidence for the compact
 * PendingBanner lead line: at 320 / 390 px and a 200%-zoom variant, with
 * several long chips and a long why/after, the lead copy keeps a readable
 * width, its focus expansion is height-bounded, and the composer stays on
 * screen and unoccluded. At the S2 widths (1440 / 900) the same long-copy
 * fixture stays inside the S2 app-shell chrome ceiling (< 15%, unchanged).
 */
const __dir = path.dirname(fileURLToPath(import.meta.url));
const daemonJs = path.resolve(__dir, "../dist/daemon/index.js");

let proc: ChildProcess | undefined;
let projectRoot: string;
let home: string;
let baseURL: string;

const BRIEF_TITLE = "Notify the lead whenever a delegated worker stops, stalls, or exits unexpectedly";
const LONG_WHY = "Tell the lead the moment a worker stops so a stalled delegated run never sits unnoticed behind a quiet terminal while the rest of the plan waits on it";

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

const spec = (id: string, title: string, objective: string, context?: string, createdAt?: string) => ({
  id, type: "spec", title, ...(createdAt ? { createdAt } : {}),
  content: {
    objective,
    ...(context ? { context } : {}),
    requirements: [{ id: "REQ-1", statement: "It works end to end", rationale: "So the run is trustworthy", acceptanceCriteria: ["observable"] }],
    tasks: [{ title: "Wire the stop hook" }, { title: "Surface it to the lead" }, { title: "Cover it with a test" }],
  },
});

daemonBeforeAll(() => [proc], async (testInfo) => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dp-nb-home-"));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-nb-"));
  proc = spawnDiagnosticProcess(process.execPath, [daemonJs], {
    env: { ...process.env, HOME: home, DEEPPAIRING_PROJECT_ROOT: projectRoot, DEEPPAIRING_NO_OPEN: "1" },
  });
  const daemon = await withSetupDiagnostics(proc, testInfo, () => waitForDaemon(projectRoot));
  baseURL = daemon.base;
  const h = { "Content-Type": "application/json", Authorization: `Bearer ${daemon.token}` };
  await fetch(`${baseURL}/api/internal/sessions/nb/register`, { method: "POST", headers: h, body: "{}" })
    .then((r) => { if (!r.ok) throw new Error(`register failed: ${r.status}`); });
  const seeds = [
    spec("nb_r1", "Rename the session-store adapter methods for the cache-invalidation sweep follow-up", "Consistent adapter naming"),
    spec("nb_r2", "Document the sliding-window TTL refresh and its interaction with the auth middleware", "Docs for the TTL refresh"),
    spec("nb_r3", "Audit every authenticated route for per-route TTL touch-ups that the middleware now covers", "Remove redundant touch-ups"),
    // The blocking brief → the lead, with a long why (objective) and a conditional after.
    spec("nb_brief", BRIEF_TITLE, LONG_WHY, "Decide alone: naming\nWill ask: none\nRisk class: escalated\nWhy: touches the Stop hook\nReview: packet"),
  ];
  for (const body of seeds) {
    await fetch(`${baseURL}/api/internal/sessions/nb/artifacts`, { method: "POST", headers: h, body: JSON.stringify(body) })
      .then((r) => { if (!r.ok) throw new Error(`seed ${body.id} failed: ${r.status}`); });
  }
});

test.afterAll(async () => {
  await teardownDaemon(proc, portOf(baseURL));
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

async function open(browser: Browser, width: number, height: number, scale = 1) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, colorScheme: "light" });
  const page = await context.newPage();
  await page.goto(`${baseURL}/?session=nb`);
  await expect(page.getByTestId("pending-next")).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("pending-next")).toHaveAttribute("data-next-copy", new RegExp(`^REVIEW ${BRIEF_TITLE}`));
  return { context, page };
}

async function box(page: Page, selector: string) {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`no bounding box for ${selector}`);
  return b;
}

/** The composer is on screen, below the banner, and the topmost element at its centre. */
async function expectComposerClear(page: Page) {
  const vh = page.viewportSize()!.height;
  const composer = await box(page, 'textarea[placeholder^="Message the agent"]');
  const banner = await box(page, '[data-testid="pending-banner"]');
  expect(composer.height).toBeGreaterThan(0);
  expect(composer.y + composer.height).toBeLessThanOrEqual(vh + 0.5);
  expect(composer.y).toBeGreaterThanOrEqual(banner.y + banner.height - 0.5);
  const topmostIsComposer = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return !!el && (el.tagName === "TEXTAREA" || !!el.closest("textarea"));
  }, { x: composer.x + composer.width / 2, y: composer.y + composer.height / 2 });
  expect(topmostIsComposer).toBe(true);
}

const NARROW = [
  { name: "320px", width: 320, height: 640, scale: 2 },
  { name: "390px", width: 390, height: 844, scale: 3 },
  // 200% zoom of a 1280×720 window = a 640×360 CSS viewport at 2 device px per CSS px.
  { name: "200% zoom of 1280x720", width: 640, height: 360, scale: 2 },
] as const;

for (const v of NARROW) {
  test(`compact lead line stays legible, bounded and clear of the composer (${v.name})`, async ({ browser }) => {
    const { context, page } = await open(browser, v.width, v.height, v.scale);
    const banner = await box(page, '[data-testid="pending-banner"]');
    const lead = await box(page, '[data-testid="pending-next"]');
    // Legible: the lead copy gets a readable width (its own row when narrow), never a sliver.
    expect(lead.width).toBeGreaterThanOrEqual(Math.min(240, banner.width * 0.6));
    expect(lead.height).toBeGreaterThan(8);
    // The banner never pushes the page sideways.
    expect(banner.x + banner.width).toBeLessThanOrEqual(v.width + 0.5);
    await expectComposerClear(page);

    // Focus the lead chip: the line unwraps, but within a bounded height.
    const chip = page.getByTestId("pending-banner").locator(`button[title="${BRIEF_TITLE}"]`);
    await chip.focus();
    await expect(page.getByTestId("pending-next")).not.toHaveClass(/\btruncate\b/);
    await expect(chip).toHaveAccessibleDescription(/Approval required before this work proceeds/);
    const expanded = await box(page, '[data-testid="pending-next"]');
    expect(expanded.height).toBeGreaterThan(lead.height);
    expect(expanded.height).toBeLessThanOrEqual(64 + 1); // max-h-16
    await expectComposerClear(page);

    // Tab away: the line returns to one row.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("pending-next")).toHaveClass(/\btruncate\b/);
    await context.close();
  });
}

for (const width of [1440, 900] as const) {
  test(`long-copy fixture stays inside the S2 chrome ceiling (${width})`, async ({ browser }) => {
    const { context, page } = await open(browser, width, 900, 2);
    const main = await box(page, "main");
    const pct = (main.y / 900) * 100;
    console.log(`[430] app-shell chrome (main top) with long lead copy (${width}): ${pct.toFixed(1)}%`);
    expect(pct).toBeLessThan(15.0);
    // Shares the chip row at S2 widths: one row of banner.
    const lead = await box(page, '[data-testid="pending-next"]');
    const count = await box(page, '[data-testid="pending-banner"] >> text=/items? waiting for you/');
    expect(Math.abs(lead.y - count.y)).toBeLessThan(8);
    await context.close();
  });
}
