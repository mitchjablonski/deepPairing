/**
 * #680 slice 2 — a comment pointed at a spot on a `page` artifact comes back
 * from check_feedback with its anchor: the prose names the kind, quote, table
 * headers and locator; the structured mirror carries the full `htmlAnchor`
 * (kind, locator, quote, prefix/suffix, table headers, nodeId, href, version).
 * A comment with no anchor is unchanged.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { FileStore } from "../../store/file-store.js";
import { setupServerTest, makeCallTool } from "./server-test-harness.js";

const ctx = setupServerTest();
const callTool = makeCallTool(ctx);
let store: FileStore;
beforeEach(() => {
  store = ctx.store;
});

async function presentPage(): Promise<string> {
  const res = await callTool("present_page", {
    title: "Cache invalidation options",
    summary: "Which strategy should I build?",
    html:
      "<h1>Cache invalidation</h1><table><tr><th>Strategy</th><th>Staleness</th></tr>" +
      "<tr><td>TTL expiry</td><td>Up to 60s</td></tr></table><a href=\"https://example.com/rfc\">the RFC</a>",
  });
  expect(res.isError).toBeFalsy();
  return store.getArtifacts().find((a) => a.type === "page")!.id;
}

describe("check_feedback — page anchors (#680 slice 2)", () => {
  it("delivers a cell comment with its table headers and locator", async () => {
    const id = await presentPage();
    await store.addComment({
      id: "cmt_cell",
      artifactId: id,
      content: "60s is too stale for sessions",
      author: "human",
      target: {
        artifactId: id,
        htmlAnchor: {
          kind: "cell",
          locator: "table > tbody > tr:nth-of-type(2) > td:nth-of-type(2)",
          quote: "Up to 60s",
          table: { row: "TTL expiry", col: "Staleness" },
          version: 1,
        },
      },
    });

    const res = await callTool("check_feedback");
    const sc = res.structuredContent as any;
    const c = sc.comments.find((x: any) => x.id === "cmt_cell");
    expect(c.htmlAnchor).toEqual({
      kind: "cell",
      locator: "table > tbody > tr:nth-of-type(2) > td:nth-of-type(2)",
      quote: "Up to 60s",
      table: { row: "TTL expiry", col: "Staleness" },
      version: 1,
    });
    expect(res.text).toContain('on page cell "Up to 60s" (row "TTL expiry", column "Staleness")');
    expect(res.text).toContain("at `table > tbody > tr:nth-of-type(2) > td:nth-of-type(2)`");
  });

  it("delivers a text question with its quote, prefix and suffix in the question lane", async () => {
    const id = await presentPage();
    await store.addComment({
      id: "cmt_text_q",
      artifactId: id,
      content: "why is this the default?",
      author: "human",
      intent: "question",
      target: {
        artifactId: id,
        htmlAnchor: { kind: "text", locator: "h1", quote: "invalidation", prefix: "Cache", suffix: "Strategy" },
      },
    });
    const res = await callTool("check_feedback");
    const sc = res.structuredContent as any;
    const q = sc.questions.find((x: any) => x.commentId === "cmt_text_q");
    expect(q.htmlAnchor).toEqual({ kind: "text", locator: "h1", quote: "invalidation", prefix: "Cache", suffix: "Strategy" });
    expect(res.text).toContain('on page text "invalidation"');
  });

  it("carries a link's href and a diagram node's id", async () => {
    const id = await presentPage();
    await store.addComment({
      id: "cmt_link",
      artifactId: id,
      content: "this link is stale",
      author: "human",
      target: { artifactId: id, htmlAnchor: { kind: "link", locator: "a:nth-of-type(1)", quote: "the RFC", href: "https://example.com/rfc" } },
    });
    await store.addComment({
      id: "cmt_node",
      artifactId: id,
      content: "this gate is in the wrong place",
      author: "human",
      target: { artifactId: id, htmlAnchor: { kind: "diagram-node", locator: "#flowchart-AuthGate-1", quote: "AuthGate", nodeId: "AuthGate" } },
    });
    const res = await callTool("check_feedback");
    const sc = res.structuredContent as any;
    expect(sc.comments.find((x: any) => x.id === "cmt_link").htmlAnchor.href).toBe("https://example.com/rfc");
    expect(sc.comments.find((x: any) => x.id === "cmt_node").htmlAnchor.nodeId).toBe("AuthGate");
    expect(res.text).toContain("(href https://example.com/rfc)");
    expect(res.text).toContain("(node AuthGate)");
  });

  it("leaves a comment without an anchor unchanged (no htmlAnchor key)", async () => {
    const id = await presentPage();
    await store.addComment({ id: "cmt_plain", artifactId: id, content: "looks good overall", author: "human", target: { artifactId: id } });
    const res = await callTool("check_feedback");
    const sc = res.structuredContent as any;
    const c = sc.comments.find((x: any) => x.id === "cmt_plain");
    expect("htmlAnchor" in c).toBe(false);
    expect(res.text).not.toContain("— on page");
  });
});
