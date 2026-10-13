import { test, expect } from "./test.js";
import AxeBuilder from "@axe-core/playwright";
import type { Locator } from "@playwright/test";
import { AttentionDaemon, AttentionEvidence, finishWalkthrough, type WalkthroughCase } from "./attention-walkthrough-harness.js";

test.use({ viewport: { width: 1280, height: 800 } });

const scenario: WalkthroughCase = {
  id: "keyboard-probe", task: "Next-up queue keyboard contract", boundSession: "probe",
  seed: [{ session: "probe", route: "register", body: { title: "Synthetic focus probe" } },
    ...["one", "two", "three"].map((id) => ({ session: "probe", route: "artifacts", body: {
      id, type: "research", title: `Synthetic review ${id}`,
      content: { summary: "Synthetic keyboard-only evidence", findings: [{ category: "Probe", detail: "No production data", significance: "high" }] },
    } })),
  ],
};

async function tabTo(e: AttentionEvidence, target: Locator): Promise<void> {
  await expect(target).toBeVisible();
  for (let i = 0; i < 120; i++) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await e.press("Tab");
  }
  throw new Error("Queue control was not reachable through keyboard Tab");
}

for (const theme of ["dark", "light"] as const) {
  test(`queue keyboard contract ${theme}`, async ({ page }, info) => {
    const e = new AttentionEvidence(page, info, { scenario, mode: "ON", viewport: { width: 1280, height: 800 }, manifest: [theme] });
    let daemon: AttentionDaemon | undefined;
    let failure: unknown;
    let cleanup: "removed" | "retained" = "retained";
    try {
      daemon = await AttentionDaemon.create(info);
      await daemon.seed(scenario.seed);
      await e.observe(theme);
      await page.goto(`${daemon.baseURL}/?session=probe`);
      await expect(page.getByTestId("next-up-bar")).toContainText("Synthetic review one");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByLabel("Loading artifact view")).toHaveCount(0);
      await e.press("Tab");
      await e.check("skip link is the first keyboard stop", () => expect(page.getByRole("link", { name: "Jump to next up", exact: true })).toBeFocused());
      await e.press("Enter");
      await e.check("skip link focuses named bar", () => expect(page.getByRole("region", { name: "Next up", exact: true })).toBeFocused());
      await e.activate(page.getByRole("button", { name: "Expand next-up details", exact: true }));
      await e.capture("expanded");
      const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      await e.check("expanded queue passes automated accessibility gate", async () => expect(axe.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) }))).toEqual([]));
      await e.activate(page.locator("#next-up-details").getByRole("button", { name: "Synthetic review one", exact: true }));
      await e.press("ArrowDown");
      await e.capture("after-arrow-down");
      await e.check("ArrowDown advances inside queue", () => expect(page.locator("#next-up-details").getByRole("button", { name: "Synthetic review two", exact: true })).toBeFocused());
      await e.check("navigation did not select the next review", () => expect(page.locator('[data-artifact-id="one"]')).toBeVisible());
      await e.press("End");
      await e.check("End reaches the last queue button", () => expect(page.locator("#next-up-details").getByRole("button", { name: "Synthetic review three", exact: true })).toBeFocused());
      await e.press("ArrowDown");
      await e.check("ArrowDown stops at the last queue button", () => expect(page.locator("#next-up-details").getByRole("button", { name: "Synthetic review three", exact: true })).toBeFocused());
      await e.press("Home");
      await e.press("ArrowUp");
      await e.check("Home and ArrowUp stop at the first queue button", () => expect(page.locator("#next-up-details").getByRole("button", { name: "Synthetic review one", exact: true })).toBeFocused());
      await e.press("Control+ArrowDown");
      await e.check("modified arrows preserve browser ownership", () => expect(page.locator("#next-up-details").getByRole("button", { name: "Synthetic review one", exact: true })).toBeFocused());
      await e.press("Tab");
      await e.check("ordinary Tab remains native", () => expect(page.locator("#next-up-details").getByRole("button", { name: "Synthetic review two", exact: true })).toBeFocused());
      await e.press("Escape");
      await e.capture("after-escape");
      await e.check("Escape closes queue", () => expect(page.locator("#next-up-details")).toHaveCount(0));
      await e.check("Escape returns focus to disclosure", () => expect(page.getByRole("button", { name: "Expand next-up details", exact: true })).toBeFocused());
      await e.press("Control+k");
      const search = page.getByPlaceholder("Search artifacts, actions...");
      await expect(search).toBeFocused();
      await page.keyboard.type("Open review queue");
      await e.press("Enter");
      await expect(page.locator("#next-up-details")).toBeVisible();
      // The palette's own modal teardown may restore its prior disclosure
      // after the explicit event focuses the section. Both are local targets.
      await expect.poll(() => page.getByRole("region", { name: "Next up", exact: true }).evaluate((section) => section.contains(document.activeElement))).toBe(true);
      await e.press("Escape");
      await e.check("removed palette opener uses stable disclosure fallback", () => expect(page.getByRole("button", { name: "Expand next-up details", exact: true })).toBeFocused());
    } catch (error) { failure = error; await e.capture("failure").catch(() => undefined); }
    finally {
      if (daemon) { try { await daemon.close(info); cleanup = "removed"; } catch (error) { failure ??= error; } }
      await finishWalkthrough(failure, () => e.save(failure ? "failed" : "passed", cleanup, failure, daemon?.seedJournal, daemon?.runtimes));
    }
  });
}

test("live changes and disappearing queue focus", async ({ page }, info) => {
  const e = new AttentionEvidence(page, info, { scenario, mode: "ON", viewport: { width: 1280, height: 800 }, manifest: ["live-focus"] });
  let daemon: AttentionDaemon | undefined;
  let failure: unknown;
  let cleanup: "removed" | "retained" = "retained";
  try {
    daemon = await AttentionDaemon.create(info);
    await daemon.seed(scenario.seed);
    await e.observe();
    await page.goto(`${daemon.baseURL}/?session=probe`);
    await expect(page.getByTestId("next-up-bar")).toContainText("Synthetic review one");
    await expect(page.getByLabel("Loading artifact view")).toHaveCount(0);
    await e.activate(page.getByRole("button", { name: "Expand next-up details", exact: true }));
    const before = await page.evaluate(() => ({ selected: [...document.querySelectorAll('[data-artifact-id]')].map((p) => p.getAttribute("data-artifact-id")), scroll: [...document.querySelectorAll('[data-dp-pane]')].map((p) => p.scrollTop) }));
    await daemon.post("probe", "artifacts", { id: "four", type: "research", title: "Synthetic review four", content: { summary: "Synthetic arrival", findings: [] } });
    await expect(page.locator("#next-up-details").getByRole("button", { name: "Synthetic review four", exact: true })).toBeVisible();
    await e.check("new arrival preserves disclosure focus", () => expect(page.getByRole("button", { name: "Collapse next-up details", exact: true })).toBeFocused());
    await daemon.post("probe", "artifacts/one/status", { status: "approved" });
    await expect(page.getByTestId("next-up-bar")).toContainText("Synthetic review two");
    await e.check("next change preserves disclosure focus", () => expect(page.getByRole("button", { name: "Collapse next-up details", exact: true })).toBeFocused());
    await e.check("next change preserves selected artifact and scroll", async () => expect(await page.evaluate(() => ({ selected: [...document.querySelectorAll('[data-artifact-id]')].map((p) => p.getAttribute("data-artifact-id")), scroll: [...document.querySelectorAll('[data-dp-pane]')].map((p) => p.scrollTop) }))).toEqual(before));
    await e.check("snapshot-backfilled next transition stays silent", () => expect(page.getByTestId("next-up-announcer")).toHaveText(""));
    await e.activate(page.locator("#next-up-details").getByRole("button", { name: "Synthetic review two", exact: true }));
    await expect(page.locator('[data-artifact-id="two"]')).toBeVisible();
    await daemon.post("probe", "artifacts/two/status", { status: "obsolete" });
    await expect(page.locator("#next-up-details").getByRole("button", { name: "Synthetic review two", exact: true })).toHaveCount(0);
    await e.capture("after-focused-queue-removal");
    await e.check("removed focused queue item recovers to disclosure", () => expect(page.getByRole("button", { name: "Collapse next-up details", exact: true })).toBeFocused());
    await e.press("Tab");
    await e.capture("after-focused-queue-removal-and-tab");
    await e.activate(page.locator("#next-up-details").getByRole("button", { name: "Synthetic review three", exact: true }));
    await expect(page.locator('[data-artifact-id="three"]')).toBeVisible();
    await expect(page.getByLabel("Loading artifact view")).toHaveCount(0);
    await e.activate(page.getByRole("button", { name: "Approve", exact: true }));
    await e.check("keyboard review action persists approval", () => expect.poll(async () => (await daemon!.artifacts("probe")).find((artifact) => artifact.id === "three")?.status).toBe("approved"));
    await e.check("existing card approval focus recovery remains local", async () => expect(await page.evaluate(() => document.activeElement?.closest("[data-artifact-id]")?.getAttribute("data-artifact-id"))).toBe("three"));
    await e.check("one polite fresh next-item potential announcement", async () => {
      await expect(page.getByTestId("next-up-announcer")).toHaveText("Next up: review — Synthetic review four");
      const count = await page.evaluate(() => (window as unknown as { __attentionEvidence: { entries: Array<{ text: string }> } }).__attentionEvidence.entries.filter((entry) => entry.text === "Next up: review — Synthetic review four").length);
      expect(count).toBe(1);
    });
  } catch (error) { failure = error; await e.capture("failure").catch(() => undefined); }
  finally {
    if (daemon) { try { await daemon.close(info); cleanup = "removed"; } catch (error) { failure ??= error; } }
    await finishWalkthrough(failure, () => e.save(failure ? "failed" : "passed", cleanup, failure, daemon?.seedJournal, daemon?.runtimes));
  }
});

const op = (route: string, body: unknown) => ({ session: "probe", route, body });
const finding = (id: string, title: string) => op("artifacts", { id, type: "research", title, content: { summary: "Synthetic gate fixture", findings: [{ category: "Probe", detail: "No production data", significance: "high" }] } });
const decision = (id: string, title: string) => op("artifacts", { id, type: "decision", title, content: { context: "Synthetic choice context", decisionId: id, stakes: "high", options: [
  { id: "a", title: "First synthetic option", description: "Synthetic", pros: ["Simple"], cons: ["Limited"], effort: "low", risk: "low" },
  { id: "b", title: "Second synthetic option", description: "Synthetic", pros: ["Flexible"], cons: ["Complex"], effort: "low", risk: "low" },
] } });
const waiting = [finding("answered", "Previously reviewed finding"), op("artifacts/answered/status", { status: "approved" }), op("comments", { id: "question", artifactId: "answered", author: "human", intent: "question", content: "Synthetic question waiting for Claude?" })];
const hold = op("preflight-block", { type: "preflight_blocked", id: "synthetic_keyboard_hold", source: "session", match: { concept: "global mutable state", description: "Synthetic hold", proposal: "Synthetic singleton", reason: "Prefer dependencies", via: "concept", rejectedAt: "2026-01-01T00:00:00.000Z" } });
const barStates = [
  { id: "A-high", expected: "DECIDE", seed: [decision("high", "Synthetic urgent choice"), decision("second_high", "Another high choice")] },
  { id: "B-review", expected: "REVIEW", seed: [finding("review", "Synthetic review oldest"), decision("high", "Synthetic urgent choice")] },
  { id: "C-info", expected: "Nothing needs you", seed: [op("artifacts", { id: "info", type: "explainer", title: "Synthetic informational artifact", content: { title: "Synthetic informational artifact", overview: "Synthetic overview", sections: [{ heading: "Read", body: "Synthetic information" }] } })] },
  { id: "D-waiting", expected: "WAITING ON CLAUDE", seed: waiting },
  { id: "E-exited", expected: "Exited with 1 of your question open", seed: [...waiting, op("unregister", {})] },
  { id: "F-held", expected: "HELD", seed: [hold] },
  { id: "G-disconnected", expected: "DISCONNECTED", seed: [finding("review", "Synthetic last-known review")] },
  { id: "empty", expected: "Nothing needs you", seed: [] },
  { id: "replay", expected: "REPLAY", seed: [...waiting, op("unregister", {})] },
];

for (const theme of ["dark", "light"] as const) for (const state of barStates) {
  test(`bar accessibility ${state.id} ${theme}`, async ({ page }, info) => {
    const recipe: WalkthroughCase = { id: state.id, task: "Automated accessibility gate, not screen-reader speech", boundSession: "probe", seed: [op("register", { title: "Synthetic accessibility state" }), ...state.seed] };
    const e = new AttentionEvidence(page, info, { scenario: recipe, mode: "ON", viewport: { width: 1280, height: 800 }, manifest: barStates.map((s) => `${s.id}/${theme}`) });
    let daemon: AttentionDaemon | undefined;
    let failure: unknown;
    let cleanup: "removed" | "retained" = "retained";
    try {
      daemon = await AttentionDaemon.create(info);
      await daemon.seed(recipe.seed.filter((seed) => seed.route !== "preflight-block"));
      if (state.id === "replay") { await daemon.restart(info); await daemon.post("live", "register", { title: "Synthetic live binding" }); }
      await e.observe(theme);
      await page.goto(`${daemon.baseURL}/?session=probe`);
      await expect.poll(() => page.evaluate(() => {
        const state = (window as unknown as { __dpConnectionStore: { getState(): { connected: boolean; hydrated: boolean } } }).__dpConnectionStore.getState();
        return state.connected && state.hydrated;
      })).toBe(true);
      await expect(page.getByLabel("Loading artifact view")).toHaveCount(0);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      for (const seed of recipe.seed.filter((s) => s.route === "preflight-block")) await daemon.post(seed.session, seed.route, seed.body);
      if (state.id === "G-disconnected") await daemon.stop(info);
      await expect(page.getByTestId("next-up-bar")).toContainText(state.expected, { timeout: 20_000 });
      for (const expanded of [false, true]) {
        if (expanded) await e.activate(page.getByRole("button", { name: "Expand next-up details", exact: true }));
        const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
        await e.check(`${expanded ? "expanded" : "collapsed"} full-page axe gate`, async () => expect(axe.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) }))).toEqual([]));
      }
      await e.capture(`${state.id}-${theme}-expanded`);
      if (state.id === "A-high") {
        await e.activate(page.getByRole("button", { name: "Collapse next-up details", exact: true }));
        const high = page.getByRole("button", { name: "+1 high decision", exact: true });
        await e.activate(high);
        await tabTo(e, page.locator("#next-up-details").getByRole("button", { name: "Another high choice", exact: true }));
        await e.press("Escape");
        await e.check("Escape returns to high-decision opener", () => expect(high).toBeFocused());
      }
      if (state.id === "F-held") {
        await e.activate(page.getByRole("button", { name: "Collapse next-up details", exact: true }));
        await e.activate(page.getByRole("button", { name: "Why", exact: true }));
        await expect(page.getByRole("button", { name: "Why", exact: true })).toHaveCount(0);
        await e.check("keyboard Why removal immediately recovers to disclosure", () => expect(page.getByRole("button", { name: "Collapse next-up details", exact: true })).toBeFocused());
        await e.capture("why-opener-recovered");
        // No intervening Tab or scripted focus: the very next keyboard action
        // must close the disclosure instead of falling through to App.
        await e.press("Escape");
        await e.check("removed Why opener uses stable disclosure fallback", () => expect(page.getByRole("button", { name: "Expand next-up details", exact: true })).toBeFocused());
        await e.check("immediate Escape closes the held expansion", () => expect(page.locator("#next-up-details")).toHaveCount(0));
      }
      if (state.id === "replay") {
        await e.press("Escape");
        await e.check("first local Escape preserves replay", () => expect(page.getByTestId("next-up-bar")).toContainText("REPLAY"));
        await e.press("Escape");
        await e.check("second global Escape exits replay", () => expect(page.getByText(/Replay mode/)).toHaveCount(0));
      }
    } catch (error) { failure = error; await e.capture("failure").catch(() => undefined); }
    finally {
      if (daemon) { try { await daemon.close(info); cleanup = "removed"; } catch (error) { failure ??= error; } }
      await finishWalkthrough(failure, () => e.save(failure ? "failed" : "passed", cleanup, failure, daemon?.seedJournal, daemon?.runtimes));
    }
  });
}
