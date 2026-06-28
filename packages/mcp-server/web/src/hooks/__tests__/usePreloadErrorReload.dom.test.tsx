import { describe, it, expect, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { usePreloadErrorReload } from "../usePreloadErrorReload";
import { useToastStore } from "../../stores/toast";

function Harness() {
  usePreloadErrorReload();
  return null;
}

beforeEach(() => {
  useToastStore.getState().dismissAll();
});

describe("usePreloadErrorReload (mermaid/stale-tab resilience)", () => {
  it("surfaces a sticky reload toast when a dynamic chunk fails to load", () => {
    render(<Harness />);
    act(() => {
      window.dispatchEvent(new Event("vite:preloadError"));
    });
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toMatch(/new version/i);
    expect(toasts[0].ttl).toBe(0); // sticky
    expect(toasts[0].action?.label).toMatch(/reload/i);
  });

  it("prompts only once even if several chunks fail", () => {
    render(<Harness />);
    act(() => {
      window.dispatchEvent(new Event("vite:preloadError"));
      window.dispatchEvent(new Event("vite:preloadError"));
      window.dispatchEvent(new Event("vite:preloadError"));
    });
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });
});
