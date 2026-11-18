import { test, expect } from "./test.js";
import { AttentionDaemon } from "./attention-walkthrough-harness.js";
import { attachDiagnosticFile } from "./diagnostics.js";

for (const moveToSidebar of [true, false]) {
  test(`lazy decision Enter follows ${moveToSidebar ? "sidebar" : "pane"} focus ownership`, async ({ page }, info) => {
    const daemon = await AttentionDaemon.create(info);
    let releaseDecision = () => {};
    const decisionGate = new Promise<void>((resolve) => { releaseDecision = () => resolve(); });
    let deferredChunks = 0;
    try {
      const session = "focus";
      const options = [
        { id: "redis", title: "Redis", description: "Synthetic external cache", pros: ["Fast"], cons: ["Operations"], effort: "low", risk: "low", recommendation: true },
        { id: "local", title: "Local", description: "Synthetic local cache", pros: ["Simple"], cons: ["Cold starts"], effort: "low", risk: "low", recommendation: false },
      ];
      await daemon.seed([
        { session, route: "register", body: { title: "Decision focus probe" } },
        { session, route: "artifacts", body: { id: "plan", type: "plan", title: "First review", content: {
          summary: "Synthetic plan", steps: [{ description: "Synthetic step", reasoning: "Focus probe", files: [] }],
        } } },
      ]);
      const decisionChunk = "**/DecisionCard-*.js";
      await page.route(decisionChunk, async (route) => {
        deferredChunks++;
        await decisionGate;
        await route.continue();
      });
      await page.addInitScript(() => {
        const receipt = { enters: [] as Array<{ tag: string; sidebar: string | null; pane: string | null }> };
        Object.assign(window, { decisionFocusReceipt: receipt });
        window.addEventListener("keydown", (event) => {
          if (!event.isTrusted || event.key !== "Enter" || !(event.target instanceof Element)) return;
          receipt.enters.push({
            tag: event.target.tagName,
            sidebar: event.target.closest("[data-artifact-item]")?.getAttribute("data-artifact-item") ?? null,
            pane: event.target.closest("[data-dp-pane]")?.getAttribute("data-artifact-id") ?? null,
          });
        }, { capture: true });
      });
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(daemon.baseURL + "/?session=" + session);
      const activePane = page.locator("[data-dp-pane]:not([inert])");
      const planPane = activePane.and(page.locator('[data-artifact-id="plan"]'));
      const decisionPane = activePane.and(page.locator('[data-artifact-id="decision"]'));
      const sidebarPlan = page.locator('[data-artifact-item="plan"]');
      await expect(planPane.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
      // Land on the plan before publishing its peer, independently of how
      // equal-priority drafts are ordered on initial hydration.
      await daemon.post(session, "artifacts", { id: "decision", type: "decision", title: "Choose a cache", content: {
        title: "Choose a cache", context: "Synthetic choice", decisionId: "cache", stakes: "high", stakesReason: "Synthetic focus probe", options,
      } });
      await daemon.post(session, "decisions", { decisionId: "cache", artifactId: "decision", context: "Synthetic choice", stakes: "high", options });
      await expect(page.locator('[data-artifact-item="decision"]')).toBeVisible();
      await expect(planPane).toBeVisible();
      await planPane.focus();
      await Promise.all([page.waitForRequest(decisionChunk), page.keyboard.press("n")]);
      await expect(decisionPane).toBeFocused();
      await expect(decisionPane.getByLabel("Loading artifact view")).toBeVisible();
      if (moveToSidebar) {
        for (let i = 0; i < 60 && !(await sidebarPlan.evaluate((el) => el === document.activeElement)); i++) {
          await page.keyboard.press("Tab");
        }
        await expect(sidebarPlan).toBeFocused();
      }
      releaseDecision();
      await expect(decisionPane.getByRole("button", { name: "Select Redis", exact: true })).toBeVisible();
      // Let the lazy commit and its focus effect run before sending the key.
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));
      await page.keyboard.press("Enter");
      const countdown = decisionPane.getByText(/Will select .*Redis.* in /);
      if (!moveToSidebar) await expect(countdown).toBeVisible();
      const countdownVisible = await countdown.isVisible();
      // Observe the real confirmation window so a misdirected Enter can leave
      // an authoritative server verdict in the failure receipt.
      await page.waitForTimeout(4_200);
      const artifacts = await daemon.artifacts(session);
      const observed = {
        deferredChunks,
        enters: await page.evaluate(() => (window as unknown as {
          decisionFocusReceipt: { enters: Array<{ tag: string; sidebar: string | null; pane: string | null }> };
        }).decisionFocusReceipt.enters),
        activePane: await activePane.getAttribute("data-artifact-id"),
        countdownVisible,
        plan: artifacts.find((a) => a.id === "plan")?.status,
        decision: artifacts.find((a) => a.id === "decision")?.status,
      };
      // CI retains diagnostics text along with its failure screenshot.
      await attachDiagnosticFile(info, "lazy-decision-focus-diagnostics", Buffer.from(JSON.stringify(observed)));
      expect(observed).toEqual(moveToSidebar ? {
        deferredChunks: 1, enters: [{ tag: "BUTTON", sidebar: "plan", pane: null }],
        activePane: "plan", countdownVisible: false, plan: "draft", decision: "draft",
      } : {
        deferredChunks: 1, enters: [{ tag: "DIV", sidebar: null, pane: "decision" }],
        activePane: "decision", countdownVisible: true, plan: "draft", decision: "approved",
      });
    } finally {
      releaseDecision();
      await daemon.close(info);
    }
  });
}

for (const width of [1280, 1920]) for (const reduced of [false, true]) {
  test("selected pane preserves its region and focus at " + width + " reduced=" + reduced, async ({ page }, info) => {
    test.setTimeout(90_000);
    const daemon = await AttentionDaemon.create(info);
    try {
      await daemon.seed([
        { session: "panes", route: "register", body: { title: "Pane transitions" } },
        ...["a", "b"].map((id) => ({ session: "panes", route: "artifacts", body: {
          id, type: "research", title: "Pane " + id, content: { summary: "Long pane", findings: Array.from({ length: 40 }, (_, n) => ({ category: "Evidence", title: "Finding " + n, detail: "Long synthetic content ".repeat(15), significance: "high" })) },
        } })),
      ]);
      await daemon.post("panes", "artifacts", { id: "broken", type: "debrief", title: "Broken renderer", content: { summary: "Synthetic renderer fault" } });
      await page.route("**/DebriefArtifact-*.js", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: 'export function DebriefArtifact() { throw new Error("Synthetic malformed renderer"); }' }));
      await page.setViewportSize({ width, height: width === 1280 ? 800 : 1080 });
      await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
      await page.goto(daemon.baseURL + "/?session=panes");
      const pane = (id: string) => page.locator('[data-dp-pane][data-artifact-id="' + id + '"]:not([inert])');
      await expect(pane("a")).toBeVisible();
      // The wrapper mounts before its lazy renderer; prove real long content and overflow first.
      await expect(pane("a").getByText("Finding 39", { exact: true })).toBeAttached();
      await expect.poll(() => pane("a").evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
      await pane("a").evaluate((el) => { el.scrollTop = 200; });
      await pane("a").evaluate((el) => { (el as HTMLElement).focus({ preventScroll: true }); });
      expect(await pane("a").evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      // Start recording before the action, rather than after a retry could hide the exit.
      const recording = page.evaluate(async () => {
        const rows = [];
        for (let frame = 0; frame < 35; frame++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const selected = document.querySelector<HTMLElement>('[data-dp-pane][data-artifact-id="b"]:not([inert])');
          if (!selected) continue;
          const parent = selected.parentElement!;
          const box = selected.getBoundingClientRect(), region = parent.getBoundingClientRect();
          rows.push({ top: box.top, left: box.left, width: box.width, height: box.height, regionHeight: region.height, offset: box.top - region.top,
            exitingCount: document.querySelectorAll('[data-dp-pane]:not([data-artifact-id="b"])').length,
            exitsInert: [...document.querySelectorAll('[data-dp-pane]:not([data-artifact-id="b"])')].every((node) => node.hasAttribute("inert")) });
        }
        return rows;
      });
      await page.keyboard.press("n");
      await expect(pane("b")).toBeFocused();
      const samples = await recording;
      expect(samples.length).toBeGreaterThan(0);
      if (!reduced) expect(samples.some((row) => row.exitingCount > 0)).toBe(true);
      const final = samples[samples.length - 1]!;
      for (const row of samples) {
        expect(row.exitsInert).toBe(true);
        expect(Math.abs(row.regionHeight - final.regionHeight)).toBeLessThan(1);
        expect(Math.abs(row.left - final.left)).toBeLessThan(1);
        expect(Math.abs(row.top - final.top)).toBeLessThan(reduced ? 1 : 5);
        expect(Math.abs(row.height - final.height)).toBeLessThan(1);
      }
      await info.attach("pane-frame-geometry-diagnostics", { body: JSON.stringify(samples), contentType: "text/plain" });
      console.log("[pane-geometry] " + JSON.stringify({ width, reduced, frames: samples.length, overlapFrames: samples.filter((row) => row.exitingCount > 0).length, maxTopDelta: Math.max(...samples.map((row) => Math.abs(row.top - final.top))), maxHeightDelta: Math.max(...samples.map((row) => Math.abs(row.height - final.height))), maxRegionHeightDelta: Math.max(...samples.map((row) => Math.abs(row.regionHeight - final.regionHeight))) }));
      await page.keyboard.press("N");
      await expect(pane("a")).toBeVisible();
      const outside = page.getByRole("button", { name: /Comment threads/i });
      await outside.focus();
      await page.locator('[data-artifact-item="b"]').click();
      await expect(page.locator('[data-artifact-item="b"]')).toBeFocused();
      for (const id of ["a", "b", "a", "b"]) await page.locator('[data-artifact-item="' + id + '"]').click();
      await expect(pane("b")).toHaveCount(1);
      await expect(pane("b")).toBeVisible();
      await expect(pane("b").getByRole("button", { name: "Approve", exact: true })).toHaveCount(1);
      // Explicit chip opens keep the external control focused, without a pane focus steal.
      const chip = page.getByTestId("pending-banner").getByTitle("Pane a", { exact: true });
      await chip.click();
      await expect(pane("a")).toBeVisible();
      await expect(chip).toBeFocused();
      await page.locator('[data-artifact-item="broken"]').click();
      await expect(pane("broken")).toContainText("This artifact failed to render");
      await expect(pane("broken")).toHaveCount(1);
      await pane("broken").focus();
      await page.keyboard.press("n");
      await expect(pane("a")).toBeFocused();
      await expect(pane("a")).not.toContainText("This artifact failed to render");
    } finally { await daemon.close(info); }
  });
}
