import { defineConfig } from "vitest/config";

const STD_EXCLUDE = [
  "**/node_modules/**",
  "**/dist/**",
  // Playwright e2e specs run under `playwright test`, not vitest.
  "**/e2e/**",
];

/**
 * C3 — Vitest 4 `projects` split (replaces the removed environmentMatchGlobs).
 *
 * The old single-project config applied the React Testing Library setup file
 * to EVERY test file, including ~50 node-only server suites that never touch
 * the DOM — a measured 916s of cumulative setup for 69s of actual test time.
 * Three projects scope environment + setup to the files that need them:
 *
 *  - server:   src/** in node. `isolate: false` — server tests build their
 *              own stores on mkdtemp dirs (fakes-not-mocks), so sharing a
 *              worker context is safe and skips per-file environment setup.
 *  - web-node: pure-logic web tests (lib/, stores/) in node, no DOM setup.
 *  - web-dom:  component tests + *.dom.test.* in happy-dom with the RTL
 *              setup file — the only place jest-dom matchers are used.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "server",
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: STD_EXCLUDE,
          isolate: false,
        },
      },
      {
        test: {
          name: "web-node",
          environment: "node",
          include: ["web/src/**/*.test.{ts,tsx}"],
          exclude: [
            ...STD_EXCLUDE,
            "web/src/components/**/__tests__/**",
            "web/src/**/*.dom.test.*",
          ],
        },
      },
      {
        test: {
          name: "web-dom",
          environment: "happy-dom",
          include: [
            "web/src/components/**/__tests__/**/*.test.{ts,tsx}",
            "web/src/**/*.dom.test.{ts,tsx}",
          ],
          exclude: STD_EXCLUDE,
          setupFiles: ["./web/src/__tests__/setup.ts"],
        },
      },
    ],
  },
});
