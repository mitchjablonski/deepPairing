/**
 * #714 — the standalone read-page-feedback shows a comment the human resolved
 * themselves (Resolve on the page review queue) with its humanResolvedAt; a
 * reopened one (null) and every other entry carry no such field.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileStore } from "../../store/file-store.js";
import { readPageFeedback } from "../page-feedback.js";

let dir: string;
let store: FileStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-pagefb-resolved-"));
  store = new FileStore(dir, "s1");
});
afterEach(() => {
  store.forceFlush();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("readPageFeedback — human resolve (#714)", () => {
  it("carries humanResolvedAt only while resolved", () => {
    store.createArtifact({ id: "pg", type: "page", title: "Page", content: { title: "Page", html: "<h1>Hi</h1>" } });
    const htmlAnchor = { kind: "element" as const, locator: "h1", quote: "Hi" };
    store.addComment({ id: "c1", artifactId: "pg", content: "done", author: "human", target: { artifactId: "pg", htmlAnchor } });
    store.addComment({ id: "c2", artifactId: "pg", content: "open", author: "human", target: { artifactId: "pg", htmlAnchor } });
    store.addComment({ id: "c3", artifactId: "pg", content: "reopened", author: "human", target: { artifactId: "pg", htmlAnchor } });
    store.addComment({ id: "c4", artifactId: "pg", content: "replied to", author: "human", target: { artifactId: "pg", htmlAnchor } });
    store.markCommentHumanResolved("c1", "2026-11-26T10:00:00.000Z");
    store.markCommentHumanResolved("c3", "2026-11-26T10:00:00.000Z");
    store.markCommentHumanResolved("c3", null);
    store.markCommentHumanResolved("c4", "2001-01-01T00:00:00.000Z");
    store.addComment({ id: "agent", artifactId: "pg", content: "Agent reply", author: "agent", parentCommentId: "c4" });
    store.addComment({ id: "human", artifactId: "pg", content: "Human reply", author: "human", parentCommentId: "agent" });
    store.acknowledgeComments(["human"]);
    const read = readPageFeedback(store, "pg");
    if (!read || read === "metadata_too_large") throw new Error("expected a read");
    const byId = Object.fromEntries(read.comments.map((c) => [c.id, c]));
    expect(byId.c1!.humanResolvedAt).toBe("2026-11-26T10:00:00.000Z");
    expect("humanResolvedAt" in byId.c2!).toBe(false);
    expect("humanResolvedAt" in byId.c3!).toBe(false);
    expect("humanResolvedAt" in byId.c4!).toBe(false);
  });
});
