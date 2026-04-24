/**
 * R4 — opt-in ping. Dual-guard (env flag + URL) and aggregate-only payload
 * are the load-bearing invariants; nothing fingerprintable leaves the
 * machine unless the user explicitly turns it on AND configures an
 * endpoint.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildPingPayload, decidePing, sendPing } from "../ping.js";

describe("decidePing", () => {
  it("opts out when no env is set", () => {
    expect(decidePing({}).shouldSend).toBe(false);
  });

  it("opts out when DEEPPAIRING_PING is set but URL is missing (no default endpoint)", () => {
    const d = decidePing({ DEEPPAIRING_PING: "1" });
    expect(d.shouldSend).toBe(false);
    expect(d.reason).toMatch(/URL is not/);
  });

  it("opts out when URL is set but DEEPPAIRING_PING is not — explicit opt-in required", () => {
    const d = decidePing({ DEEPPAIRING_PING_URL: "https://example.com/ping" });
    expect(d.shouldSend).toBe(false);
  });

  it("accepts 1 / true / yes as truthy for DEEPPAIRING_PING", () => {
    for (const v of ["1", "true", "yes"]) {
      const d = decidePing({ DEEPPAIRING_PING: v, DEEPPAIRING_PING_URL: "https://example.com/p" });
      expect(d.shouldSend).toBe(true);
    }
  });

  it("rejects non-http(s) URLs (file://, etc.)", () => {
    const d = decidePing({ DEEPPAIRING_PING: "1", DEEPPAIRING_PING_URL: "file:///tmp/x" });
    expect(d.shouldSend).toBe(false);
    expect(d.reason).toMatch(/protocol/);
  });

  it("rejects malformed URLs", () => {
    const d = decidePing({ DEEPPAIRING_PING: "1", DEEPPAIRING_PING_URL: "not-a-url" });
    expect(d.shouldSend).toBe(false);
    expect(d.reason).toMatch(/not a valid URL/);
  });

  it("approves when both guards are satisfied", () => {
    const d = decidePing({ DEEPPAIRING_PING: "1", DEEPPAIRING_PING_URL: "https://example.com/ping" });
    expect(d.shouldSend).toBe(true);
    expect(d.url).toBe("https://example.com/ping");
  });
});

describe("buildPingPayload", () => {
  it("produces an aggregate-only shape — no identifiers, no paths, no content", () => {
    const payload = buildPingPayload({
      version: "0.1.0",
      skillLikelyLoaded: true,
      recentArtifactActivity: true,
    });
    expect(payload).toMatchObject({
      version: "0.1.0",
      event: "daemon_startup",
      skillLikelyLoaded: true,
      recentArtifactActivity: true,
      platform: process.platform,
    });
    expect(payload.nodeMajor).toBeGreaterThan(0);
    expect(payload.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Sanity: the payload must not contain any obvious identifiers.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(process.cwd());
    expect(serialized).not.toContain(process.env.USER ?? "---no-user---");
  });
});

describe("sendPing", () => {
  beforeEach(() => {});
  afterEach(() => { vi.restoreAllMocks(); });

  it("POSTs the payload as JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const payload = buildPingPayload({
      version: "0.1.0",
      skillLikelyLoaded: true,
      recentArtifactActivity: false,
    });
    const res = await sendPing("https://example.com/ping", payload);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.com/ping");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual(payload);
  });

  it("returns ok:false without throwing when fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("net down")));
    const res = await sendPing("https://example.com/ping", buildPingPayload({
      version: "0.1.0", skillLikelyLoaded: false, recentArtifactActivity: false,
    }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/net down/);
  });

  it("returns ok:false with the status code when the endpoint rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const res = await sendPing("https://example.com/ping", buildPingPayload({
      version: "0.1.0", skillLikelyLoaded: false, recentArtifactActivity: false,
    }));
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
  });
});
