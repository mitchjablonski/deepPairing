import { test, expect, type Page } from "./test.js";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { teardownDaemon, portOf, spawnDiagnosticProcess, withSetupDiagnostics } from "./daemon-harness.js";

/**
 * #216 (K2) — launch hygiene, the two UX surfaces:
 *
 *  1. The 900px palette door. J4 (#212) made the header's ⌘K affordance the
 *     ONLY door to the command palette, but gated it `hidden min-[1100px]` — so
 *     below 1100px (900px = the VS Code webview width) it vanished, taking the
 *     only path to search + quick actions with it. K2 restores it as an
 *     icon-only fallback (⌘K glyph always, "Search" label only ≥1100px). This
 *     spec proves the affordance is present AND opens the palette at 900px.
 *
 *  2. First-run tone. A freshly-connected artifact-less session shows the
 *     reassuring "Connected — waiting for the agent's first move" header. The
 *     SkillLoadBanner used to fire its alarming yellow "Claude may not be using
 *     deepPairing tools yet" strip at that same instant. K2 holds the banner for
 *     a grace window, so the first-run frame reads as calm waiting, not fault.
 *     This spec asserts the alarm is absent on a fresh load and captures the
 *     reconciled frame in both themes.
 *
 * Boots a real daemon against a temp projectRoot with a registered but
 * artifact-less session (the first-run state). Screenshots land in $DP216_SHOTS
 * (default: os.tmpdir()/dp-216-shots), suffixed with $DP216_LABEL (default
 * "after") so a before/after pair can share a directory.
 */
const __dir = path.dirname(fileURLToPath(import.meta.url));
const daemonJs = path.resolve(__dir, "../dist/daemon/index.js");
const SHOTS = process.env.DP216_SHOTS ?? path.join(os.tmpdir(), "dp-216-shots");
const LABEL = process.env.DP216_LABEL ?? "after";

let proc: ChildProcess | undefined;
let projectRoot: string;
let home: string;
let baseURL: string;

async function waitForDaemon(root: string): Promise<{ base: string; token: string }> {
  const daemonJson = path.join(root, ".deeppairing", "daemon.json");
  for (let i = 0; i < 120; i++) {
    try {
      const info = JSON.parse(fs.readFileSync(daemonJson, "utf-8"));
      if (info.port && info.authToken) {
        const res = await fetch(`http://localhost:${info.port}/api/daemon-info`);
        if (res.ok) return { base: `http://localhost:${info.port}`, token: info.authToken };
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("daemon did not come up");
}

test.beforeAll(async ({}, testInfo) => {
  if (!fs.existsSync(daemonJs)) {
    throw new Error(`dist/daemon/index.js missing at ${daemonJs} — run \`pnpm build\` before the e2e suite.`);
  }
  fs.mkdirSync(SHOTS, { recursive: true });
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dp-216-home-"));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-216-"));
  proc = spawnDiagnosticProcess(process.execPath, [daemonJs], {
    env: { ...process.env, HOME: home, DEEPPAIRING_PROJECT_ROOT: projectRoot, DEEPPAIRING_NO_OPEN: "1" },
  });
  const daemon = await withSetupDiagnostics(proc, testInfo, () => waitForDaemon(projectRoot));
  baseURL = daemon.base;
  const h = { "Content-Type": "application/json", Authorization: `Bearer ${daemon.token}` };
  // Register a session but seed NO artifacts — the connected-empty first-run
  // state (the reassuring "waiting for the agent's first move" beat).
  const res = await fetch(`${baseURL}/api/internal/sessions/s/register`, {
    method: "POST", headers: h, body: JSON.stringify({ title: "Auth module" }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status}`);
});

test.afterAll(async () => {
  await teardownDaemon(proc, portOf(baseURL));
  for (const dir of [projectRoot, home]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

async function gotoFirstRun(page: Page, theme: "dark" | "light", width: number): Promise<void> {
  await page.setViewportSize({ width, height: 820 });
  await page.goto(`${baseURL}/?session=s`);
  await page.evaluate((t) => localStorage.setItem("dp-theme", t), theme);
  await page.reload();
  // The header's palette affordance is present at EVERY width post-K2, so it is
  // a stable "the shell painted at this width" signal (no artifact to wait on).
  await page.waitForSelector('[aria-label="Open the command palette"]', { timeout: 20000 });
  // Let the active-sessions poll + connection settle.
  await page.waitForTimeout(1000);
}

test("#216 (K2) — the palette door survives 900px: affordance present and opens the palette", async ({ page }) => {
  for (const theme of ["dark", "light"] as const) {
    await gotoFirstRun(page, theme, 900);

    // The ⌘K affordance is visible at 900px (icon-only fallback), not hidden.
    const trigger = page.getByRole("button", { name: /open the command palette/i });
    await expect(trigger).toBeVisible();

    // Capture the header affordance at 900px (the fix: it no longer vanishes).
    await page.screenshot({
      path: path.join(SHOTS, `k2-palette-affordance-${theme}-${LABEL}.png`),
      clip: { x: 0, y: 0, width: 900, height: 44 },
    });

    // Clicking it opens the command palette — the only door to search + quick
    // actions at this width. Prove it opens by its search input, and capture it.
    await trigger.click();
    await expect(page.getByPlaceholder(/search artifacts, actions/i)).toBeVisible();
    await page.screenshot({
      path: path.join(SHOTS, `k2-palette-open-${theme}-${LABEL}.png`),
      clip: { x: 0, y: 0, width: 900, height: 320 },
    });
  }
});

test("#216 (K2) — first-run frame is reconciled: the alarm is held, header reads as calm waiting", async ({ page }) => {
  for (const theme of ["dark", "light"] as const) {
    await gotoFirstRun(page, theme, 900);
    // The reconciliation: on a fresh load the SkillLoadBanner's alarming strip
    // must NOT be showing (the grace window holds it), so it can't contradict
    // the reassuring header. LABEL !== "after" (an origin/main "before" capture)
    // skips the assertion — that build has no grace window, so the alarm shows.
    if (LABEL === "after") {
      await expect(page.getByText(/claude may not be using deepPairing tools/i)).toHaveCount(0);
    }
    await page.screenshot({
      path: path.join(SHOTS, `k2-first-run-${theme}-${LABEL}.png`),
      clip: { x: 0, y: 0, width: 900, height: 220 },
    });
  }
});
