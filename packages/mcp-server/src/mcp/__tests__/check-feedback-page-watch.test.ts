/**
 * #680 slice 3 — check_feedback tells the agent what the page file watch did:
 * a version recorded automatically from the file (and which page comments it
 * orphaned), or a save it refused with the stored reason. Each notice is
 * reported once (acknowledged after the poll).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileWatch } from "@deeppairing/shared";
import type { FileStore } from "../../store/file-store.js";
import { setupServerTest, makeCallTool } from "./server-test-harness.js";
import { feedbackStoreView } from "../tools/feedback-ownership.js";

const ctx = setupServerTest();
const callTool = makeCallTool(ctx);
let store: FileStore;
beforeEach(() => {
  store = ctx.store;
});

function seedChain(): { v1: string; v2: string } {
  const content = (html: string) => ({ title: "Cache options", html, sourcePath: "docs/page.html" });
  store.createArtifact({ id: "art_v1", type: "page", title: "Cache options", content: content("<p>Up to 60s</p>") });
  store.createArtifact({ id: "art_v2", type: "page", title: "Cache options", content: content("<p>Up to 5s</p>"), parentId: "art_v1", version: 2 });
  store.updateArtifactStatus("art_v1", "superseded", "agent_supersede");
  return { v1: "art_v1", v2: "art_v2" };
}

describe("check_feedback — page file watch (#680 slice 3)", () => {
  it("reports an auto-recorded version with its orphaned comments, once", async () => {
    const { v1, v2 } = seedChain();
    store.setPageFileWatch(v2, "recorded", {
      at: new Date().toISOString(),
      sourcePath: "docs/page.html",
      fromArtifactId: v1,
      fromVersion: 1,
      carriedCount: 2,
      orphaned: [{ commentId: "cmt_cell", kind: "cell", quote: "Up to 60s", locator: "td", version: 1 }],
    });

    const res = await callTool("check_feedback");
    expect(res.text).toContain("Page file watch");
    expect(res.text).toContain(`${v2} (v2) "Cache options" was recorded automatically from docs/page.html`);
    expect(res.text).toContain(`supersedes ${v1} (v1)`);
    expect(res.text).toContain("1 page comment(s) are ORPHANED");
    expect(res.text).toContain(`cmt_cell: cell "Up to 60s" (made on v1)`);
    expect(res.text).toContain("2 other page comment(s) still point at text on the page");
    const sc = res.structuredContent as any;
    expect(sc.pageFileWatch).toEqual([
      expect.objectContaining({ kind: "recorded", artifactId: v2, version: 2, fromArtifactId: v1, carriedCount: 2, orphaned: [expect.objectContaining({ commentId: "cmt_cell" })] }),
    ]);
    expect(readFileWatch(store.getArtifacts().find((a) => a.id === v2)!.fileWatch).recorded!.delivered).toBe(true);
  });

  it("reports a refused save with the stored reason", async () => {
    store.createArtifact({ id: "art_p", type: "page", title: "Hosting", content: { title: "Hosting", html: "<p>stay</p>", sourcePath: "docs/h.html" } });
    store.setPageFileWatch("art_p", "refused", {
      at: new Date().toISOString(),
      sourcePath: "docs/h.html",
      cause: "gate",
      message: `the new text matches an approach your pair rejected ("Deploy: Railway"): too expensive for our scale`,
      concept: "Deploy: Railway",
      digest: "abc",
    });
    const res = await callTool("check_feedback");
    expect(res.text).toContain("A save to docs/h.html was NOT recorded as a new version of art_p");
    expect(res.text).toContain("too expensive for our scale");
    const sc = res.structuredContent as any;
    expect(sc.pageFileWatch).toEqual([expect.objectContaining({ kind: "refused", cause: "gate", artifactId: "art_p", concept: "Deploy: Railway" })]);
    expect(readFileWatch(store.getArtifacts().find((a) => a.id === "art_p")!.fileWatch).refused!.delivered).toBe(true);
  });

  it("an artifact with no notice adds nothing to the payload", async () => {
    store.createArtifact({ id: "art_q", type: "research", title: "R", content: { summary: "s", findings: [] } });
    store.addComment({ id: "cmt_x", artifactId: "art_q", content: "hello", author: "human" });
    const res = await callTool("check_feedback");
    expect(res.text).not.toContain("Page file watch");
    expect((res.structuredContent as any).pageFileWatch).toBeUndefined();
  });

  it("consumes, without reporting, a refusal on a version that is no longer open (review P3-5a)", async () => {
    seedChain();
    store.setPageFileWatch("art_v1", "refused", {
      at: new Date().toISOString(), sourcePath: "docs/page.html", cause: "gate", message: "stale refusal", digest: "z",
    });
    store.addComment({ id: "cmt_y", artifactId: "art_v2", content: "something to wake the poll", author: "human" });
    const res = await callTool("check_feedback");
    expect(res.text).not.toContain("stale refusal");
    expect(res.text).not.toContain("still sees v1");
    expect(readFileWatch(store.getArtifacts().find((a) => a.id === "art_v1")!.fileWatch).refused!.delivered).toBe(true);
  });

  it("two concurrent polls never both take one notice (review P3-7)", async () => {
    const { v1, v2 } = seedChain();
    store.setPageFileWatch(v2, "recorded", { at: new Date().toISOString(), sourcePath: "docs/page.html", fromArtifactId: v1, fromVersion: 1, carriedCount: 0, orphaned: [] });
    const a = feedbackStoreView(store, { filter: null, reservations: [], pending: null });
    const b = feedbackStoreView(store, { filter: null, reservations: [], pending: null });
    const arts = store.getArtifacts();
    const first = await a.store.selectFileWatchNotices!(arts);
    const second = await b.store.selectFileWatchNotices!(arts);
    expect(first.map((r) => r.artifactId)).toEqual([v2]);
    expect(second).toEqual([]);
    a.release();
    // Released without acknowledging: the notice is available again.
    expect((await b.store.selectFileWatchNotices!(arts)).map((r) => r.artifactId)).toEqual([v2]);
    b.release();
  });
});

describe("revise_artifact — racing the page file watch (#680 slice 3, review P2-2)", () => {
  it("refuses when the file watch already versioned the page, naming the winner", async () => {
    const { v1, v2 } = seedChain();
    store.setPageFileWatch(v2, "recorded", { at: new Date().toISOString(), sourcePath: "docs/page.html", fromArtifactId: v1, fromVersion: 1, carriedCount: 0, orphaned: [] });
    const res = await callTool("revise_artifact", { artifactId: v1, mode: "supersede", reason: "tweak", content: { html: "<p>manual</p>" } });
    expect(res.isError).toBe(true);
    expect(res.text).toContain(`${v1} changed under you — the page file watch auto-recorded ${v2} (v2)`);
    expect(res.text).toContain(`Revise from ${v2}`);
    expect(store.getArtifacts().filter((a) => a.parentId === v1).map((a) => a.id)).toEqual([v2]);
  });

  it("the compare-and-swap refuses a revise whose parent gained a version mid-call", async () => {
    // The watch's v2 exists but v1 is still open: the window between the
    // watch's create and its supersede (or revise's own read and create).
    store.createArtifact({ id: "art_p1", type: "page", title: "Cache options", content: { title: "Cache options", html: "<p>one</p>", sourcePath: "docs/page.html" } });
    store.createArtifact({ id: "art_p2", type: "page", title: "Cache options", content: { title: "Cache options", html: "<p>file</p>", sourcePath: "docs/page.html" }, parentId: "art_p1", version: 2 });
    store.setPageFileWatch("art_p2", "recorded", { at: new Date().toISOString(), sourcePath: "docs/page.html", fromArtifactId: "art_p1", fromVersion: 1, carriedCount: 0, orphaned: [] });
    const res = await callTool("revise_artifact", { artifactId: "art_p1", mode: "supersede", reason: "tweak", content: { html: "<p>manual</p>" } });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("changed under you — the page file watch auto-recorded art_p2 (v2)");
    expect(res.text).toContain("Nothing was created");
    expect(store.getArtifacts().filter((a) => a.parentId === "art_p1").map((a) => a.id)).toEqual(["art_p2"]);
    expect(store.getArtifacts().find((a) => a.id === "art_p1")!.status).toBe("draft");
  });
});
