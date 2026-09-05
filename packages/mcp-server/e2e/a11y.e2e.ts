import { test, expect } from "./test.js";
import AxeBuilder from "@axe-core/playwright";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { teardownDaemon, portOf, spawnDiagnosticProcess, withSetupDiagnostics } from "./daemon-harness.js";

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

test.beforeAll(async ({}, testInfo) => {
  if (!fs.existsSync(daemonJs)) {
    throw new Error(`dist/daemon/index.js missing at ${daemonJs} — run \`pnpm build\` before the e2e suite.`);
  }
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dp-a11y-home-"));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-a11y-"));
  proc = spawnDiagnosticProcess(process.execPath, [daemonJs], {
    // #152 — scripted start: suppress the daemon's browser auto-open.
    env: { ...process.env, HOME: home, DEEPPAIRING_PROJECT_ROOT: projectRoot, DEEPPAIRING_NO_OPEN: "1" },
  });
  const daemon = await withSetupDiagnostics(proc, testInfo, () => waitForDaemon(projectRoot));
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
        // R4 P-A — the finding carries a `concept` so the ledger-aware
        // ConceptBadge (the new R4 surface) mounts under the axe net + reaches
        // the export in BOTH themes (the round-13 fixture ratchet: seed the
        // newest surfaces, not just last release's).
        findings: [{ category: "Security", title: "F1", detail: "d", significance: "high", concept: { name: "parameterized queries", oneLineExplanation: "bind values, never concatenate them into SQL" }, evidence: [{ filePath: "src/x.ts", lineStart: 1, lineEnd: 2, snippet: 'const label = "cache me"; // pick a cache\nexport function pick(n: number) { return n ?? 42; }', explanation: "why" }] }],
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
            // #186 — this file carries REMOVED lines too, so the a11y scan
            // measures the del-side gutter, the "(removed)" composer header, and a
            // del-side comment thread (both themes).
            path: "auth/session.ts", changeType: "modified", stats: { additions: 1, deletions: 2 },
            hunks: [{ header: "@@ -10,3 +10,3 @@ export interface Session {", lines: [
              { kind: "del", content: "  ttl: number; // fixed 30-minute window", oldLine: 11 },
              { kind: "add", content: "  expiresAt: number; // sliding window", newLine: 12 },
              { kind: "del", content: "  createdAt: number;", oldLine: 12 },
            ] }],
          },
        ],
        // #175 — a MIXED disposition so the scan measures BOTH rail chips
        // (✓ ok / ↻ changes) and the derived "Send back" action for real.
        reviewState: { "auth/middleware.ts": "reviewed", "auth/session.ts": "needs_changes" },
        reviewReasons: { "auth/session.ts": "Keep the sliding-window bump on the login path too — OAuth callbacks skip this middleware." },
        // R4 P-B — a changeset-level visual ("the shape of what this PR
        // touches") so the ArtifactVisuals block mounts above the file rail
        // under the axe net in both themes.
        visuals: [{ id: "vis_cs_shape", kind: "file_map", title: "The shape", files: [{ path: "auth/middleware.ts", change: "modify" }, { path: "auth/session.ts", change: "modify" }] }],
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
  // #186 — a comment on a REMOVED line (side:"old", anchored to oldLine 11 of
  // session.ts) so the scan mounts a del-side thread. openChangeset opens the
  // composer on the OTHER del line (old 12) so both the thread and the
  // "(removed)" composer are measured together.
  await fetch(`${baseURL}/api/internal/sessions/a11y/comments`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "cmt_a11y_del", artifactId: "cs_a11y",
      content: "Keep ttl — the OAuth callback path reads it and never hits getAndTouch.",
      author: "human",
      target: { artifactId: "cs_a11y", filePath: "auth/session.ts", lineStart: 11, side: "old" },
    }),
  }).then((r) => { if (!r.ok) throw new Error(`seed del-side comment failed: ${r.status}`); });
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

  // #181 — a plan carrying a GENUINELY-BROKEN diagram (an unclosed `{` rhombus:
  // repairMermaidSource can't quote a label with no closing brace, so the repair
  // is a no-op and the render is terminal). Its own session so this pathological
  // source never disturbs the axe scans above. The #181 test mounts it and
  // asserts mermaid's OWN "Syntax error" bomb graphic never leaks to document.body
  // (suppressErrorRendering) while the component's clean fallback still renders.
  const regBad = await fetch(`${baseURL}/api/internal/sessions/a11ymermaidbad/register`, { method: "POST", headers: h, body: "{}" });
  if (!regBad.ok) throw new Error(`seed bad-mermaid register failed: ${regBad.status}`);
  await fetch(`${baseURL}/api/internal/sessions/a11ymermaidbad/artifacts`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "plan_mbad", type: "plan", title: "Plan with a broken diagram",
      content: {
        steps: [{ description: "wire it up", reasoning: "because" }],
        estimatedChanges: 1,
        visuals: [{ id: "arch_mbad", kind: "diagram", title: "Broken", source: "flowchart LR\n  A --> B{Valid?\n  B --> C" }],
      },
    }),
  }).then((r) => { if (!r.ok) throw new Error(`seed bad-mermaid plan failed: ${r.status}`); });

  // #177 slice 2a — a SUPERSEDED decision chain so the workbench mounts REAL
  // carryover markers (CARRIED / STALE / ORPHAN) for the axe scans (the #187
  // hollow-net lesson: actually render the new states). v1 is superseded (so the
  // filtered visible list renders only v2's card), v2 keeps option `a`'s id + text
  // (CARRIED), rewords `b`'s summary (STALE), and drops `c` (ORPHAN). v1-anchored
  // grain threads then carry forward onto v2's rail via useChainComments.
  const regCarry = await fetch(`${baseURL}/api/internal/sessions/a11ycarry/register`, { method: "POST", headers: h, body: "{}" });
  if (!regCarry.ok) throw new Error(`seed carry register failed: ${regCarry.status}`);
  await fetch(`${baseURL}/api/internal/sessions/a11ycarry/artifacts`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "dec_carry_v1", type: "decision", title: "Pick a store", version: 1, parentId: null,
      content: {
        context: "Which session store should we use?", decisionId: "d_carry",
        options: [
          { id: "a", title: "Redis", description: "External cache with native TTL.", pros: ["Native per-key TTL"], cons: ["Adds an ops dependency"], effort: "medium", risk: "low", recommendation: true },
          { id: "b", title: "Postgres", description: "Reuse the primary DB.", pros: ["No new infra"], cons: ["Needs a sweep"], effort: "low", risk: "low", recommendation: false },
          { id: "c", title: "In-memory", description: "An LRU map in the process.", pros: ["Zero latency"], cons: ["Lost on restart"], effort: "low", risk: "high", recommendation: false },
        ],
      },
    }),
  }).then((r) => { if (!r.ok) throw new Error(`seed carry v1 failed: ${r.status}`); });
  // v1 grain threads (anchored to dec_carry_v1) — these carry forward onto v2.
  for (const cmt of [
    { id: "cc_carry_sum", optionId: "a", sectionId: "summary", content: "TTL is exactly what we need" }, // CARRIED (a unchanged)
    { id: "cc_carry_stale", optionId: "b", sectionId: "summary", content: "does the sweep run often enough?" }, // STALE (b reworded)
    { id: "cc_carry_orphan", optionId: "c", sectionId: "summary", content: "restart loss is a dealbreaker" }, // ORPHAN (c removed)
    { id: "cc_carry_q", sectionId: "decision:question", content: "are we sure we need a store at all?" }, // CARRIED (question is permanent)
  ]) {
    await fetch(`${baseURL}/api/internal/sessions/a11ycarry/comments`, {
      method: "POST", headers: h,
      body: JSON.stringify({
        id: cmt.id, artifactId: "dec_carry_v1", author: "human", content: cmt.content,
        target: { artifactId: "dec_carry_v1", ...(cmt.optionId ? { optionId: cmt.optionId } : {}), ...(cmt.sectionId ? { sectionId: cmt.sectionId } : {}) },
      }),
    }).then((r) => { if (!r.ok) throw new Error(`seed carry comment ${cmt.id} failed: ${r.status}`); });
  }
  // Supersede v1 → the visible list drops it, so only v2's card renders.
  await fetch(`${baseURL}/api/internal/sessions/a11ycarry/artifacts/dec_carry_v1/status`, {
    method: "POST", headers: h, body: JSON.stringify({ status: "superseded", reason: "tuned" }),
  }).then((r) => { if (!r.ok) throw new Error(`seed carry supersede failed: ${r.status}`); });
  await fetch(`${baseURL}/api/internal/sessions/a11ycarry/artifacts`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "dec_carry_v2", type: "decision", title: "Pick a store", version: 2, parentId: "dec_carry_v1",
      content: {
        context: "Which session store should we use?", decisionId: "d_carry",
        options: [
          { id: "a", title: "Redis", description: "External cache with native TTL.", pros: ["Native per-key TTL"], cons: ["Adds an ops dependency"], effort: "medium", risk: "low", recommendation: true }, // unchanged → CARRIED
          { id: "b", title: "Postgres", description: "Reuse the primary Postgres DB and add a sweep job.", pros: ["No new infra"], cons: ["Needs a sweep"], effort: "low", risk: "low", recommendation: false }, // reworded → STALE
          // c dropped → its v1 threads ORPHAN
        ],
      },
    }),
  }).then((r) => { if (!r.ok) throw new Error(`seed carry v2 failed: ${r.status}`); });

  // #187 — an APPROVED changeset in its OWN session so the late FOLLOW-UP lane
  // is scanned WITHOUT disturbing the draft-review changeset (cs_a11y) above.
  // The review closed (status approved), but line commenting stays live: the
  // #187 test SELECTS it, opens a line composer (the follow-up honesty marker +
  // the Comment/Ask composer, NO Suggest), and scans both themes — the
  // hollow-net lesson: actually mount the new late-lane state.
  const regLate = await fetch(`${baseURL}/api/internal/sessions/a11ylate/register`, { method: "POST", headers: h, body: "{}" });
  if (!regLate.ok) throw new Error(`seed late-comment register failed: ${regLate.status}`);
  await fetch(`${baseURL}/api/internal/sessions/a11ylate/artifacts`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "cs_late", type: "changeset", title: "Centralize the TTL refresh",
      content: {
        summary: "The already-approved change the human wants to comment on later.",
        files: [
          {
            path: "auth/middleware.ts", changeType: "modified", stats: { additions: 2, deletions: 1 },
            hunks: [{
              header: "@@ -24,3 +24,4 @@ export function requireSession(store: SessionStore) {",
              lines: [
                { kind: "ctx", content: "    const sid = readSessionCookie(req);", oldLine: 25, newLine: 25 },
                { kind: "del", content: "    const session = await store.get(sid);", oldLine: 26 },
                { kind: "add", content: "    const session = await store.getAndTouch(sid); // refreshes TTL", newLine: 26 },
              ],
            }],
          },
        ],
      },
    }),
  }).then((r) => { if (!r.ok) throw new Error(`seed late changeset failed: ${r.status}`); });
  // Close the review with a positive verdict → status approved (the only closed
  // status that keeps the late comment lane).
  await fetch(`${baseURL}/api/internal/sessions/a11ylate/artifacts/cs_late/status`, {
    method: "POST", headers: h, body: JSON.stringify({ status: "approved" }),
  }).then((r) => { if (!r.ok) throw new Error(`seed late changeset approve failed: ${r.status}`); });

  // #190 — the end-of-feature DEBRIEF in its OWN session so BOTH theme scans
  // mount the full comprehension surface (summary + a section carrying a concept
  // + token-rich evidence, the accountability "calls I made on my own" block,
  // the needsYourEyes review list with its drill-in link, deferred, and the
  // ask-anything thread). The #187 hollow-net lesson: the helper SELECTS it and
  // opens the summary grain composer so the new grain-thread surface is scanned
  // for real, not just seeded.
  const regDebrief = await fetch(`${baseURL}/api/internal/sessions/a11ydebrief/register`, { method: "POST", headers: h, body: "{}" });
  if (!regDebrief.ok) throw new Error(`seed debrief register failed: ${regDebrief.status}`);
  await fetch(`${baseURL}/api/internal/sessions/a11ydebrief/artifacts`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "debrief_a11y", type: "debrief", title: "Debrief — sliding-window session TTL",
      content: {
        summary: "We moved the sliding-window session-TTL refresh into the auth middleware so every authenticated route inherits it for free. Here's the walk, the calls I made without you, and what I'd like your eyes on.",
        sections: [
          {
            title: "Centralized the TTL refresh in middleware",
            body: "`requireSession` now calls `store.getAndTouch(sid)`, which refreshes the expiry as a side effect of the lookup — no route has to remember to do it.",
            concepts: [{ name: "sliding-window expiration", oneLineExplanation: "each authenticated request pushes the session's expiry forward, so active users are never logged out mid-session" }],
            // Token-rich TS (string, comment, keyword, number, punctuation) so the
            // scan measures the syntax palette on this surface too — the same rule
            // the research evidence seed follows.
            evidence: [{ filePath: "auth/middleware.ts", lineStart: 26, lineEnd: 30, snippet: 'const session = await store.getAndTouch(sid); // refreshes TTL\nif (!session || session.expiresAt < Date.now()) {\n  clearSessionCookie(res);\n  return res.status(401).end();\n}', explanation: "The single choke point every authenticated route flows through." }],
            changesetRef: "cs_debrief_ref",
          },
        ],
        decisionsMade: [
          { what: "Return 401 and clear the cookie on an expired session rather than transparently re-issuing one.", why: "A silent re-issue would mask a stale session and weaken the security posture; failing closed is the safer default.", alternative: "Auto-renew any session seen within a grace window — rejected as too permissive for an auth path." },
        ],
        needsYourEyes: [
          { what: "The expiry check in the middleware diff", why: "It changes the auth failure path for every route at once — worth a careful read before we ship.", artifactRef: "cs_debrief_ref" },
        ],
        deferred: [
          { what: "Refresh-token rotation", why: "Out of scope; the sliding window covers the active-session case. Flag it if you want it next." },
        ],
        openQuestions: ["Should the sliding window survive a server restart, or is an in-memory store acceptable here?"],
      },
    }),
  }).then((r) => { if (!r.ok) throw new Error(`seed debrief failed: ${r.status}`); });

  // #190 A2 — the read-only EXPLAINER in its OWN session so BOTH theme scans mount
  // the full walk-through (overview + numbered sections with token-rich evidence,
  // the suggested-question chips, the related drill-in link, and the always-visible
  // ask-anything thread). Same #187 hollow-net discipline as the debrief seed.
  const regExplainer = await fetch(`${baseURL}/api/internal/sessions/a11yexplainer/register`, { method: "POST", headers: h, body: "{}" });
  if (!regExplainer.ok) throw new Error(`seed explainer register failed: ${regExplainer.status}`);
  await fetch(`${baseURL}/api/internal/sessions/a11yexplainer/artifacts`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "explainer_a11y", type: "explainer", title: "How session authentication works here",
      content: {
        title: "How session authentication works here",
        overview: "You're about to walk the request path for an authenticated route: how the cookie is read, where the session is looked up and its TTL refreshed, and what happens when it has expired. Read top to bottom — each step points at the exact code.",
        sections: [
          {
            heading: "1. The session is looked up and its TTL refreshed",
            body: "`requireSession` calls `store.getAndTouch(sid)`, which refreshes the expiry as a side effect of the lookup — no route has to remember to do it.",
            // Token-rich TS (string, comment, keyword, number, punctuation) so the
            // scan measures the syntax palette on this surface too.
            evidence: [{ filePath: "auth/middleware.ts", lineStart: 26, lineEnd: 30, snippet: 'const session = await store.getAndTouch(sid); // refreshes TTL\nif (!session || session.expiresAt < Date.now()) {\n  clearSessionCookie(res);\n  return res.status(401).end();\n}', explanation: "The single choke point every authenticated route flows through." }],
          },
          {
            heading: "2. An expired session fails closed",
            body: "If the session is missing or past its expiry, the cookie is cleared and the request is rejected — the code never transparently re-issues a session.",
          },
        ],
        relatedArtifactIds: ["cs_explainer_ref"],
        suggestedQuestions: ["Where does the session get created in the first place?"],
        // R4 P-B — a diagram visual so the shared ArtifactVisuals block (the
        // round-13 headline: previously stripped on explainers) mounts under the
        // axe net + reaches the export. R4 P-C — an `unknowns` entry so the
        // above-the-fold "What I'm not sure about" list + its one-click Ask
        // affordance are axe-covered too.
        visuals: [{ id: "vis_auth_seq", kind: "diagram", title: "Request path", source: "sequenceDiagram; Client->>API: GET /me\n  API->>Store: getAndTouch(sid)" }],
        unknowns: ["I couldn't tell whether the CLI login path is covered — I didn't read cli/init.ts"],
      },
    }),
  }).then((r) => { if (!r.ok) throw new Error(`seed explainer failed: ${r.status}`); });

  // -------------------------------------------------------------------------
  // R2 — THE FIXTURE RATCHET: seed the NEWEST surfaces, always.
  //
  // Round 13's process verdict named this as one of three standing ratchets,
  // and named this file as the miss: the a11y session seeded only a LOCAL
  // changeset, so Q6's external-review banner — the newest review surface in
  // the product — had ZERO axe coverage, and five of the six contrast failures
  // that shipped were on surfaces this net had never mounted. A net that only
  // covers last release's UI reports green about code it never looked at.
  //
  // Three seeds below, one per uncovered surface, each with the #187
  // hollow-net discipline (a helper that actually MOUNTS the state before
  // analyzing, not a seed that merely exists on disk):
  //   1. an EXTERNAL changeset  → ExternalReviewBanner
  //   2. a persisted gate BLOCK → PreflightBlockLog, reachable from a cold load
  //   3. a rejectable finding   → the first-reject CrossProjectCard
  // -------------------------------------------------------------------------

  // 1. Q6's external-review banner, in its OWN session so the local-changeset
  //    scans above keep measuring the LOCAL semantics (the two states differ
  //    precisely in what the banner says about whose code this is).
  const regExt = await fetch(`${baseURL}/api/internal/sessions/a11yexternal/register`, { method: "POST", headers: h, body: "{}" });
  if (!regExt.ok) throw new Error(`seed external register failed: ${regExt.status}`);
  await fetch(`${baseURL}/api/internal/sessions/a11yexternal/artifacts`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      id: "cs_external", type: "changeset", title: "Rate-limit the login endpoint",
      content: {
        summary: "A colleague's PR, pulled onto the review surface. Your verdicts stay local until you post them.",
        risks: ["touches auth"],
        // Every optional provenance field is populated: the banner degrades
        // per-field, so a scan of the FULL shape is the one that measures the
        // link, the author dangle and the branch-ref pair together.
        reviewIntent: "external",
        source: {
          kind: "github-pr", number: 482, url: "https://github.com/example/app/pull/482",
          headRef: "priya/rate-limit-login", baseRef: "main", author: "priya",
        },
        files: [
          {
            path: "auth/login.ts", changeType: "modified", stats: { additions: 4, deletions: 1 },
            hunks: [{
              header: "@@ -12,4 +12,7 @@ export async function login(req: Request) {",
              lines: [
                { kind: "ctx", content: "  const { email, password } = req.body;", oldLine: 13, newLine: 13 },
                { kind: "del", content: "  const user = await users.findByEmail(email);", oldLine: 14 },
                { kind: "add", content: "  if (!(await limiter.take(req.ip))) return res.status(429).end(); // 5/min", newLine: 14 },
                { kind: "add", content: "  const user = await users.findByEmail(email);", newLine: 15 },
              ],
            }],
          },
        ],
      },
    }),
  }).then((r) => { if (!r.ok) throw new Error(`seed external changeset failed: ${r.status}`); });

  // 2. A REAL, persisted gate block. Q2 made the log durable
  //    (.deeppairing/preflight-blocks.json, served at /api/preflight-blocks)
  //    and R2 made a cold page load hydrate it — so writing the file is enough
  //    for the chip to carry blocks with no agent in the loop. The route reads
  //    from disk per request, so this needs no daemon restart.
  fs.mkdirSync(path.join(projectRoot, ".deeppairing"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, ".deeppairing", "preflight-blocks.json"),
    JSON.stringify({
      version: 1,
      blocks: [
        {
          id: "blk_a11y_1", at: new Date(Date.now() - 90_000).toISOString(), sessionId: "a11y",
          source: "session", via: "concept",
          concept: "in-memory session store",
          proposal: "swap the Redis session store for an in-process Map",
          reason: "we lose every logged-in user on deploy — you said never again",
        },
        {
          id: "blk_a11y_2", at: new Date(Date.now() - 3_600_000).toISOString(), sessionId: "a11y",
          source: "team", via: "avoid", addedBy: "priya",
          concept: "raw SQL in route handlers",
          proposal: "inline a SELECT in the /orders handler",
          reason: "team rule: queries live in the repository layer",
        },
      ],
    }),
  );

  // 3. A findings artifact whose reject flow OPENS the first-reject
  //    cross-project card — the consent surface Q2 shipped and nothing ever
  //    scanned. Its own session, because the scan REJECTS it for real.
  const regCross = await fetch(`${baseURL}/api/internal/sessions/a11ycross/register`, { method: "POST", headers: h, body: "{}" });
  if (!regCross.ok) throw new Error(`seed cross register failed: ${regCross.status}`);
  // TWO of them: the scan REJECTS the artifact for real (a reject is terminal,
  // so a second scan of the same id would meet a "Rejected" chip and no
  // composer), and the dark + light variants each need their own.
  for (const id of ["res_cross_dark", "res_cross_light"]) {
    await fetch(`${baseURL}/api/internal/sessions/a11ycross/artifacts`, {
      method: "POST", headers: h,
      body: JSON.stringify({
        id, type: "research", title: "Config loading audit",
        content: {
          summary: "Where configuration is read, and what that costs at test time.",
          findings: [{
            category: "Design", title: "Module-level mutable config",
            detail: "Settings are hoisted to a module-level object every importer mutates.",
            significance: "high",
            evidence: "export const settings = {}; // mutated by 4 modules at import time",
            recommendation: "Pass config explicitly through the composition root.",
          }],
        },
      }),
    }).then((r) => { if (!r.ok) throw new Error(`seed cross findings failed: ${r.status}`); });
  }
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

/**
 * R2 — select an artifact from the rail, unfolding "Show N older" when the row
 * has aged out of it.
 *
 * The rail renders only the 10 most-recent artifacts (SIDEBAR_RECENT_LIMIT) and
 * folds the rest — and it aggregates every session in the project, so its
 * budget is shared by the WHOLE fixture, not by one session. This file was
 * already sitting exactly at the limit, so the R2 seeds (an external changeset
 * plus two rejectable findings) pushed `res_a11y` and `cc_a11y` under the fold
 * and three long-standing scans began timing out on locators that had simply
 * been folded away — a fixture-capacity failure that reads exactly like a
 * product regression.
 *
 * Unfolding first decouples every helper from how many surfaces the fixture
 * seeds, which is the precondition for the "fixtures always seed the newest
 * surfaces" ratchet actually being sustainable.
 *
 * Why a RETRY LOOP and not a one-shot "is it folded? unfold once, then click":
 * the rail hydrates in STAGES on a cold load. The bound session's own artifacts
 * arrive first (the target row renders, unfolded, with NO "Show older" button
 * yet), and only a few frames later does the async cross-session backfill
 * (MultiAgentSync) push the project past SIDEBAR_RECENT_LIMIT — which folds the
 * older rows away. A one-shot helper decides against whichever stage it happens
 * to observe: caught in the pre-backfill window it sees the row visible, skips
 * the unfold, and begins clicking — then the backfill lands and FOLDS the row
 * out from under the click, which then retries forever against a row that is
 * now behind the fold (deterministic on fast CI, where the window is ~90ms and
 * the click reliably starts inside it; invisible on slow WSL, where the helper
 * only runs after the backfill has already settled the fold). Re-asserting the
 * unfold and re-attempting the click on EVERY pass converges regardless of
 * which hydration stage we start in. The "Show N older" label matches only the
 * FOLDED state (unfolded reads "Show fewer"), so this only ever unfolds — it
 * never toggles a row back under the fold.
 */
async function selectSidebarArtifact(
  page: import("@playwright/test").Page,
  artifactId: string,
): Promise<void> {
  const row = page.locator(`[data-artifact-item="${artifactId}"]`);
  await expect(async () => {
    const showOlder = page.getByRole("button", { name: /Show \d+ older/i });
    if (await showOlder.count()) await showOlder.first().click();
    // Short per-attempt timeouts: a stale (mid-fold) observation should fail
    // THIS pass fast and re-unfold on the next, not burn the whole budget
    // waiting on a row the backfill is about to detach.
    await expect(row.first()).toBeVisible({ timeout: 1000 });
    await row.first().click({ timeout: 2000 });
  }).toPass({ timeout: 20000, intervals: [100, 200, 300, 500] });
}

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
  await selectSidebarArtifact(page, "res_a11y");
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
  await selectSidebarArtifact(page, "cc_a11y");
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
  await selectSidebarArtifact(page, "cs_a11y");
  await page.waitForSelector('[data-artifact-id="cs_a11y"]', { timeout: 15000 });
  // #175 — the DERIVED action (one file flagged → Send back) proves the refined
  // action bar mounted. The rail carries both disposition chips.
  await page.getByRole("button", { name: /Send back/ }).waitFor({ timeout: 15000 });
  await page.getByText("↻ changes").waitFor({ timeout: 15000 });
  // Activate the flagged file so its needs-changes REASON box mounts for the
  // scan (the #187 hollow-net lesson — actually render the new state). session.ts
  // also carries the #186 removed lines + a del-side thread.
  await page.getByTitle("modified auth/session.ts").click();
  await page.getByLabel(/Reason this file needs changes/).waitFor({ timeout: 15000 });
  // The cross-file card in the rail is part of the seeded state.
  await page.getByText("CROSS-FILE COMMENT").waitFor({ timeout: 15000 });
  // #186 — the seeded del-side thread (on removed oldLine 11) is mounted…
  await page.getByText(/Keep ttl — the OAuth callback path reads it/).waitFor({ timeout: 15000 });
  // …and open the composer on the OTHER removed line (oldLine 12) so the
  // "(removed)" header + del-side Comment/Ask composer are measured too.
  await page
    .locator('[data-comment-anchor="line:auth/session.ts:old:12"]')
    .getByRole("button", { name: /add a comment on this line/i })
    .click();
  await page.getByTestId("removed-line-header").waitFor({ timeout: 15000 });
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

/** #177 slice 2a — mount the workbench of a SUPERSEDED decision so the carryover
 *  markers (CARRIED / STALE / ORPHAN) are in the scanned DOM for real (the #187
 *  hollow-net lesson). Waits for the workbench dialog, then for BOTH a green
 *  CARRIED badge and a red ORPHAN badge (the two ends of the treatment) before
 *  settling animations — a hollow scan of an empty rail can't "pass". */
async function openCarryoverWorkbench(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForSelector("button[data-select-option]", { timeout: 15000 });
  await page.getByRole("button", { name: /Expand to discuss/i }).click();
  await page.waitForSelector('[data-testid="decision-workbench"]', { timeout: 15000 });
  await page.waitForSelector('[data-testid="carryover-badge"][data-carryover="carried"]', { timeout: 15000 });
  await page.waitForSelector('[data-testid="carryover-badge"][data-carryover="stale"]', { timeout: 15000 });
  await page.waitForSelector('[data-testid="carryover-badge"][data-carryover="orphan"]', { timeout: 15000 });
  await page.evaluate(() =>
    Promise.all(
      document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

/** #180 — mount the DEFAULT (non-workbench) decision surfaces of the SAME
 *  superseded chain so the carryover markers are scanned WITHOUT opening the
 *  Discuss workbench (the #187 hollow-net lesson: render the new states for
 *  real). The inline OptionCards carry per-option markers and the flat "Comments"
 *  thread carries per-comment ones; waits for BOTH a green CARRIED and a red
 *  ORPHAN badge (ORPHAN only exists in the flat thread — a removed option has no
 *  card) before settling animations, so a hollow scan can't "pass". */
async function openCarryoverDefaultSurfaces(page: import("@playwright/test").Page): Promise<void> {
  // The inline decision card mounts its Select buttons + the OptionCard markers.
  await page.waitForSelector("button[data-select-option]", { timeout: 15000 });
  // Workbench stays CLOSED — every badge here is a default-surface badge.
  await expect(page.locator('[data-testid="decision-workbench"]')).toHaveCount(0);
  await page.waitForSelector('[data-testid="carryover-badge"][data-carryover="carried"]', { timeout: 15000 });
  // ORPHAN lives in the flat ArtifactPanel decision-comment thread (lazy chunk).
  await page.waitForSelector('[data-testid="carryover-badge"][data-carryover="orphan"]', { timeout: 15000 });
  await page.evaluate(() =>
    Promise.all(
      document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

test("a11y (#180): the DEFAULT decision carryover markers (OptionCard + flat thread) have no serious/critical axe violations — dark", async ({ page }) => {
  await page.goto(`${baseURL}/?session=a11ycarry`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  await openCarryoverDefaultSurfaces(page);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `axe violations (default carryover surfaces, dark):\n${fmt(serious)}`).toEqual([]);
});

test("a11y (#180): the DEFAULT decision carryover markers have no serious/critical axe violations — light", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("dp-theme", "light"));
  await page.goto(`${baseURL}/?session=a11ycarry`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await openCarryoverDefaultSurfaces(page);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `axe violations (default carryover surfaces, light):\n${fmt(serious)}`).toEqual([]);
});

test("a11y (#177): the workbench carryover markers (CARRIED/STALE/ORPHAN) have no serious/critical axe violations — dark", async ({ page }) => {
  await page.goto(`${baseURL}/?session=a11ycarry`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  await openCarryoverWorkbench(page);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `axe violations (workbench carryover, dark):\n${fmt(serious)}`).toEqual([]);
});

test("a11y (#177): the workbench carryover markers have no serious/critical axe violations — light", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("dp-theme", "light"));
  await page.goto(`${baseURL}/?session=a11ycarry`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await openCarryoverWorkbench(page);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `axe violations (workbench carryover, light):\n${fmt(serious)}`).toEqual([]);
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

/** #190 — mount the DEBRIEF comprehension surface for real before scanning (the
 *  #187 hollow-net lesson). Selects the debrief, waits for every block (summary,
 *  the section's concept + evidence, the accountability block, needsYourEyes, and
 *  the always-visible ask-anything composer), opens the summary grain composer so
 *  the grain-thread surface is scanned too, then settles finite animations so axe
 *  never samples a mid-fade frame. */
async function openDebrief(page: import("@playwright/test").Page): Promise<void> {
  await selectSidebarArtifact(page, "debrief_a11y");
  await page.waitForSelector('[data-artifact-id="debrief_a11y"]', { timeout: 15000 });
  // The accountability + review blocks prove the full renderer mounted.
  await page.getByTestId("debrief-decision").first().waitFor({ timeout: 15000 });
  await page.getByTestId("debrief-needs-eyes").first().waitFor({ timeout: 15000 });
  // The ask-anything thread is the marquee surface — its composer is always
  // visible; wait for it so the scan measures the thread OPEN.
  await page.getByLabel("Comment on this debrief").waitFor({ timeout: 15000 });
  // Open the summary block's grain composer so its scoped thread is scanned too.
  await page.getByRole("button", { name: "Comment on What we built" }).click();
  await page.getByLabel("Comment on What we built").waitFor({ timeout: 15000 });
  // S2 (round-14) — the walk is EXPANDED by default now (deep-by-default), so its
  // sections (and their token-rich evidence) are already mounted for the scan — no
  // toggle click needed (clicking would COLLAPSE it and hide the evidence).
  // Token-rich evidence highlights async (shiki) — wait for a colored span so the
  // syntax palette is actually measured, not plain uncolored text.
  await page.waitForSelector(
    '[data-artifact-id="debrief_a11y"] .bg-surface-code span[style*="color:"]',
    { timeout: 15000 },
  );
  await page.evaluate(() =>
    Promise.all(
      document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

test("a11y (#190): the DEBRIEF surface (ask-anything thread open) has no serious/critical axe violations — dark", async ({ page }) => {
  await page.goto(`${baseURL}/?session=a11ydebrief`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  await openDebrief(page);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `axe violations (debrief, dark):\n${fmt(serious)}`).toEqual([]);
});

test("a11y (#190): the DEBRIEF surface (ask-anything thread open) has no serious/critical axe violations — light", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("dp-theme", "light"));
  await page.goto(`${baseURL}/?session=a11ydebrief`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await openDebrief(page);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `axe violations (debrief, light):\n${fmt(serious)}`).toEqual([]);
});

/** #190 A2 — mount the EXPLAINER walk-through for real before scanning. Selects
 *  it, waits for the sections + the always-visible ask-anything composer, opens the
 *  overview grain composer so its scoped thread is scanned too, waits for the shiki
 *  syntax palette on the evidence, then settles finite animations. */
async function openExplainer(page: import("@playwright/test").Page): Promise<void> {
  await selectSidebarArtifact(page, "explainer_a11y");
  await page.waitForSelector('[data-artifact-id="explainer_a11y"]', { timeout: 15000 });
  // The ordered sections prove the full renderer mounted.
  await page.getByTestId("explainer-section").first().waitFor({ timeout: 15000 });
  // The ask-anything thread composer is always visible — scan it OPEN.
  await page.getByLabel("Comment on this explainer").waitFor({ timeout: 15000 });
  // Open the overview block's grain composer so its scoped thread is scanned too.
  await page.getByRole("button", { name: "Comment on What you're about to read" }).click();
  await page.getByLabel("Comment on What you're about to read").waitFor({ timeout: 15000 });
  // Token-rich evidence highlights async (shiki) — wait for a colored span.
  await page.waitForSelector(
    '[data-artifact-id="explainer_a11y"] .bg-surface-code span[style*="color:"]',
    { timeout: 15000 },
  );
  await page.evaluate(() =>
    Promise.all(
      document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

test("a11y (#190 A2): the EXPLAINER surface (ask-anything thread open) has no serious/critical axe violations — dark", async ({ page }) => {
  await page.goto(`${baseURL}/?session=a11yexplainer`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  await openExplainer(page);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `axe violations (explainer, dark):\n${fmt(serious)}`).toEqual([]);
});

test("a11y (#190 A2): the EXPLAINER surface (ask-anything thread open) has no serious/critical axe violations — light", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("dp-theme", "light"));
  await page.goto(`${baseURL}/?session=a11yexplainer`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await openExplainer(page);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `axe violations (explainer, light):\n${fmt(serious)}`).toEqual([]);
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
  // #189 — autonomy was demoted into the Diagnostics (⋯) overflow menu; open
  // that first, then the autonomy popover.
  await page.goto(`${baseURL}/?session=a11y`);
  // R2 — matched on /diagnostics/i, not the exact idle label: the trigger
  // RENAMES itself to "Diagnostics — attention needed" whenever a gate block or
  // hook nag is live, and this project's fixture now carries persisted blocks
  // that a cold page load surfaces. Pinning the idle wording would make this
  // scan depend on the gate never having fired.
  const diagBtn = page.getByRole("button", { name: /diagnostics/i });
  await diagBtn.waitFor({ timeout: 15000 });
  await diagBtn.click();
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

/** #185 — open the region-comment POPOVER for real before scanning (the #187
 *  hollow-net lesson: actually mount the new UI). Drags a marquee over a rendered
 *  node so the composer opens as the anchored popover (not the legacy block —
 *  Playwright's default 1280px viewport is wide, so useIsNarrowViewport is false),
 *  then settles finite animations. Coordinates come from boundingBox() at run
 *  time — never hardcoded pixels. */
async function openRegionPopover(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForSelector(".dp-mermaid svg g.node", { timeout: 15000 });
  const node = page.locator(".dp-mermaid svg g.node").first();
  const nb = await node.boundingBox();
  if (!nb) throw new Error("region node has no geometry");
  await page.mouse.move(nb.x + 5, nb.y + 5);
  await page.mouse.down();
  await page.mouse.move(nb.x + nb.width - 5, nb.y + nb.height - 5, { steps: 10 });
  await page.mouse.up();
  // The anchored popover composer (not the below-diagram block) is now open.
  await page.waitForSelector('[data-testid="dp-region-popover"]', { timeout: 15000 });
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

test("a11y (#185): the region-comment POPOVER (open) has no serious/critical axe violations — dark", async ({ page }) => {
  await page.goto(`${baseURL}/?session=a11yplan`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  await openRegionPopover(page);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    // Zero disabled rules — the anchored popover composer (the same CommentThread
    // textarea + Cancel control, now floating over the well) must pass as-is.
    .analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `axe violations (region popover, dark):\n${fmt(serious)}`).toEqual([]);
});

test("a11y (#185): the region-comment POPOVER (open) has no serious/critical axe violations — light", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("dp-theme", "light"));
  await page.goto(`${baseURL}/?session=a11yplan`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await openRegionPopover(page);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `axe violations (region popover, light):\n${fmt(serious)}`).toEqual([]);
});

test("a11y (#185 feel round): the popover is a titled drag handle, and keyboard dismissal (Esc) is unaffected by it", async ({ page }) => {
  // The two axe scans above already run against the roomy/draggable popover;
  // this asserts the feel-round affordance is DISCOVERABLE (titled handle) and
  // that adding a pointer-only drag introduced no keyboard trap — Esc still
  // closes the composer (drag is pointer-only; keyboard users never drag).
  await page.goto(`${baseURL}/?session=a11yplan`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  await openRegionPopover(page);
  const handle = page.locator('[data-testid="dp-region-popover"] [title="Drag to move this comment box"]');
  await expect(handle).toBeVisible();
  // Esc closes the popover — the layered-Esc contract survives the drag handle.
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-testid="dp-region-popover"]')).toHaveCount(0);
});

test("#185: reverse navigation — clicking a posted region thread flash-highlights its rect on the diagram", async ({ page }) => {
  await page.goto(`${baseURL}/?session=a11yplan`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  // Post a region comment through the anchored popover (the real drag → compose
  // → send path), so a posted thread exists to navigate back FROM.
  await openRegionPopover(page);
  const composerInput = page.locator("textarea:focus");
  await composerInput.waitFor({ timeout: 10000 });
  await composerInput.fill("does this gate need a timeout?");
  await composerInput.press("Control+Enter");
  const highlight = page.locator('[data-testid="dp-region-highlight"]');
  await expect(highlight).toHaveCount(1, { timeout: 10000 });
  await expect(highlight).toHaveAttribute("data-region-flash", "false");

  // Click the thread's anchor header (a real, keyboard-operable button) — the
  // region rect flashes. The flash attribute flips true, then the timeout clears
  // it (nothing lingers). The scrollInto.. + smooth scroll can't be asserted
  // headlessly, but the flash cue proves the reverse-nav handler ran on the
  // right comment.
  await page.getByTestId("dp-region-thread-anchor").click();
  await expect(highlight).toHaveAttribute("data-region-flash", "true");
  // The pulse clears (REGION_FLASH_MS ≈ 1.6s) — assert it un-flashes on its own.
  await expect(highlight).toHaveAttribute("data-region-flash", "false", { timeout: 5000 });
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

/**
 * Q4 (round-12 UX #4) — the structural rules this whole suite was blind to.
 *
 * Every scan above filters on `withTags(["wcag2a","wcag2aa"])`, and axe files
 * `heading-order`, `landmark-one-main`, `landmark-unique`,
 * `page-has-heading-one` and `empty-heading` under `best-practice`/
 * `cat.semantics` — NOT under a WCAG tag. So a suite that truthfully advertises
 * "zero disabled rules" never once ran them, which is how the app shipped with
 * a single landmark, an h1→h3 skip on the primary content path, and every
 * section label (NEEDS YOUR EYES, FINDINGS, THE WALK-THROUGH, CHANGED FILES) as
 * a styled <div>. Select the rules BY NAME so the tag filter can't hide them
 * again, and assert on the violations themselves rather than on impact —
 * best-practice rules are reported as "moderate", so an impact filter would
 * silently pass whatever they find.
 */
const STRUCTURE_RULES = [
  "heading-order",
  "landmark-one-main",
  "landmark-unique",
  "page-has-heading-one",
  "empty-heading",
  // Q4 review (L5) — `region` (all page content belongs to a landmark) is the
  // strictest of the family and the reason the landmark work is finishable at
  // all: with it on, the scan enumerates every unlandmarked node instead of
  // stopping at "there is one <main>". Turning it on flagged exactly three,
  // in two components — the waiting strip's text and the composer's body +
  // latency hint — both now named regions. It stays ON so the next stray
  // top-level div fails here rather than in a review.
  "region",
];

test("a11y: the app shell's landmark + heading structure passes axe's semantic rules", async ({ page }) => {
  await page.goto(baseURL);
  await page.waitForSelector("text=deepPairing", { timeout: 15000 });
  await expect
    .poll(
      () => page.evaluate(() => (window as any).__dpConnectionStore?.getState?.()?.connected ?? false),
      { timeout: 15_000 },
    )
    .toBe(true);
  await page.getByText("Draft, awaiting review").first().waitFor({ timeout: 15_000 });

  // The structure these rules now have something to check.
  await expect(page.locator("header").first()).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Sessions" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Artifacts" })).toBeVisible();
  await expect(page.getByRole("main")).toBeAttached();

  const results = await new AxeBuilder({ page }).withRules(STRUCTURE_RULES).analyze();
  expect(results.violations, `axe structure violations:\n${fmt(results.violations)}`).toEqual([]);
});

test("a11y: an OPEN artifact's heading outline passes axe's semantic rules (the section labels are real headings now)", async ({ page }) => {
  await page.goto(`${baseURL}/?session=a11y`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });

  // The seeded research artifact: its FINDINGS section is now the h3 under the
  // artifact-title h2 (before: an h4, under an h3 title, under the shell h1 —
  // a skip at BOTH steps).
  await openQuestionSections(page);
  await expect(page.getByRole("heading", { name: /^Findings/i, level: 3 }).first()).toBeVisible();
  const research = await new AxeBuilder({ page }).withRules(STRUCTURE_RULES).analyze();
  expect(research.violations, `axe structure violations (research):\n${fmt(research.violations)}`).toEqual([]);

  // …and the changeset, whose CHANGED FILES picker label was a styled div.
  await openChangeset(page);
  await expect(page.getByRole("heading", { name: /^Changed files$/i, level: 3 })).toBeVisible();
  const changeset = await new AxeBuilder({ page }).withRules(STRUCTURE_RULES).analyze();
  expect(changeset.violations, `axe structure violations (changeset):\n${fmt(changeset.violations)}`).toEqual([]);
});

test("a11y: the Ledger drawer with a stance row + armed remove confirm has no serious/critical axe violations", async ({ page }) => {
  // #193 — the per-stance remove affordance shipped into a surface no e2e
  // scan ever opened (the exact hollow-net shape #187 taught us about), so
  // this opens the drawer for real. Seed one stance first so the Stances tab
  // renders a row WITH the remove button. Snapshot and restore the isolated
  // ledger so neither worker count nor declaration order becomes a fixture.
  const ledgerPath = path.join(home, ".deeppairing", "philosophy.json");
  const priorLedger = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath) : undefined;
  try {
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
    // #212 (J4) — the top-level header Ledger button was cut; the drawer's own
    // entry points all fire the shared dp:open-your-taste event. Dispatch it
    // directly so the scan sees only the drawer under test.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("dp:open-your-taste")));
    const removeBtn = page.getByRole("button", { name: /^Remove stance: global mutable state$/ });
    await removeBtn.waitFor({ timeout: 15000 });

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious, `axe violations (drawer, unarmed):\n${fmt(serious)}`).toEqual([]);

    // Arming only — never confirm, so the second scan mutates nothing further.
    await removeBtn.click();
    await page.waitForSelector('[data-testid="stance-remove-confirm"]', { timeout: 15000 });
    const armed = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    const armedSerious = armed.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(armedSerious, `axe violations (drawer, armed confirm):\n${fmt(armedSerious)}`).toEqual([]);
  } finally {
    if (priorLedger) {
      fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
      fs.writeFileSync(ledgerPath, priorLedger);
    } else {
      fs.rmSync(ledgerPath, { force: true });
    }
  }
});

/**
 * #181 — a genuinely-broken diagram must degrade to the component's clean
 * fallback WITHOUT leaking mermaid's own "Syntax error" bomb graphic to the
 * bottom of the page. This runs against REAL mermaid (not the unit-test mock):
 * suppressErrorRendering makes mermaid throw instead of drawing the bomb, and
 * the existing catch shows the source fallback + reports the failure (#176).
 *
 * PRE-FIX EVIDENCE: without `suppressErrorRendering: true` in loadMermaid()'s
 * initialize config, mermaid draws its error diagram into a temp `#d<id>` node
 * appended to document.body and throws BEFORE removing it — so the body-level
 * assertions below (no `.error-icon`, no "Syntax error in text") FAIL: the leak
 * is present. With the flag they pass.
 */
async function assertNoMermaidErrorLeak(page: import("@playwright/test").Page): Promise<void> {
  // The component's clean fallback renders (source shown, honest message).
  await page.getByText(/Couldn.t render this diagram/i).waitFor({ timeout: 15000 });
  // Mermaid's OWN error graphic must be nowhere in the DOM: no bomb icon/text,
  // and no orphaned temp render node (its enclosing div is id `d` + the minted
  // `dp-mmd-*` id) left dangling at document.body.
  await expect(page.locator(".error-icon")).toHaveCount(0);
  await expect(page.locator(".error-text")).toHaveCount(0);
  await expect(page.getByText("Syntax error in text")).toHaveCount(0);
  await expect(page.locator('[id^="ddp-mmd"], [id^="dp-mmd"]')).toHaveCount(0);
}

test("#181: a broken diagram degrades to the fallback with NO mermaid error-graphic leak — dark", async ({ page }) => {
  await page.goto(`${baseURL}/?session=a11ymermaidbad`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  await assertNoMermaidErrorLeak(page);
});

test("#181: a broken diagram degrades to the fallback with NO mermaid error-graphic leak — light", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("dp-theme", "light"));
  await page.goto(`${baseURL}/?session=a11ymermaidbad`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await assertNoMermaidErrorLeak(page);
});

/** #187 — mount the APPROVED changeset's late FOLLOW-UP lane for real before
 *  scanning (the hollow-net lesson: actually render the new state). The review is
 *  closed (no disposition buttons, no action bar), but line commenting is live:
 *  open a new-side line composer and wait for the follow-up honesty marker + the
 *  Comment/Ask composer (Suggest is withheld in the late lane), then settle
 *  finite animations. */
async function openLateFollowUpComposer(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForSelector('[data-artifact-id="cs_late"]', { timeout: 15000 });
  // Review is CLOSED — the changeset's own disposition controls + derived action
  // bar are gone (the shell's generic footer just shows an "Approved" chip).
  await expect(page.locator('[data-testid="disposition-controls"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="approve-changeset"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="approve-all"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="send-back"]')).toHaveCount(0);
  // Line commenting stays live: open the composer on the new-side line 26.
  await page
    .locator('[data-comment-anchor="line:auth/middleware.ts:26"]')
    .getByRole("button", { name: /add a comment on this line/i })
    .click();
  // The follow-up honesty marker + the reframed composer are mounted.
  await page.getByTestId("follow-up-lane-hint").waitFor({ timeout: 15000 });
  await page.getByPlaceholder(/Follow-up comment on this approved artifact/i).waitFor({ timeout: 15000 });
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

test("a11y (#187): the approved-changeset late follow-up composer has no serious/critical axe violations — dark", async ({ page }) => {
  await page.goto(`${baseURL}/?session=a11ylate`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  await openLateFollowUpComposer(page);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `axe violations (late follow-up composer, dark):\n${fmt(serious)}`).toEqual([]);
});

// ---------------------------------------------------------------------------
// R2 — the three newest surfaces, now permanently inside the net.
// ---------------------------------------------------------------------------

/** Mount Q6's EXTERNAL-review banner for real (the #187 hollow-net rule). */
async function openExternalChangeset(page: import("@playwright/test").Page): Promise<void> {
  await selectSidebarArtifact(page, "cs_external");
  await page.waitForSelector('[data-artifact-id="cs_external"]', { timeout: 15000 });
  // The banner IS the new surface — never analyze before it exists.
  await page.waitForSelector('[data-testid="external-review-banner"]', { timeout: 15000 });
  await page.evaluate(() =>
    Promise.all(
      document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

/** Open the ⋯ menu and the populated gate BLOCK LOG inside it. */
async function openGateBlockLog(page: import("@playwright/test").Page): Promise<void> {
  const diagBtn = page.getByRole("button", { name: /diagnostics/i });
  await diagBtn.waitFor({ timeout: 15000 });
  // R2 — the trigger carries the attention dot BEFORE the menu is opened,
  // because App's bootstrap hydrated the durable log on page load. That is the
  // cold-path fix, asserted here as a precondition of the scan.
  await page.waitForSelector('[data-testid="diagnostics-attention-dot"]', { timeout: 15000 });
  await diagBtn.click();
  await page.getByRole("button", { name: /show recent gate blocks/i }).click();
  await page.waitForSelector('[data-testid="gate-block-log"]', { timeout: 15000 });
  await page.evaluate(() =>
    Promise.all(
      document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

/** Reject a finding WITH a named concept — the one moment the first-reject
 *  cross-project consent card is offered. */
async function openCrossProjectCard(page: import("@playwright/test").Page, artifactId: string): Promise<void> {
  await selectSidebarArtifact(page, artifactId);
  await page.waitForSelector(`[data-artifact-id="${artifactId}"]`, { timeout: 15000 });
  // B6 — the footer floats as a slim bar until the human reaches the artifact's
  // end; the reason textarea only exists in the expanded panel. On a short
  // artifact the IntersectionObserver expands it on its own within a frame or
  // two, so WAIT for that first and only click the expander if it never comes:
  // racing the click against the auto-expand detaches the compact bar mid-click
  // ("element is not stable" → "element was detached from the DOM").
  const composer = page.getByPlaceholder(/respond to the agent/i);
  try {
    await composer.waitFor({ timeout: 4000 });
  } catch {
    await page
      .getByRole("button", { name: /Respond \/ Request changes \/ Reject/i })
      .first()
      .click({ timeout: 10000 });
    await composer.waitFor({ timeout: 15000 });
  }
  await composer.fill("we don't want config passed around by hand either — this is the wrong cut");
  await page.getByRole("button", { name: /^reject$/i }).click();
  const conceptField = page.getByLabel(/what pattern are you rejecting/i);
  await conceptField.waitFor({ timeout: 15000 });
  await conceptField.fill("global mutable state for config");
  await page.getByRole("button", { name: /reject & remember/i }).click();
  await page.waitForSelector('[data-testid="cross-project-card"]', { timeout: 15000 });
  await page.evaluate(() =>
    Promise.all(
      document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

for (const theme of ["dark", "light"] as const) {
  test(`a11y (R2): the EXTERNAL PR review banner has no serious/critical axe violations — ${theme}`, async ({ page }) => {
    if (theme === "light") await page.addInitScript(() => localStorage.setItem("dp-theme", "light"));
    await page.goto(`${baseURL}/?session=a11yexternal`);
    await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
    if (theme === "light") await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await openExternalChangeset(page);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious, `axe violations (external review banner, ${theme}):\n${fmt(serious)}`).toEqual([]);
  });

  test(`a11y (R2): the populated gate BLOCK LOG has no serious/critical axe violations — ${theme}`, async ({ page }) => {
    if (theme === "light") await page.addInitScript(() => localStorage.setItem("dp-theme", "light"));
    await page.goto(`${baseURL}/?session=a11y`);
    if (theme === "light") await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await openGateBlockLog(page);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious, `axe violations (gate block log, ${theme}):\n${fmt(serious)}`).toEqual([]);
  });

  test(`a11y (R2): the first-reject CROSS-PROJECT consent card has no serious/critical axe violations — ${theme}`, async ({ page }) => {
    if (theme === "light") await page.addInitScript(() => localStorage.setItem("dp-theme", "light"));
    await page.goto(`${baseURL}/?session=a11ycross`);
    await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
    if (theme === "light") await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await openCrossProjectCard(page, `res_cross_${theme}`);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious, `axe violations (cross-project card, ${theme}):\n${fmt(serious)}`).toEqual([]);
  });
}

/**
 * R2 — the COLD-PATH repro, run in a real browser against a real daemon. The
 * unit pins prove the wiring; this proves the whole path: a block that the
 * daemon persisted while no browser was attached is visible, unprompted, on a
 * page the human has just opened.
 */
test("R2: a block persisted server-side is visible on a COLD page load (no menu opened)", async ({ page }) => {
  await page.goto(`${baseURL}/?session=a11y`);
  // The attention dot is the only thing on screen before any interaction —
  // and it is driven by the very data that used to require opening the menu.
  await page.waitForSelector('[data-testid="diagnostics-attention-dot"]', { timeout: 15000 });
  await page.getByRole("button", { name: /diagnostics/i }).click();
  await page.getByRole("button", { name: /show recent gate blocks/i }).click();
  const log = page.getByTestId("gate-block-log");
  await expect(log).toContainText("in-memory session store");
  await expect(log).toContainText("raw SQL in route handlers");
});

/**
 * R2 — the gate log stopped occluding its siblings. Round 13 measured the
 * "hooks" chip at hookCoveredFraction 1.0 (entirely painted over) while the
 * block log was open. Playwright's actionability check is the honest test:
 * click the sibling with the panel open and see whether the click lands.
 */
test("R2: the sibling 'hooks' chip stays clickable while the gate block log is open", async ({ page }) => {
  await page.goto(`${baseURL}/?session=a11y`);
  await page.getByRole("button", { name: /diagnostics/i }).click();
  await page.getByRole("button", { name: /show recent gate blocks/i }).click();
  await page.waitForSelector('[data-testid="gate-block-log"]', { timeout: 15000 });

  const hooks = page.getByRole("button", { name: /hook/i }).first();
  const box = await hooks.boundingBox();
  expect(box, "the hooks chip must have a box while the log is open").not.toBeNull();
  // elementFromPoint at the chip's centre: pre-R2 this returned the block-log
  // panel. Playwright's click() enforces the same rule and would time out.
  const topmostIsSelf = await hooks.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && (el.contains(hit) || hit === el);
  });
  expect(topmostIsSelf, "the block log must not paint over the hooks chip").toBe(true);
  await hooks.click({ timeout: 5000 });
});

test("a11y (#187): the approved-changeset late follow-up composer has no serious/critical axe violations — light", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("dp-theme", "light"));
  await page.goto(`${baseURL}/?session=a11ylate`);
  await page.waitForSelector("[data-artifact-id]", { timeout: 15000 });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await openLateFollowUpComposer(page);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `axe violations (late follow-up composer, light):\n${fmt(serious)}`).toEqual([]);
});
