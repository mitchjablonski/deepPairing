import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { teardownDaemon, portOf } from "./daemon-harness.js";

/**
 * #212 (J2b) — the probe's exact scenario: a session with ONE pending artifact
 * that fired FOUR redundant "you have work" signals (header count pill +
 * PendingBanner + the turn pill's verbatim label + the card's own status badge).
 *
 * This boots a real daemon, seeds exactly one pending draft (auto-selected, so
 * it is the card in view), and captures the top frame region at dark / light /
 * 900px. In the current build the PendingBanner is SUPPRESSED (the card is the
 * CTA; the header pill collapses to a bare "1 for you" count). Run the same
 * spec against origin/main to capture the "before" (banner present) — see the
 * PR body for the before/after pair.
 *
 * Screenshots land in $DP212_SHOTS (default: os.tmpdir()/dp-212-shots) and are
 * suffixed with $DP212_LABEL (default "after") so a before/after pair can share
 * a directory.
 */
const __dir = path.dirname(fileURLToPath(import.meta.url));
const daemonJs = path.resolve(__dir, "../dist/daemon/index.js");
const SHOTS = process.env.DP212_SHOTS ?? path.join(os.tmpdir(), "dp-212-shots");
const LABEL = process.env.DP212_LABEL ?? "after";

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

test.beforeAll(async () => {
  if (!fs.existsSync(daemonJs)) {
    throw new Error(`dist/daemon/index.js missing at ${daemonJs} — run \`pnpm build\` before the e2e suite.`);
  }
  fs.mkdirSync(SHOTS, { recursive: true });
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dp-212-home-"));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-212-"));
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

  await post("register", { title: "Rate limiting" });
  // EXACTLY ONE pending draft — the probe's one-artifact session. It is
  // auto-selected on arrival, so it is the card in view (the step-down trigger).
  await post("artifacts", {
    id: "cs_only", type: "changeset", title: "Wire the sliding-window limiter into the middleware",
    content: {
      summary: "Centralize limiting so every route inherits it.",
      files: [
        { path: "src/middleware.ts", changeType: "modified", stats: { additions: 3, deletions: 1 },
          hunks: [{ header: "@@ -10,3 +10,5 @@ export function pipeline() {", lines: [
            { kind: "ctx", content: "  const req = ctx.req;", oldLine: 10, newLine: 10 },
            { kind: "add", content: "  await limiter.check(req.userId);", newLine: 11 },
          ] }] },
      ],
    },
  });
});

test.afterAll(async () => {
  await teardownDaemon(proc, portOf(baseURL));
  for (const dir of [projectRoot, home]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

async function gotoSession(page: Page, theme: "dark" | "light", width = 1100): Promise<void> {
  await page.setViewportSize({ width, height: 820 });
  await page.goto(`${baseURL}/?session=s`);
  await page.evaluate((t) => localStorage.setItem("dp-theme", t), theme);
  await page.reload();
  // WSL 9P cold-starts are spiky; wait generously and reload once if the bound
  // session's artifact hasn't painted yet (the daemon retains it, so a re-bind
  // always resolves it).
  try {
    await page.waitForSelector("[data-artifact-id]", { timeout: 20000 });
  } catch {
    await page.reload();
    await page.waitForSelector("[data-artifact-id]", { timeout: 20000 });
  }
  // Let the active-sessions poll + auto-select settle.
  await page.waitForTimeout(1000);
}

test("#212 (J2b) — one-card frame: dark + light + 900px (top region)", async ({ page }) => {
  for (const theme of ["dark", "light"] as const) {
    await gotoSession(page, theme, 1100);
    await page.screenshot({ path: path.join(SHOTS, `j2b-frame-${theme}-${LABEL}.png`), clip: { x: 0, y: 0, width: 1100, height: 200 } });
  }
  // 900px (VS Code webview width) — the nav labels collapse; the frame must
  // still not double up the "you have work" signal.
  await gotoSession(page, "dark", 900);
  await page.screenshot({ path: path.join(SHOTS, `j2b-frame-900px-${LABEL}.png`), clip: { x: 0, y: 0, width: 900, height: 200 } });
});

test("#212 (J2b) — assert the step-down: single in-view card suppresses the banner, pill is a bare count", async ({ page }) => {
  // Only meaningful for the "after" build; skipped when capturing the origin/main
  // "before" (the assertions would fail there — that is the point of the pair).
  test.skip(LABEL !== "after", "assertions describe the post-change behavior");
  await gotoSession(page, "dark", 1100);
  // The PendingBanner is suppressed — no "waiting for you" strip.
  await expect(page.getByText(/waiting for you/i)).toHaveCount(0);
  // The header turn-pill collapsed to a bare count (not the verbatim breakdown).
  await expect(page.getByText(/1 for you/i)).toBeVisible();
  await expect(page.getByText(/Your turn — /i)).toHaveCount(0);
  // The card itself is still the CTA (its review actions are present).
  await expect(page.getByRole("button", { name: /your turn/i })).toBeVisible();
});
