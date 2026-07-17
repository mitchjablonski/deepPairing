import { defineConfig } from "vitest/config";

const STD_EXCLUDE = [
  "**/node_modules/**",
  "**/dist/**",
  // Playwright e2e specs run under `playwright test`, not vitest.
  "**/e2e/**",
];

// Real-spawn suites: each boots one or more REAL daemon processes (tsx cold
// start + bind + daemon.json poll). They live in their own `server-spawn`
// project with fileParallelism: false so the heavy spawns never stack on each
// other — under full-run contention on WSL /mnt/c (9P latency) three
// concurrent tsx cold-starts were the main latency-straggler source.
const SPAWN_SUITES = [
  "src/__tests__/daemon-sigterm-port-release.test.ts",
  "src/__tests__/daemon-version-exposure.test.ts",
  "src/__tests__/ensure-daemon-version-gate.test.ts",
  "src/__tests__/fixture-ttl.test.ts",
];

// Port isolation: computes a per-run + per-worker DEEPPAIRING_PORT_BASE so
// test-spawned daemons bind ~20000-32000, never the product's canonical
// 3847-3974 window. Registered FIRST so the env is set before any test module
// (and project-root.ts's module-load resolution) is imported.
const PORT_WINDOW_SETUP = "./src/__tests__/test-port-window.setup.ts";

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
          exclude: [...STD_EXCLUDE, ...SPAWN_SUITES],
          // J1 — redirect the user-global philosophy ledger to an isolated tmp
          // for EVERY server test. Field incident: an un-redirected suite wrote
          // 222 rejections into the developer's real ~/.deeppairing ledger. The
          // guard runs before each test; harnesses that also redirect win by
          // last-registration. See global-store-guard.setup.ts.
          setupFiles: [PORT_WINDOW_SETUP, "./src/__tests__/global-store-guard.setup.ts"],
          isolate: false,
          // Review-caught: vi.restoreAllMocks() does NOT undo vi.stubGlobal —
          // with a shared worker context a leaked fetch stub persists into
          // every later file (ping.test.ts stubs fetch; daemon-client tests
          // make real fetches). Auto-unstub between files.
          unstubGlobals: true,
          unstubEnvs: true,
          // Latency class, not a logic class: full runs on WSL /mnt/c (9P)
          // intermittently push individually-fast tests past the 5s default
          // under whole-suite transform/IO contention. 15s absorbs the spike;
          // a genuinely stuck test still fails, just later.
          testTimeout: 15_000,
        },
      },
      {
        test: {
          name: "server-spawn",
          environment: "node",
          include: SPAWN_SUITES,
          exclude: STD_EXCLUDE,
          setupFiles: [PORT_WINDOW_SETUP, "./src/__tests__/global-store-guard.setup.ts"],
          isolate: false,
          unstubGlobals: true,
          unstubEnvs: true,
          // Serialize the real-spawn files (see SPAWN_SUITES note above).
          fileParallelism: false,
          // Required by vitest when a project's maxWorkers differs from its
          // siblings' (fileParallelism: false implies 1). groupOrder 1 also
          // runs the spawn group AFTER the parallel groups — the tsx
          // cold-starts get the machine to themselves instead of competing
          // with the transform-heavy web-dom project.
          sequence: { groupOrder: 1 },
          // These suites carry explicit per-test timeouts (40-90s); this is
          // the backstop for any new test added to the project.
          testTimeout: 60_000,
          // Disjoint port-window group from the `server` project — pool ids
          // may restart per pool, so group offsetting (not worker id alone)
          // is what guarantees the two projects never share a window. See
          // test-port-window.setup.ts.
          env: { DEEPPAIRING_TEST_PORT_GROUP: "1" },
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
          // K1 — order-dependent flake class: individual specs (originally
          // connection-hash-seed.dom.test.ts, but the victim moves with run
          // order — PredictionsBreadcrumb and others have hit it too)
          // intermittently fail "Test timed out in 5000ms" ONLY in the full
          // 58-file web-dom run, never in isolation. It's LATENCY, not a logic
          // bug or a state leak: this project spins up happy-dom per file and
          // re-transforms/re-renders heavy module graphs while the whole project
          // contends on the shared transform pipeline (cumulative import ~5min
          // across the suite). Under that load a single re-import/render
          // occasionally exceeds the 5s default. A 10s default absorbs the
          // contention spike (the same spec completes well inside it), making
          // the full run deterministic. Not a mask: assertions are unchanged and
          // a genuinely stuck test still fails, just at 20s.
          testTimeout: 10_000,
        },
      },
    ],
  },
});
