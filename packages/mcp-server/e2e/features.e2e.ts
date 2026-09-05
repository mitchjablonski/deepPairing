import { test, expect, type Page } from "./test.js";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { teardownDaemon, portOf, spawnDiagnosticProcess, withSetupDiagnostics } from "./daemon-harness.js";

/**
 * #203 (H2) — the Features view, slice 1: real-browser smoke + screenshot
 * capture. Boots two daemons on the isolated e2e port window (never 3847-3974):
 * one POPULATED with milestone/phase-prefixed artifacts + a plain (Ungrouped)
 * one + an unresolved decision, and one EMPTY (for the empty-state shot).
 *
 * Screenshots land in $DP203_SHOTS (default: os.tmpdir()/dp-203-shots):
 * populated (dark + light) and empty.
 */
const __dir = path.dirname(fileURLToPath(import.meta.url));
const daemonJs = path.resolve(__dir, "../dist/daemon/index.js");
const SHOTS = process.env.DP203_SHOTS ?? path.join(os.tmpdir(), "dp-203-shots");

let procFull: ChildProcess | undefined;
let procEmpty: ChildProcess | undefined;
let procCorr: ChildProcess | undefined;
let fullRoot: string;
let emptyRoot: string;
let corrRoot: string;
let home: string;
let fullBase: string;
let emptyBase: string;
let corrBase: string;
let seedFeatures: (base: string, root: string) => Promise<void>;

async function waitForDaemon(root: string): Promise<{ base: string; token: string }> {
  const daemonJson = path.join(root, ".deeppairing", "daemon.json");
  for (let i = 0; i < 120; i++) {
    try {
      const info = JSON.parse(fs.readFileSync(daemonJson, "utf-8"));
      if (info.port) {
        const res = await fetch(`http://localhost:${info.port}/api/daemon-info`);
        if (res.ok && info.authToken) return { base: `http://localhost:${info.port}`, token: info.authToken };
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("daemon did not come up");
}

function bootDaemon(root: string): ChildProcess {
  return spawnDiagnosticProcess(process.execPath, [daemonJs], {
    env: { ...process.env, HOME: home, DEEPPAIRING_PROJECT_ROOT: root, DEEPPAIRING_NO_OPEN: "1" },
  });
}

test.beforeAll(async ({}, testInfo) => {
  if (!fs.existsSync(daemonJs)) {
    throw new Error(`dist/daemon/index.js missing at ${daemonJs} — run \`pnpm build\` before the e2e suite.`);
  }
  fs.mkdirSync(SHOTS, { recursive: true });
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dp-203-home-"));
  fullRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-203-full-"));
  emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-203-empty-"));

  procFull = bootDaemon(fullRoot);
  procEmpty = bootDaemon(emptyRoot);
  fullBase = (await withSetupDiagnostics(procFull, testInfo, () => waitForDaemon(fullRoot))).base;
  emptyBase = (await withSetupDiagnostics(procEmpty, testInfo, () => waitForDaemon(emptyRoot))).base;

  const tokenOf = (root: string) =>
    JSON.parse(fs.readFileSync(path.join(root, ".deeppairing", "daemon.json"), "utf-8")).authToken as string;

  // The shared feature seed — a Milestone 6 (2 artifacts + an unresolved
  // decision), a Phase 0, and one plain-titled Ungrouped artifact. Seeded into
  // both the slice-1 daemon and each isolated #206 corrections daemon.
  seedFeatures = async (base: string, root: string): Promise<void> => {
    const h = { "Content-Type": "application/json", Authorization: `Bearer ${tokenOf(root)}` };
    const post = (route: string, body: unknown) =>
      fetch(`${base}/api/internal/sessions/feat/${route}`, { method: "POST", headers: h, body: JSON.stringify(body) })
        .then((r) => { if (!r.ok) throw new Error(`seed ${route} failed: ${r.status}`); });

    await post("register", {});
    // --- Milestone 6 (two artifacts, shared prefix) ---
    await post("artifacts", {
      id: "m6_plan", type: "plan", title: "Milestone 6 — content quota backfill",
      content: { summary: "Backfill historical quota usage.", steps: [
        { description: "Backfill job", reasoning: "Historical rows lack usage.", files: ["src/quota.ts"] },
      ] },
    });
    await post("artifacts", {
      id: "m6_cs", type: "changeset", title: "Milestone 6 — quota backfill changeset",
      content: { summary: "The backfill implementation.",
        files: [
          { path: "src/quota.ts", changeType: "modified", stats: { additions: 12, deletions: 2 },
            hunks: [{ header: "@@ -1,2 +1,12 @@", lines: [{ kind: "add", content: "// backfill", newLine: 1 }] }] },
          { path: "src/shared.ts", changeType: "modified", stats: { additions: 1, deletions: 0 },
            hunks: [{ header: "@@ -5,0 +5,1 @@", lines: [{ kind: "add", content: "export const X = 1;", newLine: 5 }] }] },
        ] },
    });
    // An unresolved decision in Milestone 6 → an OPEN ITEM.
    await post("artifacts", {
      id: "m6_dec", type: "decision", title: "Milestone 6 — backfill batch size?",
      content: { context: "How large a backfill batch?", decisionId: "d_m6", stakes: "medium",
        options: [
          { id: "a", title: "500 rows", description: "small", pros: ["safe"], cons: ["slow"], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "5000 rows", description: "big", pros: ["fast"], cons: ["lock"], effort: "low", risk: "med", recommendation: false },
        ] },
    });
    await post("decisions", {
      decisionId: "d_m6", artifactId: "m6_dec", context: "How large a backfill batch?", stakes: "medium",
      options: [
        { id: "a", title: "500 rows", description: "small", pros: ["safe"], cons: ["slow"], effort: "low", risk: "low", recommendation: true },
        { id: "b", title: "5000 rows", description: "big", pros: ["fast"], cons: ["lock"], effort: "low", risk: "med", recommendation: false },
      ],
    });
    // --- Phase 0 (a second feature, also touches src/shared.ts → cross-group) ---
    await post("artifacts", {
      id: "p0_cc", type: "code_change", title: "Phase 0 — bootstrap the config loader",
      content: { filePath: "src/shared.ts", changeType: "modify",
        before: "export const X = 0;", after: "export const X = 1;", reasoning: "Bootstrap config." },
    });
    // --- A plain-titled artifact → the Ungrouped bucket ---
    await post("artifacts", {
      id: "loose", type: "plan", title: "Refactor the crawler retry loop",
      content: { summary: "Unrelated cleanup.", steps: [{ description: "Cap retries", reasoning: "Avoid runaway.", files: ["src/crawl.ts"] }] },
    });
  };

  await seedFeatures(fullBase, fullRoot);
});

test.afterAll(async () => {
  await teardownDaemon(procFull, portOf(fullBase));
  await teardownDaemon(procEmpty, portOf(emptyBase));
  for (const dir of [fullRoot, emptyRoot, home]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

async function openFeatures(page: Page, base: string, session?: string): Promise<void> {
  await page.goto(session ? `${base}/?session=${session}` : base);
  await page.getByRole("button", { name: /open features view/i }).click();
  await page.waitForSelector('[data-testid="features-view"]', { timeout: 15000 });
}

test("#203 — the Features view groups artifacts, Ungrouped last, with open items + click-through", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  await openFeatures(page, fullBase, "feat");
  const view = page.locator('[data-testid="features-view"]');

  // Two named features + the Ungrouped bucket (exact group TITLE, scoped to its
  // own group container — #206's per-row "move to feature…" select lists OTHER
  // groups' titles as <option>s, so an un-scoped exact-text match is ambiguous).
  await expect(view.locator('[data-feature-group="milestone-6"]').getByText("Milestone 6", { exact: true })).toBeVisible();
  await expect(view.locator('[data-feature-group="phase-0"]').getByText("Phase 0", { exact: true })).toBeVisible();
  await expect(view.locator('[data-feature-group="__ungrouped__"]').getByText("Ungrouped", { exact: true })).toBeVisible();

  // Milestone 6 is expanded by default → its timeline artifacts are visible.
  await expect(view.getByText("Milestone 6 — content quota backfill")).toBeVisible();
  // The unresolved decision surfaces as an open item.
  await expect(view.getByText("How large a backfill batch?")).toBeVisible();

  // The Ungrouped bucket is the LAST group and collapsed by default.
  const groups = view.locator("[data-feature-group]");
  await expect(groups.last()).toHaveAttribute("data-feature-group", "__ungrouped__");
  await expect(view.getByText("Refactor the crawler retry loop")).toHaveCount(0);

  // Honest limits are stated in-UI.
  await expect(view.getByText(/derived from artifact titles/i)).toBeVisible();

  await page.screenshot({ path: path.join(SHOTS, "features-populated-dark.png") });

  // Click-through: opening a timeline artifact enters its session (modal closes).
  await view.locator("[data-feature-artifact]").first().click();
  await expect(page.locator('[data-testid="features-view"]')).toHaveCount(0, { timeout: 15000 });
});

test("#203 — light theme renders the Features view legibly", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("dp-theme", "light"));
  await page.setViewportSize({ width: 1440, height: 950 });
  await openFeatures(page, fullBase, "feat");
  expect(await page.locator("html").getAttribute("data-theme")).toBe("light");
  await expect(
    page.locator('[data-testid="features-view"] [data-feature-group="milestone-6"]').getByText("Milestone 6", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, "features-populated-light.png") });
});

test("#203 — empty project shows the honest empty state", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.goto(emptyBase);
  await page.getByRole("button", { name: /open features view/i }).click();
  const view = page.locator('[data-testid="features-view"]');
  await view.waitFor({ timeout: 15000 });
  await expect(view.getByText(/no features yet/i)).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, "features-empty.png") });
});

// #206 (I1) — the human corrections: RENAME a group + MOVE an artifact. Runs on
// a fresh seeded daemon per test so each scenario is independently runnable
// and declaration order cannot become part of the fixture contract. Exact
// group-TITLE assertions are scoped to the group container (the per-row
// move-select lists other groups' titles as <option>s).
test.describe("#206 — human corrections", () => {
  test.beforeEach(async ({}, testInfo) => {
    corrRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-206-corr-"));
    procCorr = bootDaemon(corrRoot);
    corrBase = (await withSetupDiagnostics(procCorr, testInfo, () => waitForDaemon(corrRoot))).base;
    await withSetupDiagnostics(procCorr, testInfo, () => seedFeatures(corrBase, corrRoot));
  });

  test.afterEach(async () => {
    await teardownDaemon(procCorr, portOf(corrBase));
    try { fs.rmSync(corrRoot, { recursive: true, force: true }); } catch {}
  });

  test("rename a feature and move an artifact, persisted (dark theme)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 950 });
    await openFeatures(page, corrBase, "feat");
    const view = page.locator('[data-testid="features-view"]');
    const m6 = view.locator('[data-feature-group="milestone-6"]');

    // --- RENAME Milestone 6 → "Quota backfill" ---
    await m6.locator("[data-feature-rename]").click();
    const input = view.locator("[data-feature-rename-input]");
    await input.fill("Quota backfill");
    await input.press("Enter");
    await expect(m6.getByText("Quota backfill", { exact: true })).toBeVisible();
    // The rename is authoritative — a reload re-reads it from disk (persistence).
    await page.reload();
    await page.getByRole("button", { name: /open features view/i }).click();
    await page.waitForSelector('[data-testid="features-view"]', { timeout: 15000 });
    await expect(
      view.locator('[data-feature-group="milestone-6"]').getByText("Quota backfill", { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, "features-renamed-dark.png") });

    // --- MOVE a Milestone 6 timeline artifact into Phase 0 ---
    const renamed = view.locator('[data-feature-group="milestone-6"]');
    await renamed.locator("[data-feature-move]").first().selectOption({ label: "Phase 0" });
    // It now lives under Phase 0 (expanded by default), and the corrections
    // footnote is stated in-UI.
    const phase0 = view.locator('[data-feature-group="phase-0"]');
    await expect(phase0.locator("[data-feature-artifact]")).toHaveCount(2);
    await expect(view.getByText(/feature tags the agent stamps/i)).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, "features-moved-dark.png") });
  });

  test("corrections view renders legibly (light theme)", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("dp-theme", "light"));
    await page.setViewportSize({ width: 1440, height: 950 });
    await openFeatures(page, corrBase, "feat");
    const view = page.locator('[data-testid="features-view"]');
    expect(await page.locator("html").getAttribute("data-theme")).toBe("light");
    // Exercise the persisted correction on this test's own pristine fixture.
    const m6 = view.locator('[data-feature-group="milestone-6"]');
    await m6.locator("[data-feature-rename]").click();
    const input = view.locator("[data-feature-rename-input]");
    await input.fill("Quota backfill");
    await input.press("Enter");
    await expect(
      m6.getByText("Quota backfill", { exact: true }),
    ).toBeVisible();
    // Exercise the rename input's light-theme styling.
    await m6.locator("[data-feature-rename]").click();
    await expect(view.locator("[data-feature-rename-input]")).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, "features-corrections-light.png") });
  });
});
