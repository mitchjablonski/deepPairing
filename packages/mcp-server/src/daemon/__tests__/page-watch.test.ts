/**
 * #680 slice 3 — the daemon's file watch behind file-backed `page` artifacts.
 *
 * Fakes, not mocks: a real FileStore on a temp project, real files on disk read
 * through present_page's own reader, the real preflight gate, a fake directory
 * watcher the test fires (the event source), and vitest's fake clock for the
 * quiet period / rate limit.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileWatch, type Artifact } from "@deeppairing/shared";
import { FileStore, ParentSupersededError } from "../../store/file-store.js";
import { PageWatcher, type PageDirWatcher, type PageWatchDeps } from "../page-watch.js";
import { preflightRejectedApproaches } from "../../mcp/tool-helpers.js";
import { createHttpRoutes } from "../../http/routes.js";
import { withHash } from "../../http/__tests__/routes.harness.js";

const SID = "sess_pagewatch";

let root: string;
let outside: string;
let store: FileStore;
let events: any[];
let live: boolean;
let fakeWatchers: Array<{ dir: string; fire: (name: string | null) => void; closed: boolean }>;
let watcher: PageWatcher;

function makeWatcher(opts: { pollIntervalMs?: number; gate?: PageWatchDeps["gate"]; statSig?: PageWatchDeps["statSig"] } = {}): PageWatcher {
  return new PageWatcher({
    projectRoot: root,
    getStore: (sid) => (sid === SID ? store : undefined),
    broadcast: (_sid, e) => void events.push(e),
    isSessionLive: () => live,
    watch: (dir, listener) => {
      const w = { dir, closed: false, fire: (name: string | null) => { if (!w.closed) listener("change", name); } };
      fakeWatchers.push(w);
      const handle: PageDirWatcher = { close: () => { w.closed = true; } };
      return handle;
    },
    pollIntervalMs: opts.pollIntervalMs ?? 0,
    ...(opts.gate ? { gate: opts.gate } : {}),
    ...(opts.statSig ? { statSig: opts.statSig } : {}),
  });
}

function write(rel: string, html: string): void {
  fs.writeFileSync(path.join(root, rel), html);
  for (const w of fakeWatchers) w.fire(path.basename(rel));
}

function presentFilePage(rel: string, html: string): Artifact {
  fs.writeFileSync(path.join(root, rel), html);
  return store.createArtifact({ id: `art_${Math.random().toString(36).slice(2, 10)}`, type: "page", title: "Cache options", content: { title: "Cache options", html, sourcePath: rel } });
}

const pages = () => store.getArtifacts().filter((a) => a.type === "page");
const liveTip = () => pages().find((a) => a.status === "draft");

async function settle(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await watcher.idle();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dp-pagewatch-root-")));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dp-pagewatch-outside-")));
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  store = new FileStore(root, SID);
  events = [];
  live = true;
  fakeWatchers = [];
  watcher = makeWatcher();
});

afterEach(() => {
  watcher.dispose();
  store.dispose();
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("page file watch — debounce and rate limit", () => {
  it("records ONE new version for a burst of writes, after the quiet period", async () => {
    const v1 = presentFilePage("docs/page.html", "<h1>Options</h1><p>TTL expiry, up to 60s.</p>");
    watcher.sync(SID);
    expect(watcher.watched(SID)).toEqual([v1.id]);

    write("docs/page.html", "<h1>Options</h1><p>draft 1</p>");
    await settle(500);
    write("docs/page.html", "<h1>Options</h1><p>draft 2</p>");
    await settle(500);
    write("docs/page.html", "<h1>Options</h1><p>Write-through, never stale.</p>");
    await settle(1_900);
    expect(pages()).toHaveLength(1); // still inside the quiet period

    await settle(200);
    expect(pages()).toHaveLength(2);
    const v2 = liveTip()!;
    expect(v2.version).toBe(2);
    expect(v2.parentId).toBe(v1.id);
    expect((v2.content as any).html).toBe("<h1>Options</h1><p>Write-through, never stale.</p>");
    expect((v2.content as any).sourcePath).toBe("docs/page.html");
    expect(store.getArtifacts().find((a) => a.id === v1.id)!.status).toBe("superseded");
    expect(store.getComments().some((c) => c.target.artifactId === v1.id && c.author === "agent" && c.content.includes(v2.id))).toBe(true);
    expect(readFileWatch(v2.fileWatch).recorded).toMatchObject({ fromArtifactId: v1.id, fromVersion: 1, sourcePath: "docs/page.html" });
    expect(events.some((e) => e.type === "artifact_created" && e.artifact.id === v2.id)).toBe(true);
    expect(events.some((e) => e.type === "artifact_updated" && e.artifactId === v1.id && e.status === "superseded")).toBe(true);
    // The watch moved to the new version.
    expect(watcher.watched(SID)).toEqual([v2.id]);
  });

  it("records at most one version per 10s per artifact", async () => {
    presentFilePage("docs/page.html", "<p>one</p>");
    watcher.sync(SID);
    write("docs/page.html", "<p>two</p>");
    await settle(2_000);
    expect(pages()).toHaveLength(2);

    write("docs/page.html", "<p>three</p>");
    await settle(2_000); // quiet, but inside the 10s window since v2 (t=2s)
    expect(pages()).toHaveLength(2);
    await settle(7_900); // t=11.9s
    expect(pages()).toHaveLength(2);
    await settle(200); // t=12.1s: the window ended at 12s
    expect(pages()).toHaveLength(3);
    expect((liveTip()!.content as any).html).toBe("<p>three</p>");
  });

  it("a touch that leaves the content unchanged records nothing", async () => {
    presentFilePage("docs/page.html", "<p>same</p>");
    watcher.sync(SID);
    write("docs/page.html", "<p>same</p>");
    await settle(3_000);
    expect(pages()).toHaveLength(1);
  });

  it("the stat poll catches a save the directory watcher missed", async () => {
    watcher.dispose();
    watcher = makeWatcher({ pollIntervalMs: 1_000 });
    presentFilePage("docs/page.html", "<p>before</p>");
    watcher.sync(SID);
    // Write WITHOUT firing the fake watcher.
    fs.writeFileSync(path.join(root, "docs/page.html"), "<p>after the poll noticed</p>");
    await settle(1_000);
    await settle(2_000);
    expect((liveTip()!.content as any).html).toBe("<p>after the poll noticed</p>");
  });
});

describe("page file watch — re-anchoring and orphans", () => {
  it("lists comments whose text is gone as orphaned; others carry", async () => {
    const v1 = presentFilePage(
      "docs/page.html",
      "<table><tr><th>Strategy</th><th>Staleness</th></tr><tr><td>TTL expiry</td><td>Up to 60s</td></tr></table><p>We could also use write-through caching.</p>",
    );
    store.addComment({
      id: "cmt_cell", artifactId: v1.id, author: "human", content: "60s is too stale",
      target: { artifactId: v1.id, htmlAnchor: { kind: "cell", locator: "tr:nth-of-type(2) > td:nth-of-type(2)", quote: "Up to 60s", table: { row: "TTL expiry", col: "Staleness" }, version: 1 } },
    });
    store.addComment({
      id: "cmt_text", artifactId: v1.id, author: "human", content: "yes, do this",
      target: { artifactId: v1.id, htmlAnchor: { kind: "text", locator: "p", quote: "write-through caching", version: 1 } },
    });
    watcher.sync(SID);
    // The agent rewrites the table row; the paragraph stays.
    write("docs/page.html", "<table><tr><th>Strategy</th><th>Staleness</th></tr><tr><td>TTL expiry</td><td>Up to 5s</td></tr></table><p>We could also use write-through   caching.</p>");
    await settle(2_000);
    const rec = readFileWatch(liveTip()!.fileWatch).recorded!;
    expect(rec.orphaned.map((o) => o.commentId)).toEqual(["cmt_cell"]);
    expect(rec.orphaned[0]).toMatchObject({ kind: "cell", quote: "Up to 60s", version: 1 });
    expect(rec.carriedCount).toBe(1);
    // Nothing moved or vanished: both comments are still on v1.
    expect(store.getComments().filter((c) => c.author === "human").map((c) => c.target.artifactId)).toEqual([v1.id, v1.id]);
  });
});

describe("page file watch — the rejection gate", () => {
  it("refuses a save that matches rejection memory: no version, a refused notice, a block event", async () => {
    store.recordRejectedApproach({ description: "Deploy: Railway", reason: "too expensive for our scale" });
    const v1 = presentFilePage("docs/page.html", "<h1>Hosting</h1><p>Keep the current host.</p>");
    watcher.sync(SID);
    write("docs/page.html", "<h1>Hosting</h1><p>We should move the API to Railway for simpler deploys.</p>");
    await settle(2_000);

    expect(pages()).toHaveLength(1);
    const cur = store.getArtifacts().find((a) => a.id === v1.id)!;
    expect(cur.status).toBe("draft");
    expect((cur.content as any).html).toBe("<h1>Hosting</h1><p>Keep the current host.</p>");
    const refused = readFileWatch(cur.fileWatch).refused!;
    expect(refused).toMatchObject({ cause: "gate", sourcePath: "docs/page.html" });
    expect(refused.message).toContain("too expensive for our scale");
    const blocks = events.filter((e) => e.type === "preflight_blocked");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ toolName: "page_watch", artifactId: v1.id, eligible: false, ineligibleReason: "file_watch" });

    // The same bytes again: not re-blocked, not re-announced.
    write("docs/page.html", "<h1>Hosting</h1><p>We should move the API to Railway for simpler deploys.</p>");
    await settle(12_000);
    expect(events.filter((e) => e.type === "preflight_blocked")).toHaveLength(1);

    // A clean edit records normally, and the moot refusal is marked delivered.
    write("docs/page.html", "<h1>Hosting</h1><p>Stay on the current host; revisit next quarter.</p>");
    await settle(12_000);
    expect(pages()).toHaveLength(2);
    expect(readFileWatch(store.getArtifacts().find((a) => a.id === v1.id)!.fileWatch).refused!.delivered).toBe(true);
  });
});

describe("page file watch — a spot ruled out on the page (#680 slice 4)", () => {
  it("refuses a later save that keeps the ruled-out text, with the human's reason; a save without it records", async () => {
    const v1 = presentFilePage("docs/page.html", "<h1>Hosting</h1><p>Move the API to a managed edge host.</p><p>Keep the worker on the VM.</p>");
    watcher.sync(SID);
    // The companion's explicit submit, through the real route.
    const app = withHash(createHttpRoutes(store, root, () => {}), root);
    const res = await app.request(`/api/artifacts/${v1.id}/rule-out`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ htmlAnchor: { kind: "element", locator: "p:nth-of-type(1)", quote: "Move the API to a managed edge host." }, reason: "edge cold starts hurt our p99" }),
    });
    expect(res.status).toBe(200);

    write("docs/page.html", "<h1>Hosting</h1><p>Move the API to a managed edge host.</p><p>Move the worker too.</p>");
    await settle(2_000);
    expect(pages()).toHaveLength(1);
    const refused = readFileWatch(store.getArtifacts().find((a) => a.id === v1.id)!.fileWatch).refused!;
    expect(refused).toMatchObject({ cause: "gate", sourcePath: "docs/page.html" });
    expect(refused.message).toContain("edge cold starts hurt our p99");

    write("docs/page.html", "<h1>Hosting</h1><p>Keep the API on the VM.</p><p>Keep the worker on the VM.</p>");
    await settle(12_000);
    expect(pages()).toHaveLength(2);
  });
});

describe("page file watch — lifetime and hostile files", () => {
  it("stops watching once the artifact is resolved, and on session end / dispose", async () => {
    const v1 = presentFilePage("docs/page.html", "<p>one</p>");
    watcher.sync(SID);
    expect(fakeWatchers).toHaveLength(1);
    store.updateArtifactStatus(v1.id, "approved", "ui_approve_button");
    watcher.sync(SID);
    expect(watcher.watched(SID)).toEqual([]);
    expect(fakeWatchers[0]!.closed).toBe(true);
    write("docs/page.html", "<p>two</p>");
    await settle(12_000);
    expect(pages()).toHaveLength(1);

    presentFilePage("docs/other.html", "<p>a</p>");
    watcher.sync(SID);
    expect(watcher.watched(SID)).toHaveLength(1);
    watcher.stopSession(SID);
    expect(watcher.watched(SID)).toEqual([]);

    watcher.sync(SID);
    expect(watcher.watched(SID)).toHaveLength(1);
    live = false; // wrapper gone
    watcher.sync(SID);
    expect(watcher.watched(SID)).toEqual([]);

    live = true;
    watcher.sync(SID);
    watcher.dispose();
    expect(watcher.watched(SID)).toEqual([]);
    expect(fakeWatchers.every((w) => w.closed)).toBe(true);
    watcher.sync(SID); // after dispose: no new watches
    expect(watcher.watched(SID)).toEqual([]);
  });

  it("a deleted file records nothing and does not crash; its return is recorded", async () => {
    presentFilePage("docs/page.html", "<p>one</p>");
    watcher.sync(SID);
    fs.rmSync(path.join(root, "docs/page.html"));
    for (const w of fakeWatchers) w.fire("page.html");
    await settle(3_000);
    expect(pages()).toHaveLength(1);
    expect(readFileWatch(pages()[0]!.fileWatch).refused).toBeUndefined();
    write("docs/page.html", "<p>back again</p>");
    await settle(2_000);
    expect((liveTip()!.content as any).html).toBe("<p>back again</p>");
  });

  it("a symlink swapped in to a file outside the project is refused, never read", async () => {
    const v1 = presentFilePage("docs/page.html", "<p>inside</p>");
    watcher.sync(SID);
    fs.writeFileSync(path.join(outside, "secret.html"), "<p>OUTSIDE SECRET</p>");
    fs.rmSync(path.join(root, "docs/page.html"));
    fs.symlinkSync(path.join(outside, "secret.html"), path.join(root, "docs/page.html"));
    for (const w of fakeWatchers) w.fire("page.html");
    await settle(2_000);
    expect(pages()).toHaveLength(1);
    const cur = store.getArtifacts().find((a) => a.id === v1.id)!;
    expect((cur.content as any).html).toBe("<p>inside</p>");
    const refused = readFileWatch(cur.fileWatch).refused!;
    expect(refused.cause).toBe("unreadable");
    expect(refused.message).toContain("outside the project root");
    expect(JSON.stringify(store.getArtifacts())).not.toContain("OUTSIDE SECRET");
  });

  it("ignores pages without a sourcePath", () => {
    store.createArtifact({ id: "art_inline", type: "page", title: "Inline", content: { title: "Inline", html: "<p>x</p>" } });
    watcher.sync(SID);
    expect(watcher.watched(SID)).toEqual([]);
  });
});

describe("page file watch — review fixes", () => {
  it("P2-1: stopSession while the gate is in flight records nothing; re-registering re-watches and records", async () => {
    watcher.dispose();
    // A fake gate: the REAL gate, held open until the test releases it.
    let hold = true;
    let release: (() => void) | null = null;
    const gate: PageWatchDeps["gate"] = async (...args) => {
      if (hold) {
        hold = false;
        await new Promise<void>((r) => { release = r; });
      }
      return preflightRejectedApproaches(...args);
    };
    watcher = makeWatcher({ gate });
    const v1 = presentFilePage("docs/page.html", "<p>one</p>");
    watcher.sync(SID);
    write("docs/page.html", "<p>two</p>");
    await vi.advanceTimersByTimeAsync(2_000); // the quiet timer fired; the gate is pending
    expect(release).not.toBeNull();
    watcher.stopSession(SID);
    release!();
    await watcher.idle();
    expect(pages()).toHaveLength(1);
    expect(store.getArtifacts().find((a) => a.id === v1.id)!.status).toBe("draft");
    expect(watcher.watched(SID)).toEqual([]);

    // Re-registration: watched again, and the save made meanwhile is recorded
    // by the start-up check (P3-5c), then a later save too.
    watcher.sync(SID);
    expect(watcher.watched(SID)).toEqual([v1.id]);
    await settle(2_000);
    expect(pages()).toHaveLength(2);
    expect((liveTip()!.content as any).html).toBe("<p>two</p>");
    write("docs/page.html", "<p>three</p>");
    await settle(12_000);
    expect((liveTip()!.content as any).html).toBe("<p>three</p>");
  });

  it("P2-1: dispose while the gate is in flight records nothing", async () => {
    watcher.dispose();
    let release: (() => void) | null = null;
    const gate: PageWatchDeps["gate"] = async (...args) => {
      await new Promise<void>((r) => { release = r; });
      return preflightRejectedApproaches(...args);
    };
    watcher = makeWatcher({ gate });
    presentFilePage("docs/page.html", "<p>one</p>");
    watcher.sync(SID);
    write("docs/page.html", "<p>two</p>");
    await vi.advanceTimersByTimeAsync(2_000);
    watcher.dispose();
    release!();
    await watcher.idle();
    expect(pages()).toHaveLength(1);
  });

  it("P2-2: a revise that already versioned the page wins; the watch records nothing", async () => {
    const v1 = presentFilePage("docs/page.html", "<p>one</p>");
    watcher.sync(SID);
    // revise_artifact mid-flight over HTTP: its v2 exists, v1 not yet superseded.
    store.createArtifact({ id: "art_manual", type: "page", title: "Cache options", content: { title: "Cache options", html: "<p>manual</p>" }, parentId: v1.id, version: 2, requireUnsupersededParent: true });
    write("docs/page.html", "<p>from the file</p>");
    await settle(2_000);
    const kids = store.getArtifacts().filter((a) => a.parentId === v1.id);
    expect(kids.map((a) => a.id)).toEqual(["art_manual"]);
  });

  it("P2-2: the store refuses a second supersede-create on one parent", async () => {
    const v1 = presentFilePage("docs/page.html", "<p>one</p>");
    watcher.sync(SID);
    write("docs/page.html", "<p>two</p>");
    await settle(2_000);
    const v2 = liveTip()!;
    expect(() => store.createArtifact({ id: "art_late", type: "page", title: "x", content: { title: "x", html: "<p>x</p>" }, parentId: v1.id, version: 2, requireUnsupersededParent: true }))
      .toThrow(ParentSupersededError);
    try {
      store.createArtifact({ id: "art_late", type: "page", title: "x", content: { title: "x", html: "<p>x</p>" }, parentId: v1.id, version: 2, requireUnsupersededParent: true });
    } catch (err) {
      expect(err).toMatchObject({ code: "parent_superseded", successorId: v2.id, successorVersion: 2, successorFromFile: true });
    }
    expect(store.getArtifacts().some((a) => a.id === "art_late")).toBe(false);
  });

  it("P3-5b: retiring the stance re-admits identical refused bytes", async () => {
    store.recordRejectedApproach({ description: "Deploy: Railway", reason: "too expensive" });
    presentFilePage("docs/page.html", "<p>Keep the current host.</p>");
    watcher.sync(SID);
    write("docs/page.html", "<p>We should move the API to Railway for simpler deploys.</p>");
    await settle(2_000);
    expect(pages()).toHaveLength(1);
    store.retractRejectedApproach("Deploy: Railway");
    write("docs/page.html", "<p>We should move the API to Railway for simpler deploys.</p>"); // same bytes
    await settle(12_000);
    expect(pages()).toHaveLength(2);
  });

  it("P3-5c: a save made before the watch started is picked up at start", async () => {
    presentFilePage("docs/page.html", "<p>one</p>");
    fs.writeFileSync(path.join(root, "docs/page.html"), "<p>edited while unwatched</p>");
    watcher.sync(SID);
    await settle(2_000);
    expect((liveTip()!.content as any).html).toBe("<p>edited while unwatched</p>");
  });

  it("P3-6: a path swapped for a symlink to ANOTHER in-project file is refused, not recorded", async () => {
    const v1 = presentFilePage("docs/page.html", "<p>inside</p>");
    watcher.sync(SID);
    fs.writeFileSync(path.join(root, "docs/other.html"), "<p>a different page</p>");
    fs.rmSync(path.join(root, "docs/page.html"));
    fs.symlinkSync(path.join(root, "docs/other.html"), path.join(root, "docs/page.html"));
    for (const w of fakeWatchers) w.fire("page.html");
    await settle(2_000);
    expect(pages()).toHaveLength(1);
    const refused = readFileWatch(store.getArtifacts().find((a) => a.id === v1.id)!.fileWatch).refused!;
    expect(refused.cause).toBe("unreadable");
    expect(refused.message).toContain("resolves to a different file (docs/other.html)");
  });

  it("P3-4: acknowledging an old refusal never swallows a newer one", () => {
    const v1 = presentFilePage("docs/page.html", "<p>one</p>");
    store.setPageFileWatch(v1.id, "refused", { at: "2026-11-21T00:00:00.000Z", sourcePath: "docs/page.html", cause: "gate", message: "old", digest: "d1" });
    const oldRef = { artifactId: v1.id, refusedAt: "2026-11-21T00:00:00.000Z", refusedDigest: "d1" };
    store.setPageFileWatch(v1.id, "refused", { at: "2026-11-21T00:00:05.000Z", sourcePath: "docs/page.html", cause: "gate", message: "new", digest: "d2" });
    store.acknowledgeFileWatchNotices([oldRef]);
    const refused = readFileWatch(store.getArtifacts().find((a) => a.id === v1.id)!.fileWatch).refused!;
    expect(refused).toMatchObject({ message: "new" });
    expect(refused.delivered).toBeUndefined();
    store.acknowledgeFileWatchNotices([{ artifactId: v1.id, refusedAt: "2026-11-21T00:00:05.000Z", refusedDigest: "d2" }]);
    expect(readFileWatch(store.getArtifacts().find((a) => a.id === v1.id)!.fileWatch).refused!.delivered).toBe(true);
  });
});

describe("page file watch — a save landing during the gate check (Codex review)", () => {
  /** The real gate, with its FIRST call held open until released. */
  function heldFirstGate(): { gate: PageWatchDeps["gate"]; release: () => void; pending: () => boolean } {
    let release: (() => void) | null = null;
    let first = true;
    const gate: PageWatchDeps["gate"] = async (...args) => {
      if (first) {
        first = false;
        await new Promise<void>((r) => { release = r; });
      }
      return preflightRejectedApproaches(...args);
    };
    return { gate, release: () => release!(), pending: () => release !== null };
  }

  it("save B during save A's gate: only B is recorded, after its own quiet period (not the rate limit)", async () => {
    watcher.dispose();
    const held = heldFirstGate();
    watcher = makeWatcher({ gate: held.gate });
    const v1 = presentFilePage("docs/page.html", "<p>zero</p>");
    watcher.sync(SID);
    write("docs/page.html", "<p>save A</p>");
    await vi.advanceTimersByTimeAsync(2_000); // A's quiet period ends; A's gate is now pending
    expect(held.pending()).toBe(true);
    write("docs/page.html", "<p>save B</p>"); // B lands mid-gate
    held.release();
    await watcher.idle();
    // A is stale: no version, no notice.
    expect(pages()).toHaveLength(1);
    expect(store.getArtifacts().find((a) => a.id === v1.id)!.fileWatch).toBeUndefined();
    // B: its own 2s quiet read — NOT 10s behind a window A never earned.
    await settle(1_900);
    expect(pages()).toHaveLength(1);
    await settle(200);
    expect(pages()).toHaveLength(2);
    const v2 = liveTip()!;
    expect((v2.content as any).html).toBe("<p>save B</p>");
    expect(store.getArtifacts().filter((a) => a.parentId === v1.id)).toHaveLength(1);
    expect(events.filter((e) => e.type === "artifact_created")).toHaveLength(1);
  });

  it("refusal variant: A matches a stance, B doesn't — no refusal for A, B recorded", async () => {
    store.recordRejectedApproach({ description: "Deploy: Railway", reason: "too expensive for our scale" });
    watcher.dispose();
    const held = heldFirstGate();
    watcher = makeWatcher({ gate: held.gate });
    const v1 = presentFilePage("docs/page.html", "<p>Keep the current host.</p>");
    watcher.sync(SID);
    write("docs/page.html", "<p>We should move the API to Railway for simpler deploys.</p>");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(held.pending()).toBe(true);
    write("docs/page.html", "<p>Stay on the current host for now.</p>");
    held.release();
    await watcher.idle();
    expect(readFileWatch(store.getArtifacts().find((a) => a.id === v1.id)!.fileWatch).refused).toBeUndefined();
    expect(events.filter((e) => e.type === "preflight_blocked")).toHaveLength(0);
    await settle(2_100);
    expect(pages()).toHaveLength(2);
    expect((liveTip()!.content as any).html).toBe("<p>Stay on the current host for now.</p>");
    expect(readFileWatch(store.getArtifacts().find((a) => a.id === v1.id)!.fileWatch).refused).toBeUndefined();
    expect(events.filter((e) => e.type === "preflight_blocked")).toHaveLength(0);
  });

  // Stat-poll-only path (WSL /mnt/c: fs.watch never fires). Save B is already
  // on disk when A's gate returns, BEFORE the next poll tick could bump gen.
  const disk = (html: string) => fs.writeFileSync(path.join(root, "docs/page.html"), html);

  it("stat-poll path: B on disk before the next tick — A records nothing, B gets its own quiet period", async () => {
    watcher.dispose();
    const held = heldFirstGate();
    watcher = makeWatcher({ gate: held.gate, pollIntervalMs: 1_000 });
    const v1 = presentFilePage("docs/page.html", "<p>zero</p>");
    watcher.sync(SID);
    disk("<p>save A, seen by the poll</p>"); // no watcher event
    await vi.advanceTimersByTimeAsync(1_000); // poll tick sees A → quiet timer
    await vi.advanceTimersByTimeAsync(2_000); // A's quiet ends; A's gate is pending
    expect(held.pending()).toBe(true);
    disk("<p>save B, longer than A so the size moves</p>"); // no event, no tick
    held.release();
    await watcher.idle();
    expect(pages()).toHaveLength(1);
    expect(store.getArtifacts().find((a) => a.id === v1.id)!.fileWatch).toBeUndefined();
    await settle(1_900);
    expect(pages()).toHaveLength(1);
    await settle(200);
    expect(pages()).toHaveLength(2);
    expect((liveTip()!.content as any).html).toBe("<p>save B, longer than A so the size moves</p>");
    expect(events.filter((e) => e.type === "artifact_created")).toHaveLength(1);
  });

  it("stat-poll path, refusal variant: no refusal for A, B recorded", async () => {
    store.recordRejectedApproach({ description: "Deploy: Railway", reason: "too expensive for our scale" });
    watcher.dispose();
    const held = heldFirstGate();
    watcher = makeWatcher({ gate: held.gate, pollIntervalMs: 1_000 });
    const v1 = presentFilePage("docs/page.html", "<p>Keep the current host.</p>");
    watcher.sync(SID);
    disk("<p>We should move the API to Railway for simpler deploys.</p>");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(held.pending()).toBe(true);
    disk("<p>Stay on the current host for now; revisit hosting next quarter.</p>");
    held.release();
    await watcher.idle();
    expect(readFileWatch(store.getArtifacts().find((a) => a.id === v1.id)!.fileWatch).refused).toBeUndefined();
    expect(events.filter((e) => e.type === "preflight_blocked")).toHaveLength(0);
    await settle(2_100);
    expect(pages()).toHaveLength(2);
    expect((liveTip()!.content as any).html).toBe("<p>Stay on the current host for now; revisit hosting next quarter.</p>");
    expect(events.filter((e) => e.type === "preflight_blocked")).toHaveLength(0);
  });

  it("stat-poll path: an mtime-only touch during the gate does not discard A", async () => {
    watcher.dispose();
    const held = heldFirstGate();
    watcher = makeWatcher({ gate: held.gate, pollIntervalMs: 1_000 });
    presentFilePage("docs/page.html", "<p>zero</p>");
    watcher.sync(SID);
    disk("<p>save A</p>");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(held.pending()).toBe(true);
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(root, "docs/page.html"), later, later); // same bytes, new mtime
    held.release();
    await watcher.idle();
    expect(pages()).toHaveLength(2);
    expect((liveTip()!.content as any).html).toBe("<p>save A</p>");
  });

  it("same-stat rewrite: a same-size save the stat can't see during the gate still discards A", async () => {
    // A coarse filesystem, faked: timestamps never move, so the signature is
    // size + inode only (what a same-tick or mtime-restored rewrite looks like).
    const coarse = (p: string) => {
      try { const st = fs.statSync(p); return `${st.size}:${st.ino}`; } catch { return "missing"; }
    };
    watcher.dispose();
    const held = heldFirstGate();
    watcher = makeWatcher({ gate: held.gate, pollIntervalMs: 1_000, statSig: coarse });
    const v1 = presentFilePage("docs/page.html", "<p>zero</p>");
    watcher.sync(SID);
    disk("<p>save AAAA</p>"); // size differs from v1, so the poll sees it
    await vi.advanceTimersByTimeAsync(3_000); // poll tick, then A's quiet ends; gate pending
    expect(held.pending()).toBe(true);
    const file = path.join(root, "docs/page.html");
    const before = fs.statSync(file);
    disk("<p>save BBBB</p>"); // same size, same inode
    fs.utimesSync(file, before.atime, before.mtime); // and the mtime put back
    expect(coarse(file)).toBe(`${before.size}:${before.ino}`);
    held.release();
    await watcher.idle();
    expect(pages()).toHaveLength(1);
    expect(store.getArtifacts().find((a) => a.id === v1.id)!.fileWatch).toBeUndefined();
    await settle(2_100);
    expect(pages()).toHaveLength(2);
    expect((liveTip()!.content as any).html).toBe("<p>save BBBB</p>");
    expect(events.filter((e) => e.type === "artifact_created")).toHaveLength(1);
  });

  it("statSig includes ctime, so the real poll notices an mtime-restored rewrite", async () => {
    watcher.dispose();
    watcher = makeWatcher({ pollIntervalMs: 1_000 });
    presentFilePage("docs/page.html", "<p>save AAAA</p>");
    watcher.sync(SID);
    await settle(3_000); // start-up check: unchanged, nothing recorded
    expect(pages()).toHaveLength(1);
    const file = path.join(root, "docs/page.html");
    const before = fs.statSync(file);
    await new Promise((r) => setImmediate(r));
    disk("<p>save BBBB</p>");
    fs.utimesSync(file, before.atime, before.mtime);
    await settle(1_000); // next poll tick
    await settle(2_100);
    expect((liveTip()!.content as any).html).toBe("<p>save BBBB</p>");
  });
});

