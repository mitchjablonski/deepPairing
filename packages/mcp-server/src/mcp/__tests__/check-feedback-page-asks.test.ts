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

  it("a page without asks keeps its entry unchanged (no openAsks key, no prose line)", async () => {
    const id = await presentPage("<h1>Plain</h1><p>No asks.</p>");
    const res = await callTool("check_feedback");
    expect(entryFor(res.structuredContent, id)).not.toHaveProperty("openAsks");
    expect(res.text).not.toContain("open ask");
  });
});
