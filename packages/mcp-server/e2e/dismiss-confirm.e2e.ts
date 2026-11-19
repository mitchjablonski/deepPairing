import { test, expect } from "./test.js";
import { AttentionDaemon } from "./attention-walkthrough-harness.js";

// #668 item 1 / Sol (#670) — real pointer + keyboard proof for the two-step
// pane Dismiss: a double-click on the trigger can't commit, the destructive
// target is outside the trigger's hit area, and a deliberate keyboard confirm
// does commit.
test("pane Dismiss: a rapid repeat can't commit; a deliberate keyboard confirm does", async ({ page }, info) => {
  test.setTimeout(90_000);
  const daemon = await AttentionDaemon.create(info);
  try {
    await daemon.seed([
      { session: "dismiss", route: "register", body: { title: "Dismiss confirm" } },
      { session: "dismiss", route: "artifacts", body: {
        id: "d1", type: "research", title: "Dismiss probe",
        content: { summary: "Short", findings: [{ category: "Evidence", title: "One", detail: "Synthetic", significance: "low" }] },
      } },
    ]);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(daemon.baseURL + "/?session=dismiss");
    const pane = page.locator('[data-dp-pane][data-artifact-id="d1"]:not([inert])');
    const trigger = pane.getByRole("button", { name: "Dismiss — overcome by new information" });
    await trigger.scrollIntoViewIfNeeded();
    await expect(trigger).toBeVisible();
    const t = (await trigger.boundingBox())!;

    // Real rapid repeat at the trigger's centre.
    await page.mouse.dblclick(t.x + t.width / 2, t.y + t.height / 2);
    const confirmBtn = pane.getByRole("button", { name: /Dismiss\? \(can't be undone\)/ });
    // The double-click's second press lands on "Keep it" (cancel) — or the
    // confirmation is still open; either way nothing was written.
    await page.waitForTimeout(600);
    expect((await daemon.artifacts("dismiss")).find((a) => a.id === "d1")?.status).toBe("draft");

    // Arm once and measure: the destructive target is outside the trigger's box.
    if (!(await confirmBtn.isVisible())) await trigger.click();
    await expect(confirmBtn).toBeVisible();
    const c = (await confirmBtn.boundingBox())!;
    const overlaps = c.x < t.x + t.width && c.x + c.width > t.x && c.y < t.y + t.height && c.y + c.height > t.y;
    expect(overlaps).toBe(false);
    await expect(pane.getByRole("button", { name: "Keep it" })).toBeFocused();

    // Deliberate keyboard confirm.
    await page.waitForTimeout(500);
    await page.keyboard.press("Tab");
    await expect(confirmBtn).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await daemon.artifacts("dismiss")).find((a) => a.id === "d1")?.status).toBe("obsolete");
  } finally {
    await daemon.close(info);
  }
});
