/**
 * Test port-window isolation (setupFiles, server + server-spawn vitest projects).
 *
 * Field incident this closes: vitest-spawned REAL daemons (tsx spawn suites,
 * the old-version fixture, ensureDaemon's fresh spawn) bound inside the
 * product's canonical 3847-3974 window — the SAME window the developer's live
 * daemons use. Four zombie fixtures from aborted runs were found squatting
 * product ports, and parallel workers raced each other for the same slots.
 *
 * project-root.ts resolves BASE_PORT/PORT_SPAN from DEEPPAIRING_PORT_BASE /
 * DEEPPAIRING_PORT_SPAN at module load, and every spawned daemon inherits
 * `...process.env` — so setting the env HERE (top-level setup code, which runs
 * before any test module is imported) relocates the whole window for the test
 * process AND everything it spawns, coherently.
 *
 * Window layout — must be DISJOINT per concurrently-running worker:
 *   base = 20000 + (ppid % 4000)            // per-RUN jitter, identical across
 *                                           // workers (all pool workers share
 *                                           // the vitest orchestrator parent)
 *        + group * 4096                     // server vs server-spawn project
 *                                           // (pool ids MAY restart per pool)
 *        + workerId * 128                   // per-worker stride == span
 * Ceiling: 20000 + 3999 + 4096 + 32*128 = 32191 < 32768, so windows stay below
 * the Linux ephemeral range (no OS-assigned collisions) and far above the
 * canonical 3847-3974 product window.
 *
 * `??=` on purpose: an explicit caller override (e.g. a developer reproducing
 * a specific window) wins over the computed one. NOTE these are direct
 * process.env writes, NOT vi.stubEnv — the server project's
 * `unstubEnvs: true` must not strip them between files.
 */

if (process.env.DEEPPAIRING_PORT_BASE === undefined) {
  const runJitter = (process.ppid || 0) % 4000;
  // DEEPPAIRING_TEST_PORT_GROUP is set per vitest project (server-spawn = 1)
  // so the two pools can never overlap even if their worker ids collide.
  const group = Number(process.env.DEEPPAIRING_TEST_PORT_GROUP ?? "0") || 0;
  const workerId = Number(process.env.VITEST_POOL_ID ?? "1") || 1;
  process.env.DEEPPAIRING_PORT_BASE = String(20000 + runJitter + group * 4096 + workerId * 128);
}
process.env.DEEPPAIRING_PORT_SPAN ??= "128";
