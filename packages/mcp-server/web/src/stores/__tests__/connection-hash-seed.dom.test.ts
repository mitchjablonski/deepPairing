import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * II2.2 — the connection store must seed `projectHash` from the daemon's HTML
 * injection (`window.__dpProjectHash`) at module-init time, so the very first
 * WS connect URL and mutation fetch carry X-Project-Hash and clear the
 * fail-closed gate. Without it a fresh tab deadlocks (hashless first WS
 * upgrade → 403 → no `connected` payload → hash stays null → 403 forever).
 *
 * This file is `.dom.test.ts` so it runs in happy-dom (real `window`).
 * resetModules + dynamic import re-runs the store factory per scenario.
 */
describe("II2.2 — connection store seeds projectHash from window.__dpProjectHash", () => {
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
