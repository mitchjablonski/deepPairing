import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "setup-failure.fixture.ts",
  outputDir: process.env.DP_SETUP_DIAGNOSTIC_OUTPUT,
  workers: 1,
  reporter: "line",
});
