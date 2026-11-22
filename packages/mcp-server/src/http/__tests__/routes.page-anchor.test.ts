// #680 slice 2 — a page comment's `htmlAnchor` is validated at the HTTP
// boundary (malformed / over-length → 400, nothing stored) and stored in its
// parsed form when valid. The store drops an invalid anchor from any other
// writer, and two same-text comments on different spots don't dedupe.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FileStore } from "../../store/file-store.js";
import { createRoutesTestContext, destroyRoutesTestContext, type RoutesApp } from "./routes.harness.js";

let tmpDir: string;
let store: FileStore;
let app: RoutesApp;

beforeEach(() => {
  ({ tmpDir, store, app } = createRoutesTestContext());
  store.createArtifact({ id: "page_1", type: "page", title: "Cache options", content: { title: "Cache options", html: "<p>hi</p>" } });
});
afterEach(() => {
  destroyRoutesTestContext({ tmpDir, store });
});

const cellAnchor = {
  kind: "cell",
  locator: "table > tbody > tr:nth-of-type(2) > td:nth-of-type(2)",
  quote: "Up to 60s",
  table: { row: "TTL expiry", col: "Staleness" },
  version: 1,
};

function post(body: unknown) {
  return app.request("/api/comments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("#680 slice 2 — POST /api/comments with an htmlAnchor", () => {
  it("stores a valid anchor on the comment target", async () => {
    const res = await post({ artifactId: "page_1", content: "60s is too stale", target: { artifactId: "page_1", htmlAnchor: cellAnchor } });
    expect(res.status).toBe(200);
    const comments = await store.getCommentsForArtifact("page_1");
    expect(comments).toHaveLength(1);
    expect(comments[0]!.target.htmlAnchor).toEqual(cellAnchor);
  });

  it("refuses a malformed anchor with 400 and stores nothing", async () => {
    const res = await post({ artifactId: "page_1", content: "x", target: { artifactId: "page_1", htmlAnchor: { kind: "region", locator: "#a", quote: "a" } } });
    expect(res.status).toBe(400);
    expect(await store.getCommentsForArtifact("page_1")).toHaveLength(0);
  });

  it("refuses an over-length quote with 400", async () => {
    const res = await post({ artifactId: "page_1", content: "x", target: { artifactId: "page_1", htmlAnchor: { kind: "text", locator: "p", quote: "q".repeat(281) } } });
    expect(res.status).toBe(400);
    expect(await store.getCommentsForArtifact("page_1")).toHaveLength(0);
  });

  it("does not collapse two same-text comments on different spots", async () => {
    await post({ artifactId: "page_1", content: "why?", target: { artifactId: "page_1", htmlAnchor: cellAnchor } });
    await post({ artifactId: "page_1", content: "why?", target: { artifactId: "page_1", htmlAnchor: { ...cellAnchor, locator: "#other", quote: "None" } } });
    expect(await store.getCommentsForArtifact("page_1")).toHaveLength(2);
  });
});

describe("#680 slice 2 — the store drops an invalid anchor from any writer", () => {
  it("keeps the comment, drops the anchor", () => {
    const c = store.addComment({
      id: "cmt_bad_anchor",
      artifactId: "page_1",
      content: "spoofed",
      author: "human",
      target: { artifactId: "page_1", htmlAnchor: { kind: "element", locator: "x".repeat(600), quote: "a" } },
    });
    expect(c.target.htmlAnchor).toBeUndefined();
    expect(c.content).toBe("spoofed");
  });
});

describe("#680 slice 2 — page-only invariant", () => {
  it("strips an htmlAnchor posted on a non-page artifact, keeping the comment", async () => {
    store.createArtifact({ id: "plan_1", type: "plan", title: "Wire it up", content: { steps: [] } });
    const res = await post({ artifactId: "plan_1", content: "on a plan", target: { artifactId: "plan_1", htmlAnchor: cellAnchor } });
    expect(res.status).toBe(200);
    const [c] = await store.getCommentsForArtifact("plan_1");
    expect(c!.content).toBe("on a plan");
    expect(c!.target.htmlAnchor).toBeUndefined();
  });

  it("strips it from a session-level comment and from an unknown artifact", () => {
    const s1 = store.addComment({ id: "cmt_sess", artifactId: "__session__", content: "hi", author: "human", target: { artifactId: "__session__", htmlAnchor: cellAnchor } });
    expect(s1.target.htmlAnchor).toBeUndefined();
    const s2 = store.addComment({ id: "cmt_unknown", artifactId: "art_nope", content: "hi", author: "agent", target: { artifactId: "art_nope", htmlAnchor: cellAnchor } });
    expect(s2.target.htmlAnchor).toBeUndefined();
  });

  it("keeps it on a superseded page version (comments carried by the chain)", () => {
    store.createArtifact({ id: "page_2", type: "page", title: "Cache options", content: { title: "Cache options", html: "<p>v2</p>" }, parentId: "page_1" });
    const c = store.addComment({ id: "cmt_v2", artifactId: "page_2", content: "v2 note", author: "human", target: { artifactId: "page_2", htmlAnchor: cellAnchor } });
    expect(c.target.htmlAnchor).toEqual(cellAnchor);
  });
});

describe("#680 slice 2 — the saved owner is the id the store checked", () => {
  it("stamps params.artifactId last, over a conflicting target.artifactId", () => {
    store.createArtifact({ id: "plan_9", type: "plan", title: "Other", content: { steps: [] } });
    const c = store.addComment({
      id: "cmt_conflict",
      artifactId: "page_1",
      content: "which owner?",
      author: "human",
      target: { artifactId: "plan_9", htmlAnchor: cellAnchor },
    });
    expect(c.target.artifactId).toBe("page_1");
    // The anchor was judged against page_1 (a page), so it is kept.
    expect(c.target.htmlAnchor).toEqual(cellAnchor);
    expect(store.getCommentsForArtifact("plan_9")).toHaveLength(0);
  });
});
