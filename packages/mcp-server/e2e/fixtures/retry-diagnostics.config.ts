import { defineConfig } from "@playwright/test";

// Explicit local/CI acceptance probe, excluded from the normal E2E inventory.
export default defineConfig({
  testDir: ".",
  testMatch: "retry-diagnostics.fixture.ts",
  outputDir: process.env.DP_RETRY_DIAGNOSTIC_OUTPUT,
  workers: 1,
  retries: 1,
  reporter: "list",
  use: { headless: true, screenshot: "only-on-failure", trace: "retain-on-failure" },
});
