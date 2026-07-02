import { defineConfig } from "vitest/config";

/**
 * C3 — REQUIRED under Vitest 4: v4 dropped `dist/**` from defaultExclude, and
 * this package compiles its __tests__ into dist/ (turbo test dependsOn build),
 * so a configless run collects every test TWICE — the second copy from a
 * possibly-stale build artifact. Review-caught: "232 passed" was 116 × 2.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
