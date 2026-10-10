import { test, expect } from "./test.js";
import fs from "node:fs/promises";
import { AttentionDaemon, AttentionEvidence, finishWalkthrough, type SeedOperation, type WalkthroughCase } from "./attention-walkthrough-harness.js";

const op = (session: string, route: string, body: unknown): SeedOperation => ({ session, route, body });
const register = (session: string, title: string) => op(session, "register", { title });
const research = (id: string, title: string) => ({
  id, type: "research", title,
  content: { summary: `${title}. Synthetic walkthrough evidence.`, findings: [{ category: "Walkthrough", title, detail: "Synthetic finding, not production work.", significance: "high" }] },
});
const plan = (id: string, title: string) => ({
  id, type: "plan", title,
  content: { summary: "Synthetic four-step plan.", steps: Array.from({ length: 4 }, (_, i) => ({ description: `Synthetic step ${i + 1}`, reasoning: "Walkthrough only", files: [`synthetic/step-${i + 1}.ts`] })) },
});
const explainer = (id: string, title: string) => ({
  id, type: "explainer", title,
  content: { title, overview: "Synthetic overview.", sections: [{ heading: "How it works", body: "Synthetic read-only walkthrough." }] },
});
const options = [
  { id: "opt_a", title: "Redis", description: "Synthetic external cache", pros: ["Fast"], cons: ["Operations"], effort: "low", risk: "low", recommendation: true },
  { id: "opt_b", title: "In-process", description: "Synthetic local cache", pros: ["Simple"], cons: ["Cold starts"], effort: "low", risk: "low", recommendation: false },
];
const decision = (session: string, id: string, title: string): SeedOperation[] => [
  op(session, "artifacts", { id, type: "decision", title, content: { title, context: title, decisionId: `${id}_record`, stakes: "high", stakesReason: "Synthetic irreversible cutover.", options } }),
  op(session, "decisions", { decisionId: `${id}_record`, artifactId: id, context: title, stakes: "high", options }),
];
const question = (session: string, id: string, artifactId: string, content: string) =>
  op(session, "comments", { id, artifactId, author: "human", intent: "question", content });
const hold = (session: string) => op(session, "preflight-block", {
  type: "preflight_blocked", id: "synthetic_hold", source: "session",
  match: { concept: "global mutable state for config", description: "Global singleton config", proposal: "Add a ConfigStore singleton that every module imports", reason: "Prefer explicit dependencies", via: "concept", rejectedAt: "2026-01-01T00:00:00.000Z" },
});

const cacheTitle = "Which store backs the session cache?";
const billingTitle = "Backfill invoices before or after the cutover?";
const rateTitle = "Add per-user API rate limiting";
const queueTitles = Array.from({ length: 13 }, (_, i) => i === 7 ? "Drop the legacy sessions table during the cutover?" : `Queue review ${i + 1}`);
const queueSeed: SeedOperation[] = [register("queue", "Cutover queue")];
for (let i = 0; i < 13; i++) {
  if (i === 7) queueSeed.push(...decision("queue", `queue_${i}`, queueTitles[i]));
  else queueSeed.push(op("queue", "artifacts", i % 3 === 0 ? plan(`queue_${i}`, queueTitles[i]) : research(`queue_${i}`, queueTitles[i])));
}
const exitedSeed = [
  register("rate", "Rate limiting"),
  op("rate", "artifacts", research("rate_approved", "Approved middleware audit")),
  op("rate", "artifacts/rate_approved/status", { status: "approved" }),
  question("rate", "q_upgrade", "rate_approved", "Does this cover websocket upgrades too?"),
  op("rate", "artifacts", plan("rate_plan", rateTitle)),
  op("rate", "artifacts", research("rate_draft", "Retry burst audit")),
  question("rate", "q_burst", "rate_draft", "Is the burst from retries or from real users?"),
];

/** Actual count comes from this explicit manifest, never the legacy report's 44. */
export const SCENARIOS: WalkthroughCase[] = [
  { id: "S1", task: "What needs an answer and what does answering do?", boundSession: "cache", seed: [
    register("cache", "Session cache work"), op("cache", "artifacts", plan("cache_plan", "Add a write-through session cache")),
    ...decision("cache", "cache_decision", cacheTitle), op("cache", "artifacts", research("cache_finding", "Session cache hit rate is 12%")),
    op("cache", "artifacts", explainer("cache_explainer", "How the session cache works")),
  ] },
  { id: "S2", task: "Find the blocker in another live session", boundSession: "auth", seed: [
    register("auth", "Auth refactor"), op("auth", "artifacts", research("auth_a", "Approved auth audit")), op("auth", "artifacts/auth_a/status", { status: "approved" }),
    op("auth", "artifacts", research("auth_b", "Approved auth follow-up")), op("auth", "artifacts/auth_b/status", { status: "approved" }),
    register("billing", "Billing migration"), ...decision("billing", "billing_decision", billingTitle),
    register("docs", "Docs cleanup"), op("docs", "artifacts", explainer("docs_explainer", "How the docs build pipeline works")),
  ] },
  { id: "S3", task: "Find the high-stakes item and clear thirteen reviews", boundSession: "queue", seed: queueSeed },
  { id: "S4-landing", task: "Land on an exited agent with two questions owed", boundSession: "rate", seed: [...exitedSeed, op("rate", "unregister", {})] },
  { id: "S4-exit-transition", task: "Observe exit while the page is open", boundSession: "rate", seed: exitedSeed },
  { id: "S5-empty-arrivals", task: "Known-empty session followed by live arrivals", boundSession: "empty", seed: [register("empty", "New session")] },
  { id: "S5-disconnected", task: "Last-known pending work after an owned daemon exits", boundSession: "cache", seed: [register("cache", "Session cache work"), ...decision("cache", "cache_decision", cacheTitle)] },
  { id: "S5-replay", task: "Historical deep link is read-only, Escape returns live", boundSession: "past", restartAfterSeed: true, seed: [register("past", "Historical cache work"), ...decision("past", "past_decision", cacheTitle), op("past", "unregister", {})] },
  { id: "S5-long-titles", task: "Long titles preserve pinned controls and full accessible names", boundSession: "long", seed: [register("long", "Long titles"),
    ...decision("long", "long_a", "Should the session cache key include ".padEnd(220, "long synthetic wording ")),
    op("long", "artifacts", research("long_finding", "A synthetic cache finding ".padEnd(140, "long wording "))),
    ...decision("long", "long_b", "Second high-stakes cache decision"),
  ] },
  { id: "S5-hold-idle", task: "A persistent hold still explains itself after its toast fades", boundSession: "held", seed: [register("held", "Held config work"), hold("held")] },
  { id: "S5-hold-pending", task: "A hold never covers a pending decision", boundSession: "held", seed: [register("held", "Held config work"), ...decision("held", "held_decision", "Where should config be loaded?"), hold("held")] },
  { id: "S5-empty-bound-sibling", task: "An empty bound session does not hide a sibling blocker", boundSession: "new", seed: [register("new", "New session"), register("billing", "Billing migration"), ...decision("billing", "billing_decision", billingTitle)] },
];

export const MATRIX = SCENARIOS.flatMap((scenario) => (["OFF", "ON"] as const).flatMap((mode) =>
  [{ width: 1280, height: 800 }, { width: 1920, height: 1080 }].map((viewport) => ({ scenario, mode, viewport })),
));
const manifest = MATRIX.map(({ scenario, mode, viewport }) => `${scenario.id}/${mode}/${viewport.width}x${viewport.height}`);

async function hydrated(evidence: AttentionEvidence): Promise<void> {
  await expect.poll(() => evidence.page.evaluate(() => {
    const s = (window as unknown as { __dpConnectionStore?: { getState(): { connected: boolean; hydrated: boolean } } }).__dpConnectionStore?.getState();
    return Boolean(s?.connected && s.hydrated);
  })).toBe(true);
  await expect(evidence.page.getByLabel("Loading artifact view")).toHaveCount(0);
}

async function openPrimary(e: AttentionEvidence): Promise<void> {
  await e.activate(e.row.mode === "ON" ? e.page.getByRole("button", { name: "Open", exact: true }) : e.page.getByRole("button", { name: /Your turn.*click to jump/ }));
}

for (const row of MATRIX) {
  test.describe(`${row.scenario.id} ${row.mode} ${row.viewport.width}x${row.viewport.height}`, () => {
    test.use({ viewport: row.viewport });
    test(row.scenario.task, async ({ page }, info) => {
      const evidence = new AttentionEvidence(page, info, { ...row, manifest });
      let daemon: AttentionDaemon | undefined;
      let failure: unknown;
      let cleanup: "removed" | "retained" = "retained";
      try {
        daemon = await AttentionDaemon.create(info);
        await daemon.seed(row.scenario.seed.filter((seed) => seed.route !== "preflight-block"));
        if (row.scenario.restartAfterSeed) {
          await daemon.restart(info);
          await daemon.post("live", "register", { title: "Live after history" });
        }
        await evidence.observe();
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
        await page.goto(`${daemon.baseURL}/?session=${row.scenario.boundSession}`);
        await hydrated(evidence);
        await evidence.check("preference mode matches the real bar", () => expect(page.getByTestId("next-up-bar")).toHaveCount(row.mode === "ON" ? 1 : 0));

        if (["S2", "S5-empty-bound-sibling"].includes(row.scenario.id)) {
          await evidence.check("sibling blocker is visible with bound-session identity retained", async () => {
            expect(await page.evaluate(() => (window as unknown as { __dpConnectionStore: { getState(): { sessionId: string } } }).__dpConnectionStore.getState().sessionId)).toBe(row.scenario.boundSession);
            await expect(page.getByRole("button", { name: new RegExp(`^${billingTitle.replace(/[?]/g, "\\?")}`) }).first()).toBeVisible({ timeout: 20_000 });
            if (row.mode === "ON") await expect(page.getByTestId("next-up-bar")).toContainText("Billing migration");
          });
        }
        if (row.scenario.id === "S5-replay") {
          await evidence.check("deep link entered the historical read-only frame", () => expect(page.getByText(/Replay mode/)).toBeVisible({ timeout: 20_000 }));
        }
        for (const event of row.scenario.seed.filter((seed) => seed.route === "preflight-block")) await daemon.post(event.session, event.route, event.body);
        if (row.scenario.id.startsWith("S5-hold")) await expect(page.getByRole("alert").filter({ hasText: "Blocked by your taste" })).toBeVisible();
        await evidence.capture("landing");

        switch (row.scenario.id) {
          case "S1":
            if (row.mode === "ON") await evidence.check("primary consequence and one high decision exposed", async () => {
              await expect(page.getByTestId("next-up-bar")).toContainText("4 steps");
              await expect(page.getByRole("button", { name: "+1 high decision", exact: true })).toBeVisible();
            });
            await openPrimary(evidence);
            await evidence.capture("opened-primary");
            break;
          case "S2":
          case "S5-empty-bound-sibling":
            await openPrimary(evidence);
            await evidence.check("keyboard action opened the sibling decision without rebinding the tab", async () => {
              await expect(page.locator('[data-artifact-id="billing_decision"]')).toBeVisible();
              // The selected wrapper appears before the lazy DecisionCard.
              // Capture completed content, not its transient skeleton.
              for (const option of ["Redis", "In-process"]) await expect(page.getByRole("button", { name: `Select ${option}`, exact: true })).toBeVisible();
              expect(await page.evaluate(() => (window as unknown as { __dpConnectionStore: { getState(): { sessionId: string } } }).__dpConnectionStore.getState().sessionId)).toBe(row.scenario.boundSession);
            });
            if (row.mode === "ON") await evidence.activate(page.getByRole("button", { name: "Expand next-up details", exact: true }));
            await evidence.capture("opened-blocker");
            break;
          case "S3": {
            if (row.mode === "ON") {
              await evidence.activate(page.getByRole("button", { name: "+1 high decision", exact: true }));
              await evidence.activate(page.getByRole("button", { name: /Drop the legacy sessions table during the cutover/ }).last());
            } else for (let i = 0; i < 7; i++) await evidence.press("n");
            await evidence.check("high-stakes target opened", () => expect(page.locator('[data-artifact-id="queue_7"]')).toBeVisible());
            await evidence.capture("high-stakes");
            for (let i = 0; i < 13; i++) {
              // Real Tab/Enter only: never locator.click(), focus(), or store writes.
              await evidence.activate(page.getByRole("button", { name: new RegExp(`^${queueTitles[i].replace(/[?]/g, "\\?")} ${i === 7 ? "Decision" : "Draft"}`) }));
              await expect(page.locator(`[data-artifact-id="queue_${i}"]`)).toBeVisible();
              await expect(page.getByLabel("Loading artifact view")).toHaveCount(0);
              await evidence.activate(i === 7 ? page.getByRole("button", { name: "Select Redis", exact: true }) : page.getByRole("button", { name: "Approve", exact: true }));
              await evidence.check(`queue_${i} persisted approved by keyboard`, () => expect.poll(async () => (await daemon!.artifacts("queue")).find((a) => a.id === `queue_${i}`)?.status).toBe("approved"));
            }
            await evidence.check("all thirteen persisted reviews are closed", () => expect.poll(async () => (await daemon!.artifacts("queue")).filter((a) => a.status === "draft").length).toBe(0));
            await evidence.capture("queue-cleared");
            break;
          }
          case "S4-landing":
          case "S4-exit-transition":
            if (row.scenario.id === "S4-exit-transition") {
              await daemon.post("rate", "unregister", {});
            }
            await evidence.check("exited state is exposed", () => expect(row.mode === "ON"
              ? page.getByText(/Agent exited — resume to continue/)
              : page.getByRole("button", { name: "2 questions waiting for Claude", exact: true })
            ).toBeVisible({ timeout: 20_000 }));
            await evidence.activate(page.getByRole("button", { name: "Copy resume prompt", exact: true }));
            await evidence.check("clipboard holds the synthetic two-question resume prompt", async () => {
              await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("2 questions");
            });
            await evidence.capture("resume-copied");
            break;
          case "S5-empty-arrivals":
            await daemon.post("empty", "artifacts", research("arrival_finding", "Session cache hit rate is 12%"));
            for (const seed of decision("empty", "arrival_decision", cacheTitle)) await daemon.post(seed.session, seed.route, seed.body);
            await evidence.check("real arrivals replace known-empty attention", () => expect(page.getByRole("button", { name: /^Session cache hit rate is 12% Draft/ })).toBeVisible());
            await evidence.capture("arrived");
            await openPrimary(evidence);
            break;
          case "S5-disconnected":
            await expect(page.getByRole("button", { name: "Select Redis", exact: true })).toBeVisible();
            await daemon.stop(info);
            await evidence.check("owned daemon exit disables decision actions", async () => {
              await expect(page.getByRole("button", { name: "Select Redis", exact: true })).toBeDisabled();
              if (row.mode === "ON") await expect(page.getByTestId("next-up-bar")).toContainText("DISCONNECTED");
              await expect.poll(() => page.evaluate(() => {
                const s = (window as unknown as { __dpConnectionStore: { getState(): { disconnectedSince: number | null } } }).__dpConnectionStore.getState();
                return s.disconnectedSince == null ? 0 : Date.now() - s.disconnectedSince;
              }), { timeout: 10_000 }).toBeGreaterThanOrEqual(5000);
            });
            await evidence.capture("disconnected");
            break;
          case "S5-replay":
            await evidence.check("historical decision is visible but its choice actions are read-only", async () => {
              await expect(page.locator('[data-artifact-id="past_decision"]')).toBeVisible();
              for (const option of ["Redis", "In-process"]) await expect(page.getByRole("button", { name: `Select ${option}`, exact: true })).toBeDisabled();
            });
            await evidence.capture("read-only-replay");
            await evidence.press("Escape");
            await evidence.check("Escape returns to the hydrated live binding without historical residue", async () => {
              await expect(page.getByText(/Replay mode/)).toHaveCount(0, { timeout: 20_000 });
              await hydrated(evidence);
              expect(await page.evaluate(() => (window as unknown as { __dpConnectionStore: { getState(): { sessionId: string } } }).__dpConnectionStore.getState().sessionId)).toBe("live");
              await expect(page.locator('[data-artifact-id="past_decision"]')).toHaveCount(0);
              await expect(page.getByRole("button", { name: "Select Redis", exact: true })).toHaveCount(0);
            });
            await evidence.capture("replay-exited");
            break;
          case "S5-long-titles":
            if (row.mode === "ON") await evidence.check("all pinned bar controls fit the viewport", async () => {
              expect(await page.getByTestId("next-up-bar").ariaSnapshot()).toContain(String((row.scenario.seed[1].body as { title: string }).title));
              // Primary is itself HIGH; this count names the one additional
              // high decision, not all high decisions including the primary.
              for (const control of [page.getByRole("button", { name: "Open", exact: true }), page.getByRole("button", { name: "+1 high decision", exact: true }), page.getByRole("button", { name: "Expand next-up details", exact: true })]) {
                await expect(control).toBeVisible();
                const rect = await control.boundingBox();
                expect(rect).not.toBeNull();
                expect(rect!.x).toBeGreaterThanOrEqual(0);
                expect(rect!.x + rect!.width).toBeLessThanOrEqual(row.viewport.width);
              }
            });
            await openPrimary(evidence);
            await evidence.capture("long-title-opened");
            break;
          case "S5-hold-idle":
          case "S5-hold-pending":
            await expect(page.getByRole("alert").filter({ hasText: "Blocked by your taste" })).toHaveCount(0, { timeout: 20_000 });
            if (row.mode === "ON") {
              await evidence.check("hold remains visible without covering pending work", async () => {
                await expect(page.getByTestId("next-up-bar")).toContainText(row.scenario.id === "S5-hold-idle" ? "global mutable state for config" : "Where should config be loaded?");
              });
              await evidence.activate(page.getByRole("button", { name: row.scenario.id === "S5-hold-idle" ? "Why" : "Expand next-up details", exact: true }));
            } else {
              await evidence.activate(page.getByRole("button", { name: /Diagnostics/ }));
              await evidence.activate(page.getByRole("button", { name: /Show recent gate blocks/ }));
            }
            await evidence.capture("persistent-hold");
            break;
        }
      } catch (error) {
        failure = error;
        await evidence.capture("failure").catch(() => undefined);
      } finally {
        try { if (daemon) { await daemon.close(info); cleanup = "removed"; } }
        catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], "Walkthrough failed and owned cleanup was not confirmed"); }
        await finishWalkthrough(failure, () => evidence.save(failure === undefined ? "passed" : "failed", cleanup, failure, daemon?.seedJournal, daemon?.runtimes));
      }
    });
  });
}

// Infrastructure guard, not a scenario row: real owned child, no mocks.
test("HARNESS fault: failed diagnostic attachments cannot skip cleanup or replace setup cause", async ({}, info) => {
  const original = new Error("synthetic causal setup failure");
  let ownedRoot = "";
  let failedAttachments = 0;
  let caught: unknown;
  try {
    await AttentionDaemon.create(info, {
      diagnostics: async () => { failedAttachments++; throw new Error("synthetic output full/unwritable"); },
      readyCheck: async (daemon) => { ownedRoot = daemon.root; throw original; },
    });
  } catch (error) { caught = error; }
  expect(caught).toBe(original);
  expect(failedAttachments).toBeGreaterThanOrEqual(2); // create catch AND stop.
  expect(ownedRoot).not.toBe("");
  await expect(fs.access(ownedRoot)).rejects.toMatchObject({ code: "ENOENT" });
});

test("HARNESS fault: evidence publication cannot mask a primary row failure or silently pass", async () => {
  const primary = new Error("synthetic causal row assertion");
  const secondary = new Error("synthetic evidence output full/unwritable");
  let caught: unknown;
  try { await finishWalkthrough(primary, async () => { throw secondary; }); }
  catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(AggregateError);
  expect((caught as AggregateError).errors).toEqual([primary, secondary]);
  await expect(finishWalkthrough(undefined, async () => { throw secondary; })).rejects.toBe(secondary);
  await expect(finishWalkthrough(primary, async () => undefined)).rejects.toBe(primary);
  await expect(finishWalkthrough(undefined, async () => undefined)).resolves.toBeUndefined();
});
