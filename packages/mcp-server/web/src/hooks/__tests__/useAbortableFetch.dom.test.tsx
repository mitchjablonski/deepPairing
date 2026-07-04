import { describe, it, expect } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useAbortableFetch } from "../useAbortableFetch";

describe("E7 — useAbortableFetch", () => {
  it("resolves data and exposes it", async () => {
    const { result } = renderHook(() =>
      useAbortableFetch(async () => ({ ok: 1 }), []),
    );
    await waitFor(() => expect(result.current).toEqual({ ok: 1 }));
  });

  it("aborts the in-flight signal on unmount and never sets state", async () => {
    let captured: AbortSignal | null = null;
    let release!: (v: { ok: number } | null) => void;
    const gate = new Promise<{ ok: number } | null>((r) => { release = r; });
    const { result, unmount } = renderHook(() =>
      useAbortableFetch(async (signal) => { captured = signal; return gate; }, []),
    );
    unmount();
    expect(captured!.aborted).toBe(true); // the REAL fix: the request is cancelled, not ignored
    release({ ok: 2 });
    await Promise.resolve();
    expect(result.current).toBeNull();
  });

  it("a dep change aborts the previous generation's signal", async () => {
    const signals: AbortSignal[] = [];
    const { rerender } = renderHook(
      ({ k }) => useAbortableFetch(async (signal) => { signals.push(signal); return null; }, [k]),
      { initialProps: { k: 1 } },
    );
    rerender({ k: 2 });
    await waitFor(() => expect(signals.length).toBe(2));
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
  });

  it("a rejecting REFETCH keeps the last-known data (transient-blip contract)", async () => {
    let fail = false;
    const { result, rerender } = renderHook(
      ({ k }) => useAbortableFetch(async () => {
        if (fail) throw new Error("blip");
        return { ok: k };
      }, [k]),
      { initialProps: { k: 1 } },
    );
    await waitFor(() => expect(result.current).toEqual({ ok: 1 }));
    fail = true;
    rerender({ k: 2 });
    // The failed refetch must NOT null out the data — stale beats vanished.
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toEqual({ ok: 1 });
  });

  it("a fetcher resolving null CLEARS the data (explicit-clear contract)", async () => {
    let empty = false;
    const { result, rerender } = renderHook(
      ({ k }) => useAbortableFetch(async () => (empty ? null : { ok: k }), [k]),
      { initialProps: { k: 1 } },
    );
    await waitFor(() => expect(result.current).toEqual({ ok: 1 }));
    empty = true;
    rerender({ k: 2 });
    await waitFor(() => expect(result.current).toBeNull());
  });
});
