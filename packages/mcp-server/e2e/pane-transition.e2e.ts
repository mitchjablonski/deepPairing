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
      await page.setViewportSize({ width, height: width === 1280 ? 800 : 1080 });
      await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
      await page.goto(daemon.baseURL + "/?session=panes");
      const pane = (id: string) => page.locator('[data-dp-pane][data-artifact-id="' + id + '"]:not([inert])');
      await expect(pane("a")).toBeVisible();
      await pane("a").evaluate((el) => { el.scrollTop = 200; });
      await pane("a").getByRole("button", { name: "Pane a", exact: true }).focus();
      await page.keyboard.press("n");
      await expect(pane("b")).toBeFocused();
      const samples = await page.evaluate(async () => {
        const rows = [];
        for (let frame = 0; frame < 20; frame++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const selected = document.querySelector<HTMLElement>('[data-dp-pane][data-artifact-id="b"]:not([inert])');
          if (!selected) throw new Error("Selected pane missing");
          const parent = selected.parentElement!;
          const box = selected.getBoundingClientRect(), region = parent.getBoundingClientRect();
          rows.push({ top: box.top, left: box.left, width: box.width, height: box.height, regionHeight: region.height, offset: box.top - region.top,
            exitsInert: [...document.querySelectorAll('[data-dp-pane]:not([data-artifact-id="b"])')].every((node) => node.hasAttribute("inert")) });
        }
        return rows;
      });
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
    } finally { await daemon.close(info); }
  });
}
