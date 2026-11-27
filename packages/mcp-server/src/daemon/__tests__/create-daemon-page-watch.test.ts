/**
 * #680 slice 3 — the page file watch WIRED through the real createDaemon
 * factory: an artifact-changing broadcast syncs the watch, a save records a
 * version, and unregistering the wrapper stops the watch.
 *
 * Fakes, not mocks: the real factory and routes, a real FileStore on a temp
 * project, real files, and a fake directory watcher the test fires (the
 * factory's `pageWatch` seam). Tiny quiet/rate timings keep it on real timers.
 */
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readFileWatch } from "@deeppairing/shared";
import { createDaemon, type Daemon } from "../create-daemon.js";
import { projectHashOf } from "../../project-root.js";
import { createStandaloneSessionId } from "../../standalone-session-id.js";
import { preflightRejectedApproaches } from "../../mcp/tool-helpers.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";

let fx: GlobalStoreFixture;
let daemon: Daemon;
const watchers: Array<{ fire: (name: string) => void; closed: boolean }> = [];

afterEach(() => {
  for (const s of daemon.sessions.values()) s.dispose();
  daemon.dispose();
  fx.dispose();
  watchers.length = 0;
});

const until = async (cond: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("createDaemon — page file watch wiring", () => {
  it("broadcast → sync → record on save; unregister → stop", async () => {
    fx = withGlobalStore("dp-daemon-pagewatch-");
    const root = fx.dir;
    fs.mkdirSync(path.join(root, "docs"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "p.html"), "<p>one</p>");
    daemon = createDaemon({
      projectRoot: root,
      authToken: "tok",
      log: () => {},
      exitProcess: () => {},
      releaseListenSocket: () => {},
      env: {},
      pageWatch: {
        watch: (_dir, listener) => {
          const w = { closed: false, fire: (name: string) => { if (!w.closed) listener("change", name); } };
          watchers.push(w);
          return { close: () => { w.closed = true; } };
        },
        pollIntervalMs: 0,
        quietMs: 20,
        minIntervalMs: 0,
      },
    });
    const headers = { Authorization: "Bearer tok", "X-Project-Hash": projectHashOf(root), "Content-Type": "application/json" };
    const internal = (p: string, body: unknown) =>
      daemon.app.request(`/api/internal/sessions/s1/${p}`, { method: "POST", headers, body: JSON.stringify(body) });

    expect((await internal("register", {})).status).toBe(200);
    const created = await internal("artifacts", {
      id: "art_p1", type: "page", title: "Page", content: { title: "Page", html: "<p>one</p>", sourcePath: "docs/p.html" },
    });
    expect(created.status).toBe(200);
    await until(() => watchers.length === 1); // the artifact_created broadcast synced the watch
    expect(daemon.pageWatcher.watched("s1")).toEqual(["art_p1"]);

    fs.writeFileSync(path.join(root, "docs", "p.html"), "<p>two</p>");
    watchers[0]!.fire("p.html");
    const store = daemon.sessions.get("s1")!;
    await until(() => store.getArtifacts().length === 2);
    await daemon.pageWatcher.idle();
    const v2 = store.getArtifacts().find((a) => a.parentId === "art_p1")!;
    expect((v2.content as { html: string }).html).toBe("<p>two</p>");
    expect(readFileWatch(v2.fileWatch).recorded?.fromArtifactId).toBe("art_p1");
    await until(() => daemon.pageWatcher.watched("s1")[0] === v2.id);

    expect((await internal("unregister", {})).status).toBe(200);
    expect(daemon.pageWatcher.watched("s1")).toEqual([]);
    expect(watchers.every((w) => w.closed)).toBe(true);
  });

  it("drains an admitted save, refuses new standalone writes, and stops only the ended review", async () => {
    fx = withGlobalStore("dp-daemon-pagewatch-end-");
    const root = fx.dir;
    const sessionId = createStandaloneSessionId(root);
    const siblingId = createStandaloneSessionId(root);
    fs.writeFileSync(path.join(root, "first.html"), "<p>one</p>");
    fs.writeFileSync(path.join(root, "second.html"), "<p>sibling</p>");
    let gateEntered = false;
    let releaseGate!: () => void;
    const gateReleased = new Promise<void>((resolve) => { releaseGate = resolve; });
    daemon = createDaemon({
      projectRoot: root,
      authToken: "tok",
      log: () => {},
      exitProcess: () => {},
      releaseListenSocket: () => {},
      env: {},
      pageWatch: {
        watch: (_dir, listener) => {
          const w = { closed: false, fire: (name: string) => { if (!w.closed) listener("change", name); } };
          watchers.push(w);
          return { close: () => { w.closed = true; } };
        },
        pollIntervalMs: 0,
        quietMs: 0,
        minIntervalMs: 0,
        gate: async (...args) => {
          gateEntered = true;
          await gateReleased;
          return preflightRejectedApproaches(...args);
        },
      },
    });
    const headers = { Authorization: "Bearer tok", "X-Project-Hash": projectHashOf(root), "Content-Type": "application/json" };
    const internal = (id: string, command: string, body: Record<string, unknown>) =>
      daemon.app.request(`/api/internal/sessions/${id}/${command}`, {
        method: "POST", headers, body: JSON.stringify({ ...body, expectedProjectRoot: root }),
      });
    for (const [id, source] of [[sessionId, "first.html"], [siblingId, "second.html"]] as const) {
      expect((await internal(id, "open-review", { mode: "open" })).status).toBe(200);
      const created = await internal(id, "present-page", { operationId: randomUUID(), args: { title: "Page", path: source } });
      expect(await created.json()).toMatchObject({ structuredContent: { sourcePath: source } });
    }
    await until(() => watchers.length === 2);

    fs.writeFileSync(path.join(root, "first.html"), "<p>two</p>");
    watchers[0]!.fire("first.html");
    await until(() => gateEntered);
    const ending = daemon.standaloneCloseout.end(sessionId);
    const store = daemon.sessions.get(sessionId)!;
    const artifactId = store.getArtifacts()[0]!.id;
    const operationId = randomUUID();
    const writes = [
      ["present-options", { operationId, args: {} }],
      ["present-page", { operationId, args: { path: "first.html" } }],
      ["revise-page", { operationId, artifactId, htmlBase64: "PHA+dGhyZWU8L3A+", reason: "Updated" }],
    ] as const;
    try {
      for (const [command, body] of writes) {
        const result = await internal(sessionId, command, body);
        expect(result.status).toBe(409);
        expect(await result.json()).toMatchObject({ code: "session_closing" });
      }
      expect(daemon.standaloneCloseout.state(sessionId)).toEqual({ state: "closing" });
    } finally {
      releaseGate();
      await ending;
    }
    expect(store.getArtifacts()).toHaveLength(2);
    expect(daemon.pageWatcher.watched(sessionId)).toEqual([]);
    expect(daemon.pageWatcher.watched(siblingId)).toHaveLength(1);
    expect(watchers[0]!.closed).toBe(true);
    expect(watchers[1]!.closed).toBe(false);

    // Simulate a cold review while retaining the same daemon factory routes.
    store.dispose();
    daemon.sessions.delete(sessionId);
    for (const [command, body] of writes.slice(0, 2)) {
      const result = await internal(sessionId, command, body);
      expect(result.status).toBe(409);
      expect(await result.json()).toMatchObject({ code: "session_ended" });
      expect(daemon.sessions.has(sessionId)).toBe(false);
    }
    expect((await internal(sessionId, "open-review", { mode: "resume" })).status).toBe(200);
    daemon.pageWatcher.sync(sessionId);
    expect(daemon.pageWatcher.watched(sessionId)).toEqual([]);
    expect(watchers).toHaveLength(2);
    expect(fs.readdirSync(path.join(root, ".deeppairing", "sessions", sessionId)).some((name) => name.includes(operationId))).toBe(false);
  });
});
