import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useConfirmCountdown } from "../useConfirmCountdown";

describe("#175 useConfirmCountdown — the reused confirm-countdown affordance", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("arms, ticks down, and commits exactly once at zero", () => {
    const commit = vi.fn();
    const { result } = renderHook(() => useConfirmCountdown(commit));
    expect(result.current.countdown).toBeNull();

    act(() => result.current.arm(3));
    expect(result.current.countdown).toBe(3);
    expect(result.current.armed).toBe(true);

    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current.countdown).toBe(2);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current.countdown).toBe(1);
    act(() => { vi.advanceTimersByTime(1000); });
    // hits 0 → commit fires, countdown disarms.
    expect(commit).toHaveBeenCalledTimes(1);
    expect(result.current.countdown).toBeNull();

    // No further commits after disarm.
    act(() => { vi.advanceTimersByTime(3000); });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("cancel() HOLDS: it clears the countdown, never commits, and latches held", () => {
    const commit = vi.fn();
    const { result } = renderHook(() => useConfirmCountdown(commit));
    act(() => result.current.arm(3));
    act(() => { vi.advanceTimersByTime(1000); });
    act(() => result.current.cancel());
    expect(result.current.countdown).toBeNull();
    expect(result.current.held).toBe(true);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(commit).not.toHaveBeenCalled();
  });

  it("Escape while armed holds the countdown", () => {
    const commit = vi.fn();
    const { result } = renderHook(() => useConfirmCountdown(commit));
    act(() => result.current.arm(3));
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(result.current.countdown).toBeNull();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(commit).not.toHaveBeenCalled();
  });
});
