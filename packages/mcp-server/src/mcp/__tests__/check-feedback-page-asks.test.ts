/**
 * #714 gap 5 — check_feedback tells the agent which asks on a pending page
 * (data-dp-decision / data-dp-question) its pair hasn't answered yet: the
 * pendingArtifacts entry carries `openAsks: [{id, kind, text}]` and one prose
 * line names them. An ask counts as answered once a human comment is anchored
 * to it (on this version or an earlier one). Pages without asks are unchanged.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { FileStore } from "../../store/file-store.js";
import { setupServerTest, makeCallTool } from "./server-test-harness.js";

const ctx = setupServerTest();
const callTool = makeCallTool(ctx);
let store: FileStore;
beforeEach(() => {
  store = ctx.store;
  // A pending page with nothing new would long-poll for 30s; these tests read
  // the payload, not the wait, so the fake store returns at once.
  (store as unknown as { waitForFeedback: () => Promise<void> }).waitForFeedback = async () => {};
});

const ASKS_HTML =
  "<h1>Profile cache</h1><p>TL;DR: Redis in front of the profile service.</p>" +
  "<section id=\"asks\"><h2>What I need from you</h2>" +
  "<p id=\"decide-ttl\" data-dp-decision><strong>Decide:</strong> a 60s TTL, or invalidate on every write?</p>" +
  "<p id=\"ask-budget\" data-dp-question><strong>Question:</strong> is one more Redis instance in budget?</p></section>";

async function presentPage(html: string): Promise<string> {
  const res = await callTool("present_page", { title: "Profile cache", summary: "Which TTL?", html });
  expect(res.isError).toBeFalsy();
  return store.getArtifacts().find((a) => a.type === "page")!.id;
}
const entryFor = (sc: any, id: string) => sc.pendingArtifacts.find((p: any) => p.id === id);

describe("check_feedback — open page asks (#714 gap 5)", () => {
  it("lists every unanswered ask on the pending page entry and in one prose line", async () => {
    const id = await presentPage(ASKS_HTML);
    const res = await callTool("check_feedback");
    const entry = entryFor(res.structuredContent, id);
    expect(entry.openAsks).toEqual([
      { id: "decide-ttl", kind: "decision", text: "Decide: a 60s TTL, or invalidate on every write?" },
      { id: "ask-budget", kind: "question", text: "Question: is one more Redis instance in budget?" },
    ]);
    expect(res.text).toContain('📝 Page "Profile cache" has 2 open asks your pair hasn\'t answered yet: #decide-ttl (decision) "Decide: a 60s TTL, or invalidate on every write?"');
  });

  it("drops an ask once a human comment is anchored inside it", async () => {
    const id = await presentPage(ASKS_HTML);
    await store.addComment({
      id: "cmt_ttl",
      artifactId: id,
      content: "Invalidate on write",
      author: "human",
      target: { artifactId: id, htmlAnchor: { kind: "text", locator: "#decide-ttl", quote: "invalidate on every write", version: 1 } },
    });
    const res = await callTool("check_feedback");
    expect(entryFor(res.structuredContent, id).openAsks).toEqual([
      { id: "ask-budget", kind: "question", text: "Question: is one more Redis instance in budget?" },
    ]);
    expect(res.text).toContain("has 1 open ask your pair");
    expect(res.text).not.toContain("#decide-ttl (decision)");
  });

  it("counts an answer on the previous version for the same ask on the revision", async () => {
    const v1 = await presentPage(ASKS_HTML);
    await store.addComment({
      id: "cmt_budget",
      artifactId: v1,
      content: "Yes, in budget",
      author: "human",
      target: { artifactId: v1, htmlAnchor: { kind: "element", locator: "#ask-budget", quote: "Question: is one more Redis instance in budget?" } },
    });
    await callTool("check_feedback");
    const rev = await callTool("revise_artifact", {
      artifactId: v1,
      mode: "supersede",
      reason: "Tightened the TL;DR",
      content: { html: ASKS_HTML.replace("TL;DR: Redis", "TL;DR: Put Redis") },
    });
    expect(rev.isError, rev.text).toBeFalsy();
    const v2 = store.getArtifacts().find((a) => a.type === "page" && a.parentId === v1)!.id;
    const res = await callTool("check_feedback");
    expect(entryFor(res.structuredContent, v2).openAsks.map((q: any) => q.id)).toEqual(["decide-ttl"]);
  });

  it("a reused id with a NEW question stays open on the revision (earlier answer quoted the old text)", async () => {
    const v1 = await presentPage('<h1>Q</h1><div id="q1" data-dp-question>Which DB?</div>');
    await store.addComment({
      id: "cmt_db",
      artifactId: v1,
      content: "Postgres",
      author: "human",
      target: { artifactId: v1, htmlAnchor: { kind: "element", locator: "#q1", quote: "Which DB?", version: 1 } },
    });
    await callTool("check_feedback");
    const rev = await callTool("revise_artifact", { artifactId: v1, mode: "supersede", reason: "Next question", content: { html: '<h1>Q</h1><div id="q1" data-dp-question>Which region?</div>' } });
    expect(rev.isError, rev.text).toBeFalsy();
    const v2 = store.getArtifacts().find((a) => a.type === "page" && a.parentId === v1)!.id;
    const res = await callTool("check_feedback");
    expect(entryFor(res.structuredContent, v2).openAsks).toEqual([{ id: "q1", kind: "question", text: "Which region?" }]);
  });

  it("keeps v1 answers on a child option and on an entity-spelled Reply through a revise", async () => {
    const html = (tldr: string) =>
      `<h1>Q</h1><p>${tldr}</p>` +
      '<div id="db" data-dp-decision>Which database for sessions? <ul><li id="pg">Postgres</li><li>MySQL</li></ul></div>' +
      '<p id="cache" data-dp-question>Isn&rsquo;t the &ldquo;caf&eacute;&rdquo; cache enough for now?</p>';
    const v1 = await presentPage(html("v1"));
    const comment = (id: string, locator: string, quote: string) =>
      store.addComment({ id, artifactId: v1, content: "answer", author: "human", target: { artifactId: v1, htmlAnchor: { kind: "element", locator, quote, version: 1 } } });
    await comment("cmt_pg", "#pg", "Postgres");
    await comment("cmt_cache", "#cache", "Isn\u2019t the \u201Ccaf\u00E9\u201D cache enough for now?");
    await callTool("check_feedback");
    const rev = await callTool("revise_artifact", { artifactId: v1, mode: "supersede", reason: "TL;DR", content: { html: html("v2") } });
    expect(rev.isError, rev.text).toBeFalsy();
    const v2 = store.getArtifacts().find((a) => a.type === "page" && a.parentId === v1)!.id;
    const res = await callTool("check_feedback");
    expect(entryFor(res.structuredContent, v2)).not.toHaveProperty("openAsks");
  });

  it("id-less asks are listed as verifiable:false, kept out of the owed count, and named in their own line", async () => {
    const id = await presentPage('<h1>Q</h1><p id="q1" data-dp-question>Has id?</p><p data-dp-question>No id one?</p><p data-dp-decision>No id two?</p>');
    const res = await callTool("check_feedback");
    expect(entryFor(res.structuredContent, id).openAsks).toEqual([
      { id: "q1", kind: "question", text: "Has id?" },
      { verifiable: false, kind: "question", text: "No id one?" },
      { verifiable: false, kind: "decision", text: "No id two?" },
    ]);
    expect(res.text).toContain('has 1 open ask your pair hasn\'t answered yet: #q1 (question) "Has id?"');
    expect(res.text).toContain('2 asks have no id on page "Profile cache", so their answers can\'t be checked here — add ids, or check the companion.');
  });

  it("caps the structured openAsks at 20 per page with openAsksOmitted", async () => {
    const html = "<h1>Many</h1>" + Array.from({ length: 23 }, (_, i) => `<p id="a${i}" data-dp-question>Ask ${i}?</p>`).join("");
    const id = await presentPage(html);
    const res = await callTool("check_feedback");
    const entry = entryFor(res.structuredContent, id);
    expect(entry.openAsks).toHaveLength(20);
    expect(entry.openAsksOmitted).toBe(3);
    expect(res.text).toContain("has 23 open asks");
  });

  it("a page without asks keeps its entry unchanged (no openAsks key, no prose line)", async () => {
    const id = await presentPage("<h1>Plain</h1><p>No asks.</p>");
    const res = await callTool("check_feedback");
    expect(entryFor(res.structuredContent, id)).not.toHaveProperty("openAsks");
    expect(res.text).not.toContain("open ask");
  });
});
