import { describe, it, expect } from "vitest";
import { corsAllowedOrigin, isAllowedWsOrigin } from "../origin-policy.js";

describe("D5 — corsAllowedOrigin", () => {
  it("rejects loopback web origins (the attacker class: any local dev server)", () => {
    expect(corsAllowedOrigin("http://localhost:3000")).toBeUndefined();
    expect(corsAllowedOrigin("http://127.0.0.1:8080")).toBeUndefined();
    expect(corsAllowedOrigin("http://localhost:3847")).toBeUndefined(); // even another daemon's UI
  });

  it("rejects non-local origins", () => {
    expect(corsAllowedOrigin("https://evil.example")).toBeUndefined();
  });

  it("allows the VS Code webview scheme (unspoofable by web pages)", () => {
    expect(corsAllowedOrigin("vscode-webview://1a2b3c")).toBe("vscode-webview://1a2b3c");
  });
});

describe("D5 — isAllowedWsOrigin", () => {
  it("allows no-Origin (non-browser clients: curl, tests, daemon sweep)", () => {
    expect(isAllowedWsOrigin(undefined, "localhost:3847")).toBe(true);
  });

  it("allows the daemon's OWN origin (same host:port)", () => {
    expect(isAllowedWsOrigin("http://localhost:3847", "localhost:3847")).toBe(true);
    expect(isAllowedWsOrigin("http://127.0.0.1:3847", "127.0.0.1:3847")).toBe(true);
  });

  it("rejects a DIFFERENT loopback port — WS ignores CORS, this is the only gate", () => {
    expect(isAllowedWsOrigin("http://localhost:3000", "localhost:3847")).toBe(false);
    expect(isAllowedWsOrigin("http://localhost:3848", "localhost:3847")).toBe(false);
  });

  it("rejects DNS rebinding: same-origin match on a NON-loopback host (raw upgrade bypasses the Hono Host guard)", () => {
    // Attacker page at http://evil.com with DNS rebound to 127.0.0.1:
    // Origin and Host agree with each other — but neither is loopback.
    expect(isAllowedWsOrigin("http://evil.com:3941", "evil.com:3941")).toBe(false);
  });

  it("allows the VS Code webview; rejects malformed origins", () => {
    expect(isAllowedWsOrigin("vscode-webview://1a2b3c", "localhost:3847")).toBe(true);
    expect(isAllowedWsOrigin("not a url", "localhost:3847")).toBe(false);
  });
});

describe("D5 — the stolen-HTML vector is closed at the CORS layer", () => {
  it("a loopback origin gets NO ACAO for the served HTML (token not readable cross-origin)", () => {
    // The policy function is what both cors() mounts call; a rejected origin
    // means hono emits no Access-Control-Allow-Origin header at all.
    expect(corsAllowedOrigin("http://localhost:3000")).toBeUndefined();
  });
});
