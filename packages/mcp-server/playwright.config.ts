import { defineConfig } from "@playwright/test";

/**
 * Playwright e2e — the real-browser backstop for the companion UI bootstrap.
 *
 * Separate from the vitest suite (`pnpm test`): vitest covers the server seam
 * (static-ui.test.ts) and the store seam (connection-hash-seed.dom.test.ts) in
 * isolation; this drives an actual Chromium against a real daemon to prove the
 * whole chain — served HTML injection → store seed → WS upgrade 101 →
 * connected → no fail-closed 403 — so a human stops being the QA for it.
 *
 * Specs live in e2e/ and end in .e2e.ts (vitest excludes them). The daemon is
 * booted per-spec from the built dist, so `pnpm build` must run first.
 * One-time browser install: `pnpm test:e2e:install` (downloads Chromium).
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    headless: true,
    actionTimeout: 10_000,
    // #194 M5 — the app's default theme is now "system" (was hard "dark"). The
    // a11y specs' "— dark" variants DON'T set dp-theme; they relied on that old
    // default, so under "system" they'd resolve to Chromium's default light and
    // silently scan the wrong theme. Pin the emulated OS scheme to dark so the
    // unset ("system") default resolves dark here, preserving each dark/light
    // scan's intent. The explicit "light" specs set localStorage dp-theme and
    // override via [data-theme="light"] regardless of this.
    colorScheme: "dark",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
