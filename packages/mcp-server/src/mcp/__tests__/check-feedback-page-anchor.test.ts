/**
 * #680 slice 2 — a comment pointed at a spot on a `page` artifact comes back
 * from check_feedback with its anchor: the prose names the kind, quote, table
 * headers and locator; the structured mirror carries the full `htmlAnchor`
 * (kind, locator, quote, prefix/suffix, table headers, nodeId, href, version).
 * A comment with no anchor is unchanged.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
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

describe("check_feedback — page anchor section context (#714 gap 10)", () => {
  it("names the section in the prose and mirrors it (with element affixes) in the structured anchor", async () => {
    const id = await presentPage();
    await store.addComment({
      id: "cmt_section",
      artifactId: id,
      content: "move this before the risks",
      author: "human",
      target: {
        artifactId: id,
        htmlAnchor: {
          kind: "element",
          locator: "main > div:nth-of-type(4)",
          quote: "Ship behind a flag",
          prefix: "Rollout",
          suffix: "Risks",
          section: { heading: "Rollout", id: "rollout" },
        },
      },
    });
    const res = await callTool("check_feedback");
    expect(res.text).toContain('on page element "Ship behind a flag" (in "Rollout" #rollout) at `main > div:nth-of-type(4)`');
    const c = (res.structuredContent as any).comments.find((x: any) => x.id === "cmt_section");
    expect(c.htmlAnchor).toEqual({
      kind: "element",
      locator: "main > div:nth-of-type(4)",
      quote: "Ship behind a flag",
      prefix: "Rollout",
      suffix: "Risks",
      section: { heading: "Rollout", id: "rollout" },
    });
  });

  it("a heading-only or id-only section, and none at all", async () => {
    const id = await presentPage();
    const add = (cid: string, section?: { heading?: string; id?: string }) =>
      store.addComment({
        id: cid, artifactId: id, content: `note ${cid}`, author: "human",
        target: { artifactId: id, htmlAnchor: { kind: "element", locator: `#${cid}`, quote: cid, ...(section ? { section } : {}) } },
      });
    await add("c_h", { heading: "Risks" });
    await add("c_i", { id: "faq" });
    await add("c_n");
    const res = await callTool("check_feedback");
    expect(res.text).toContain('"c_h" (in "Risks") at `#c_h`');
    expect(res.text).toContain('"c_i" (in #faq) at `#c_i`');
    expect(res.text).toContain('"c_n" at `#c_n`');
    const sc = res.structuredContent as any;
    expect(sc.comments.find((x: any) => x.id === "c_n").htmlAnchor.section).toBeUndefined();
  });
});

describe("check_feedback — a page comment the human resolved themselves (#714)", () => {
  it("says RESOLVED BY THE HUMAN in prose and carries humanResolvedAt; an unresolved one is unchanged", async () => {
    const id = await presentPage();
    const anchor = { kind: "element" as const, locator: "h1", quote: "Cache invalidation", version: 1 };
    await store.addComment({ id: "cmt_done", artifactId: id, content: "rename this heading", author: "human", target: { artifactId: id, htmlAnchor: anchor } });
    await store.addComment({ id: "cmt_open", artifactId: id, content: "add a TL;DR", author: "human", target: { artifactId: id, htmlAnchor: anchor } });
    const stamp = store.getComment("cmt_done")!.createdAt;
    store.markCommentHumanResolved("cmt_done", stamp);
    const res = await callTool("check_feedback");
    const sc = res.structuredContent as any;
    expect(sc.comments.find((x: any) => x.id === "cmt_done").humanResolvedAt).toBe(stamp);
    expect(sc.comments.find((x: any) => x.id === "cmt_open").humanResolvedAt).toBeUndefined();
    const line = (res.text as string).split("\n").find((l) => l.includes("rename this heading"))!;
    expect(line).toContain("RESOLVED BY THE HUMAN");
    const openLine = (res.text as string).split("\n").find((l) => l.includes("add a TL;DR"))!;
    expect(openLine).not.toContain("RESOLVED");
  });

  it("omits obsolete resolution metadata after a later human reply that was already drained", async () => {
    const id = await presentPage();
    const anchor = { kind: "element" as const, locator: "h1", quote: "Cache invalidation" };
    store.addComment({ id: "root", artifactId: id, content: "rename this heading", author: "human", target: { artifactId: id, htmlAnchor: anchor } });
    const stamp = store.getComment("root")!.createdAt;
    store.markCommentHumanResolved("root", stamp);
    const reply = store.addComment({ id: "reply", artifactId: id, content: "I still need this", author: "human", parentCommentId: "root" });
    reply.createdAt = new Date(Date.parse(stamp) + 1).toISOString();
    store.acknowledgeComments(["reply"]);
    const res = await callTool("check_feedback");
    const comment = (res.structuredContent as any).comments.find((x: any) => x.id === "root");
    expect(comment).not.toHaveProperty("humanResolvedAt");
    expect(comment).not.toHaveProperty("reopenedByHuman");
    expect((res.text as string).split("\n").find((line) => line.includes("rename this heading"))).not.toMatch(/RESOLVED|REOPENED/);
  });
});

describe("check_feedback — a page comment the human reopened (#725)", () => {
  it("re-delivers it marked REOPENED BY THE HUMAN", async () => {
    const id = await presentPage();
    const anchor = { kind: "element" as const, locator: "h1", quote: "Cache invalidation", version: 1 };
    await store.addComment({ id: "cmt_re", artifactId: id, content: "rename this heading", author: "human", target: { artifactId: id, htmlAnchor: anchor } });
    store.markCommentHumanResolved("cmt_re");
    await callTool("check_feedback");
    store.markCommentHumanResolved("cmt_re", null);
    const res = await callTool("check_feedback");
    const line = (res.text as string).split("\n").find((l) => l.includes("rename this heading"))!;
    expect(line).toContain("REOPENED BY THE HUMAN");
    expect(line).not.toContain("RESOLVED BY THE HUMAN");
    expect((res.structuredContent as any).comments.find((x: any) => x.id === "cmt_re").reopenedByHuman).toBe(true);
  });

  it("keeps a reopen that races with settling an in-flight resolved delivery", async () => {
    const id = await presentPage();
    const commentId = "cmt_race";
    store.addComment({
      id: commentId, artifactId: id, content: "rename this heading", author: "human",
      target: { artifactId: id, htmlAnchor: { kind: "element", locator: "h1", quote: "Cache invalidation" } },
    });
    store.markCommentHumanResolved(commentId);
    const acknowledge = store.acknowledgeComments.bind(store);
    const race = vi.spyOn(store, "acknowledgeComments").mockImplementationOnce((ids, delivered) => {
      store.markCommentHumanResolved(commentId, null);
      acknowledge(ids, delivered);
    });
    try {
      const earlier = await callTool("check_feedback");
      expect((earlier.structuredContent as any).comments.find((c: any) => c.id === commentId)).toHaveProperty("humanResolvedAt");
      expect(store.getComment(commentId)?.acknowledged).toBe(false);
      const later = await callTool("check_feedback");
      expect((later.structuredContent as any).comments.find((c: any) => c.id === commentId)).toMatchObject({ reopenedByHuman: true });
      expect(store.getComment(commentId)?.acknowledged).toBe(true);
    } finally {
      race.mockRestore();
    }
  });
});
