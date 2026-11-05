import { test, expect } from "./test.js";
import type { Locator } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { AttentionDaemon, AttentionEvidence, finishWalkthrough, type SeedOperation, type WalkthroughCase } from "./attention-walkthrough-harness.js";

/**
 * #430 slice 2 — the before/after gaps the 48-row matrix doesn't cover.
 *
 * OBSERVATIONAL ON PURPOSE. The same recipe has to run on the baseline and on the
 * D1/D2 head, so nothing here asserts who leads, where a filter lives or whether
 * `Why` exists. The checks only prove the seed arrived and the row reached the
 * state it measures. Judging the recorded numbers is the reader's job.
 *
 * Terminal asks are seeded through the REAL watcher path: a fire is written to
 * the sandbox's .deeppairing/hooks-state.json (what the PreToolUse hook does) and
 * the daemon turns it into a durable entry. The internal preflight-block route is
 * unusable for this: `blockEntryFromEvent` keeps no lane/decision, so a tab would
 * see a terminal ask live and a plain block after any reload or late hydrate.
 */

const HOOK_FIRE = "hook-gate-fire";
const HOOK_LIMITATION = "Terminal asks are a test-written hooks-state fire through the real daemon watcher, unattributed to a session (no Claude session id); no real hook, Claude Code prompt or terminal was involved.";

const op = (session: string, route: string, body: unknown): SeedOperation => ({ session, route, body });
const register = (session: string, title: string) => op(session, "register", { title });
const research = (id: string, title: string) => ({
  id, type: "research", title,
  content: { summary: `${title}. Synthetic evidence row.`, findings: [{ category: "Evidence", title, detail: "Synthetic finding, not production work.", significance: "high" }] },
});
const plan = (id: string, title: string) => ({
  id, type: "plan", title,
  content: { summary: "Synthetic plan.", steps: Array.from({ length: 4 }, (_, i) => ({ description: `Synthetic step ${i + 1}`, reasoning: "Evidence only", files: [`synthetic/step-${i + 1}.ts`] })) },
});
const options = [
  { id: "opt_a", title: "Redis", description: "Synthetic external cache", pros: ["Fast"], cons: ["Operations"], effort: "low", risk: "low", recommendation: true },
  { id: "opt_b", title: "In-process", description: "Synthetic local cache", pros: ["Simple"], cons: ["Cold starts"], effort: "low", risk: "low", recommendation: false },
];
const decision = (session: string, id: string, title: string): SeedOperation[] => [
  op(session, "artifacts", { id, type: "decision", title, content: { title, context: title, decisionId: `${id}_record`, stakes: "high", stakesReason: "Synthetic irreversible cutover.", options } }),
  op(session, "decisions", { decisionId: `${id}_record`, artifactId: id, context: title, stakes: "high", options }),
];
/** The shape recordHookFire writes, minus `at` so the recipe and seed digests
 * stay comparable across runs (`at` is stamped when the fire is written). */
const terminalAsk = (id: string) => op("hook", HOOK_FIRE, {
  id, hook: "preflight", kind: "ask", reason: "session",
  gate: { decision: "ask", source: "session", via: "concept", concept: "global mutable state for config", description: "Global singleton config", reason: "Prefer explicit dependencies", tool: "Write", target: "synthetic/config-store.ts" },
});

const queueSeed: SeedOperation[] = [register("queue", "Cutover queue")];
for (let i = 0; i < 13; i++) {
  const title = `Queue item ${i + 1}`;
  if (i === 7 || i === 10) queueSeed.push(...decision("queue", `queue_${i}`, `High-stakes ${title}`));
  else queueSeed.push(op("queue", "artifacts", i % 3 === 0 ? plan(`queue_${i}`, title) : research(`queue_${i}`, title)));
}

/** `rows` is what the sidebar must list before measuring: proof the seed landed. */
const SCENARIOS: Array<WalkthroughCase & { rows: number }> = [
  { id: "E1-ask-zero-drafts", task: "Terminal ask with zero drafts", boundSession: "ask", rows: 1, seed: [
    register("ask", "Config work"), op("ask", "artifacts", research("ask_done", "Approved config audit")), op("ask", "artifacts/ask_done/status", { status: "approved" }),
    terminalAsk("hf_evidence_zero"),
  ] },
  { id: "E2-ask-newer-decision", task: "Terminal ask with a newer decision", boundSession: "ask", rows: 1, seed: [
    register("ask", "Config work"), terminalAsk("hf_evidence_newer"), ...decision("ask", "ask_decision", "Where should config be loaded?"),
  ] },
  { id: "E3-ask-selected-draft", task: "Terminal ask with the sole draft selected", boundSession: "ask", rows: 1, seed: [
    register("ask", "Config work"), op("ask", "artifacts", research("ask_draft", "Config loading audit")), terminalAsk("hf_evidence_selected"),
  ] },
  { id: "E4-three-sessions-filter", task: "Three sessions with the filter used", boundSession: "alpha", rows: 5, seed: [
    register("alpha", "Auth refactor"), op("alpha", "artifacts", plan("alpha_plan", "Auth refactor plan")), op("alpha", "artifacts", research("alpha_audit", "Auth audit")),
    register("beta", "Billing migration"), ...decision("beta", "beta_decision", "Backfill invoices before or after the cutover?"),
    register("gamma", "Docs cleanup"), op("gamma", "artifacts", research("gamma_audit", "Docs audit")), op("gamma", "artifacts", plan("gamma_plan", "Docs plan")),
  ] },
  { id: "E5-queue-two-high", task: "Thirteen-item queue with two high decisions", boundSession: "queue", rows: 13, seed: queueSeed },
];

const MATRIX = SCENARIOS.flatMap((scenario) => (["OFF", "ON"] as const).flatMap((mode) =>
  [{ width: 1280, height: 800 }, { width: 1920, height: 1080 }].map((viewport) => ({ scenario, mode, viewport })),
));
const manifest = MATRIX.map(({ scenario, mode, viewport }) => `${scenario.id}/${mode}/${viewport.width}x${viewport.height}`);

async function writeHookFire(daemon: AttentionDaemon, fire: { id: string }): Promise<void> {
  const dir = path.join(daemon.project, ".deeppairing");
  const file = path.join(dir, "hooks-state.json");
  const temp = `${file}.evidence-tmp`;
  await fs.writeFile(temp, JSON.stringify({ version: 1, fires: [{ ...fire, at: new Date().toISOString() }] }));
  await fs.rename(temp, file);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const log = await fs.readFile(path.join(dir, "preflight-blocks.json"), "utf8").catch(() => "");
    if (log.includes(`"blk_${fire.id}"`)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Daemon watcher did not record the synthetic terminal ask within 10s");
}

async function seedRow(daemon: AttentionDaemon, seed: SeedOperation[]): Promise<void> {
  for (const operation of seed) {
    if (operation.route !== HOOK_FIRE) { await daemon.post(operation.session, operation.route, operation.body); continue; }
    await writeHookFire(daemon, operation.body as { id: string });
    daemon.seedJournal.push(operation);
  }
}

async function tabTo(e: AttentionEvidence, target: Locator): Promise<void> {
  await expect(target).toBeVisible();
  for (let i = 0; i < 120; i++) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await e.press("Tab");
  }
  throw new Error("Control was not reachable through keyboard Tab");
}

async function detailReady(e: AttentionEvidence): Promise<void> {
  await expect(e.page.getByLabel("Loading artifact view")).toHaveCount(0);
}

async function openFirstRow(e: AttentionEvidence): Promise<void> {
  const first = e.page.locator("nav[aria-label='Artifacts'] [data-artifact-item]").first();
  const id = await first.getAttribute("data-artifact-item");
  await e.activate(first);
  await expect(e.page.locator(`[data-artifact-id="${id}"]`)).toBeVisible();
  await detailReady(e);
}

/** The filter's home is what D1 changes, so the recipe follows whichever exists:
 * the same user action on both sides of the comparison. */
async function useSessionFilter(e: AttentionEvidence, rows: number): Promise<void> {
  const menu = e.page.getByTestId("agents-filter-menu");
  if (await menu.count()) {
    await tabTo(e, menu);
    await menu.selectOption({ index: 2 }); // All, Agent 1, Agent 2.
  } else {
    await e.activate(e.page.getByRole("button", { name: /^Agent 2 \(/ }));
  }
  await e.check("the filter narrowed the sidebar", () => expect.poll(() => e.page.locator("nav[aria-label='Artifacts'] [data-artifact-item]").count()).toBeLessThan(rows));
}

for (const row of MATRIX) {
  test.describe(`${row.scenario.id} ${row.mode} ${row.viewport.width}x${row.viewport.height}`, () => {
    test.use({ viewport: row.viewport });
    test(row.scenario.task, async ({ page }, info) => {
      const limitations = row.scenario.seed.some((seed) => seed.route === HOOK_FIRE) ? [HOOK_LIMITATION] : [];
      const evidence = new AttentionEvidence(page, info, { ...row, manifest, limitations });
      let daemon: AttentionDaemon | undefined;
      let failure: unknown;
      let cleanup: "removed" | "retained" = "retained";
      try {
        daemon = await AttentionDaemon.create(info);
        await seedRow(daemon, row.scenario.seed);
        await evidence.observe();
        // The held lead hydrates from this read, so a landing measured before it
        // finishes would report a missing ask that isn't missing.
        await Promise.all([
          page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/api/preflight-blocks") && response.ok()),
          page.goto(`${daemon.baseURL}/?session=${row.scenario.boundSession}`),
        ]);
        await expect.poll(() => page.evaluate(() => {
          const s = (window as unknown as { __dpConnectionStore?: { getState(): { connected: boolean; hydrated: boolean } } }).__dpConnectionStore?.getState();
          return Boolean(s?.connected && s.hydrated);
        })).toBe(true);
        await detailReady(evidence);
        await evidence.check("preference mode matches the real bar", () => expect(page.getByTestId("next-up-bar")).toHaveCount(row.mode === "ON" ? 1 : 0));
        await evidence.check("every seeded artifact reached the sidebar", () => expect(page.locator("nav[aria-label='Artifacts'] [data-artifact-item]")).toHaveCount(row.scenario.rows, { timeout: 20_000 }));
        await evidence.measure("landing");
        await evidence.capture("landing");

        if (row.scenario.id === "E5-queue-two-high") {
          await evidence.press("n");
          await detailReady(evidence);
          await evidence.measure("after-n");
          await evidence.capture("after-n");
        } else {
          if (row.scenario.id === "E4-three-sessions-filter") {
            await useSessionFilter(evidence, row.scenario.rows);
            await evidence.measure("filtered");
            await evidence.capture("filtered");
          }
          await openFirstRow(evidence);
          await evidence.measure("detail-open");
          await evidence.capture("detail-open");
        }
      } catch (error) {
        failure = error;
        await evidence.capture("failure").catch(() => undefined);
      } finally {
        try { if (daemon) { await daemon.close(info); cleanup = "removed"; } }
        catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], "Evidence row failed and owned cleanup was not confirmed"); }
        await finishWalkthrough(failure, () => evidence.save(failure === undefined ? "passed" : "failed", cleanup, failure, daemon?.seedJournal, daemon?.runtimes));
      }
    });
  });
}
