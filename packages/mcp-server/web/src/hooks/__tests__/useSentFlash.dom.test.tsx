import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSentFlash } from "../useSentFlash";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useSentFlash", () => {
  it("starts with sent=false", () => {
    const { result } = renderHook(() => useSentFlash());
    expect(result.current.sent).toBe(false);
  });

  it("sets sent=true on flash(), then back to false after the duration", () => {
    const { result } = renderHook(() => useSentFlash(2000));
    act(() => { result.current.flash(); });
    expect(result.current.sent).toBe(true);
    act(() => { vi.advanceTimersByTime(1999); });
    expect(result.current.sent).toBe(true);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current.sent).toBe(false);
  });

  it("resets the timer when flash() is called again mid-flash", () => {
    const { result } = renderHook(() => useSentFlash(2000));
    act(() => { result.current.flash(); });
    act(() => { vi.advanceTimersByTime(1500); });
    act(() => { result.current.flash(); });       // fresh 2000ms window
    act(() => { vi.advanceTimersByTime(1500); });
    // First timer would have fired by now; hook should still be "sent"
    expect(result.current.sent).toBe(true);
    act(() => { vi.advanceTimersByTime(500); });
    expect(result.current.sent).toBe(false);
  });

  it("clears the timer on unmount so orphan setState doesn't leak", () => {
    const { result, unmount } = renderHook(() => useSentFlash(2000));
    act(() => { result.current.flash(); });
    unmount();
    // Advancing timers after unmount should NOT throw / warn about setState
    // on an unmounted component. No assertion needed beyond clean tick.
    act(() => { vi.advanceTimersByTime(3000); });
  });
});
