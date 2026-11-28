/**
 * #711 gate 4 — the companion WebSocket carries a standalone review's End.
 *
 * Driven through the real createDaemon factory, a real HTTP server and real
 * `ws` clients (fakes, not mocks). The socket is send-only — writes are HTTP
 * routes with typed 409s — so what it owes a tab is the End STATE: exactly one
 * `review_ended` when closeout completes (none for a failed End), and the same
 * frame on connect after End, read from the durable marker without warming a
 * writable store.
 */
import { afterEach, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { ReviewEndedEventSchema } from "@deeppairing/shared";
import { createDaemon, type Daemon } from "../create-daemon.js";
import { FileStore } from "../../store/file-store.js";
import { projectHashOf } from "../../project-root.js";
import { createStandaloneSessionId } from "../../standalone-session-id.js";
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
const clients: Tab[] = [];

async function start(): Promise<Running> {
  const fx = withGlobalStore("dp-socket-ended-");
  const daemon = createDaemon({
    projectRoot: fx.dir, authToken: "test-token", log: () => {},
    exitProcess: () => {}, releaseListenSocket: () => {}, env: {},
  });
  const server = serve({ fetch: daemon.app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => {
    const listener = server as unknown as { address(): AddressInfo | null; once(event: string, cb: () => void): void };
    if (listener.address()) resolve(); else listener.once("listening", resolve);
  });
  daemon.attachUpgradeHandler(server as unknown as Parameters<Daemon["attachUpgradeHandler"]>[0]);
  const port = (server as unknown as { address(): AddressInfo }).address().port;
  const result = { fx, daemon, server, base: `ws://127.0.0.1:${port}`, hash: projectHashOf(fx.dir) };
  running.push(result);
  return result;
}

afterEach(() => {
  for (const tab of clients.splice(0)) tab.close();
  for (const item of running.splice(0)) {
    for (const store of item.daemon.sessions.values()) store.dispose();
    item.daemon.dispose();
    try { item.server.closeAllConnections?.(); } catch {}
    try { item.server.close(); } catch {}
    item.fx.dispose();
  }
});

/** A companion tab: a real socket that records every frame it receives. */
class Tab {
  readonly frames: Array<Record<string, unknown>> = [];
  private readonly ws: WebSocket;
  readonly open: Promise<void>;
  constructor(base: string, hash: string, sessionId?: string) {
    const query = new URLSearchParams({ projectHash: hash });
    if (sessionId) query.set("sessionId", sessionId);
    this.ws = new WebSocket(`${base}/ws?${query}`);
    this.ws.on("message", (data) => this.frames.push(JSON.parse(String(data)) as Record<string, unknown>));
    this.open = new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
    clients.push(this);
  }
  send(frame: unknown): void { this.ws.send(typeof frame === "string" ? frame : JSON.stringify(frame)); }
  of(type: string) { return this.frames.filter((frame) => frame.type === type); }
  async next(type: string, count = 1): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 5_000;
    while (this.of(type).length < count) {
      if (Date.now() > deadline) throw new Error(`No ${type} frame #${count}; got ${JSON.stringify(this.frames)}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return this.of(type)[count - 1]!;
  }
  get isOpen(): boolean { return this.ws.readyState === WebSocket.OPEN; }
  close(): void { try { this.ws.close(); } catch {} }
}

async function tab(r: Running, sessionId?: string): Promise<Tab> {
  const t = new Tab(r.base, r.hash, sessionId);
  await t.open;
  return t;
}

/** Every file in the session directory with its bytes — "no write" means equal. */
function snapshotDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isFile()) out[name] = fs.readFileSync(file, "utf8");
  }
  return out;
}

const settle = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));

function standalone(r: Running) {
  const sessionId = createStandaloneSessionId(r.fx.dir);
  const store = r.daemon.createSession(sessionId);
  store.createArtifact({ id: "a1", type: "code_change", title: "Change", content: { filePath: "a.ts", diff: "-a\n+b" } });
  store.forceFlush();
  const dir = path.join(r.fx.dir, ".deeppairing", "sessions", sessionId);
  return { sessionId, store, dir, markerPath: path.join(dir, "review-ended.json") };
}

describe("#711 gate 4 — companion socket End state", () => {
  it("pushes exactly one review_ended to tabs open before End, with the marker's endedAt", async () => {
    const r = await start();
    const { sessionId } = standalone(r);
    const before = await tab(r, sessionId);
    const sibling = await tab(r, sessionId);
    await before.next("connected");
    await sibling.next("connected");
    expect(before.of("review_ended")).toEqual([]);

    const marker = await r.daemon.standaloneCloseout.end(sessionId);
    const pushed = ReviewEndedEventSchema.parse(await before.next("review_ended"));
    expect(pushed).toEqual({ type: "review_ended", sessionId, endedAt: marker.endedAt, code: ERROR_CODES.session_ended });
    expect(await sibling.next("review_ended")).toEqual(pushed);
    // End again is idempotent on the marker and does not re-announce.
    await r.daemon.standaloneCloseout.end(sessionId);
    await settle();
    expect(before.of("review_ended")).toHaveLength(1);
    expect(sibling.of("review_ended")).toHaveLength(1);
  });

  it("gives a tab that connects during closing exactly one review_ended, from the broadcast, once End completes", async () => {
    const r = await start();
    const { sessionId, markerPath } = standalone(r);
    const releaseWriter = r.daemon.standaloneCloseout.admitWrite(sessionId);
    expect(releaseWriter).toBeTypeOf("function");
    const ending = r.daemon.standaloneCloseout.end(sessionId);
    let during: Tab;
    try {
      expect(r.daemon.standaloneCloseout.state(sessionId)).toEqual({ state: "closing" });
      during = await tab(r, sessionId);
      await during.next("connected");
      await settle();
      expect(during.frames.map((frame) => frame.type)).toEqual(["connected"]);
      expect(fs.existsSync(markerPath)).toBe(false);
    } finally {
      releaseWriter!();
    }
    const marker = await ending;
    expect(await during!.next("review_ended")).toEqual({ type: "review_ended", sessionId, endedAt: marker.endedAt, code: ERROR_CODES.session_ended });
    await settle();
    expect(during!.frames.map((frame) => frame.type)).toEqual(["connected", "review_ended"]);
  });

  it("sends nothing for a failed End, then broadcasts once when a later End succeeds", async () => {
    const r = await start();
    const { sessionId, store, markerPath } = standalone(r);
    const t = await tab(r, sessionId);
    await t.next("connected");

    // A fake flush failure at the closeout's final flush (an own-property
    // override on the real store, removed after one call).
    const realFlush = store.forceFlush.bind(store);
    Object.defineProperty(store, "forceFlush", {
      configurable: true, writable: true,
      value: () => {
        delete (store as unknown as Record<string, unknown>).forceFlush;
        throw new Error("Closeout flush interrupted");
      },
    });
    await expect(r.daemon.standaloneCloseout.end(sessionId)).rejects.toThrow("Closeout flush interrupted");
    await settle();
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(r.daemon.standaloneCloseout.state(sessionId)).toEqual({ state: "open" });
    expect(t.of("review_ended")).toEqual([]);
    realFlush();

    const marker = await r.daemon.standaloneCloseout.end(sessionId);
    expect(await t.next("review_ended")).toMatchObject({ sessionId, endedAt: marker.endedAt, code: ERROR_CODES.session_ended });
    await settle();
    expect(t.of("review_ended")).toHaveLength(1);
  });

  it("tells a tab that connects after End, from the marker, without loading a writable store", async () => {
    const r = await start();
    const { sessionId, dir } = standalone(r);
    const marker = await r.daemon.standaloneCloseout.end(sessionId);

    // Loaded store: connected first, then the End state.
    const late = await tab(r, sessionId);
    await late.next("review_ended");
    expect(late.frames.map((frame) => frame.type)).toEqual(["connected", "review_ended"]);
    expect(late.of("review_ended")[0]).toEqual({ type: "review_ended", sessionId, endedAt: marker.endedAt, code: ERROR_CODES.session_ended });

    // Not loaded (e.g. a daemon restart): the read-only snapshot hydrates the
    // tab and the marker reports End; no FileStore is constructed or warmed.
    r.daemon.sessions.get(sessionId)!.dispose();
    r.daemon.sessions.delete(sessionId);
    const diskBefore = snapshotDir(dir);
    const cold = await tab(r, sessionId);
    await cold.next("review_ended");
    expect(cold.frames.map((frame) => frame.type)).toEqual(["connected", "review_ended"]);
    const state = cold.of("connected")[0]!.state as { artifacts: Array<{ id: string }> };
    expect(state.artifacts.map((artifact) => artifact.id)).toEqual(["a1"]);
    expect(r.daemon.sessions.has(sessionId)).toBe(false);
    expect(snapshotDir(dir)).toEqual(diskBefore);
  });

  // The read-only reader is tolerant of damaged collections (it falls back
  // rather than throwing), so its failure modes are injected with a fake
  // replacement of the static for one connect each.
  it.each([
    ["throws", () => { throw new Error("snapshot unreadable"); }],
    ["returns null", () => null],
  ] as const)("still sends review_ended, and keeps the socket open, when a cold ended review's snapshot %s", async (_label, fake) => {
    const r = await start();
    const { sessionId, dir } = standalone(r);
    const marker = await r.daemon.standaloneCloseout.end(sessionId);
    r.daemon.sessions.get(sessionId)!.dispose();
    r.daemon.sessions.delete(sessionId);
    const diskBefore = snapshotDir(dir);
    const real = FileStore.readSessionSnapshot;
    let calls = 0;
    FileStore.readSessionSnapshot = (() => { calls++; return fake(); }) as typeof FileStore.readSessionSnapshot;
    let cold: Tab;
    try {
      cold = await tab(r, sessionId);
      await cold.next("review_ended");
    } finally {
      FileStore.readSessionSnapshot = real;
    }
    await settle();
    expect(calls).toBe(1);
    // No `connected` (there is no snapshot to hydrate), but End still reaches
    // the tab and the connection survives as a subscriber.
    expect(cold!.frames).toEqual([{ type: "review_ended", sessionId, endedAt: marker.endedAt, code: ERROR_CODES.session_ended }]);
    expect(cold!.isOpen).toBe(true);
    expect(r.daemon.getClientCount()).toBe(1);
    expect(r.daemon.sessions.has(sessionId)).toBe(false);
    expect(snapshotDir(dir)).toEqual(diskBefore);
  });

  it("reports a damaged End marker on connect as session_marker_invalid", async () => {
    const r = await start();
    const { sessionId, markerPath } = standalone(r);
    fs.writeFileSync(markerPath, "{ damaged");
    const t = await tab(r, sessionId);
    expect(ReviewEndedEventSchema.parse(await t.next("review_ended"))).toMatchObject({
      sessionId, code: ERROR_CODES.session_marker_invalid,
    });
    expect(t.frames.map((frame) => frame.type)).toEqual(["connected", "review_ended"]);
  });

  it("stays send-only, and sends no End frame for wrapper sessions", async () => {
    const r = await start();
    r.daemon.createSession("wrapper-1");
    const t = await tab(r, "wrapper-1");
    await t.next("connected");
    t.send({ type: "comment", content: "Writes are HTTP routes" });
    t.send("not json");
    await settle();
    expect(t.frames.map((frame) => frame.type)).toEqual(["connected"]);
    expect(t.isOpen).toBe(true);
  });
});
