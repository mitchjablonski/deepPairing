import { defineConfig } from "@playwright/test";
import ordinary from "../../playwright.config.js";
import { SMOKE_USE } from "../attention-ci-smoke.js";

export default defineConfig({
  ...ordinary, testDir: ".", testMatch: "attention-ci-failure.fixture.ts",
  outputDir: process.env.DP_ATTENTION_FAULT_OUTPUT, timeout: 40_000,
  reporter: "line", use: { ...ordinary.use, ...SMOKE_USE },
});
