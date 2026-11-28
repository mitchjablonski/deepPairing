/**
 * #711 gate 4 — the companion WebSocket carries a standalone review's End.
 *
 * Driven through the real createDaemon factory, a real HTTP server and real
 * `ws` clients (fakes, not mocks): a tab open before End hears `review_ended`
 * when closeout completes; a tab connecting after End learns it on connect from
 * the durable marker (without warming a writable store); a write candidate on
 * the socket gets the HTTP codes — `session_closing`, `session_ended`,
 * `session_marker_invalid` — with no write, broadcast or activity stamp; and
 * read-only frames keep working throughout.
 */
import { afterEach, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { ReviewEndedEventSchema, ReviewStateEventSchema, SocketMessageRefusedEventSchema } from "@deeppairing/shared";
import { createDaemon, type Daemon } from "../create-daemon.js";
import { handleSocketMessage, type SocketAdmission } from "../socket-messages.js";
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

const WRITE = { type: "comment", requestId: "w1", content: "Should not land" };

describe("#711 gate 4 — companion socket End state", () => {
  it("refuses socket writes while closing and after End, pushes review_ended to an open tab, keeps reads working", async () => {
    const r = await start();
    const sessionId = createStandaloneSessionId(r.fx.dir);
    const store = r.daemon.createSession(sessionId);
    store.createArtifact({ id: "a1", type: "code_change", title: "Change", content: { filePath: "a.ts", diff: "-a\n+b" } });
    store.forceFlush();
    const dir = path.join(r.fx.dir, ".deeppairing", "sessions", sessionId);
    const markerPath = path.join(dir, "review-ended.json");

    const before = await tab(r, sessionId);
    const bystander = await tab(r, sessionId);
    await before.next("connected");
    await bystander.next("connected");
    expect(before.of("review_ended")).toEqual([]);

    // Open: reads answer; an unregistered write type is admitted then refused
    // `unsupported` — the socket has no write path of its own.
    before.send({ type: "review_state", requestId: "r0" });
    expect(await before.next("review_state")).toEqual({ type: "review_state", sessionId, state: "open", requestId: "r0" });
    before.send(WRITE);
    expect(await before.next("message_refused")).toMatchObject({ code: ERROR_CODES.unsupported, messageType: "comment", requestId: "w1" });

    // Closing: hold an admitted writer so End parks in its drain.
    const releaseWriter = r.daemon.standaloneCloseout.admitWrite(sessionId);
    expect(releaseWriter).toBeTypeOf("function");
    const ending = r.daemon.standaloneCloseout.end(sessionId);
    try {
      const diskBefore = snapshotDir(dir);
      const metaBefore = JSON.stringify(r.daemon.sessionMeta.get(sessionId) ?? null);
      const bystanderFrames = bystander.frames.length;
      before.send(WRITE);
      const closing = await before.next("message_refused", 2);
      expect(SocketMessageRefusedEventSchema.parse(closing)).toMatchObject({
        sessionId, requestId: "w1", messageType: "comment", code: ERROR_CODES.session_closing,
      });
      before.send({ type: "review_state" });
      expect(await before.next("review_state", 2)).toMatchObject({ state: "closing", code: ERROR_CODES.session_closing });
      before.send({ type: "ping", requestId: "p1" });
      expect(await before.next("pong")).toEqual({ type: "pong", requestId: "p1" });
      // No write, no broadcast, no activity stamp, no marker yet.
      expect(snapshotDir(dir)).toEqual(diskBefore);
      expect(JSON.stringify(r.daemon.sessionMeta.get(sessionId) ?? null)).toBe(metaBefore);
      expect(bystander.frames.length).toBe(bystanderFrames);
      expect(fs.existsSync(markerPath)).toBe(false);
      expect(before.of("review_ended")).toEqual([]);
    } finally {
      releaseWriter!();
    }
    const marker = await ending;

    // The pre-End tab (and its sibling) hear End from the closeout itself.
    const pushed = ReviewEndedEventSchema.parse(await before.next("review_ended"));
    expect(pushed).toEqual({ type: "review_ended", sessionId, endedAt: marker.endedAt, code: ERROR_CODES.session_ended });
    expect(await bystander.next("review_ended")).toMatchObject({ endedAt: marker.endedAt });

    // Ended: the write is refused `session_ended`, nothing lands or broadcasts.
    const diskEnded = snapshotDir(dir);
    const bystanderFrames = bystander.frames.length;
    before.send(WRITE);
    expect(await before.next("message_refused", 3)).toMatchObject({ code: ERROR_CODES.session_ended, sessionId });
    before.send({ type: "review_state" });
    expect(ReviewStateEventSchema.parse(await before.next("review_state", 3))).toMatchObject({
      state: "ended", endedAt: marker.endedAt, code: ERROR_CODES.session_ended,
    });
    expect(snapshotDir(dir)).toEqual(diskEnded);
    expect(bystander.frames.length).toBe(bystanderFrames);
  });

  it("tells a tab that connects after End, from the marker, without loading a writable store", async () => {
    const r = await start();
    const sessionId = createStandaloneSessionId(r.fx.dir);
    const store = r.daemon.createSession(sessionId);
    store.createArtifact({ id: "a1", type: "code_change", title: "Change", content: { filePath: "a.ts", diff: "-a\n+b" } });
    const marker = await r.daemon.standaloneCloseout.end(sessionId);
    const dir = path.join(r.fx.dir, ".deeppairing", "sessions", sessionId);

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
    cold.send(WRITE);
    expect(await cold.next("message_refused")).toMatchObject({ code: ERROR_CODES.session_ended });
    expect(r.daemon.sessions.has(sessionId)).toBe(false);
    expect(snapshotDir(dir)).toEqual(diskBefore);
  });

  it("refuses with session_marker_invalid on a damaged End marker, on connect and on write", async () => {
    const r = await start();
    const sessionId = createStandaloneSessionId(r.fx.dir);
    r.daemon.createSession(sessionId).forceFlush();
    const dir = path.join(r.fx.dir, ".deeppairing", "sessions", sessionId);
    fs.writeFileSync(path.join(dir, "review-ended.json"), "{ damaged");
    const diskBefore = snapshotDir(dir);

    const t = await tab(r, sessionId);
    expect(ReviewEndedEventSchema.parse(await t.next("review_ended"))).toMatchObject({
      sessionId, code: ERROR_CODES.session_marker_invalid,
    });
    t.send(WRITE);
    expect(await t.next("message_refused")).toMatchObject({ code: ERROR_CODES.session_marker_invalid, sessionId });
    t.send({ type: "review_state" });
    expect(await t.next("review_state")).toMatchObject({ state: "marker_invalid", code: ERROR_CODES.session_marker_invalid });
    expect(snapshotDir(dir)).toEqual(diskBefore);
  });

  it("leaves wrapper sessions and global tabs without End frames", async () => {
    const r = await start();
    r.daemon.createSession("wrapper-1");
    const t = await tab(r, "wrapper-1");
    await t.next("connected");
    t.send({ type: "review_state" });
    expect(await t.next("review_state")).toEqual({ type: "review_state", sessionId: "wrapper-1", state: "open" });
    const global = await tab(r);
    await global.next("connected");
    global.send(WRITE);
    expect(await global.next("message_refused")).toMatchObject({ code: ERROR_CODES.unsupported });
    global.send("not json");
    expect(await global.next("message_refused", 2)).toMatchObject({ code: ERROR_CODES.validation_error });
    expect(t.of("review_ended")).toEqual([]);
  });
});

describe("handleSocketMessage — admission precedes every write handler", () => {
  function harness(admission: SocketAdmission) {
    const events: string[] = [];
    const replies: Array<Record<string, unknown>> = [];
    const ctx = {
      sessionId: "s1",
      admit: () => { events.push("admit"); return admission; },
      reviewState: () => null,
      reply: (frame: Record<string, unknown>) => { replies.push(frame); },
      mutations: { comment: () => { events.push("handler"); } },
    };
    return { events, replies, ctx };
  }

  it("never runs the handler on a refusal", async () => {
    const { events, replies, ctx } = harness({ refusal: { code: ERROR_CODES.session_closing, message: "closing" } });
    await handleSocketMessage(JSON.stringify({ type: "comment" }), ctx);
    expect(events).toEqual(["admit"]);
    expect(replies).toEqual([{ type: "message_refused", sessionId: "s1", messageType: "comment", code: ERROR_CODES.session_closing, message: "closing" }]);
  });

  it("runs the handler inside the admission and releases after it settles", async () => {
    const { events, ctx } = harness({ release: () => events.push("release") });
    await handleSocketMessage(JSON.stringify({ type: "comment" }), ctx);
    expect(events).toEqual(["admit", "handler", "release"]);
  });

  it("answers read-only frames without admission", async () => {
    const { events, replies, ctx } = harness({ refusal: { code: ERROR_CODES.session_ended, message: "ended" } });
    await handleSocketMessage(JSON.stringify({ type: "ping" }), ctx);
    await handleSocketMessage(JSON.stringify({ type: "review_state" }), ctx);
    expect(events).toEqual([]);
    expect(replies).toEqual([{ type: "pong" }, { type: "review_state", sessionId: "s1", state: "open" }]);
  });
});
