import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { teardownDaemon, portOf } from "./daemon-harness.js";

/**
 * #189 (UX LIGHTENING) — the real-browser backstops for the two layout fixes
 * that only a rendered DOM can prove, plus the "after" screenshot capture for
 * the PR:
 *   - #4  the ~900px (VS Code webview) header no longer garbles: the "Your
 *         turn" pill and the nav cluster do not overlap.
 *   - #5  a mermaid diagram on a LIGHT-theme card gets LIGHT node fills (not the
 *         dark-theme dark fills that were unreadable on white).
 *
 * Screenshots land in $DP189_SHOTS (default: os.tmpdir()/dp-189-shots).
 */
const __dir = path.dirname(fileURLToPath(import.meta.url));
const daemonJs = path.resolve(__dir, "../dist/daemon/index.js");
const SHOTS = process.env.DP189_SHOTS ?? path.join(os.tmpdir(), "dp-189-shots");

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
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("daemon did not come up");
}

test.beforeAll(async () => {
  if (!fs.existsSync(daemonJs)) {
    throw new Error(`dist/daemon/index.js missing at ${daemonJs} — run \`pnpm build\` before the e2e suite.`);
  }
  fs.mkdirSync(SHOTS, { recursive: true });
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dp-189-home-"));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-189-"));
  proc = spawn(process.execPath, [daemonJs], {
    env: { ...process.env, HOME: home, DEEPPAIRING_PROJECT_ROOT: projectRoot, DEEPPAIRING_NO_OPEN: "1" },
    stdio: "ignore",
  });
  const daemon = await waitForDaemon(projectRoot);
  baseURL = daemon.base;
  const h = { "Content-Type": "application/json", Authorization: `Bearer ${daemon.token}` };
  const post = (route: string, body: unknown) =>
    fetch(`${baseURL}/api/internal/sessions/ux/${route}`, { method: "POST", headers: h, body: JSON.stringify(body) })
      .then((r) => { if (!r.ok) throw new Error(`seed ${route} failed: ${r.status}`); });

  await post("register", {});
  // A plan with a diagram visual (light-mermaid target) + draft steps (fix #6).
  await post("artifacts", {
    id: "plan_ux", type: "plan", title: "Add per-user API rate limiting",
    content: {
      summary: "Sliding-window limiter behind the middleware.",
      estimatedChanges: 3,
      visuals: [{ id: "vis_flow", kind: "diagram", title: "Request flow",
        source: "graph LR; Client[Client] --> MW[Middleware]; MW --> RL[Rate Limiter]; RL --> Redis[(Redis)]; MW --> RH[Route Handler]" }],
      steps: [
        { description: "Add a RateLimiter interface + Redis-backed sliding window", reasoning: "Avoids the burst-at-boundary problem of fixed windows.", files: ["src/rate-limit.ts"] },
        { description: "Wire the limiter into the middleware chain", reasoning: "Every route inherits limiting.", files: ["src/middleware.ts"] },
        { description: "Add a route-wrapper helper", reasoning: "Opt-in per-route overrides.", files: ["src/wrap.ts"] },
      ],
    },
  });
  // Findings/research (unified-verb card).
  await post("artifacts", {
    id: "res_ux", type: "research", title: "Middleware audit before wiring the limiter",
    content: { summary: "Where the request pipeline touches auth + rate state.",
      findings: [{ category: "Architecture", title: "Single choke point", detail: "All routes flow through one middleware.", significance: "high" }] },
  });
  // Decision (Select / None of these fit / Reject).
  await post("artifacts", {
    id: "dec_ux", type: "decision", title: "Where do we store rate-limit counters?",
    content: { context: "Counter store for the limiter?", decisionId: "d_ux", stakes: "high",
      options: [
        { id: "a", title: "Redis", description: "Shared counter store", pros: ["fast", "shared"], cons: ["ops"], effort: "low", risk: "low", recommendation: true },
        { id: "b", title: "In-process", description: "Per-node map", pros: ["simple"], cons: ["not shared"], effort: "low", risk: "med", recommendation: false },
      ] },
  });
  await post("decisions", {
    decisionId: "d_ux", artifactId: "dec_ux", context: "Counter store for the limiter?", stakes: "high",
    options: [
      { id: "a", title: "Redis", description: "Shared counter store", pros: ["fast"], cons: ["ops"], effort: "low", risk: "low", recommendation: true },
      { id: "b", title: "In-process", description: "Per-node map", pros: ["simple"], cons: ["not shared"], effort: "low", risk: "med", recommendation: false },
    ],
  });
  // Changeset (Approve / Send back / Reject).
  await post("artifacts", {
    id: "cs_ux", type: "changeset", title: "Wire the sliding-window limiter into the middleware",
    content: { summary: "Centralize limiting so every route inherits it.",
      files: [
        { path: "src/middleware.ts", changeType: "modified", stats: { additions: 3, deletions: 1 },
          hunks: [{ header: "@@ -10,3 +10,5 @@ export function pipeline() {", lines: [
            { kind: "ctx", content: "  const req = ctx.req;", oldLine: 10, newLine: 10 },
            { kind: "add", content: "  await limiter.check(req.userId);", newLine: 11 },
          ] }] },
        { path: "src/rate-limit.ts", changeType: "added", stats: { additions: 20, deletions: 0 },
          hunks: [{ header: "@@ -0,0 +1,3 @@", lines: [
            { kind: "add", content: "export class RateLimiter {}", newLine: 1 },
          ] }] },
      ] },
  });
  // Single-file code_change (Approve / Request changes / Reject via ArtifactStatusActions).
  await post("artifacts", {
    id: "cc_ux", type: "code_change", title: "Route-wrapper helper",
    content: { filePath: "src/wrap.ts", changeType: "create",
      after: ["export function withLimit(handler) {", "  return async (req, res) => {", "    await limiter.check(req.userId);", "    return handler(req, res);", "  };", "}"].join("\n") },
  });
});

test.afterAll(async () => {
  await teardownDaemon(proc, portOf(baseURL));
  for (const dir of [projectRoot, home]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

/** Do two DOM rects overlap horizontally AND vertically (i.e. truly collide)? */
function rectsOverlap(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

async function gotoSession(page: Page): Promise<void> {
  await page.goto(`${baseURL}/?session=ux`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
}

test("#189/#4 — at 900px the 'Your turn' pill does not overlap the nav cluster", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await gotoSession(page);
  const pill = page.getByRole("button", { name: /your turn/i });
  await pill.waitFor({ timeout: 15000 });
  // The nav labels collapse below 1100px; the buttons stay reachable by aria.
  const ledger = page.getByRole("button", { name: /open the ledger/i });
  const help = page.getByRole("button", { name: /show keyboard shortcuts/i });
  const pillBox = await pill.boundingBox();
  const ledgerBox = await ledger.boundingBox();
  const helpBox = await help.boundingBox();
  if (!pillBox || !ledgerBox || !helpBox) throw new Error("missing header geometry");
  // The pill (left group) must sit entirely left of the nav cluster — no garble.
  expect(rectsOverlap(pillBox, ledgerBox), "pill overlaps the Ledger nav button").toBe(false);
  expect(rectsOverlap(pillBox, helpBox), "pill overlaps the help nav button").toBe(false);
  expect(pillBox.x + pillBox.width).toBeLessThanOrEqual(ledgerBox.x + 1);
  await page.screenshot({ path: path.join(SHOTS, "after-900px-header.png") });
});

test("#189/#5 — a mermaid diagram on a LIGHT card gets light node fills (not dark)", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("dp-theme", "light"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoSession(page);
  // The plan is auto-selected first; wait for the real mermaid SVG.
  await page.waitForSelector(".dp-mermaid svg", { timeout: 15000 });
  expect(await page.locator("html").getAttribute("data-theme")).toBe("light");
  const fill = await page.evaluate(() => {
    const node = document.querySelector(".dp-mermaid svg g.node") as SVGGElement | null;
    if (!node) return null;
    const shape = node.querySelector("rect, polygon, path, circle, ellipse") as SVGElement | null;
    if (!shape) return null;
    return getComputedStyle(shape).fill;
  });
  expect(fill, "no node shape fill found").toBeTruthy();
  // Parse the rgb channels out of the computed fill → relative luminance.
  // A light theme fills nodes light (mermaid "default": ~#ECECFF); the dark
  // theme fills them dark (~#1f2020) — luminance cleanly separates the two.
  const nums = fill!.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  expect(nums.length, `unparseable fill: ${fill}`).toBeGreaterThanOrEqual(3);
  const [r, g, b] = nums;
  const lum = (0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)) / 255;
  expect(lum, `node fill ${fill} is too dark for a light card`).toBeGreaterThan(0.5);
  await page.screenshot({ path: path.join(SHOTS, "after-light-mermaid.png"), fullPage: false });
});

test("#189 — capture 'after' screenshots for the PR (header, sidebar, verb cards)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  await gotoSession(page);
  // Header (default width, nav labels visible).
  await page.screenshot({ path: path.join(SHOTS, "after-header-dark.png"), clip: { x: 0, y: 0, width: 1440, height: 60 } });
  // Diagnostics (⋯) menu open — proves gate/hooks/autonomy/stats are reachable.
  await page.getByRole("button", { name: /open diagnostics menu/i }).click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(SHOTS, "after-diagnostics-menu.png"), clip: { x: 900, y: 0, width: 540, height: 320 } });
  await page.keyboard.press("Escape");
  // Sidebar — flow singletons no longer show a repeated ALL-CAPS header.
  await page.screenshot({ path: path.join(SHOTS, "after-sidebar-flow.png"), clip: { x: 0, y: 40, width: 300, height: 500 } });

  // One unified-verb card per type — select each via its sidebar row (scoped to
  // the sidebar scroll container so the match is the list button, not the detail
  // heading), then screenshot the review footer in context.
  const cards: Array<[string, string]> = [
    ["Add per-user API rate limiting", "after-verbs-plan.png"],
    ["Middleware audit", "after-verbs-findings.png"],
    ["Where do we store", "after-verbs-decision.png"],
    ["Wire the sliding-window", "after-verbs-changeset.png"],
    ["Route-wrapper helper", "after-verbs-codechange.png"],
  ];
  const sidebar = page.locator('[data-testid="sidebar-scroll"]');
  for (const [text, file] of cards) {
    await sidebar.locator("button").filter({ hasText: text }).first().click({ timeout: 8000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SHOTS, file) });
  }
});
