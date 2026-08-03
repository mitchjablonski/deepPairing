/**
 * #187 — check_feedback delivers a late FOLLOW-UP comment (posted to an
 * already-APPROVED artifact) clearly distinguished from review feedback: a prose
 * prefix naming the approved artifact, one guidance paragraph ("NOT a review
 * reopening — address it as new input"), and a `followUp:true` on the structured
 * comment/question. A NORMAL (draft-review) comment is delivered byte-for-byte
 * unchanged — no prefix, no guidance, no structured flag.
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

async function presentChangeset(): Promise<string> {
  await callTool("present_changeset", {
    title: "Move TTL refresh into middleware",
    files: [
      { path: "auth/middleware.ts", changeType: "modified", hunks: [{ lines: [{ kind: "add", content: "x", newLine: 26 }] }] },
    ],
  });
  return store.getArtifacts().find((a) => a.type === "changeset")!.id;
}

describe("check_feedback — late follow-up lane (#187)", () => {
  it("a comment on an APPROVED artifact is delivered with the follow-up prefix + guidance + structured flag", async () => {
    const id = await presentChangeset();
    await store.updateArtifactStatus(id, "approved", "ui_approve_button" as any);
    // A late line comment (store stamps followUp:true from the approved status).
    await store.addComment({
      id: "cmt_fu",
      artifactId: id,
      content: "one more thought on the sliding window",
      author: "human",
      target: { filePath: "auth/middleware.ts", lineStart: 26 },
    } as any);

    const res = await callTool("check_feedback");
    // Prose: the item names the approved artifact + carries the guidance.
    expect(res.text).toContain('[follow-up on the APPROVED artifact "Move TTL refresh into middleware"]');
    expect(res.text).toContain("one more thought on the sliding window");
    expect(res.text).toContain("FOLLOW-UP FEEDBACK");
    expect(res.text).toContain("NOT a review reopening");

    // Structured: the comment carries followUp:true.
    const sc = res.structuredContent as any;
    const entry = sc.comments.find((c: any) => c.id === "cmt_fu");
    expect(entry).toBeDefined();
    expect(entry.followUp).toBe(true);
  });

  it("a follow-up QUESTION is prefixed + flagged in structuredQuestions", async () => {
    const id = await presentChangeset();
    await store.updateArtifactStatus(id, "approved", "ui_approve_button" as any);
    await store.addComment({
      id: "cmt_fq",
      artifactId: id,
      content: "does this survive a server restart?",
      author: "human",
      intent: "question",
    } as any);

    const res = await callTool("check_feedback");
    expect(res.text).toContain('[follow-up on the APPROVED artifact "Move TTL refresh into middleware"]');
    const sc = res.structuredContent as any;
    const q = sc.questions.find((q: any) => q.commentId === "cmt_fq");
    expect(q).toBeDefined();
    expect(q.followUp).toBe(true);
  });

  it("NORMAL delivery is byte-unchanged: a DRAFT-review comment has no prefix, no guidance, no structured flag", async () => {
    const id = await presentChangeset(); // stays draft
    await store.addComment({
      id: "cmt_normal",
      artifactId: id,
      content: "plain review comment",
      author: "human",
      target: { filePath: "auth/middleware.ts", lineStart: 26 },
    } as any);

    const res = await callTool("check_feedback");
    expect(res.text).not.toContain("follow-up on the APPROVED artifact");
    expect(res.text).not.toContain("FOLLOW-UP FEEDBACK");

    const sc = res.structuredContent as any;
    const entry = sc.comments.find((c: any) => c.id === "cmt_normal");
    expect(entry).toBeDefined();
    expect("followUp" in entry).toBe(false);
  });
});
