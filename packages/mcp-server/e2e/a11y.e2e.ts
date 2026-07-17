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
    // #152 — scripted start: suppress the daemon's browser auto-open.
    env: { ...process.env, HOME: home, DEEPPAIRING_PROJECT_ROOT: projectRoot, DEEPPAIRING_NO_OPEN: "1" },
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
      // #158 — persisted secret-scanner metadata (labels only, never values):
      // puts the SecretWarningBanner + the sidebar ⚠ marker into BOTH session
      // scans (dark + light) so the new role="alert" surface is axe-covered
      // with the same zero-disabled-rules contract as everything else here.
      secretWarnings: [{ pattern: "AKIA", label: "AWS access key id" }],
    }),
  }).then((r) => { if (!r.ok) throw new Error(`seed decision failed: ${r.status}`); });
  // #160 — a comment whose body trips the create-time secret scan (AWS's
  // documented EXAMPLE key, never a real credential). The daemon's addComment
  // persists labels-only secretWarnings, so the inline ⚠ chip renders in the
  // decision card's comment thread — putting the chip into BOTH session scans
  // (dark + light) under the same zero-disabled-rules contract as the banner.
  await fetch(`${baseURL}/api/internal/sessions/a11y/comments`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "cmt_a11y_secret", artifactId: "dec_a11y",
      content: "fwiw the key I use is AKIAIOSFODNN7EXAMPLE — does that change the pick?",
      author: "human", target: { artifactId: "dec_a11y" },
    }),
  }).then((r) => { if (!r.ok) throw new Error(`seed comment failed: ${r.status}`); });
  // #138 — the project-wide decisions view reads decisions.json (the RECORD),
  // not decision artifacts, so record one so the view has a row to render+scan.
  await fetch(`${baseURL}/api/internal/sessions/a11y/decisions`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      decisionId: "d_a11y", artifactId: "dec_a11y", context: "Which cache fits?", stakes: "high",
      options: [
        { id: "a", title: "Redis", description: "d", pros: ["fast"], cons: ["ops"], effort: "low", risk: "low", recommendation: true },
        { id: "b", title: "In-proc", description: "d", pros: ["simple"], cons: ["cold"], effort: "low", risk: "low", recommendation: false },
      ],
    }),
  }).then((r) => { if (!r.ok) throw new Error(`seed decision record failed: ${r.status}`); });
  await fetch(`${baseURL}/api/internal/sessions/a11y/artifacts`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "res_a11y", type: "research", title: "Audit",
      content: {
        summary: "s",
        findings: [{ category: "Security", title: "F1", detail: "d", significance: "high", evidence: [{ filePath: "src/x.ts", lineStart: 1, lineEnd: 2, snippet: "code", explanation: "why" }] }],
        // #164 — open-question SECTIONS (the redesign). Two questions feed the
        // openQuestionSections() helper below: the dark + light session tests
        // SELECT this artifact and expand the first section, so axe scans the
        // sections for real — disclosure button, Ask pill, question labelling,
        // answered chip, and the inline answer composer (expanded) alongside a
        // collapsed sibling. Seeded UNANSWERED (no comment): auto-expanding a
        // composer at page load put it into the Autonomy popover test's
        // deliberately-early, pre-settle page scan, catching it (and the
        // documented "Draft" chip) mid entrance-fade.
        openQuestions: ["Should the cache be write-through?", "Which eviction policy?"],
      },
    }),
  }).then((r) => { if (!r.ok) throw new Error(`seed findings failed: ${r.status}`); });
  // #140 — a SEPARATE single-artifact session whose plan carries a diagram, so
  // it renders directly (like bootstrap's visuals test) and axe can scan the
  // region-comment affordance (drag overlay + keyboard node-list disclosure)
  // with ZERO disabled rules.
  const regPlan = await fetch(`${baseURL}/api/internal/sessions/a11yplan/register`, { method: "POST", headers: h, body: "{}" });
  if (!regPlan.ok) throw new Error(`seed plan register failed: ${regPlan.status}`);
  await fetch(`${baseURL}/api/internal/sessions/a11yplan/artifacts`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "plan_a11y", type: "plan", title: "Plan with a diagram",
      content: {
        steps: [{ description: "wire it up", reasoning: "because" }],
        estimatedChanges: 1,
        visuals: [{ id: "arch_a11y", kind: "diagram", title: "Architecture", source: "graph TD; AuthGate-->Login" }],
      },
    }),
  }).then((r) => { if (!r.ok) throw new Error(`seed plan failed: ${r.status}`); });
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

/** #164 review — bring the research artifact's OpenQuestionSections into the
 *  DOM and expand one, so the axe scan covers the sections FOR REAL (the first
 *  cut of this net seeded openQuestions but only ever scanned the decision
 *  artifact — the sections were never mounted; a hollow net). Expanding the
 *  first section puts the inline answer composer into the scan too; the second
 *  stays collapsed, so both disclosure states are covered. */
async function openQuestionSections(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("button", { name: /^Audit/ }).click();
  await page.waitForSelector('[data-artifact-id="res_a11y"]', { timeout: 15000 });
  await page.getByText("Should the cache be write-through?").waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Answer this question" }).first().click();
  await page.getByLabel("Answer question 1").waitFor({ timeout: 15000 });
  // Same rule as the app-shell scan: let every FINITE animation finish (the
  // artifact panel's entrance fade + the composer's dp-fade-in) so axe never
  // samples a mid-fade frame — the documented color-contrast phantom class.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
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

  // #164 — second scan with the research artifact selected: the open-question
  // sections mounted, first one expanded (inline answer composer in the DOM).
  await openQuestionSections(page);
  const qResults = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const qSerious = qResults.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(qSerious, `axe violations (open-question sections):\n${fmt(qSerious)}`).toEqual([]);
});

test("a11y: session view in the LIGHT theme has no serious/critical axe violations (#150)", async ({ page }) => {
  // #150 — every scan above runs in the default dark theme, which let the
  // light theme ship five accent-on-dim pairs at 1.6–2.9:1 (dark's accent
  // fgs leaking onto pale light washes) with CI none the wiser. This is the
  // session-view scan re-run with the light theme active via the REAL toggle
  // mechanism: the preferences store reads localStorage "dp-theme" at load
  // and stamps data-theme on <html> (web/src/stores/preferences.ts), so
  // seeding localStorage before navigation exercises the same code path as a
  // user picking Light — no CSS override, no attribute forced from the test.
  await page.addInitScript(() => localStorage.setItem("dp-theme", "light"));
  await page.goto(`${baseURL}/?session=a11y`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  // Same marquee-surface rule as the dark scan: never analyze before the lazy
  // DecisionCard chunk mounts its Select buttons.
  await page.waitForSelector("button[data-select-option]", { timeout: 15000 });
  // Belt-and-braces: assert the store actually applied the theme, so a future
  // rename of the localStorage key degrades this test to a loud failure
  // instead of silently re-scanning dark.
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    // Zero disabled rules — same contract as every other scan in this file.
    .analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `axe violations:\n${fmt(serious)}`).toEqual([]);

  // #164 — light-theme parity for the open-question sections (mounted +
  // first section expanded), same zero-disabled-rules contract.
  await openQuestionSections(page);
  const qResults = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const qSerious = qResults.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(qSerious, `axe violations (open-question sections, light):\n${fmt(qSerious)}`).toEqual([]);
});

test("a11y: project-wide decisions view has no serious/critical axe violations", async ({ page }) => {
  // #138 — the decisions view is a modal (useModal: role=dialog, focus trap,
  // Esc). Scan it with the same ZERO-disabled-rules axe net: real semantics
  // (each row is a single button, no nested-interactive), keyboard-navigable.
  await page.goto(`${baseURL}/?session=a11y`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  await page.click('[aria-label="Open project decisions"]');
  await page.waitForSelector('[data-testid="decisions-view"]', { timeout: 15000 });
  // Wait for the seeded decision row so axe scans the populated list, not a
  // transient loading state (the marquee-surface rule from the session test).
  await page.waitForSelector("[data-decision-row]", { timeout: 15000 });
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `axe violations:\n${fmt(serious)}`).toEqual([]);
});

test("a11y: the Autonomy popover (with the #139 detail-density toggle) has no serious/critical axe violations", async ({ page }) => {
  // #139 added a Detail: Rich/Terse radiogroup inside the Autonomy popover.
  // The two page-level scans above never open the popover, so this opens it and
  // scans the live radiogroup markup (accessible name + radio checked state).
  // The Autonomy control lives in the shell CHROME (header), so this test
  // depends only on the button rendering — NOT on any artifact loading (waiting
  // for [data-artifact-id] here just adds an unrelated session-load flake).
  await page.goto(`${baseURL}/?session=a11y`);
  const autonomyBtn = page.getByRole("button", { name: /autonomy:/i });
  await autonomyBtn.waitFor({ timeout: 15000 });
  await autonomyBtn.click();
  // Wait for the popover's detail-density radiogroup to mount before scanning.
  await page.getByRole("radiogroup", { name: /detail density/i }).waitFor({ timeout: 15000 });
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `axe violations:\n${fmt(serious)}`).toEqual([]);
});

test("a11y: a plan diagram's region-comment affordance has no serious/critical axe violations (#140)", async ({ page }) => {
  await page.goto(`${baseURL}/?session=a11yplan`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  // The region overlay + keyboard node-list disclosure mount only once the real
  // Mermaid engine has produced the SVG — never analyze before it exists.
  await page.waitForSelector(".dp-mermaid svg", { timeout: 15000 });
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    // Zero disabled rules — the region UI (drag-capture overlay is aria-hidden;
    // the keyboard path is real <button>s inside a <details>) must pass as-is,
    // notably nested-interactive + aria-hidden-focus.
    .analyze();
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
  // #159 run — the phantom fired again and the target is NOW captured (per the
  // note above): the amber "● Draft, awaiting review" status chip, fg #2f291a
  // on #161617 at 1.25:1. That fg is steady-state amber blended at low opacity
  // — axe sampled the chip's ENTRANCE FADE frame (the session-view scans prove
  // the settled chip passes AA). Mechanism confirmed ⇒ adjust the wait, not
  // the rules: wait for the post-connect chrome (the chip) to mount, then for
  // every FINITE animation/transition to finish. Infinite ones (animate-pulse)
  // are excluded — awaiting those would never resolve — and axe blends
  // steady-state pulse opacity correctly already.
  await page.getByText("Draft, awaiting review").first().waitFor({ timeout: 15_000 });
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    // F1 — no disabled rules: the axe net is fully live
    .analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `axe violations:\n${fmt(serious)}`).toEqual([]);
});
