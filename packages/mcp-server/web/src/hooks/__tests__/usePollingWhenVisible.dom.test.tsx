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

  it("calls the LATEST callback without resubscribing (cbRef) on re-render", () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const { rerender } = render(<Harness cb={cb1} ms={1000} />);
    act(() => vi.advanceTimersByTime(1000));
    expect(cb1).toHaveBeenCalledTimes(1);
    rerender(<Harness cb={cb2} ms={1000} />); // same interval/enabled → no resubscribe
    act(() => vi.advanceTimersByTime(1000));
    expect(cb2).toHaveBeenCalledTimes(1);
    expect(cb1).toHaveBeenCalledTimes(1); // old callback no longer fires
  });

  it("clears the interval + visibility listener on unmount (no leak)", () => {
    const cb = vi.fn();
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const { unmount } = render(<Harness cb={cb} ms={1000} />);
    act(() => vi.advanceTimersByTime(1000));
    expect(cb).toHaveBeenCalledTimes(1);
    unmount();
    expect(removeSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    act(() => vi.advanceTimersByTime(5000)); // timer cleared → no further calls
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
