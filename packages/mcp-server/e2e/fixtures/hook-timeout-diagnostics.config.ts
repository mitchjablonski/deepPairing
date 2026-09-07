import { defineConfig } from "@playwright/test";
import { playwrightPortEnv } from "../playwright-port-window.js";

Object.assign(process.env, playwrightPortEnv(process.env, process.pid));

export default defineConfig({
  testDir: ".",
  testMatch: "hook-timeout-diagnostics.fixture.ts",
  outputDir: process.env.DP_HOOK_TIMEOUT_DIAGNOSTIC_OUTPUT,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 30_000,
  use: { headless: true, screenshot: "off", trace: "off" },
});
