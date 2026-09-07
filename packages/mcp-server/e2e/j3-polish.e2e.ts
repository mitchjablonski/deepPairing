import { test, expect, type Page } from "./test.js";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachDaemonOutput, teardownDaemon, portOf, spawnDiagnosticProcess, withSetupDiagnostics } from "./daemon-harness.js";

/**
 * #213 (J3) — round-5 corrections-polish screenshots + smoke: the Move UNDO
 * toast (M-4), the lazy-load SKELETON fallback (L-9), and the 900px collapsed
 * rail's tooltip scent (L-8). Boots a fresh daemon and session for every test
 * on the isolated e2e port window (never 3847-3974), seeded with
 * milestone/phase/ungrouped artifacts.
 *
 * Screenshots land in $DP213_SHOTS (default: os.tmpdir()/dp-213-shots).
 */
const __dir = path.dirname(fileURLToPath(import.meta.url));
const daemonJs = path.resolve(__dir, "../dist/daemon/index.js");
const SHOTS = process.env.DP213_SHOTS ?? path.join(os.tmpdir(), "dp-213-shots");

let proc: ChildProcess | undefined;
let root: string;
let home: string;
let base: string;

async function waitForDaemon(r: string): Promise<string> {
  const daemonJson = path.join(r, ".deeppairing", "daemon.json");
  for (let i = 0; i < 120; i++) {
    try {
      const info = JSON.parse(fs.readFileSync(daemonJson, "utf-8"));
      if (info.port) {
        const res = await fetch(`http://localhost:${info.port}/api/daemon-info`);
        if (res.ok && info.authToken) return `http://localhost:${info.port}`;
      }
    } catch {}
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error("daemon did not come up");
}

test.beforeEach(async ({}, testInfo) => {
  if (!fs.existsSync(daemonJs)) {
    throw new Error(`dist/daemon/index.js missing at ${daemonJs} — run \`pnpm build\` before the e2e suite.`);
  }
  fs.mkdirSync(SHOTS, { recursive: true });
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dp-213-home-"));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dp-213-root-"));
  proc = spawnDiagnosticProcess(process.execPath, [daemonJs], {
    env: { ...process.env, HOME: home, DEEPPAIRING_PROJECT_ROOT: root, DEEPPAIRING_NO_OPEN: "1" },
  });
  base = await withSetupDiagnostics(proc, testInfo, () => waitForDaemon(root));

  const token = JSON.parse(fs.readFileSync(path.join(root, ".deeppairing", "daemon.json"), "utf-8")).authToken as string;
  const h = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  const post = (route: string, body: unknown) =>
    fetch(`${base}/api/internal/sessions/feat/${route}`, { method: "POST", headers: h, body: JSON.stringify(body) })
      .then((r) => { if (!r.ok) throw new Error(`seed ${route} failed: ${r.status}`); });

  await post("register", {});
  // Milestone 6 — a plan + a research artifact (the research renderer is a good
  // skeleton subject: findings + evidence are a chunky lazy chunk).
  await post("artifacts", {
    id: "m6_plan", type: "plan", title: "Milestone 6 — content quota backfill",
    content: { summary: "Backfill historical quota usage.", steps: [
      { description: "Backfill job", reasoning: "Historical rows lack usage.", files: ["src/quota.ts"] },
    ] },
  });
  await post("artifacts", {
    id: "m6_res", type: "research", title: "Milestone 6 — middleware audit",
    content: { summary: "Where the limiter must sit.",
      findings: [{ category: "Architecture", title: "Single choke point", detail: "All routes flow through one middleware.", significance: "high" }] },
  });
  // Phase 0 — a second feature (the move target).
  await post("artifacts", {
    id: "p0_cc", type: "code_change", title: "Phase 0 — bootstrap the config loader",
    content: { filePath: "src/shared.ts", changeType: "modify",
      before: "export const X = 0;", after: "export const X = 1;", reasoning: "Bootstrap config." },
  });
  // A plain-titled artifact → Ungrouped.
  await post("artifacts", {
    id: "loose", type: "plan", title: "Refactor the crawler retry loop",
    content: { summary: "Unrelated cleanup.", steps: [{ description: "Cap retries", reasoning: "Avoid runaway.", files: ["src/crawl.ts"] }] },
  });
});

test.afterEach(async ({}, testInfo) => {
  await attachDaemonOutput(proc, testInfo);
  await teardownDaemon(proc, portOf(base));
  for (const dir of [root, home]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

async function openFeatures(page: Page): Promise<void> {
  await page.goto(`${base}/?session=feat`);
  await page.getByRole("button", { name: /open features view/i }).click();
  await page.waitForSelector('[data-testid="features-view"]', { timeout: 15000 });
}

// L-5 + M-4 — the per-row Move select (revealed on row hover/focus) posts the
// override AND raises an UNDO toast. Undo restores the prior state.
const undoDark = async ({ page }: { page: Page }) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  await openFeatures(page);
  const view = page.locator('[data-testid="features-view"]');
  const m6 = view.locator('[data-feature-group="milestone-6"]');

  // Move a Milestone 6 artifact into Phase 0 via the per-row select. (Playwright
  // ignores opacity for actionability, so the hover-revealed select is usable.)
  await m6.locator("[data-feature-move]").first().selectOption({ label: "Phase 0" });

  // The Undo toast surfaces, worded for the destination, with an Undo button.
  const toast = page.locator('[data-testid="toast-region"]');
  await expect(toast.getByText(/Moved to Phase 0/i)).toBeVisible();
  await expect(toast.getByRole("button", { name: /^Undo$/ })).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, "undo-toast-dark.png") });

  // Undo puts it back — Milestone 6 regains its second artifact.
  await toast.getByRole("button", { name: /^Undo$/ }).click();
  await expect(
    view.locator('[data-feature-group="milestone-6"] [data-feature-artifact]'),
  ).toHaveCount(2, { timeout: 10000 });
};

const undoLight = async ({ page }: { page: Page }) => {
  await page.addInitScript(() => localStorage.setItem("dp-theme", "light"));
  await page.setViewportSize({ width: 1440, height: 950 });
  await openFeatures(page);
  const view = page.locator('[data-testid="features-view"]');
  const m6 = view.locator('[data-feature-group="milestone-6"]');
  await m6.locator("[data-feature-move]").first().selectOption({ label: "Phase 0" });
  const toast = page.locator('[data-testid="toast-region"]');
  await expect(toast.getByText(/Moved to Phase 0/i)).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, "undo-toast-light.png") });
};

// #341 acceptance probe: reverse actual registration order in the same worker,
// while the default suite and each test's fresh beforeEach seed stay unchanged.
const undoCases = [
  { title: "#213 M-4 — moving an artifact raises an Undo toast (dark)", run: undoDark },
  { title: "#213 M-4 — the Undo toast renders legibly (light)", run: undoLight },
];
if (process.env.DP_E2E_UNDO_REVERSE === "1") undoCases.reverse();
for (const scenario of undoCases) test(scenario.title, scenario.run);

// L-9 — the lazy artifact renderer's Suspense fallback is a type-shaped skeleton
// (title bar + prose + body + trailing blocks), not a blank grey flash. Delay
// the renderer chunks so the skeleton is observable, then screenshot it.
const RENDERER_CHUNK = /assets\/.*(Artifact|DecisionCard|ReasoningCard|RevisionDiff).*\.js$/;
async function captureSkeleton(page: Page, file: string): Promise<void> {
  // Load the shell FIRST (uninterrupted), so the sidebar + artifact list are
  // fully present. Delaying chunks from the very first byte races the shell load
  // on a cold WSL browser and the sidebar can be slow to paint.
  await page.goto(`${base}/?session=feat`);
  await expect(page.locator("[data-artifact-item]").first()).toBeVisible({ timeout: 15000 });
  // NOW delay the lazy renderer chunks (their filenames carry the component
  // name), so the NEXT selection holds on the Suspense fallback long enough to
  // screenshot.
  await page.route(RENDERER_CHUNK, async (route) => {
    await new Promise((r) => setTimeout(r, 2500));
    await route.continue();
  });
  // Select a research artifact — a distinct renderer chunk that isn't loaded yet,
  // so its lazy import suspends behind the delayed route and the skeleton paints.
  await page.getByText("Milestone 6 — middleware audit").click();
  // .first() — during the AnimatePresence(popLayout) cross-fade the outgoing +
  // incoming ArtifactDetail are both briefly mounted, so two skeletons can match;
  // one visible is enough to prove the fallback paints.
  await expect(page.locator('[data-testid="artifact-skeleton"]').first()).toBeVisible({ timeout: 5000 });
  await page.screenshot({ path: path.join(SHOTS, file) });
  await page.unroute(RENDERER_CHUNK);
}

test("#213 L-9 — the lazy-load skeleton shows instead of a blank body (dark)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  await captureSkeleton(page, "skeleton-dark.png");
});

test("#213 L-9 — the skeleton renders legibly (light)", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("dp-theme", "light"));
  await page.setViewportSize({ width: 1440, height: 950 });
  await captureSkeleton(page, "skeleton-light.png");
});

// L-8 — at 900px (narrow / webview) the sidebar collapses to an icon rail; each
// icon BUTTON must carry the rich "Type: title — status" scent on title +
// aria-label, so an icon-only column stays readable.
async function assertRailScent(page: Page, file: string): Promise<void> {
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto(`${base}/?session=feat`);
  const item = page.locator("[data-artifact-item]").first();
  await expect(item).toBeVisible({ timeout: 15000 });
  const title = await item.getAttribute("title");
  const aria = await item.getAttribute("aria-label");
  expect(title).toBeTruthy();
  expect(title).toBe(aria); // same rich scent on both
  // Carries type + title + status, not the bare title alone.
  expect(title).toMatch(/:.*—/);
  await page.screenshot({ path: path.join(SHOTS, file) });
}

test("#213 L-8 — the 900px collapsed rail names each artifact on the button (dark)", async ({ page }) => {
  await assertRailScent(page, "rail-tooltip-dark.png");
});

test("#213 L-8 — the collapsed rail renders legibly (light)", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("dp-theme", "light"));
  await assertRailScent(page, "rail-tooltip-light.png");
});
