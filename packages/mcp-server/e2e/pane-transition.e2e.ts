import { test, expect } from "./test.js";
import { AttentionDaemon } from "./attention-walkthrough-harness.js";

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
      await page.route("**/DebriefArtifact-*.js", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: 'throw new Error("Synthetic malformed renderer");' }));
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
      await info.attach("pane-frame-geometry", { body: JSON.stringify(samples), contentType: "application/json" });
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
