/**
 * #338 — a reconnect must not let a frozen writer throw through the real
 * WebSocket connection callback. This uses two FileStores to produce the
 * actual review conflict, then proves the refusal is bounded and isolated:
 * disk is unchanged, HTTP survives, and another session still hydrates.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { serve } from "@hono/node-server";
import WebSocket from "ws";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createDaemon, type Daemon } from "../create-daemon.js";
import { FileStore } from "../../store/file-store.js";
import { projectHashOf } from "../../project-root.js";
import { ERROR_CODES } from "../../error-codes.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";

interface Running {
  fx: GlobalStoreFixture;
  daemon: Daemon;
  server: ReturnType<typeof serve>;
  base: string;
  hash: string;
}

const running: Running[] = [];

async function start(log: (message: string) => void = () => {}): Promise<Running> {
  const fx = withGlobalStore("dp-frozen-ws-connect-");
  const daemon = createDaemon({
    projectRoot: fx.dir,
    authToken: "test-token",
    log,
    exitProcess: () => {},
    releaseListenSocket: () => {},
    env: {},
  });
  const server = serve({ fetch: daemon.app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => {
    const listener = server as unknown as { address(): AddressInfo | null; once(event: string, cb: () => void): void };
    if (listener.address()) resolve(); else listener.once("listening", resolve);
  });
  daemon.attachUpgradeHandler(server as unknown as Parameters<Daemon["attachUpgradeHandler"]>[0]);
  const port = (server as unknown as { address(): AddressInfo }).address().port;
  const result = { fx, daemon, server, base: `http://127.0.0.1:${port}`, hash: projectHashOf(fx.dir) };
  running.push(result);
  return result;
}

afterEach(() => {
  vi.useRealTimers();
  for (const item of running.splice(0)) {
    item.daemon.dispose();
    try { item.server.closeAllConnections?.(); } catch {}
    try { item.server.close(); } catch {}
    item.fx.dispose();
  }
});

function refused(base: string, hash: string, sessionId?: string): Promise<{
  frames: Array<Record<string, unknown>>;
  code: number;
  reason: string;
}> {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams({ projectHash: hash });
    if (sessionId) query.set("sessionId", sessionId);
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws?${query}`);
    const frames: Array<Record<string, unknown>> = [];
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("WebSocket refusal did not close within 5s"));
    }, 5000);
    ws.on("message", (data) => frames.push(JSON.parse(String(data)) as Record<string, unknown>));
    ws.on("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ frames, code, reason: String(reason) });
    });
    ws.on("error", reject);
  });
}

function firstFrame(base: string, hash: string, sessionId: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws?sessionId=${sessionId}&projectHash=${hash}`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("No WebSocket frame within 5s"));
    }, 5000);
    ws.on("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(data)) as Record<string, unknown>);
      ws.close();
    });
    ws.on("error", reject);
  });
}

describe("#338 — frozen initial WebSocket snapshots", () => {
  it("refuses a real frozen session without connected, mutation, or daemon loss", async () => {
    const logs: string[] = [];
    const { fx, daemon, base, hash } = await start((message) => logs.push(message));
    const frozen = daemon.createSession("frozen");
    frozen.createArtifact({
      id: "a", type: "code_change", title: "Original",
      content: { filePath: "a.ts", diff: "-a\n+b" },
    });
    frozen.forceFlush();

    const external = fx.track(new FileStore(fx.dir, "frozen"));
    const changed = external.getArtifacts()[0]!;
    changed.content = { filePath: "a.ts", diff: "-a\n+different" };
    changed.version = 2;
    external.renameArtifact("a", changed.title);
    external.forceFlush();
    frozen.updateArtifactStatus("a", "approved", "ui_approve_button");
    expect(() => frozen.forceFlush()).toThrow(/changed content.*review verdict/i);

    const artifactsPath = path.join(fx.dir, ".deeppairing", "sessions", "frozen", "artifacts.json");
    const before = fs.readFileSync(artifactsPath, "utf8");
    const result = await refused(base, hash, "frozen");
    expect(result.frames).toEqual([{
      type: "connection_refused",
      code: ERROR_CODES.session_review_conflict,
      message: "Session state requires review before reconnecting.",
    }]);
    expect(result.frames.some((frame) => frame.type === "connected")).toBe(false);
    expect(result.code).toBe(1011);
    expect(result.reason).toBe("Initial snapshot unavailable");
    expect(daemon.getClientCount()).toBe(0);
    expect(fs.readFileSync(artifactsPath, "utf8")).toBe(before);
    expect(logs.some((line) => line.includes("session review conflict") && line.includes("session=frozen"))).toBe(true);
    const globalResult = await refused(base, hash);
    expect(globalResult.frames).toEqual([{
      type: "connection_refused",
      code: ERROR_CODES.session_review_conflict,
      message: "Session state requires review before reconnecting.",
    }]);
    expect(globalResult.frames.some((frame) => frame.type === "connected")).toBe(false);
    expect(daemon.getClientCount()).toBe(0);

    const health = await fetch(`${base}/api/daemon-info`);
    expect(health.status).toBe(200);

    const healthy = daemon.createSession("healthy");
    healthy.createArtifact({ id: "ok", type: "research", title: "Healthy", content: {} });
    healthy.forceFlush();
    const healthyFrame = await firstFrame(base, hash, "healthy");
    expect(healthyFrame.type).toBe("connected");
    expect((healthyFrame.state as { artifacts: Array<{ id: string }> }).artifacts.map((artifact) => artifact.id)).toEqual(["ok"]);
  });

  it("uses a generic refusal for unexpected snapshot errors and never leaks private details", async () => {
    const logs: string[] = [];
    const { daemon, base, hash } = await start((message) => logs.push(message));
    const broken = daemon.createSession("broken");
    broken.getFullState = (() => { throw new Error("private artifact secret"); }) as typeof broken.getFullState;

    const result = await refused(base, hash, "broken");
    expect(result.frames).toEqual([{
      type: "connection_refused",
      message: "Session state is temporarily unavailable.",
    }]);
    expect(JSON.stringify(result.frames)).not.toContain("private artifact secret");
    expect(result.code).toBe(1011);
    expect(daemon.getClientCount()).toBe(0);
    expect(logs.some((line) => line.includes("private artifact secret"))).toBe(true);

    // An abrupt peer departure during another refusal still runs the handlers
    // installed before getFullState() and cannot leave a registered client.
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`${base.replace("http", "ws")}/ws?sessionId=broken&projectHash=${hash}`);
      ws.on("open", () => ws.terminate());
      ws.on("close", () => resolve());
      ws.on("error", () => resolve());
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(daemon.getClientCount()).toBe(0);
  });

  it("terminates a refusal whose send callback never completes", async () => {
    const logs: string[] = [];
    const { daemon } = await start((message) => logs.push(message));
    const broken = daemon.createSession("stalled");
    broken.getFullState = (() => { throw new Error("snapshot failed"); }) as typeof broken.getFullState;

    class StalledSocket extends EventEmitter {
      sent: string[] = [];
      terminated = false;
      send(data: string): void { this.sent.push(data); }
      close(): void {}
      terminate(): void { this.terminated = true; }
    }
    const socket = new StalledSocket();
    vi.useFakeTimers();
    daemon.wss.emit("connection", socket as unknown as WebSocket, { url: "/ws?sessionId=stalled" });
    expect(socket.sent.map((frame) => JSON.parse(frame))).toEqual([{
      type: "connection_refused",
      message: "Session state is temporarily unavailable.",
    }]);
    expect(daemon.getClientCount()).toBe(0);
    expect(socket.terminated).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(socket.terminated).toBe(true);
    expect(logs.some((line) => line.includes("refusal timed out") && line.includes("session=stalled"))).toBe(true);
  });
});
