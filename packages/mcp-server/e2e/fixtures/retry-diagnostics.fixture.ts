import { once } from "node:events";
import { test, expect } from "../test.js";
import { spawnDiagnosticProcess } from "../daemon-harness.js";

test("retains failed-attempt evidence when retry makes the run green", async ({ page }, testInfo) => {
  await page.setContent("<h1>Retry diagnostic fixture</h1>");
  if (testInfo.retry === 0) {
    const proc = spawnDiagnosticProcess(process.execPath, ["-e",
      "console.error('Authorization: Bearer fixture-daemon-secret'); process.exit(19)"]);
    await once(proc, "close");
    await page.evaluate(() => console.error("Cookie: sid=fixture-browser-secret"));
  }
  expect(testInfo.retry, "deliberate first-attempt failure").toBe(1);
});
