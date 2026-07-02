import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDraft } from "../useDraft";

describe("D9 (H5) — useDraft", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.useFakeTimers();
  });

  it("persists after the debounce and restores on remount (the reload case)", () => {
    const { result, unmount } = renderHook(() => useDraft("msg:s1"));
    act(() => result.current[1]("half-typed thought"));
    act(() => { vi.advanceTimersByTime(400); });
    unmount();
    const { result: again } = renderHook(() => useDraft("msg:s1"));
    expect(again.current[0]).toBe("half-typed thought");
  });

  it("keys isolate sessions — a draft can never follow you across a switch (M5)", () => {
    const { result, rerender } = renderHook(({ k }) => useDraft(k), {
      initialProps: { k: "msg:s1" },
    });
    act(() => result.current[1]("for session one"));
    act(() => { vi.advanceTimersByTime(400); });
    rerender({ k: "msg:s2" });
    expect(result.current[0]).toBe("");
    rerender({ k: "msg:s1" });
    expect(result.current[0]).toBe("for session one");
  });

  it("clearing the value deletes the entry (send = cleanup)", () => {
    const { result } = renderHook(() => useDraft("msg:s1"));
    act(() => result.current[1]("x"));
    act(() => { vi.advanceTimersByTime(400); });
    act(() => result.current[1](""));
    act(() => { vi.advanceTimersByTime(400); });
    expect(sessionStorage.getItem("dp:draft:msg:s1")).toBeNull();
  });
});

describe("D9 review — flush semantics", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.useFakeTimers();
  });

  it("switching keys WITHIN the debounce window flushes the old key's draft (fast rail click)", () => {
    const { result, rerender } = renderHook(({ k }) => useDraft(k), {
      initialProps: { k: "msg:s1" },
    });
    act(() => result.current[1]("typed then switched fast"));
    // NO timer advance — switch before the 300ms write fires.
    rerender({ k: "msg:s2" });
    expect(sessionStorage.getItem("dp:draft:msg:s1")).toBe("typed then switched fast");
    rerender({ k: "msg:s1" });
    expect(result.current[0]).toBe("typed then switched fast");
  });

  it("unmount within the debounce window flushes (reload-toast case)", () => {
    const { result, unmount } = renderHook(() => useDraft("msg:s1"));
    act(() => result.current[1]("about to reload"));
    unmount();
    expect(sessionStorage.getItem("dp:draft:msg:s1")).toBe("about to reload");
  });
});
