import { describe, it, expect, afterEach, vi } from "vitest";
import { sessionHeaders, safeFetch, ApiError, setCurrentHost, apiBase, wsBase } from "../api";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setCurrentHost(""); // MP1 — reset to default origin between tests
});

describe("MP1 — switchable base (project switch)", () => {
  it("apiBase/wsBase follow setCurrentHost so the SPA can repoint at another project's daemon", () => {
    setCurrentHost("localhost:3910");
    expect(apiBase()).toBe("http://localhost:3910");
    expect(wsBase()).toBe("ws://localhost:3910/ws");

    // Switch to a different project's port — both bases follow.
    setCurrentHost("localhost:3866");
    expect(apiBase()).toBe("http://localhost:3866");
    expect(wsBase()).toBe("ws://localhost:3866/ws");
  });

  it("a mutation built from apiBase() targets the SELECTED daemon's port, not a fixed origin", async () => {
    setCurrentHost("localhost:3910");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    // Mirrors how the artifact store posts an accept.
    await safeFetch(`${apiBase()}/api/artifacts/art_x/status`, { method: "POST" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3910/api/artifacts/art_x/status",
      expect.objectContaining({ method: "POST" }),
    );
  });
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

  it("F6 — forSessionId OVERRIDES the tab binding (owner routing) and keeps the hash/token attach", () => {
    vi.stubGlobal("window", {
      __dpConnectionStore: {
        getState: () => ({ sessionId: "sess_tab", projectHash: "hashX" }),
      },
      __deepPairingToken: "tok_1",
    });
    const h = sessionHeaders("sess_owner");
    expect(h["X-Session-Id"]).toBe("sess_owner");
    expect(h["X-Project-Hash"]).toBe("hashX"); // AA4 pairing survives the override
    expect(h["Authorization"]).toBe("Bearer tok_1");
    // Without the override, the tab binding applies as before.
    expect(sessionHeaders()["X-Session-Id"]).toBe("sess_tab");
  });

  it("SP1 — carries the bearer token (window.__deepPairingToken) so mutations pass the gate", () => {
    vi.stubGlobal("window", {
      __dpConnectionStore: { getState: () => ({ sessionId: "s1", projectHash: "h1" }) },
      __deepPairingToken: "tok-xyz",
    });
    const h = sessionHeaders();
    expect(h["Authorization"]).toBe("Bearer tok-xyz");
  });

  it("SP1 — omits Authorization when no token is injected", () => {
    vi.stubGlobal("window", { __dpConnectionStore: { getState: () => ({ sessionId: "s1" }) } });
    expect(sessionHeaders()["Authorization"]).toBeUndefined();
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

describe("safeFetch (U3)", () => {
  // Field bug pre-U3: every store mutation called bare `fetch` and
  // dropped the response. A 4xx/5xx — or a network error — was silent;
  // the user clicked Approve and the daemon never received the POST.
  // safeFetch throws ApiError on every non-success so callers can toast.

  function mockFetch(impl: () => Promise<Response> | Response): void {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(impl));
  }

  it("returns the Response unchanged on 2xx", async () => {
    mockFetch(() => new Response("ok", { status: 200 }));
    const res = await safeFetch("/x");
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe("ok");
  });

  it("throws ApiError with status + parsed daemon error on a structured 4xx body", async () => {
    mockFetch(() => new Response(
      JSON.stringify({ error: "no active session", code: "no_active_session" }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    ));
    await expect(safeFetch("/x", { method: "POST" })).rejects.toMatchObject({
      name: "ApiError",
      status: 409,
      code: "no_active_session",
    });
  });

  it("specializes the no_active_session message with a 'start Claude Code' hint", async () => {
    mockFetch(() => new Response(
      JSON.stringify({ error: "...", code: "no_active_session" }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    ));
    try {
      await safeFetch("/x", { method: "POST" });
      throw new Error("should not reach");
    } catch (err: any) {
      expect(err).toBeInstanceOf(ApiError);
      expect(err.message).toMatch(/start Claude Code with deepPairing/i);
    }
  });

  it("throws a generic ApiError when the body isn't JSON", async () => {
    mockFetch(() => new Response("Internal Server Error", { status: 500 }));
    await expect(safeFetch("/x", { method: "POST" })).rejects.toMatchObject({
      name: "ApiError",
      status: 500,
      code: null,
    });
  });

  it("throws ApiError(0, network_error) when fetch itself rejects", async () => {
    mockFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    await expect(safeFetch("/x")).rejects.toMatchObject({
      name: "ApiError",
      status: 0,
      code: "network_error",
    });
    // Network-error message points the user at doctor.
    try { await safeFetch("/x"); } catch (e: any) {
      expect(e.message).toMatch(/deeppairing doctor/i);
    }
  });
});
