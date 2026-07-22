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
// Bearer for the public mutation routes (the ledger-drawer scan seeds a
// stance via /api/philosophy/seed — into the K2-isolated tmp HOME ledger).
let authToken: string;

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
  authToken = daemon.token;

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
          // #173 — option "a" carries a diagram so the compare grid shows the
          // "Expand to comment" affordance and the focused region-commenting
          // dialog (openDecisionDiagramFocus) can be mounted + scanned.
          { id: "a", title: "Redis", description: "d", pros: ["fast"], cons: ["ops"], effort: "low", risk: "low", recommendation: true, concept: { name: "external cache service" },
            visuals: [{ id: "vis_cache", kind: "diagram", title: "Architecture", source: "graph LR; AppServer[App Server] --> Redis[Redis]" }] },
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
        // #166 — the evidence snippet is REAL multi-line TypeScript (string,
        // comment, keyword, punctuation, number tokens), not the old one-word
        // "code": the vitesse-light AA failure (#B07D48 strings at 3.27:1)
        // shipped because no scanned surface ever mounted a highlighted string
        // or comment — the seed must exercise the token families for the scans
        // to mean anything. Both the dark and light session scans select this
        // artifact and wait for shiki's colored spans before analyzing.
        findings: [{ category: "Security", title: "F1", detail: "d", significance: "high", evidence: [{ filePath: "src/x.ts", lineStart: 1, lineEnd: 2, snippet: 'const label = "cache me"; // pick a cache\nexport function pick(n: number) { return n ?? 42; }', explanation: "why" }] }],
        // #164 — open-question SECTIONS (the redesign, round 2: no disclosure
        // — the composer is always visible). Two questions feed the
        // openQuestionSections() helper below: the dark + light session tests
        // SELECT this artifact so axe scans the sections for real — question
        // labelling, the always-visible answer composer (textarea + the
        // Answer/Ask submit buttons, disabled-empty state), per-section.
        openQuestions: ["Should the cache be write-through?", "Which eviction policy?"],
      },
    }),
  }).then((r) => { if (!r.ok) throw new Error(`seed findings failed: ${r.status}`); });
  // #172 — a code_change carrying two suggested edits (a PENDING one and a
  // COUNTERED one, the latter with Claude's reply). No `before` → the Result
  // view (CommentableCode) renders, mounting SuggestionCards on the anchor
  // lines so axe covers the pending amber pill, the countered violet pill + its
  // action row, and the mini unified diff in BOTH themes.
  const uploadSrc = [
    "export async function uploadWithRetry(file) {",
    "  for (let attempt = 0; attempt < 5; attempt++) {",
    "    try { return await upload(file); }",
    "    catch { await sleep(1000); }",
    "  }",
    "  throw new UploadFailedError();",
    "}",
  ].join("\n");
  await fetch(`${baseURL}/api/internal/sessions/a11y/artifacts`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "cc_a11y", type: "code_change", title: "Retry wrapper",
      content: { filePath: "lib/upload.ts", after: uploadSrc, changeType: "create" },
    }),
  }).then((r) => { if (!r.ok) throw new Error(`seed code_change failed: ${r.status}`); });
  await fetch(`${baseURL}/api/internal/sessions/a11y/comments`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "cmt_sugg_pending", artifactId: "cc_a11y", author: "human", intent: "suggestion",
      content: "Fixed 1s sleeps hammer the endpoint.",
      target: { artifactId: "cc_a11y", lineStart: 4, lineEnd: 4, filePath: "lib/upload.ts" },
      suggestion: {
        originalText: "    catch { await sleep(1000); }",
        replacementText: "    catch (err) {\n      if (!isRetryable(err)) throw err;\n      await sleep(2 ** attempt * 250);\n    }",
        lineStart: 4, lineEnd: 4, state: "pending",
      },
    }),
  }).then((r) => { if (!r.ok) throw new Error(`seed pending suggestion failed: ${r.status}`); });
  await fetch(`${baseURL}/api/internal/sessions/a11y/comments`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "cmt_sugg_countered", artifactId: "cc_a11y", author: "human", intent: "suggestion",
      content: "return null instead of throwing",
      target: { artifactId: "cc_a11y", lineStart: 6, lineEnd: 6, filePath: "lib/upload.ts" },
      suggestion: {
        originalText: "  throw new UploadFailedError();",
        replacementText: "  return null;",
        lineStart: 6, lineEnd: 6, state: "countered",
        counter: { reason: "Returning null would silently drop the upload — attach the last error as cause instead." },
      },
    }),
  }).then((r) => { if (!r.ok) throw new Error(`seed countered suggestion failed: ${r.status}`); });
  await fetch(`${baseURL}/api/internal/sessions/a11y/comments`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "cmt_sugg_reply", artifactId: "cc_a11y", author: "agent", parentCommentId: "cmt_sugg_countered",
      content: "Returning null would silently drop the upload — three call sites never check for it. Keep the throw but attach the last error as cause?",
      target: { artifactId: "cc_a11y", lineStart: 6, lineEnd: 6, filePath: "lib/upload.ts" },
    }),
  }).then((r) => { if (!r.ok) throw new Error(`seed suggestion reply failed: ${r.status}`); });

  // #171/#175 — a multi-file CHANGESET, seeded into the a11y session so BOTH
  // theme scans mount and measure the refined review surface (the #187
  // hollow-net lesson: openChangeset() below SELECTS it, activates the flagged
  // file, and waits for the needs-changes reason box before analyzing). Real,
  // token-rich diff hunks + a risk chip + a MIXED disposition (one reviewed, one
  // needs_changes) so the summary strip, both rail chips, the reason box, and the
  // DERIVED "Send back" action are all in the DOM for the scan.
  await fetch(`${baseURL}/api/internal/sessions/a11y/artifacts`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "cs_a11y", type: "changeset", title: "Move session-TTL refresh into middleware",
      content: {
        summary: "Centralize the sliding-window refresh so every route inherits it.",
        risks: ["touches auth"],
        files: [
          {
            path: "auth/middleware.ts", changeType: "modified", stats: { additions: 3, deletions: 2 },
            hunks: [{
              header: "@@ -24,4 +24,6 @@ export function requireSession(store: SessionStore) {",
              lines: [
                { kind: "ctx", content: "    const sid = readSessionCookie(req);", oldLine: 25, newLine: 25 },
                { kind: "del", content: "    const session = await store.get(sid);", oldLine: 26 },
                { kind: "add", content: "    const session = await store.getAndTouch(sid); // refreshes TTL", newLine: 26 },
                { kind: "add", content: "    if (!session || session.expiresAt < Date.now()) return res.status(401).end();", newLine: 27 },
              ],
            }],
          },
          {
            path: "auth/session.ts", changeType: "modified", stats: { additions: 1, deletions: 0 },
            hunks: [{ header: "@@ -10,2 +10,3 @@ export interface Session {", lines: [
              { kind: "add", content: "  expiresAt: number; // sliding window", newLine: 12 },
            ] }],
          },
        ],
        // #175 — a MIXED disposition so the scan measures BOTH rail chips
        // (✓ ok / ↻ changes) and the derived "Send back" action for real.
        reviewState: { "auth/middleware.ts": "reviewed", "auth/session.ts": "needs_changes" },
        reviewReasons: { "auth/session.ts": "Keep the sliding-window bump on the login path too — OAuth callbacks skip this middleware." },
      },
    }),
  }).then((r) => { if (!r.ok) throw new Error(`seed changeset failed: ${r.status}`); });
  // A cross-file comment binding the two anchors — puts the rail's CROSS-FILE
  // card into the scanned DOM.
  await fetch(`${baseURL}/api/internal/sessions/a11y/comments`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "cmt_a11y_xfile", artifactId: "cs_a11y",
      content: "TTL constant and the middleware check must stay in sync.",
      author: "human",
      target: { artifactId: "cs_a11y", anchors: [
        { filePath: "auth/session.ts", lineStart: 12 },
        { filePath: "auth/middleware.ts", lineStart: 26 },
      ] },
    }),
  }).then((r) => { if (!r.ok) throw new Error(`seed changeset comment failed: ${r.status}`); });
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
 *  DOM so the axe scan covers the sections FOR REAL (the first cut of this
 *  net seeded openQuestions but only ever scanned the decision artifact — the
 *  sections were never mounted; a hollow net). Round 2 killed the disclosure:
 *  the answer composer (textarea + Answer/Ask buttons) is always visible, so
 *  selecting the artifact mounts the complete surface — no expand click. */
async function openQuestionSections(page: import("@playwright/test").Page): Promise<void> {
  // The sidebar row's data attribute — the title alone ("Audit") also matches
  // the flow-group header + type chip (strict-mode ambiguity).
  await page.click('[data-artifact-item="res_a11y"]');
  await page.waitForSelector('[data-artifact-id="res_a11y"]', { timeout: 15000 });
  await page.getByLabel("Answer question 1").waitFor({ timeout: 15000 });
  // #166 — shiki highlights asynchronously (lazy wasm + grammar chunks): wait
  // for a COLORED token span inside the evidence snippet, or axe would scan
  // plain uncolored text and "pass" without ever measuring the syntax palette
  // (exactly how the vitesse-light AA failure went unseen).
  await page.waitForSelector(
    '[data-artifact-id="res_a11y"] .bg-surface-code span[style*="color:"]',
    { timeout: 15000 },
  );
  // Same rule as the app-shell scan: let every FINITE animation finish (the
  // artifact panel's entrance fade) so axe never samples a mid-fade frame —
  // the documented color-contrast phantom class.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

/** #172 — mount the code_change with its two SuggestionCards (pending +
 *  countered) so axe scans the pills, mini-diff, and action row for real. */
async function openSuggestionArtifact(page: import("@playwright/test").Page): Promise<void> {
  await page.click('[data-artifact-item="cc_a11y"]');
  await page.waitForSelector('[data-artifact-id="cc_a11y"]', { timeout: 15000 });
  // Both cards must be mounted (pending + countered) before analyzing.
  await page.waitForSelector('[data-testid="suggestion-card"][data-state="pending"]', { timeout: 15000 });
  await page.waitForSelector('[data-testid="suggestion-card"][data-state="countered"]', { timeout: 15000 });
  await page.evaluate(() =>
    Promise.all(
      document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

/** #171/#175 — mount the CHANGESET review surface for real before scanning (the
 *  #187 hollow-net lesson: seeding alone never renders the component). Selects
 *  the changeset, waits for the derived "Send back" action + a rail disposition
 *  chip, activates the flagged file so its needs-changes reason box mounts, then
 *  settles finite animations so axe never samples a mid-fade frame. */
async function openChangeset(page: import("@playwright/test").Page): Promise<void> {
  await page.click('[data-artifact-item="cs_a11y"]');
  await page.waitForSelector('[data-artifact-id="cs_a11y"]', { timeout: 15000 });
  // #175 — the DERIVED action (one file flagged → Send back) proves the refined
  // action bar mounted. The rail carries both disposition chips.
  await page.getByRole("button", { name: /Send back/ }).waitFor({ timeout: 15000 });
  await page.getByText("↻ changes").waitFor({ timeout: 15000 });
  // Activate the flagged file so its needs-changes REASON box mounts for the
  // scan (the #187 hollow-net lesson — actually render the new state).
  await page.getByTitle("modified auth/session.ts").click();
  await page.getByLabel(/Reason this file needs changes/).waitFor({ timeout: 15000 });
  // The cross-file card in the rail is part of the seeded state.
  await page.getByText("CROSS-FILE COMMENT").waitFor({ timeout: 15000 });
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

/** #173 — mount the DECISION DIAGRAM FOCUSED VIEW for real before scanning
 *  (the #187 hollow-net lesson: the scan must actually mount the new UI). Waits
 *  for the compare grid, clicks the option's "Expand to comment" affordance, and
 *  waits for the focused dialog + its LIVE region layer (real Mermaid SVG +
 *  aria-hidden drag overlay) before settling animations. */
async function openDecisionDiagramFocus(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForSelector("button[data-select-option]", { timeout: 15000 });
  // The compare-diagrams grid is shown by default; wait for the option diagram
  // to render so the card is fully mounted before reaching for the affordance.
  await page.waitForSelector(".dp-mermaid svg", { timeout: 15000 });
  await page.getByRole("button", { name: /Expand.*to comment/i }).first().click();
  // The focused dialog opens with the live region layer over a real SVG.
  await page.waitForSelector('[data-testid="decision-diagram-focus"]', { timeout: 15000 });
  await page.waitForSelector('[data-testid="decision-diagram-focus"] .dp-mermaid svg g.node', { timeout: 15000 });
  await page.waitForSelector('[data-testid="dp-region-overlay"]', { timeout: 15000 });
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

/** #174 — mount the DECISION WORKBENCH open for real before scanning (the
 *  #187 hollow-net lesson: the scan must actually mount the new UI, not assert
 *  an empty page). Waits for the compare card, clicks the ONE "Discuss"
 *  affordance, and waits for the workbench dialog + a column diagram (the
 *  workbench mounts its own read-only VisualBody) before settling animations. */
async function openDecisionWorkbench(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForSelector("button[data-select-option]", { timeout: 15000 });
  await page.getByRole("button", { name: /Expand to discuss/i }).click();
  await page.waitForSelector('[data-testid="decision-workbench"]', { timeout: 15000 });
  // The workbench renders each option's content, incl. option "a"'s diagram —
  // wait for the real Mermaid SVG so the full surface is mounted before axe runs.
  await page.waitForSelector('[data-testid="decision-workbench"] .dp-mermaid svg', { timeout: 15000 });
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

/** #174 interaction pass — mount the POPPED-OUT option + its persistent inline
 *  whole-option composer for real before scanning (the #187 hollow-net lesson:
 *  actually render the NEW states, never assert an empty scan). Opens the
 *  workbench, clicks the first option's ⤢ pop-out, and waits for the focused
 *  option column + its roomy comment/ask composer (whose textarea's exact
 *  accessible name is the bare option title). The clickable pro/con rows
 *  (cursor-pointer divs with onClick, the 💬 button still the announced control)
 *  are in this scanned subtree, so a new axe violation from them would fail. */
async function openWorkbenchPoppedOut(page: import("@playwright/test").Page): Promise<void> {
  await openDecisionWorkbench(page);
  await page.locator('[data-testid="decision-workbench"] [data-testid="option-popout"]').first().click();
  await page.waitForSelector('[data-testid="workbench-focused-option"]', { timeout: 15000 });
  // The inline whole-option composer is anchored to the option itself — its
  // textarea's accessible name is the bare option title (exact, so the grain
  // "· pro/con/summary/whole option" affordance buttons don't collide).
  await page.getByLabel("Comment on Redis", { exact: true }).waitFor({ timeout: 15000 });
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

test("a11y (#174): the decision WORKBENCH (open) has no serious/critical axe violations — dark", async ({ page }) => {
  await page.goto(`${baseURL}/?session=a11y`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  await openDecisionWorkbench(page);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    // Zero disabled rules — the workbench dialog (role=dialog + aria-modal +
    // focus trap), its grain-comment affordances, the comment rail composers,
    // and the per-option Choose buttons must all pass as-is.
    .analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `axe violations (decision workbench, dark):\n${fmt(serious)}`).toEqual([]);
});

test("a11y (#174): the decision WORKBENCH (open) has no serious/critical axe violations — light", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("dp-theme", "light"));
  await page.goto(`${baseURL}/?session=a11y`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await openDecisionWorkbench(page);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `axe violations (decision workbench, light):\n${fmt(serious)}`).toEqual([]);
});

test("keyboard (#174): the Discuss affordance is reachable and the workbench is operable (Esc returns)", async ({ page }) => {
  await page.goto(`${baseURL}/?session=a11y`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  await page.waitForSelector("button[data-select-option]", { timeout: 15000 });

  // The Discuss affordance is a real, focusable button — reachable by keyboard,
  // then activated by Enter.
  const discuss = page.getByRole("button", { name: /Expand to discuss/i });
  await discuss.focus();
  await expect(discuss).toBeFocused();
  await discuss.press("Enter");

  // The dialog opened and moved focus INSIDE it (focus trap), never left on the
  // now-hidden trigger.
  const dialog = page.locator('[data-testid="decision-workbench"]');
  await dialog.waitFor({ timeout: 15000 });
  await expect.poll(() => dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);

  // Esc collapses it back to the card (the useModal contract).
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("a11y (#174): the workbench POPPED-OUT option + inline whole-option composer — dark", async ({ page }) => {
  await page.goto(`${baseURL}/?session=a11y`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  await openWorkbenchPoppedOut(page);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    // Zero disabled rules — the focused option column, its ← Back button, the
    // roomy inline whole-option comment/ask composer, the grain affordances, and
    // the clickable pro/con rows (non-role divs; the 💬 button is the announced
    // control) must all pass as-is.
    .analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `axe violations (workbench popped-out, dark):\n${fmt(serious)}`).toEqual([]);
});

test("a11y (#174): the workbench POPPED-OUT option + inline whole-option composer — light", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("dp-theme", "light"));
  await page.goto(`${baseURL}/?session=a11y`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await openWorkbenchPoppedOut(page);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `axe violations (workbench popped-out, light):\n${fmt(serious)}`).toEqual([]);
});

test("keyboard (#174): the ⤢ pop-out and the ← Back button are reachable + operable", async ({ page }) => {
  await page.goto(`${baseURL}/?session=a11y`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  await page.waitForSelector("button[data-select-option]", { timeout: 15000 });
  await page.getByRole("button", { name: /Expand to discuss/i }).click();
  await page.waitForSelector('[data-testid="decision-workbench"]', { timeout: 15000 });

  // The per-option ⤢ pop-out is a real focusable button — reach it, activate by Enter.
  const popout = page.locator('[data-testid="option-popout"]').first();
  await popout.focus();
  await expect(popout).toBeFocused();
  await popout.press("Enter");

  // The focused option column mounted (with its inline composer).
  await page.waitForSelector('[data-testid="workbench-focused-option"]', { timeout: 15000 });

  // The ← Back button is reachable + operable, returning to the compare grid.
  const back = page.getByRole("button", { name: /Back to all options/i });
  await back.focus();
  await expect(back).toBeFocused();
  await back.press("Enter");
  await expect(page.locator('[data-testid="workbench-focused-option"]')).toHaveCount(0);
  // Back in the grid — the pop-out buttons are present again.
  await expect(page.locator('[data-testid="option-popout"]').first()).toBeVisible();
});

test("a11y (#173): the decision diagram FOCUSED VIEW has no serious/critical axe violations — dark", async ({ page }) => {
  await page.goto(`${baseURL}/?session=a11y`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  await openDecisionDiagramFocus(page);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    // Zero disabled rules — the focused dialog (role=dialog + aria-modal + focus
    // trap), its aria-hidden drag overlay, and the keyboard node-list must pass
    // as-is (notably aria-hidden-focus + nested-interactive).
    .analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `axe violations (decision diagram focus, dark):\n${fmt(serious)}`).toEqual([]);
});

test("a11y (#173): the decision diagram FOCUSED VIEW has no serious/critical axe violations — light", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("dp-theme", "light"));
  await page.goto(`${baseURL}/?session=a11y`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await openDecisionDiagramFocus(page);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `axe violations (decision diagram focus, light):\n${fmt(serious)}`).toEqual([]);
});

test("keyboard (#173): the Expand affordance is reachable and the focused dialog is operable (Esc returns)", async ({ page }) => {
  await page.goto(`${baseURL}/?session=a11y`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  await page.waitForSelector("button[data-select-option]", { timeout: 15000 });
  await page.waitForSelector(".dp-mermaid svg", { timeout: 15000 });

  // The expand affordance is a real, focusable button (kept in the tab order;
  // focus-visible reveals it) — reachable by keyboard, then activated by Enter.
  const expand = page.getByRole("button", { name: /Expand.*to comment/i }).first();
  await expand.focus();
  await expect(expand).toBeFocused();
  await expand.press("Enter");

  // The dialog opened and moved focus INSIDE it (focus trap) — never left on the
  // now-hidden trigger.
  const dialog = page.locator('[data-testid="decision-diagram-focus"]');
  await dialog.waitFor({ timeout: 15000 });
  await expect.poll(() => dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);

  // Esc closes it and returns to the compare grid (the useModal contract).
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

/** #175 — open the `?` cheat-sheet overlay (it lists the changeset review keys)
 *  so axe can scan the modal for real. Assumes focus is on a non-input control. */
async function openCheatSheet(page: import("@playwright/test").Page): Promise<void> {
  // Move focus off any input (the needs-changes reason box) so App's global `?`
  // handler isn't suppressed by its editable-target guard.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await page.locator("body").press("Shift+Slash"); // Shift+Slash → "?"
  await page.getByRole("heading", { name: /Keyboard Shortcuts/i }).waitFor({ timeout: 15000 });
  // The changeset section renders straight from the central keymap.
  await page.getByText(/Looks right → next file/).waitFor({ timeout: 15000 });
}

test("a11y (#172): suggested-edit cards (pending + countered) have no serious/critical axe violations — dark", async ({ page }) => {
  await page.goto(`${baseURL}/?session=a11y`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  await openSuggestionArtifact(page);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `axe violations (suggestion cards, dark):\n${fmt(serious)}`).toEqual([]);
});

test("a11y (#172): suggested-edit cards have no serious/critical axe violations — light", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("dp-theme", "light"));
  await page.goto(`${baseURL}/?session=a11y`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await openSuggestionArtifact(page);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `axe violations (suggestion cards, light):\n${fmt(serious)}`).toEqual([]);
});

test("keyboard (#172): the Suggest edit composer and the counter action buttons are reachable + operable", async ({ page }) => {
  await page.goto(`${baseURL}/?session=a11y`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  await openSuggestionArtifact(page);

  // The countered card's action buttons are reachable by keyboard.
  const takeCounter = page.getByRole("button", { name: /take the counter/i });
  await takeCounter.focus();
  await expect(takeCounter).toBeFocused();
  const insist = page.getByRole("button", { name: /insist on mine/i });
  await insist.focus();
  await expect(insist).toBeFocused();

  // Open a line composer, switch to Suggest edit, and type into the mono
  // mini-editor entirely by keyboard — the editor is a real, operable textbox.
  await page.locator('[data-comment-anchor="line:lib/upload.ts:2"] button[aria-label="Add a comment on this line"]').click();
  await page.getByRole("button", { name: /^Suggest edit$/ }).click();
  const editor = page.getByTestId("suggestion-editor");
  await editor.focus();
  await expect(editor).toBeFocused();
  await page.keyboard.type(" // edited");
  await expect(editor).toHaveValue(/\/\/ edited/);

  // ACTIVATE "Take the counter" by keyboard (Enter), not just focus — the
  // countered card must resolve (its action row disappears once state → applied).
  // Done LAST so the mutation doesn't disturb the scans above (no retries).
  await takeCounter.focus();
  await takeCounter.press("Enter");
  await expect(page.getByRole("button", { name: /take the counter/i })).toHaveCount(0);
});

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
  // sections mounted with their always-visible composers (round 2).
  await openQuestionSections(page);
  const qResults = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const qSerious = qResults.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(qSerious, `axe violations (open-question sections):\n${fmt(qSerious)}`).toEqual([]);

  // #171/#175 — third scan with the CHANGESET review surface mounted (summary
  // strip, rail disposition chips, unified diff, cross-file card, needs-changes
  // reason box, derived action bar).
  await openChangeset(page);
  const csResults = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const csSerious = csResults.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(csSerious, `axe violations (changeset):\n${fmt(csSerious)}`).toEqual([]);

  // #175 — the `?` cheat-sheet overlay (lists the changeset review keys), dark.
  await openCheatSheet(page);
  const chResults = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const chSerious = chResults.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(chSerious, `axe violations (cheat-sheet, dark):\n${fmt(chSerious)}`).toEqual([]);
  await page.keyboard.press("Escape");
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

  // #164 — light-theme parity for the open-question sections (mounted, with
  // always-visible composers). #166 — FULL-PAGE again, like the dark test:
  // this scan launched include()-scoped to the sections because its first real
  // run caught vitesse-light's string color (#B07D48) at 3.27:1 on the light
  // surface-code. The #166 palette re-tint (lib/syntax-palette.ts, locked by
  // syntax-token-contrast.test.ts) fixed the whole light+dark syntax palette,
  // so the scope is dropped — and the page now includes a MOUNTED highlighted
  // snippet (openQuestionSections waits for shiki's colored spans), so the
  // palette is measured for real on every run.
  await openQuestionSections(page);
  const qResults = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  const qSerious = qResults.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(qSerious, `axe violations (open-question sections, light):\n${fmt(qSerious)}`).toEqual([]);

  // #171 — light-theme parity for the changeset review surface.
  await openChangeset(page);
  const csResults = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const csSerious = csResults.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(csSerious, `axe violations (changeset, light):\n${fmt(csSerious)}`).toEqual([]);

  // #175 — the `?` cheat-sheet overlay, light parity.
  await openCheatSheet(page);
  const chResults = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const chSerious = chResults.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(chSerious, `axe violations (cheat-sheet, light):\n${fmt(chSerious)}`).toEqual([]);
  await page.keyboard.press("Escape");
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

test("a11y: the Ledger drawer with a stance row + armed remove confirm has no serious/critical axe violations", async ({ page }) => {
  // #193 — the per-stance remove affordance shipped into a surface no e2e
  // scan ever opened (the exact hollow-net shape #187 taught us about), so
  // this opens the drawer for real. Seed one stance first so the Stances tab
  // renders a row WITH the remove button (workers=1 + declaration order:
  // this runs last, so the seeded ledger entry can't disturb earlier scans;
  // the ledger lives in the K2 tmp HOME, never the developer's real one).
  const info = (await (await fetch(`${baseURL}/api/daemon-info`)).json()) as { projectHash: string };
  const seed = await fetch(`${baseURL}/api/philosophy/seed`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Project-Hash": info.projectHash,
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({
      concept: "global mutable state",
      verdict: "rejected",
      reason: "broke testability in 3 places",
    }),
  });
  if (!seed.ok) throw new Error(`seed stance failed: ${seed.status}`);

  await page.goto(`${baseURL}/?session=a11y`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  await page.click('[aria-label="Open the Ledger"]');
  // Marquee-surface rule: never analyze before the row + its remove button
  // exist (a drawer stuck on "Loading…" would pass hollow).
  const removeBtn = page.getByRole("button", { name: /^Remove stance: global mutable state$/ });
  await removeBtn.waitFor({ timeout: 15000 });

  // Scan 1 — drawer open, row unarmed. Zero disabled rules, like every scan
  // in this file.
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `axe violations (drawer, unarmed):\n${fmt(serious)}`).toEqual([]);

  // Scan 2 — armed confirm (the destructive step's copy + buttons). Arming
  // only — never confirm, so the scan mutates nothing.
  await removeBtn.click();
  await page.waitForSelector('[data-testid="stance-remove-confirm"]', { timeout: 15000 });
  const armed = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  const armedSerious = armed.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(armedSerious, `axe violations (drawer, armed confirm):\n${fmt(armedSerious)}`).toEqual([]);
});
