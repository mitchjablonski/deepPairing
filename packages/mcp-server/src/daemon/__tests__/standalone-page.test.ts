/**
 * #679/#680 — `deeppairing present page` through the authenticated daemon
 * route: the same presentPage() handler as MCP (gate, contained file read),
 * request-ID receipts, the measured body cap, and the file watch.
 *
 * Fakes, not mocks: the real createDaemon factory and routes, a real FileStore
 * on a temp project, real files and symlinks, and a fake directory watcher the
 * test fires (the factory's `pageWatch` seam).
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PAGE_HTML_MAX_BYTES, readFileWatch } from "@deeppairing/shared";
import { withGlobalStore } from "../../__tests__/global-store-fixture.js";
import { STANDALONE_PAGE_MAX_BODY_BYTES } from "../../http/guards.js";
import { projectHashOf } from "../../project-root.js";
import { createStandaloneSessionId } from "../../standalone-session-id.js";
import { createDaemon, type Daemon } from "../create-daemon.js";

const b64 = (html: string | Buffer) => Buffer.from(html).toString("base64");
const page = (html: string, extra: Record<string, unknown> = {}) => ({ title: "Replay backend", htmlBase64: b64(html), ...extra });

const until = async (cond: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

function fixture() {
  const fx = withGlobalStore("dp-cli-page-");
  const root = fx.dir;
  const sessionId = createStandaloneSessionId(root);
  const daemons: Daemon[] = [];
  const watchers: Array<{ dir: string; fire: (name: string) => void; closed: boolean }> = [];
  const start = () => {
    const daemon = createDaemon({
      projectRoot: root, authToken: "test-token", log: () => {},
      exitProcess: () => {}, releaseListenSocket: () => {}, env: {},
      pageWatch: {
        watch: (dir, listener) => {
          const w = { dir, closed: false, fire: (name: string) => { if (!w.closed) listener("change", name); } };
          watchers.push(w);
          return { close: () => { w.closed = true; } };
        },
        pollIntervalMs: 0, quietMs: 20, minIntervalMs: 0,
      },
    });
    daemons.push(daemon);
    return daemon;
  };
  const request = (daemon: Daemon, route: string, body: object, opts: { authenticated?: boolean; session?: string; raw?: string } = {}) =>
    daemon.app.request(`http://localhost/api/internal/sessions/${opts.session ?? sessionId}/${route}`, {
      method: "POST",
      headers: {
        Host: "localhost", "Content-Type": "application/json", "X-Project-Hash": projectHashOf(root),
        ...(opts.authenticated === false ? {} : { Authorization: "Bearer test-token" }),
      },
      body: opts.raw ?? JSON.stringify({ expectedProjectRoot: root, ...body }),
    });
  const open = async (daemon: Daemon, session = sessionId) =>
    expect((await request(daemon, "open-review", { mode: "open" }, { session })).status).toBe(200);
  const present = (daemon: Daemon, operationId: string, args: object, session = sessionId) =>
    request(daemon, "present-page", { operationId, args }, { session });
  return {
    root, sessionId, watchers, start, request, open, present,
    dispose: () => {
      for (const daemon of daemons) {
        for (const store of daemon.sessions.values()) store.dispose();
        daemon.dispose();
      }
      fx.dispose();
    },
  };
}

describe("authenticated standalone page", () => {
  it("presents an inline page, replays the same request ID, and refuses changed input on it", async () => {
    const f = fixture();
    try {
      const daemon = f.start();
      await f.open(daemon);
      const op = randomUUID();
      const input = page("<h1>Replay</h1><p>Keep a local replay file.</p>", { summary: "Which backend?" });
      const first = await (await f.present(daemon, op, input)).json();
      expect(first.isError).toBeUndefined();
      const artifactId = first.structuredContent.artifactId as string;
      expect(artifactId).toMatch(/^art_[0-9a-f]{32}$/);
      const store = daemon.sessions.get(f.sessionId)!;
      expect(store.getArtifacts()).toMatchObject([{
        id: artifactId, type: "page", status: "draft",
        content: { title: "Replay backend", summary: "Which backend?", html: "<h1>Replay</h1><p>Keep a local replay file.</p>" },
      }]);
      expect((store.getArtifacts()[0]!.content as { sourcePath?: string }).sourcePath).toBeUndefined();
      expect(daemon.activeSessions.size).toBe(0); // no wrapper lease was granted

      expect(await (await f.present(daemon, op, input)).json()).toMatchObject({ structuredContent: { artifactId, replayed: true } });
      // A replay survives a daemon restart (the receipt is durable).
      store.dispose();
      daemon.dispose();
      const second = f.start();
      expect((await f.request(second, "open-review", { mode: "resume" })).status).toBe(200);
      expect(await (await f.present(second, op, input)).json()).toMatchObject({ structuredContent: { artifactId, replayed: true } });

      const changed = await (await f.present(second, op, page("<p>Different page</p>"))).json();
      expect(changed).toMatchObject({ isError: true, structuredContent: { code: "standalone_operation_conflict" } });
      expect(changed.content[0].text).toContain("use a new UUID for changed input");
      expect(second.sessions.get(f.sessionId)!.getArtifacts()).toHaveLength(1);
      expect(fs.statSync(path.join(f.root, ".deeppairing", "sessions", f.sessionId, `present-page-${op}.json`)).mode & 0o777).toBe(0o600);
    } finally {
      f.dispose();
    }
  });

  it("runs the rejection gate on the page text and returns the stored reason verbatim", async () => {
    const f = fixture();
    try {
      const daemon = f.start();
      await f.open(daemon);
      const store = daemon.sessions.get(f.sessionId)!;
      const reason = "No operators for this dependency — we can't page anyone at 3am for Redis.";
      store.recordRejectedApproach({ description: "Redis Streams", concept: "Redis Streams", reason });
      const op = randomUUID();
      const refused = await (await f.present(daemon, op, page("<p>Use Redis Streams for event replay.</p>", { concept: "Redis Streams" }))).json();
      expect(refused).toMatchObject({ isError: true, structuredContent: { code: "rejected_approach_blocked", reason } });
      expect(store.getArtifacts()).toHaveLength(0);
      // Nothing was written, so the same request ID with the same input is gated again, not replayed.
      expect(await (await f.present(daemon, op, page("<p>Use Redis Streams for event replay.</p>", { concept: "Redis Streams" }))).json())
        .toMatchObject({ isError: true, structuredContent: { code: "rejected_approach_blocked", reason } });
      expect(store.getArtifacts()).toHaveLength(0);
    } finally {
      f.dispose();
    }
  });

  it("refuses paths outside the project, absolute paths and symlink escapes through presentPage's reader", async () => {
    const f = fixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dp-page-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.html"), "<p>outside the project</p>");
      fs.mkdirSync(path.join(f.root, "docs"));
      fs.symlinkSync(path.join(outside, "secret.html"), path.join(f.root, "docs", "link.html"));
      const daemon = f.start();
      await f.open(daemon);
      const store = daemon.sessions.get(f.sessionId)!;

      const relativeEscape = await (await f.present(daemon, randomUUID(), { title: "Escape", path: "../secret.html" })).json();
      expect(relativeEscape).toMatchObject({ isError: true, _meta: { code: "INPUT_VALIDATION_FAILED" } });
      expect(relativeEscape.content[0].text).toContain("outside the project root");

      const absolute = await (await f.present(daemon, randomUUID(), { title: "Absolute", path: path.join(f.root, "docs", "link.html") })).json();
      expect(absolute).toMatchObject({ isError: true, _meta: { code: "INPUT_VALIDATION_FAILED" } });
      expect(absolute.content[0].text).toContain("must be relative to the project root");

      const symlink = await (await f.present(daemon, randomUUID(), { title: "Symlink", path: "docs/link.html" })).json();
      expect(symlink).toMatchObject({ isError: true, _meta: { code: "INPUT_VALIDATION_FAILED" } });
      expect(symlink.content[0].text).toContain("through a symlink");

      expect(store.getArtifacts()).toHaveLength(0);
      expect(f.watchers).toHaveLength(0);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
      f.dispose();
    }
  });

  it("caps the inline page at exactly PAGE_HTML_MAX_BYTES, measures the body, and requires the bearer", async () => {
    const f = fixture();
    try {
      const daemon = f.start();
      await f.open(daemon);
      const store = daemon.sessions.get(f.sessionId)!;
      const atCap = `<p>${"x".repeat(PAGE_HTML_MAX_BYTES - 7)}</p>`;
      expect(Buffer.byteLength(atCap)).toBe(PAGE_HTML_MAX_BYTES);

      expect((await f.request(daemon, "present-page", { operationId: randomUUID(), args: page(atCap) }, { authenticated: false })).status).toBe(401);
      expect(store.getArtifacts()).toHaveLength(0);

      const over = await f.present(daemon, randomUUID(), page(atCap + "x"));
      expect(over.status).toBe(413);
      expect(await over.json()).toMatchObject({ code: "body_too_large", error: expect.stringContaining("page cap") });

      // A body past the measured ceiling is refused by the stream limiter, before parsing.
      const padded = await f.present(daemon, randomUUID(), page("<p>small</p>", { summary: "s".repeat(STANDALONE_PAGE_MAX_BODY_BYTES) }));
      expect(padded.status).toBe(413);
      expect(await padded.json()).toMatchObject({ code: "body_too_large", error: expect.stringContaining("standalone page cap") });
      // The ordinary 512 KiB artifact lane still caps present-options.
      const optionsTooBig = await f.request(daemon, "present-options", { operationId: randomUUID(), args: { context: "x".repeat(600 * 1024) } });
      expect(optionsTooBig.status).toBe(413);
      expect(store.getArtifacts()).toHaveLength(0);

      const ok = await f.present(daemon, randomUUID(), page(atCap));
      expect(ok.status).toBe(200);
      expect((await ok.json()).structuredContent.artifactId).toMatch(/^art_/);
      expect(store.getArtifacts()).toHaveLength(1);
    } finally {
      f.dispose();
    }
  });

  it("keeps standalone sessions isolated and refuses unknown or foreign sessions", async () => {
    const f = fixture();
    try {
      const daemon = f.start();
      const other = createStandaloneSessionId(f.root);
      await f.open(daemon);
      await f.open(daemon, other);
      const op = randomUUID();
      const input = page("<p>Same request, two sessions.</p>");
      const a = await (await f.present(daemon, op, input)).json();
      const b = await (await f.present(daemon, op, input, other)).json();
      expect(a.structuredContent.replayed).toBeUndefined();
      expect(b.structuredContent.replayed).toBeUndefined();
      expect(a.structuredContent.artifactId).not.toBe(b.structuredContent.artifactId);
      expect(daemon.sessions.get(f.sessionId)!.getArtifacts().map((x) => x.id)).toEqual([a.structuredContent.artifactId]);
      expect(daemon.sessions.get(other)!.getArtifacts().map((x) => x.id)).toEqual([b.structuredContent.artifactId]);

      const missing = createStandaloneSessionId(f.root);
      expect((await f.present(daemon, randomUUID(), input, missing)).status).toBe(404);
      expect(daemon.sessions.has(missing)).toBe(false);
      const foreign = createStandaloneSessionId(path.join(f.root, "elsewhere"));
      expect((await f.present(daemon, randomUUID(), input, foreign)).status).toBe(403);
      expect((await f.present(daemon, randomUUID(), input, "session_legacy")).status).toBe(403);
    } finally {
      f.dispose();
    }
  });

  it("presents a project-relative path as a file-backed page that the watcher records on save", async () => {
    const f = fixture();
    try {
      fs.mkdirSync(path.join(f.root, "docs"));
      fs.writeFileSync(path.join(f.root, "docs", "plan.html"), "<p>one</p>");
      const daemon = f.start();
      await f.open(daemon);
      const op = randomUUID();
      const input = { title: "Plan page", path: "docs/plan.html" };
      const result = await (await f.present(daemon, op, input)).json();
      expect(result.structuredContent).toMatchObject({ artifactId: expect.stringMatching(/^art_/), sourcePath: "docs/plan.html" });
      const artifactId = result.structuredContent.artifactId as string;
      const store = daemon.sessions.get(f.sessionId)!;
      expect(store.getArtifacts()).toMatchObject([{ id: artifactId, content: { html: "<p>one</p>", sourcePath: "docs/plan.html" } }]);

      // The artifact_created broadcast synced the watch, with no wrapper lease.
      await until(() => f.watchers.length === 1);
      expect(daemon.pageWatcher.watched(f.sessionId)).toEqual([artifactId]);
      expect(daemon.activeSessions.size).toBe(0);

      fs.writeFileSync(path.join(f.root, "docs", "plan.html"), "<p>two</p>");
      f.watchers[0]!.fire("plan.html");
      await until(() => store.getArtifacts().length === 2);
      await daemon.pageWatcher.idle();
      const v2 = store.getArtifacts().find((a) => a.parentId === artifactId)!;
      expect(v2).toMatchObject({ version: 2, content: { html: "<p>two</p>", sourcePath: "docs/plan.html" } });
      expect(readFileWatch(v2.fileWatch).recorded?.fromArtifactId).toBe(artifactId);

      // A retry of the original call replays v1; the file's later save is not "changed input".
      expect(await (await f.present(daemon, op, input)).json()).toMatchObject({
        structuredContent: { artifactId, sourcePath: "docs/plan.html", replayed: true },
      });
      expect(store.getArtifacts()).toHaveLength(2);
    } finally {
      f.dispose();
    }
  });
});
