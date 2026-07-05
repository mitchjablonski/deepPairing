import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { teardownDaemon, portOf } from "./daemon-harness.js";

/**
 * C3 — automated a11y regression net (@axe-core/playwright). The UI invests
 * heavily in a11y by hand (focus traps, aria-modal, live regions, the useModal
 * contract) but had no machine check — every regression so far was caught by
 * a human review pass. This runs axe's WCAG 2.x A/AA rules against the two
 * highest-traffic surfaces: the idle shell and a session with a decision +
 * findings under review.
 *
 * Violations fail loudly with rule ids + target selectors, so a failure here
 * reads as a to-do list, not a mystery.
 */
const __dir = path.dirname(fileURLToPath(import.meta.url));
const daemonJs = path.resolve(__dir, "../dist/daemon/index.js");

let proc: ChildProcess | undefined;
let projectRoot: string;
// K2 — isolate HOME so a daemon that ever mirrors a rejection into the global
// (~/.deeppairing) ledger writes into a throwaway tmp dir, never the
// developer's real home. Dormant today (the publish gate defaults off) but this
// is the last test-infra→real-ledger vector; capture-readme.e2e.ts already does
// this. Cleaned up in afterAll alongside the daemon teardown.
let home: string;
let baseURL: string;

async function waitForDaemon(root: string): Promise<{ base: string; token: string }> {
  const daemonJson = path.join(root, ".deeppairing", "daemon.json");
  for (let i = 0; i < 120; i++) {
    try {
      const info = JSON.parse(fs.readFileSync(daemonJson, "utf-8"));
      if (info.port) {
        const res = await fetch(`http://localhost:${info.port}/api/daemon-info`);
        // The internal seed routes are bearer-gated; on POSIX (CI + WSL dev)
        // the token lives in the project's daemon.json. Non-POSIX dev boxes
        // would need bootstrap.e2e's sidecar fallback — not wired here.
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
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dp-a11y-home-"));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-a11y-"));
  proc = spawn(process.execPath, [daemonJs], {
    env: { ...process.env, HOME: home, DEEPPAIRING_PROJECT_ROOT: projectRoot },
    stdio: "ignore",
  });
  const daemon = await waitForDaemon(projectRoot);
  baseURL = daemon.base;

  // Seed a session with the two richest review surfaces.
  const h = { "Content-Type": "application/json", Authorization: `Bearer ${daemon.token}` };
  const reg = await fetch(`${baseURL}/api/internal/sessions/a11y/register`, { method: "POST", headers: h, body: "{}" });
  if (!reg.ok) throw new Error(`seed register failed: ${reg.status}`);
  await fetch(`${baseURL}/api/internal/sessions/a11y/artifacts`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "dec_a11y", type: "decision", title: "Pick a cache",
      content: {
        context: "Which cache fits?", decisionId: "d_a11y", stakes: "high",
        options: [
          { id: "a", title: "Redis", description: "d", pros: ["fast"], cons: ["ops"], effort: "low", risk: "low", recommendation: true, concept: { name: "external cache service" } },
          { id: "b", title: "In-proc", description: "d", pros: ["simple"], cons: ["cold"], effort: "low", risk: "low", recommendation: false },
        ],
      },
    }),
  }).then((r) => { if (!r.ok) throw new Error(`seed decision failed: ${r.status}`); });
  await fetch(`${baseURL}/api/internal/sessions/a11y/artifacts`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "res_a11y", type: "research", title: "Audit",
      content: {
        summary: "s",
        findings: [{ category: "Security", title: "F1", detail: "d", significance: "high", evidence: [{ filePath: "src/x.ts", lineStart: 1, lineEnd: 2, snippet: "code", explanation: "why" }] }],
      },
    }),
  }).then((r) => { if (!r.ok) throw new Error(`seed findings failed: ${r.status}`); });
});

test.afterAll(async () => {
  // I1 — teardown BARRIER: block until the daemon is provably down (process
  // exited AND its port refuses connections) before the next spec spawns.
  // Pre-I1 this was a fire-and-forget `proc?.kill()` that let the daemon keep
  // LISTENING inside the shared [3847,3974] port window while the next spec's
  // daemon started, causing EADDRINUSE rescans + a slow/degraded boot that
  // tripped that spec's 15s waits. See daemon-harness.ts.
  await teardownDaemon(proc, portOf(baseURL));
  try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  // K2 — drop the isolated HOME once the daemon is provably down.
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
});

function fmt(violations: Array<{ id: string; impact?: string | null; nodes: Array<{ target: unknown[] }> }>): string {
  return violations
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)
    .join("\n");
}

test("a11y: session view with decision + findings has no serious/critical axe violations", async ({ page }) => {
  await page.goto(`${baseURL}/?session=a11y`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  // F1 review — the DecisionCard renderer is a LAZY chunk: without this wait
  // axe scanned the page before the option grid mounted and "passed" while
  // the Select buttons were failing. Never analyze before the marquee
  // surface exists.
  await page.waitForSelector("button[data-select-option]", { timeout: 15000 });
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    // F1 — the axe net runs with ZERO disabled rules. History of the two
    // exclusions this net launched with (both fixed, keep for archaeology):
    // - color-contrast: FIXED (F1) — token re-tint, both themes; muted is
    //   AA on the four RENDERED dark surfaces (4.16 on the unused
    //   surface-active and 3.6-4.4 on full-strength *-dim fills — don't put
    //   muted text on those without checking).
    // - nested-interactive: FIXED (D3) — option cards are plain containers
    //   with an explicit per-option Select button.
    // Do not add a disableRules() call without a tracking note + task.
    .analyze(); // F1 — color-contrast un-excluded: the token re-tint passes AA; ZERO exclusions remain
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `axe violations:\n${fmt(serious)}`).toEqual([]);
});

test("a11y: app shell (no session selected) has no serious/critical axe violations", async ({ page }) => {
  // Note: a session exists (seeded in beforeAll), so this scans the shell
  // chrome + aggregate surface rather than a truly empty app.
  await page.goto(baseURL);
  await page.waitForSelector("text=deepPairing", { timeout: 15000 });
  // I1 — wait for the shell to be LIVE (WS connected) before scanning, not
  // just for the static "deepPairing" chrome text. Scanning at first paint
  // intermittently flagged a phantom serious color-contrast violation
  // (amber text measured ~1.07 against the dark surface, gone a frame
  // later; ~1-in-8 in isolation). Review note: the exact mechanism is
  // unproven — 1.07-on-dark implies a mid-hydration/transient element
  // rather than a pure unstyled page (which would measure ~21:1 black on
  // white). If it ever fires again, capture violations[].nodes[].target
  // before adjusting the wait. Post-connect the app auto-binds the seeded
  // session, so this test scans the BOUND shell deterministically — the
  // old "no session selected" name was already a misnomer (see below).
  // The WS `connected` flip (the same signal bootstrap.e2e asserts) only
  // happens after the style-bearing bundle has hydrated, so it's a reliable
  // "styles applied, surface settled" gate. Mirrors this file's session-view
  // test, which already waits for its marquee surface before analyzing.
  await expect
    .poll(
      () => page.evaluate(() => (window as any).__dpConnectionStore?.getState?.()?.connected ?? false),
      { timeout: 15_000 },
    )
    .toBe(true);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    // F1 — no disabled rules: the axe net is fully live
    .analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `axe violations:\n${fmt(serious)}`).toEqual([]);
});
