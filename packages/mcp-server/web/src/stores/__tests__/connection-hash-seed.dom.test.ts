import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * II2.2 — the connection store must seed `projectHash` from the daemon's HTML
 * injection (`window.__dpProjectHash`) at module-init time, so the very first
 * WS connect URL and mutation fetch carry X-Project-Hash and clear the
 * fail-closed gate. Without it a fresh tab deadlocks (hashless first WS
 * upgrade → 403 → no `connected` payload → hash stays null → 403 forever).
 *
 * This file is `.dom.test.ts` so it runs in happy-dom (real `window`).
 * resetModules + dynamic import re-runs the store factory per scenario.
 *
 * K1 — this spec was ~1-in-3 order-dependent-flaky in the FULL web-dom run
 * (green in isolation). The root cause was NOT a value leak: it was
 * `await import("../connection")` occasionally exceeding the 5s test timeout
 * ("Test timed out in 5000ms"). Re-evaluating the store's module graph under
 * resetModules, while the whole web-dom project hammers the shared transform
 * pipeline (cumulative import ~5min across 58 happy-dom files), pushed a single
 * re-import past 5s. The project-wide fix is the raised web-dom `testTimeout`
 * (vitest.config.ts) — the latency is transient contention, not a hang, so the
 * same re-import completes well inside the higher budget. Here we ALSO shrink
 * this spec's own re-import cost by mocking the heavy WS-adapter subgraph, and
 * scrub `window.__dpProjectHash` on BOTH sides of every test so no ordering —
 * within this file or a leaked global from a prior file — can seed a stale hash
 * into the factory.
 */

// Cut the real adapter (→ lib/api, WS wiring) out of the re-imported graph: the
// store reads window.__dpProjectHash synchronously in its factory; the adapter
// is lazily used only by connect(), which these tests never call.
vi.mock("../../lib/connection-adapter", () => ({
  createAdapter: () => ({
    connect() {},
    disconnect() {},
    onMessage() {},
    onConnect() {},
    onDisconnect() {},
    onFatalMismatch() {},
    refreshUrl() {},
  }),
}));

describe("II2.2 — connection store seeds projectHash from window.__dpProjectHash", () => {
  beforeEach(() => {
    delete (window as any).__dpProjectHash;
    vi.resetModules();
  });

  afterEach(() => {
    delete (window as any).__dpProjectHash;
    vi.resetModules();
  });

  it("seeds projectHash from the injected window.__dpProjectHash", async () => {
    (window as any).__dpProjectHash = "7878c725";
    vi.resetModules();
    const { useConnectionStore } = await import("../connection");
    expect(useConnectionStore.getState().projectHash).toBe("7878c725");
  });

  it("defaults projectHash to null when nothing was injected", async () => {
    delete (window as any).__dpProjectHash;
    vi.resetModules();
    const { useConnectionStore } = await import("../connection");
    expect(useConnectionStore.getState().projectHash).toBeNull();
  });
});
