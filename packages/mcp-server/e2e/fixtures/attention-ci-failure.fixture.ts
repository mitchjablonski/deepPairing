import { test, expect } from "../test.js";
import { runAttentionSmoke } from "../attention-ci-smoke.js";

test("deliberate real browser assertion failure", async ({ page }, info) => {
  await runAttentionSmoke(page, info, "dark", async (browserPage) => {
    await browserPage.evaluate(() => console.error("Authorization: Bearer synthetic-auth-sentinel"));
    await expect(browserPage.getByRole("button", { name: "Deliberately absent smoke control", exact: true })).toBeVisible({ timeout: 100 });
  });
});
