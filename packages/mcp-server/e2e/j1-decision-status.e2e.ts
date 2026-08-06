import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { teardownDaemon, portOf } from "./daemon-harness.js";

/**
 * J1 (#209) — real-browser verification + PR screenshots that the STATUS track
 * and the RESOLUTION track now tell the same story, both themes:
 *   (a) a RESOLVED decision wears "Approved" in the header pill — never the
 *       amber "Draft, awaiting review" it used to keep after the choice.
 *   (b) a RETRACTED (unresolved) decision renders its withdrawal reason in the
 *       read-only footer AND dims the recommended-option highlight (round-5 L-6).
 *   (c) the Project Decisions modal badges the retracted decision "Withdrawn",
 *       not a permanent "Awaiting your decision".
 *
 * One daemon, kept LIVE. Screenshots land in $DP209_SHOTS.
 */
const __dir = path.dirname(fileURLToPath(import.meta.url));
const daemonJs = path.resolve(__dir, "../dist/daemon/index.js");
const SHOTS = process.env.DP209_SHOTS ?? path.join(os.tmpdir(), "dp-209-shots");

let proc: ChildProcess;
let baseURL: string;
let projectRoot: string;
let home: string;

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

const OPTS = [
  { id: "o1", title: "Redis", description: "In-memory store", pros: ["fast"], cons: ["another service"], effort: "low", risk: "low", recommendation: true },
  { id: "o2", title: "Postgres table", description: "Reuse the primary DB", pros: ["no new infra"], cons: ["row churn"], effort: "medium", risk: "medium", recommendation: false },
];

test.beforeAll(async () => {
  if (!fs.existsSync(daemonJs)) {
    throw new Error(`dist/daemon/index.js missing at ${daemonJs} — run \`pnpm build\` before the e2e suite.`);
  }
  fs.mkdirSync(SHOTS, { recursive: true });
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dp-209-home-"));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-209-"));
  proc = spawn(process.execPath, [daemonJs], {
    env: { ...process.env, HOME: home, DEEPPAIRING_PROJECT_ROOT: projectRoot, DEEPPAIRING_NO_OPEN: "1" },
    stdio: "ignore",
  });
  const daemon = await waitForDaemon(projectRoot);
  baseURL = daemon.base;
  const h = { "Content-Type": "application/json", Authorization: `Bearer ${daemon.token}` };
  const post = (route: string, body: unknown) =>
    fetch(`${baseURL}/api/internal/sessions/s/${route}`, { method: "POST", headers: h, body: JSON.stringify(body) })
      .then((r) => { if (!r.ok) throw new Error(`seed ${route} failed: ${r.status}`); });

  await post("register", { title: "J1 decision status" });

  // (a) A RESOLVED decision — created draft, recorded, then resolved through the
  // real store path, which now advances the artifact draft→approved.
  await post("artifacts", {
    id: "dec_done", type: "decision", title: "Which hashing algorithm?",
    content: { context: "Which password hash?", decisionId: "d_done", stakes: "high", options: OPTS },
  });
  await post("decisions", { decisionId: "d_done", artifactId: "dec_done", context: "Which password hash?", options: OPTS });
  await post("decisions/d_done/resolve", { optionId: "o1", reasoning: "memory-hard + tunable" });

  // (b/c) A RETRACTED, still-UNRESOLVED decision — carries a withdrawal reason
  // and a live (unresolved) decision record so it appears in the project modal.
  await post("artifacts", {
    id: "dec_wd", type: "decision", title: "Which session store?",
    content: { context: "Which store backs the session cache?", decisionId: "d_wd", stakes: "high", options: OPTS },
  });
  await post("decisions", { decisionId: "d_wd", artifactId: "dec_wd", context: "Which store backs the session cache?", options: OPTS });
  await post("artifacts/dec_wd/retract-reason", { reason: "Superseded by the caching-layer RFC — re-scoping before we pick." });
  await post("artifacts/dec_wd/status", { status: "retracted" });
});

test.afterAll(async () => {
  if (proc) await teardownDaemon(proc, portOf(baseURL));
  for (const dir of [projectRoot, home]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

async function load(page: Page, theme: "dark" | "light"): Promise<void> {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto(`${baseURL}/?session=s`);
  await page.evaluate((t) => localStorage.setItem("dp-theme", t), theme);
  await page.reload();
  await page.waitForSelector("[data-artifact-id]", { timeout: 20000 });
  await page.waitForTimeout(600);
}

async function selectArtifact(page: Page, title: string): Promise<void> {
  await page.getByText(title, { exact: false }).first().click();
  await page.waitForTimeout(400);
}

test("(a) resolved pill + (b) retracted reason/dimmed border + (c) Withdrawn modal row, both themes", async ({ page }) => {
  for (const theme of ["dark", "light"] as const) {
    await load(page, theme);

    // (a) RESOLVED decision — the header pill reads Approved, NOT the amber
    // "Draft, awaiting review" it used to keep after the choice was made.
    await selectArtifact(page, "Which hashing algorithm?");
    const panel = page.locator("[data-artifact-id='dec_done']");
    await expect(panel.getByText("Approved", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Draft, awaiting review")).toHaveCount(0);
    await page.screenshot({ path: path.join(SHOTS, `resolved-decision-approved-pill-${theme}.png`), fullPage: false });

    // (b) RETRACTED decision — the read-only footer surfaces the withdrawal
    // reason, and the recommended option's bright highlight is dimmed.
    await selectArtifact(page, "Which session store?");
    await expect(page.getByText("In-memory store")).toBeVisible();
    await expect(page.getByText("Retracted by agent").first()).toBeVisible();
    await expect(page.getByText(/Superseded by the caching-layer RFC/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "Select Redis" })).toBeDisabled();
    await page.screenshot({ path: path.join(SHOTS, `retracted-decision-reason-dimmed-${theme}.png`), fullPage: false });

    // (c) Project Decisions modal — the retracted decision is badged "Withdrawn",
    // never a permanent "Awaiting your decision".
    await page.getByRole("button", { name: "Open project decisions" }).click();
    await page.waitForTimeout(500);
    await expect(page.getByText("Withdrawn", { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, `decisions-modal-withdrawn-${theme}.png`), fullPage: false });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }
});
