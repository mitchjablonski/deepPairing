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
import fs from "node:fs";
import path from "node:path";
import { readFileWatch } from "@deeppairing/shared";
import { createDaemon, type Daemon } from "../create-daemon.js";
import { projectHashOf } from "../../project-root.js";
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
});
