import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { usePollingWhenVisible } from "../usePollingWhenVisible";

let hidden = false;

beforeEach(() => {
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function Harness({ cb, ms, enabled }: { cb: () => void; ms: number; enabled?: boolean }) {
  usePollingWhenVisible(cb, ms, enabled);
  return null;
}

describe("usePollingWhenVisible", () => {
  it("polls on the interval while the tab is visible", () => {
    const cb = vi.fn();
    render(<Harness cb={cb} ms={1000} />);
    act(() => vi.advanceTimersByTime(3000));
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it("pauses when hidden and resumes with a catch-up call on re-show", () => {
    const cb = vi.fn();
    render(<Harness cb={cb} ms={1000} />);
    act(() => vi.advanceTimersByTime(1000));
    expect(cb).toHaveBeenCalledTimes(1);

    act(() => {
      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => vi.advanceTimersByTime(5000)); // paused → no further calls
    expect(cb).toHaveBeenCalledTimes(1);

    act(() => {
      hidden = false;
      document.dispatchEvent(new Event("visibilitychange")); // immediate catch-up
    });
    expect(cb).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(1000)); // resumed
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it("does not poll at all when disabled (e.g. disconnected)", () => {
    const cb = vi.fn();
    render(<Harness cb={cb} ms={1000} enabled={false} />);
    act(() => vi.advanceTimersByTime(5000));
    expect(cb).not.toHaveBeenCalled();
  });
});
