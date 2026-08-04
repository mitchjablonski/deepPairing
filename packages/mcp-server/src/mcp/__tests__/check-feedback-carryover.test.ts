/**
 * #192 (serving H1) — check_feedback CARRYOVER: a human question asked in a
 * previous run (already ACKNOWLEDGED there, so the normal drain won't re-report
 * it) but never ANSWERED must be re-delivered on the next run so it gets answered
 * without the human re-raising it. Read-only, spread-only-when-present so the
 * healthy hot-path payload stays byte-for-byte unchanged.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { FileStore } from "../../store/file-store.js";
import { setupServerTest, makeCallTool } from "./server-test-harness.js";
import { expectHealthyCheckFeedbackPayload } from "./check-feedback-test-helpers.js";

const ctx = setupServerTest();
const callTool = makeCallTool(ctx);
let store: FileStore;
beforeEach(() => {
  store = ctx.store;
});

async function presentChangeset(): Promise<string> {
  await callTool("present_changeset", {
    title: "Guard changeset",
    files: [{ path: "auth/guard.ts", changeType: "modified", hunks: [{ lines: [{ kind: "add", content: "x", newLine: 1 }] }] }],
  });
  const id = store.getArtifacts().find((a) => a.type === "changeset")!.id;
  // Approve so no draft remains — an un-reviewed draft makes check_feedback
  // long-poll 30s; these tests exercise the carryover path, not the wait.
  await store.updateArtifactStatus(id, "approved", "ui_approve_button" as any);
  return id;
}

describe("check_feedback — unanswered-question carryover (#192)", () => {
  it("re-surfaces a prior-run, already-acknowledged, still-unanswered question", async () => {
    const id = await presentChangeset();
    await store.addComment({
      id: "cmt_q_old", artifactId: id, content: "why cookies and not JWT?",
      author: "human", intent: "question",
    } as any);
    // Simulate a PREVIOUS run draining it (acknowledge) without answering.
    await store.acknowledgeComments(["cmt_q_old"]);

    const res = await callTool("check_feedback");
    // Prose surfaces it under the carryover header.
    expect(res.text).toContain("carried over");
    expect(res.text).toContain("cmt_q_old");
    // Structured mirror carries the comment + artifact refs.
    const sc = res.structuredContent as any;
    expect(Array.isArray(sc.unansweredCarryover)).toBe(true);
    const entry = sc.unansweredCarryover.find((q: any) => q.commentId === "cmt_q_old");
    expect(entry).toBeDefined();
    expect(entry.artifactId).toBe(id);
  });

  it("does NOT duplicate a question that is being delivered NEW in THIS same poll", async () => {
    const id = await presentChangeset();
    // Fresh, UN-acknowledged question — the normal drain reports it this poll.
    await store.addComment({
      id: "cmt_q_new", artifactId: id, content: "does this survive a restart?",
      author: "human", intent: "question",
    } as any);

    const res = await callTool("check_feedback");
    const sc = res.structuredContent as any;
    // It appears once, in `questions` (the normal drain), never doubled in carryover.
    expect(sc.questions.find((q: any) => q.commentId === "cmt_q_new")).toBeDefined();
    expect(sc.unansweredCarryover).toBeUndefined();
  });

  it("a healthy session (no unanswered questions) omits unansweredCarryover entirely (byte-for-byte hot path)", async () => {
    const res = await callTool("check_feedback");
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.unansweredCarryover).toBeUndefined();
    expectHealthyCheckFeedbackPayload(sc);
  });

  it("stops carrying a question over once it is answered", async () => {
    const id = await presentChangeset();
    await store.addComment({
      id: "cmt_q2", artifactId: id, content: "which hashing algo?",
      author: "human", intent: "question",
    } as any);
    await store.acknowledgeComments(["cmt_q2"]);
    // Answer it (links answeredByCommentId), then poll again.
    await callTool("answer_question", { commentId: "cmt_q2", answer: "argon2id — OWASP default." });

    const res = await callTool("check_feedback");
    const sc = res.structuredContent as any;
    expect(sc.unansweredCarryover).toBeUndefined();
  });
});
