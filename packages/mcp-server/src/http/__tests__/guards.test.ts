import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { applyTopLevelGuards, isLoopbackHost, projectHashGate } from "../guards.js";

/**
 * The top-level guards are what make the DNS-rebinding Host check and the body
 * cap cover EVERY route order-independently (pre-this they lived inside a
 * sub-app and only covered the top-level daemon routes by mount-order luck).
 * These tests pin both guards against a top-level route — the exact surface
 * that was fragile.
 */
function buildApp(maxBodyBytes = 64): Hono {
  const app = new Hono();
  applyTopLevelGuards(app, { maxBodyBytes });
  app.get("/api/daemon-info", (c) => c.json({ ok: true }));
  app.post("/api/echo", async (c) => c.json({ got: await c.req.text() }));
  return app;
}

describe("isLoopbackHost", () => {
  it("accepts loopback names + a missing Host, rejects everything else", () => {
    expect(isLoopbackHost(undefined)).toBe(true); // CLI / WS / test clients
    expect(isLoopbackHost("localhost:3847")).toBe(true);
    expect(isLoopbackHost("127.0.0.1:3847")).toBe(true);
    expect(isLoopbackHost("[::1]:3847")).toBe(true);
    expect(isLoopbackHost("evil.com")).toBe(false);
    expect(isLoopbackHost("attacker.example:3847")).toBe(false);
  });
});

describe("applyTopLevelGuards — DNS-rebinding host guard (covers top-level routes)", () => {
  it("403s a non-loopback Host on a top-level route", async () => {
    const res = await buildApp().request("/api/daemon-info", { headers: { host: "evil.com" } });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("forbidden_host");
  });
  it("allows a loopback Host", async () => {
    const res = await buildApp().request("/api/daemon-info", { headers: { host: "localhost:3847" } });
    expect(res.status).toBe(200);
  });
  it("allows a missing Host", async () => {
    const res = await buildApp().request("/api/daemon-info");
    expect(res.status).toBe(200);
  });
});

describe("applyTopLevelGuards — body cap (chunked-safe)", () => {
  it("413s an oversized body declared via Content-Length", async () => {
    const res = await buildApp(10).request("/api/echo", {
      method: "POST",
      body: "x".repeat(50),
      headers: { host: "localhost" },
    });
    expect(res.status).toBe(413);
  });

  it("413s an oversized CHUNKED body with NO Content-Length (the bypass the old check missed)", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(50)));
        controller.close();
      },
    });
    const req = new Request("http://localhost/api/echo", {
      method: "POST",
      body: stream,
      headers: { host: "localhost" },
      // Node requires duplex for a stream body; it carries no Content-Length.
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const res = await buildApp(10).request(req);
    expect(res.status).toBe(413);
  });

  it("allows a small body through", async () => {
    const res = await buildApp(64).request("/api/echo", {
      method: "POST",
      body: "hi",
      headers: { host: "localhost" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).got).toBe("hi");
  });
});

describe("projectHashGate (S1 — gates root-app reads that bypass the publicRoutes hash check)", () => {
  function gatedApp(daemonHash: string | undefined): Hono {
    const app = new Hono();
    app.use("/api/live-session/*", projectHashGate(daemonHash));
    app.get("/api/live-session/:id", (c) => c.json({ secret: "full session state" }));
    return app;
  }

  it("403s a request whose X-Project-Hash doesn't match the daemon's (stale tab on the wrong daemon)", async () => {
    const res = await gatedApp("hashA").request("/api/live-session/s1", { headers: { "X-Project-Hash": "hashB" } });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("project_hash_mismatch");
  });

  it("403s a request with NO X-Project-Hash", async () => {
    const res = await gatedApp("hashA").request("/api/live-session/s1");
    expect(res.status).toBe(403);
  });

  it("passes when the hash matches", async () => {
    const res = await gatedApp("hashA").request("/api/live-session/s1", { headers: { "X-Project-Hash": "hashA" } });
    expect(res.status).toBe(200);
    expect((await res.json()).secret).toBe("full session state");
  });

  it("no-ops when the daemon has no hash (test fixtures without a projectRoot)", async () => {
    const res = await gatedApp(undefined).request("/api/live-session/s1");
    expect(res.status).toBe(200);
  });
});
