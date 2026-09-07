import { test, daemonBeforeAll, expect, type Page } from "./test.js";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { teardownDaemon, portOf, spawnDiagnosticProcess, withSetupDiagnostics } from "./daemon-harness.js";

/**
 * I2 (#207) — real-browser verification + PR screenshots for the write-lock
 * extension, both themes:
 *   (d) a RETRACTED decision — options readable, Select disabled + read-only
 *       labelled, the "Discuss" workbench entry withheld, footer actions inert.
 *   (e) a RETRACTED debrief — every grain/ask composer withheld, narrative +
 *       any prior thread readable.
 *
 * One daemon, kept LIVE. Screenshots land in $DP207_SHOTS.
 */
const __dir = path.dirname(fileURLToPath(import.meta.url));
const daemonJs = path.resolve(__dir, "../dist/daemon/index.js");
const SHOTS = process.env.DP207_SHOTS ?? path.join(os.tmpdir(), "dp-207-shots");

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

daemonBeforeAll(() => [proc], async (testInfo) => {
  if (!fs.existsSync(daemonJs)) {
    throw new Error(`dist/daemon/index.js missing at ${daemonJs} — run \`pnpm build\` before the e2e suite.`);
  }
  fs.mkdirSync(SHOTS, { recursive: true });
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dp-207-home-"));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-207-"));
  proc = spawnDiagnosticProcess(process.execPath, [daemonJs], {
    env: { ...process.env, HOME: home, DEEPPAIRING_PROJECT_ROOT: projectRoot, DEEPPAIRING_NO_OPEN: "1" },
  });
  const daemon = await withSetupDiagnostics(proc, testInfo, () => waitForDaemon(projectRoot));
  baseURL = daemon.base;
  const h = { "Content-Type": "application/json", Authorization: `Bearer ${daemon.token}` };
  const post = (route: string, body: unknown) =>
    fetch(`${baseURL}/api/internal/sessions/s/${route}`, { method: "POST", headers: h, body: JSON.stringify(body) })
      .then((r) => { if (!r.ok) throw new Error(`seed ${route} failed: ${r.status}`); });

  await post("register", { title: "I2 surfaces" });

  // (d) A retracted DECISION — never resolved, so it renders the option grid.
  await post("artifacts", {
    id: "dec_ret", type: "decision", title: "Which session store?",
    content: {
      context: "Which store backs the session cache?",
      decisionId: "dec_store",
      stakes: "high",
      options: [
        { id: "o1", title: "Redis", description: "In-memory store", pros: ["fast"], cons: ["another service"], effort: "low", risk: "low", recommendation: true },
        { id: "o2", title: "Postgres table", description: "Reuse the primary DB", pros: ["no new infra"], cons: ["row churn"], effort: "medium", risk: "medium", recommendation: false },
      ],
    },
  });
  await post("artifacts/dec_ret/status", { status: "retracted" });
  await post("comments", { id: "dwd_1", artifactId: "dec_ret", author: "agent", content: "Withdrawn." });

  // (e) A retracted DEBRIEF with a prior grain thread on the summary block.
  await post("artifacts", {
    id: "deb_ret", type: "debrief", title: "Session TTL refresh — debrief",
    content: {
      summary: "Moved the sliding-window session-TTL refresh into middleware.",
      sections: [{ title: "Centralized the TTL refresh in middleware", body: "One choke point now touches the store." }],
      decisionsMade: [{ what: "Return 401 and clear the cookie on a stale session", why: "Fail closed." }],
      needsYourEyes: [{ what: "The 401 branch", why: "Confirm the redirect target." }],
      deferred: [{ what: "Metrics", why: "Follow-up PR." }],
      openQuestions: ["Should idle timeout be configurable?"],
    },
  });
  await post("artifacts/deb_ret/status", { status: "retracted" });
  await post("comments", {
    id: "dgc_1", artifactId: "deb_ret", author: "human", content: "Nice — this is exactly the choke point.",
    target: { artifactId: "deb_ret", sectionId: "debrief:summary" },
  });
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
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  await page.waitForTimeout(600);
}

async function selectArtifact(page: Page, title: string): Promise<void> {
  await page.getByText(title, { exact: false }).first().click();
  await page.waitForTimeout(400);
}

test("(d) retracted decision + (e) retracted debrief write-lock, both themes", async ({ page }) => {
  for (const theme of ["dark", "light"] as const) {
    await load(page, theme);

    // (d) Retracted decision — options readable, Select disabled + read-only,
    // Discuss entry + footer actions withheld.
    await selectArtifact(page, "Which session store?");
    await expect(page.getByText("In-memory store")).toBeVisible();
    await expect(page.getByRole("button", { name: "Select Redis" })).toBeDisabled();
    await expect(page.getByRole("button", { name: /Expand to discuss/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Send decision back for revised options/i })).toHaveCount(0);
    await page.screenshot({ path: path.join(SHOTS, `retracted-decision-${theme}.png`), fullPage: false });

    // (e) Retracted debrief — every composer withheld, narrative + prior thread readable.
    await selectArtifact(page, "Session TTL refresh — debrief");
    await expect(page.getByText(/Moved the sliding-window session-TTL refresh/i)).toBeVisible();
    await expect(page.getByText("Nice — this is exactly the choke point.")).toBeVisible();
    // No grain-comment toggles, no ask-anything textarea.
    await expect(page.locator("[data-grain-affordance]")).toHaveCount(0);
    await expect(page.getByLabel("Comment on this debrief")).toHaveCount(0);
    await page.screenshot({ path: path.join(SHOTS, `retracted-debrief-${theme}.png`), fullPage: false });
  }
});
