import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useLedgerStore, ensureLedgerSubscriptions, resetLedgerStoreForTests } from "../ledger";

/**
 * EE2 — shared digest store. Pre-EE2 PreflightBreadcrumb +
 * YourTasteDrawer + IdleHome each had their own /api/ledger/digest
 * fetch + dp:preflight-trace listener. With 50 artifacts on screen +
 * a fresh trace event, that was 50 redundant network roundtrips per
 * broadcast. These tests verify dedup + the single-listener
 * invalidation path.
 */

beforeEach(() => {
  resetLedgerStoreForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetLedgerStoreForTests();
});

const sampleDigest = {
  shapedThisProject: 3,
  nearMissesThisProject: 1,
  blockedThisProject: 0,
  sessionsTouched: 1,
  topCitedStances: [],
  seededStances: [],
  globalLedger: { concepts: 2, projects: 1, multiProjectConcepts: 0 },
};

describe("useLedgerStore (EE2)", () => {
  it("dedupes concurrent ensureLedgerSubscriptions / refetch calls into a single fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => sampleDigest,
    });
    vi.stubGlobal("fetch", fetchMock);
    // Simulate 5 components calling ensureLedgerSubscriptions concurrently.
    ensureLedgerSubscriptions();
    ensureLedgerSubscriptions();
    await Promise.all([
      useLedgerStore.getState().refetch(),
      useLedgerStore.getState().refetch(),
      useLedgerStore.getState().refetch(),
    ]);
    // Only one in-flight fetch at a time.
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(useLedgerStore.getState().digest).toEqual(sampleDigest);
  });

  it("dp:preflight-trace event triggers exactly one refetch (single listener)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => sampleDigest,
    });
    vi.stubGlobal("fetch", fetchMock);
    // First call wires the listener + initial fetch.
    ensureLedgerSubscriptions();
    await useLedgerStore.getState().refetch();
    const initialCalls = fetchMock.mock.calls.length;
    // Second + third ensure calls are no-ops on the listener side.
    ensureLedgerSubscriptions();
    ensureLedgerSubscriptions();
    // Fire the event — exactly one refetch should fire (one listener).
    window.dispatchEvent(new CustomEvent("dp:preflight-trace"));
    // Wait for async refetch to complete.
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock.mock.calls.length).toBe(initialCalls + 1);
  });

  it("error state surfaces non-2xx responses", async () => {
    // FF3 — 5xx retries once with 500ms backoff. Both attempts fail
    // here, so the error state surfaces.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await useLedgerStore.getState().refetch();
    expect(useLedgerStore.getState().error).toBe("500");
    expect(useLedgerStore.getState().digest).toBeNull();
  });

  it("FF3 — 5xx triggers exactly one retry with backoff before settling into error state", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal("fetch", fetchMock);
    await useLedgerStore.getState().refetch();
    // Two attempts: initial + 1 retry. Pre-FF3 was 1.
    expect(fetchMock.mock.calls.length).toBe(2);
    expect(useLedgerStore.getState().error).toBe("503");
  });

  it("FF3 — 5xx that succeeds on retry clears error + populates digest", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce({ ok: true, json: async () => sampleDigest });
    vi.stubGlobal("fetch", fetchMock);
    await useLedgerStore.getState().refetch();
    expect(fetchMock.mock.calls.length).toBe(2);
    expect(useLedgerStore.getState().error).toBeNull();
    expect(useLedgerStore.getState().digest).toEqual(sampleDigest);
  });

  it("FF3 — 4xx does NOT retry (one attempt only)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal("fetch", fetchMock);
    await useLedgerStore.getState().refetch();
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(useLedgerStore.getState().error).toBe("404");
  });

  it("FF3 — resetLedgerStoreForTests removes the dp:preflight-trace listener", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => sampleDigest,
    });
    vi.stubGlobal("fetch", fetchMock);
    ensureLedgerSubscriptions();
    await useLedgerStore.getState().refetch();
    const beforeReset = fetchMock.mock.calls.length;
    resetLedgerStoreForTests();
    // Pre-FF3 the dangling listener would still call refetch. Post-FF3
    // it's been removed.
    window.dispatchEvent(new CustomEvent("dp:preflight-trace"));
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock.mock.calls.length).toBe(beforeReset);
  });

  it("version bumps on each successful fetch (lets subscribers react to refresh)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => sampleDigest,
    }));
    expect(useLedgerStore.getState().version).toBe(0);
    await useLedgerStore.getState().refetch();
    expect(useLedgerStore.getState().version).toBe(1);
    await useLedgerStore.getState().refetch();
    expect(useLedgerStore.getState().version).toBe(2);
  });
});
