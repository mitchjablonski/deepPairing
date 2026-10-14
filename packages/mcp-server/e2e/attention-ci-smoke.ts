import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type Locator, type TestInfo } from "./test.js";
import { AttentionDaemon } from "./attention-walkthrough-harness.js";
import { attachDiagnosticFile, redactDiagnostic } from "./diagnostics.js";

export const SMOKE_TAGS = ["@attention-smoke", "@queue-arrows", "@why-immediate-escape", "@removed-focus", "@dark-light-axe"];
export const SMOKE_USE = {
  viewport: { width: 1280, height: 800 }, contextOptions: { reducedMotion: "reduce" as const },
  trace: "off" as const, video: "off" as const, screenshot: "only-on-failure" as const,
};
export const SMOKE_TIMEOUT_MS = 60_000;

async function activate(page: Page, target: Locator): Promise<void> {
  await expect(target).toBeVisible();
  await expect(target).toBeEnabled();
  for (let stops = 0; stops < 80; stops++) {
    if (await target.evaluate((element) => element === document.activeElement)) {
      await page.keyboard.press("Enter");
      return;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error("Smoke control was not reachable through keyboard Tab");
}

async function smokeJourney(page: Page, daemon: AttentionDaemon): Promise<void> {
  const queue = page.locator("#next-up-details");
  const first = queue.getByRole("button", { name: "Synthetic review one", exact: true });
  const second = queue.getByRole("button", { name: "Synthetic review two", exact: true });
  await activate(page, page.getByRole("button", { name: "Expand next-up details", exact: true }));
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(result.violations.map((violation) => ({ id: violation.id, targets: violation.nodes.map((node) => node.target) }))).toEqual([]);
  await activate(page, first);
  await page.keyboard.press("ArrowDown");
  await expect(second).toBeFocused();
  await expect(page.locator('[data-artifact-id="one"]')).toBeVisible();
  await page.keyboard.press("ArrowUp");
  await expect(first).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await daemon.post("smoke", "artifacts/two/status", { status: "obsolete" });
  await expect(second).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Collapse next-up details", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(queue).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Expand next-up details", exact: true })).toBeFocused();

  // Remove the last review, then deliver a real hold through the daemon.
  await daemon.post("smoke", "artifacts/one/status", { status: "obsolete" });
  await daemon.post("smoke", "preflight-block", {
    type: "preflight_blocked", id: "synthetic_ci_hold", source: "session",
    match: { concept: "global mutable state", description: "Synthetic hold", proposal: "Synthetic singleton", reason: "Prefer dependencies", via: "concept", rejectedAt: "2026-01-01T00:00:00.000Z" },
  });
  await expect(page.getByTestId("next-up-bar")).toContainText("HELD");
  await activate(page, page.getByRole("button", { name: "Why", exact: true }));
  // No intervening Tab or script focus can hide the disappearing opener.
  await expect(page.getByRole("button", { name: "Why", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Collapse next-up details", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(queue).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Expand next-up details", exact: true })).toBeFocused();

}

/** Reuses real owned-daemon startup/exit/TCP-refusal barriers. No pass artifacts. */
export async function runAttentionSmoke(page: Page, info: TestInfo, theme: "dark" | "light",
  journey: (page: Page, daemon: AttentionDaemon) => Promise<void> = smokeJourney): Promise<void> {
  const started = performance.now();
  let daemon: AttentionDaemon | undefined;
  let failed = false;
  let failure: unknown;
  let cleanup = "not-created";
  try {
    daemon = await AttentionDaemon.create(info);
    cleanup = "retained";
    await daemon.post("smoke", "register", { title: "Synthetic CI attention smoke" });
    for (const id of ["one", "two"]) await daemon.post("smoke", "artifacts", {
      id, type: "research", title: `Synthetic review ${id}`,
      content: { summary: "Synthetic browser smoke", findings: [{ category: "Smoke", detail: "No production data", significance: "high" }] },
    });
    await page.addInitScript((selectedTheme) => {
      localStorage.setItem("dp-next-up-bar", "1");
      localStorage.setItem("dp-theme", selectedTheme);
    }, theme);
    await page.goto(`${daemon.baseURL}/?session=smoke`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.getByTestId("next-up-bar")).toContainText("Synthetic review one");
    await expect(page.getByLabel("Loading artifact view")).toHaveCount(0);
    await journey(page, daemon);
  } catch (error) { failed = true; failure = error; }
  finally {
    if (daemon) {
      try { await daemon.close(info); cleanup = "removed"; }
      catch (error) {
        failure = failed ? new AggregateError([failure, error], "Smoke failed and owned cleanup was not confirmed") : error;
        failed = true;
      }
    }
    const evidence = {
      case: info.title, theme, node: process.version, elapsedMs: Math.round(performance.now() - started), cleanup,
      runtime: daemon?.runtimes[0], browser: page.context().browser()?.version(),
      // Synthetic owned paths only. These let the fault guard independently
      // verify that the same sandbox disappeared and its port was released.
      sandbox: daemon ? { root: daemon.root, port: Number(new URL(daemon.baseURL).port) } : undefined,
      ...(failed ? { failure: redactDiagnostic(String(failure)).slice(0, 2000) } : {}),
    };
    if (failed) {
      const body = Buffer.from(redactDiagnostic(JSON.stringify(evidence, null, 2)));
      await attachDiagnosticFile(info, "attention-smoke-diagnostics", body.subarray(0, 16 * 1024));
    } else {
      // A bounded runtime summary in the job log; nothing is attached/uploaded.
      console.log(`[attention-smoke] ${JSON.stringify({ case: info.title, theme, node: evidence.node, browser: evidence.browser, elapsedMs: evidence.elapsedMs, cleanup, gitSha: evidence.runtime?.gitSha, webSha256: evidence.runtime?.webManifestSha256 })}`);
    }
  }
  if (failed) throw failure;
}
