import { describe, it, expect, afterEach, vi } from "vitest";
import { sessionHeaders } from "../api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sessionHeaders", () => {
  it("always includes Content-Type: application/json", () => {
    const h = sessionHeaders();
    expect(h["Content-Type"]).toBe("application/json");
  });

  it("does not set X-Session-Id when no connection store exists", () => {
    // In node (no window), this is the default
    const h = sessionHeaders();
    expect(h["X-Session-Id"]).toBeUndefined();
  });

  it("adds X-Session-Id from window.__dpConnectionStore when present", () => {
    vi.stubGlobal("window", {
      __dpConnectionStore: {
        getState: () => ({ sessionId: "sess_abc" }),
      },
    });
    const h = sessionHeaders();
    expect(h["X-Session-Id"]).toBe("sess_abc");
  });

  it("omits X-Session-Id when connection store has no sessionId", () => {
    vi.stubGlobal("window", {
      __dpConnectionStore: {
        getState: () => ({ sessionId: null }),
      },
    });
    const h = sessionHeaders();
    expect(h["X-Session-Id"]).toBeUndefined();
  });

  it("survives a connection store that throws", () => {
    vi.stubGlobal("window", {
      __dpConnectionStore: {
        getState: () => { throw new Error("boom"); },
      },
    });
    expect(() => sessionHeaders()).not.toThrow();
  });
});
