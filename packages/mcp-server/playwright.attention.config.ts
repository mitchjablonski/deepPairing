import { defineConfig } from "@playwright/test";
import { playwrightPortEnv } from "./e2e/playwright-port-window.js";

// Inherit the existing validated override/per-invocation noncanonical policy.
Object.assign(process.env, playwrightPortEnv(process.env, process.pid));

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.walkthrough.ts",
  outputDir: "test-results/attention-walkthroughs",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    browserName: "chromium",
    headless: true,
    colorScheme: "dark",
    contextOptions: { reducedMotion: "reduce" },
    actionTimeout: 10_000,
    trace: "off", // HTML/WS/network traces can contain injected credentials.
    video: "off",
    screenshot: "off", // Only explicit synthetic, relative-path evidence shots.
  },
});
