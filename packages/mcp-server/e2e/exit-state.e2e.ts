import { test, expect, type Page } from "./test.js";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { teardownDaemon, portOf } from "./daemon-harness.js";

/**
 * F2 (#196) — real-browser verification + PR screenshots for the two states a
 * rendered DOM proves best:
 *   - item 4 (M3): the agent's-turn pill shows "Agent exited — resume to
 *     continue" (no pulse) once the wrapper is gone, instead of a stale
 *     "Agent working"/"Up to date".
 *   - item 5 (M4): with pending drafts + an unanswered question + an exited
 *     agent, the header pills COLLAPSE to counts (the PendingBanner /
 *     ResumeQuestionsBanner below carry the actionable label) — the same fact
 *     no longer renders verbatim 4-5x.
 *
 * Two ISOLATED daemons (MultiAgentSync backfills EVERY active session's
 * artifacts into the merged store, so a drafts-session and a clean-session must
 * not share a daemon). Screenshots land in $DP196_SHOTS.
 */
const __dir = path.dirname(fileURLToPath(import.meta.url));
const daemonJs = path.resolve(__dir, "../dist/daemon/index.js");
const SHOTS = process.env.DP196_SHOTS ?? path.join(os.tmpdir(), "dp-196-shots");

interface Daemon {
  proc: ChildProcess;
  baseURL: string;
  projectRoot: string;
  home: string;
}

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

async function bootDaemon(tag: string, seed: (post: (route: string, body: unknown) => Promise<void>) => Promise<void>): Promise<Daemon> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `dp-196-home-${tag}-`));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `dp-196-${tag}-`));
  const proc = spawn(process.execPath, [daemonJs], {
    env: { ...process.env, HOME: home, DEEPPAIRING_PROJECT_ROOT: projectRoot, DEEPPAIRING_NO_OPEN: "1" },
    stdio: "ignore",
  });
  const daemon = await waitForDaemon(projectRoot);
  const baseURL = daemon.base;
  const h = { "Content-Type": "application/json", Authorization: `Bearer ${daemon.token}` };
  const post = (route: string, body: unknown) =>
    fetch(`${baseURL}/api/internal/sessions/s/${route}`, { method: "POST", headers: h, body: JSON.stringify(body) })
      .then((r) => { if (!r.ok) throw new Error(`seed ${route} failed: ${r.status}`); });
  await post("register", { title: "Rate limiting" });
  await seed(post);
  // Exit the wrapper: drop the session from the active set (live:false) while
  // its store stays readable — exactly the state both items are about.
  await post("unregister", {});
  return { proc, baseURL, projectRoot, home };
}

// Item 5: two draft artifacts (pending) + an unanswered question comment.
let soup: Daemon;
// Item 4: one approved artifact (hasArtifacts, no pending) + an unanswered question.
let exited: Daemon;

test.beforeAll(async () => {
  if (!fs.existsSync(daemonJs)) {
    throw new Error(`dist/daemon/index.js missing at ${daemonJs} — run \`pnpm build\` before the e2e suite.`);
  }
  fs.mkdirSync(SHOTS, { recursive: true });

  soup = await bootDaemon("soup", async (post) => {
    await post("artifacts", {
      id: "plan_1", type: "plan", title: "Add per-user API rate limiting",
      content: { summary: "Sliding-window limiter.", steps: [{ description: "Add a RateLimiter", reasoning: "burst safety", files: ["src/rl.ts"] }] },
    });
    await post("artifacts", {
      id: "res_1", type: "research", title: "Middleware audit",
      content: { summary: "One choke point.", findings: [{ category: "Architecture", title: "Single choke point", detail: "All routes flow through one middleware.", significance: "high" }] },
    });
    await post("comments", { id: "q_1", artifactId: "res_1", author: "human", intent: "question", content: "Does this cover websocket upgrades too?" });
  });

  exited = await bootDaemon("exit", async (post) => {
    await post("artifacts", {
      id: "res_a", type: "research", title: "Middleware audit",
      content: { summary: "One choke point.", findings: [{ category: "Architecture", title: "Single choke point", detail: "All routes flow through one middleware.", significance: "high" }] },
    });
    // Approve it so it leaves the pending set (agent's-turn branch, no pill).
    await post("artifacts/res_a/status", { status: "approved" });
    await post("comments", { id: "q_a", artifactId: "res_a", author: "human", intent: "question", content: "Does this cover websocket upgrades too?" });
  });
});

test.afterAll(async () => {
  for (const d of [soup, exited]) {
    if (!d) continue;
    await teardownDaemon(d.proc, portOf(d.baseURL));
    for (const dir of [d.projectRoot, d.home]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }
});

async function shot(page: Page, baseURL: string, name: string, theme: "dark" | "light"): Promise<void> {
  await page.setViewportSize({ width: 1100, height: 820 });
  await page.goto(`${baseURL}/?session=s`);
  await page.evaluate((t) => localStorage.setItem("dp-theme", t), theme);
  await page.reload();
  // Wait for the artifact list so the session is bound + rendered.
  await page.waitForSelector("[data-artifact-id], main", { timeout: 15000 });
  // Give the active-sessions poll a beat to reflect live:false.
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`), clip: { x: 0, y: 0, width: 1100, height: 190 } });
}

test("item 5 (M4) — banner-soup dedup: header pills collapse to counts, both themes", async ({ page }) => {
  for (const theme of ["dark", "light"] as const) {
    await shot(page, soup.baseURL, "item5-dedup", theme);
  }
  // Verify (theme-independent) the deduped header + acting banners.
  await page.goto(`${soup.baseURL}/?session=s`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  await page.waitForTimeout(1200);
  // S2 (round-14) — the dedup deepened: the header pending pill drops the number
  // entirely (the waiting banner OWNS the one authoritative count) and collapses
  // to a bare "Your turn" jump affordance — NOT the verbatim breakdown, NOT a
  // count.
  await expect(page.getByRole("button", { name: /your turn/i })).toBeVisible();
  await expect(page.getByText(/Your turn — /i)).toHaveCount(0);
  // The acting banners carry the labels (and the count) once each.
  await expect(page.getByText(/waiting for you/i)).toBeVisible();
  await expect(page.getByText(/waiting for Claude/i)).toBeVisible();
});

test("item 4 (M3) — agent-exited pill, both themes", async ({ page }) => {
  for (const theme of ["dark", "light"] as const) {
    await shot(page, exited.baseURL, "item4-exited", theme);
  }
  await page.goto(`${exited.baseURL}/?session=s`);
  await page.waitForSelector("main", { timeout: 15000 });
  await page.waitForTimeout(1500);
  await expect(page.getByText(/Agent exited — resume to continue/i)).toBeVisible();
  // No stale "Agent working"/"Up to date" claim over an exited agent.
  await expect(page.getByText(/Agent working|Up to date/i)).toHaveCount(0);
});
