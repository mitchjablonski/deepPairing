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
 *
 * #430 slice 2 (Sol's condition 5) — the same checks with a held terminal ask
 * leading over the drafts, for the D2 `Why`, plus D1's sidebar and detail tops
 * recorded separately. `main` top can't see D1: the row sits inside <main>.
 */
const __dir = path.dirname(fileURLToPath(import.meta.url));
const daemonJs = path.resolve(__dir, "../dist/daemon/index.js");

let proc: ChildProcess | undefined;
let projectRoot: string;
let home: string;
let baseURL: string;
let token: string;

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
  token = daemon.token;
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

const HELD_ASK_ID = "blk_nb_ask";

test.describe("#430 slice 2 — a held terminal ask, and a second session", () => {
  test.beforeAll(async () => {
    // Runs after the tests above, so their lead is untouched. The log route reads
    // this file per request; held asks are local to each browser context.
    const concept = "Do not rewrite the session-store migration while the delegated cache sweep is still running";
    const targetPath = "packages/mcp-server/src/store/migrations/2026-session-store-sliding-window-ttl.sql";
    const hold = (id: string, ageMs: number) => ({
      id, at: new Date(Date.now() - ageMs).toISOString(), sessionId: "hook", source: "session", via: "concept",
      lane: "hook", decision: "ask", toolName: "Edit", concept, targetPath, reason: LONG_WHY,
    });
    fs.mkdirSync(path.join(projectRoot, ".deeppairing"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, ".deeppairing", "preflight-blocks.json"),
      // Older than every seeded draft, so the ask leads; two, because Why marks the whole log.
      JSON.stringify({ version: 1, blocks: [hold("blk_nb_ask_2", 3_600_000), hold(HELD_ASK_ID, 7_200_000)] }),
    );
    const h = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
    await fetch(`${baseURL}/api/internal/sessions/nb2/register`, { method: "POST", headers: h, body: "{}" })
      .then((r) => { if (!r.ok) throw new Error(`register nb2 failed: ${r.status}`); });
    await fetch(`${baseURL}/api/internal/sessions/nb2/artifacts`, { method: "POST", headers: h, body: JSON.stringify(spec("nb2_sibling", "Sibling session draft", "A second session to filter by")) })
      .then((r) => { if (!r.ok) throw new Error(`seed nb2 failed: ${r.status}`); });
  });

  async function openHeld(browser: Browser, width: number, height: number, scale = 1) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, colorScheme: "light" });
    const page = await context.newPage();
    const mutations: string[] = [];
    page.on("request", (r) => { if (!["GET", "HEAD", "OPTIONS"].includes(r.method())) mutations.push(`${r.method()} ${r.url()}`); });
    await page.goto(`${baseURL}/?session=nb`);
    await expect(page.getByTestId("pending-next")).toHaveAttribute("data-next-copy", /^HELD IN TERMINAL/, { timeout: 20000 });
    return { context, page, mutations, why: page.getByRole("button", { name: "Why this is held" }) };
  }

  for (const v of NARROW) {
    test(`Why wraps, stays reachable, and returns focus (${v.name})`, async ({ browser }) => {
      const { context, page, mutations, why } = await openHeld(browser, v.width, v.height, v.scale);
      const banner = await box(page, '[data-testid="pending-banner"]');
      expect(banner.x + banner.width).toBeLessThanOrEqual(v.width + 0.5);
      const lead = await box(page, '[data-testid="pending-next"]');
      expect(lead.width).toBeGreaterThanOrEqual(Math.min(240, banner.width * 0.6));
      await expect(why).toBeVisible();
      const whyBox = await why.boundingBox();
      expect(whyBox!.x).toBeGreaterThanOrEqual(0);
      expect(whyBox!.x + whyBox!.width).toBeLessThanOrEqual(v.width + 0.5);
      expect(whyBox!.y + whyBox!.height).toBeLessThanOrEqual(v.height + 0.5);
      await expectComposerClear(page);

      // One Tab past the held row, with the keyboard only.
      await page.getByTestId("pending-next").focus();
      await page.keyboard.press("Tab");
      await expect(why).toBeFocused();
      await expectComposerClear(page);
      await page.keyboard.press("Enter");

      const entry = page.locator(`[id="gate-block-${HELD_ASK_ID}"]`);
      await expect(entry).toBeFocused();
      await expect(entry).toBeInViewport();
      await expect(entry.getByTestId("gate-hook-next")).toContainText("If Claude Code is still asking, answer in that terminal.");
      const log = await box(page, '[data-testid="gate-block-log"]');
      expect(log.x).toBeGreaterThanOrEqual(-0.5);
      expect(log.x + log.width).toBeLessThanOrEqual(v.width + 0.5);
      await expect(why).toHaveCount(0);
      await expect(page.getByTestId("pending-next")).toHaveAttribute("data-next-copy", /^(?!HELD IN TERMINAL)/);
      expect(mutations).toEqual([]);

      await page.keyboard.press("Escape");
      await expect(page.getByTestId("gate-block-log")).toHaveCount(0);
      await expect(page.locator("header").getByRole("button", { name: /diagnostics/i })).toBeFocused();
      await expectComposerClear(page);
      expect(mutations).toEqual([]);
      await context.close();
    });
  }

  for (const width of [1440, 900] as const) {
    test(`held plus drafts stays inside the S2 ceiling; first-content tops recorded (${width})`, async ({ browser }) => {
      const { context, page, why } = await openHeld(browser, width, 900, 2);
      await expect(why).toBeVisible();
      const main = await box(page, "main");
      const pct = (main.y / 900) * 100;
      console.log(`[430 D2] app-shell chrome (main top) with held lead and Why (${width}): ${pct.toFixed(1)}%`);
      expect(pct).toBeLessThan(15.0);
      // One row: the Why shares the lead's row at the S2 widths.
      const lead = await box(page, '[data-testid="pending-next"]');
      const whyBox = await why.boundingBox();
      expect(Math.abs((whyBox!.y + whyBox!.height / 2) - (lead.y + lead.height / 2))).toBeLessThan(8);

      // The sibling has merged once the filter shows. Then open the first draft chip.
      const filter = width === 1440 ? page.getByTestId("agents-filter-menu") : page.getByText("Agents:");
      await expect(filter).toBeVisible({ timeout: 20000 });
      await page.getByTestId("pending-banner").locator("button[title]:not([aria-label])").first().click();
      await expect(page.locator("[data-artifact-id]").first()).toBeVisible({ timeout: 15000 });
      const tops = async () => {
        const detail = await page.locator("[data-artifact-id]").first().boundingBox();
        const firstRow = page.locator('nav[aria-label="Artifacts"] [data-artifact-item]').first();
        const sidebar = (await firstRow.count()) ? await firstRow.boundingBox() : null;
        return { detail: detail!.y, sidebar: sidebar ? sidebar.y : null };
      };
      const report = (label: string, t: { detail: number; sidebar: number | null }) =>
        console.log(`[430 D1] first-content tops, ${label} (${width}): detail ${(t.detail / 9).toFixed(1)}% | sidebar ${t.sidebar === null ? "n/a" : `${(t.sidebar / 9).toFixed(1)}%`}`);

      if (width === 1440) {
        await expect(page.getByText("Agents:")).toHaveCount(0);
        const withMenu = await tops();
        report("menu", withMenu);
        // The same screen with the row back: the row costs the detail its height,
        // and the menu costs the sidebar instead. Both are recorded, not netted.
        await page.locator("[data-sidebar-toggle]").click();
        await expect(page.getByText("Agents:")).toBeVisible();
        const withRow = await tops();
        report("row, sidebar collapsed", withRow);
        expect(withRow.detail).toBeGreaterThan(withMenu.detail);
      } else {
        // 900px counts as narrow, so the row stays here and D1 saves nothing.
        report("row, narrow", await tops());
      }
      await context.close();
    });
  }

  test("the menu works from the keyboard and keeps its choice across a resize (1440)", async ({ browser }) => {
    const { context, page } = await openHeld(browser, 1440, 900);
    const menu = page.getByTestId("agents-filter-menu");
    await expect(menu).toBeVisible({ timeout: 20000 });
    await menu.focus();
    await page.keyboard.press("ArrowDown");
    await expect(menu).not.toHaveValue("all");
    const chosen = await menu.inputValue();
    await expect(menu).toBeFocused();

    await page.setViewportSize({ width: 800, height: 900 });
    const active = page.locator("[data-agents-active]");
    await expect(active).toBeFocused();
    await expect(active).toHaveAttribute("title", chosen);

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(menu).toHaveValue(chosen);
    await expect(menu).toBeFocused();
    await context.close();
  });
});
