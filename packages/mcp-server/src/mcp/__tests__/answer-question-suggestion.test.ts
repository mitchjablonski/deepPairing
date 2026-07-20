import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleAnswerQuestion } from "../tools/answer-question.js";
import type { ToolContext } from "../tools/types.js";
import { FileStore } from "../../store/file-store.js";
import { setGlobalStoreForTests } from "../../store/global-store.js";

/**
 * #172 — answer_question is ALSO the agent's response surface for a suggested
 * edit. These lock the apply / counter / insist-honoring transitions and the
 * ledger side-effects, driving a real FileStore (fake, not mock).
 */

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-aq-sugg-"));
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
});
afterEach(() => {
  setGlobalStoreForTests(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeCtx(store: FileStore): ToolContext {
  return {
    server: { notification: () => {} },
    store,
    broadcast: () => {},
    port: 4000,
    helpers: { getPassiveFeedback: async () => "" } as ToolContext["helpers"],
    state: {
      checkFeedbackPollCount: 0,
      reportedRejectedVerdicts: new Set<string>(),
      reportedPlanVerdicts: new Set<string>(),
    },
  } as unknown as ToolContext;
}

function seed(store: FileStore, content: string) {
  store.addComment({
    id: "cmt_s",
    artifactId: "art_1",
    content,
    author: "human",
    target: { lineStart: 15, lineEnd: 17, filePath: "lib/upload.ts" },
    intent: "suggestion",
    suggestion: {
      originalText: "  catch { await sleep(1000); }",
      replacementText: "  catch (err) { if (!isRetryable(err)) throw err; }",
      lineStart: 15,
      lineEnd: 17,
      state: "pending",
    },
  });
}

describe("#172 answer_question resolves suggestions", () => {
  it("applies a suggestion, stamps the version, posts the reply, and records the why", async () => {
    const store = new FileStore(tmpDir, "s_apply");
    seed(store, "backoff over fixed delay");
    const res = await handleAnswerQuestion(makeCtx(store), {
      commentId: "cmt_s",
      answer: "Applied verbatim, treating 5xx as retryable.",
      suggestionState: "applied",
      appliedInVersion: 2,
    });
    expect(res.isError).toBeFalsy();
    const c = store.getComment("cmt_s")!;
    expect(c.suggestion?.state).toBe("applied");
    expect(c.suggestion?.appliedInVersion).toBe(2);
    // Reply comment posted as a child (Claude's reply on the card).
    const reply = store.getCommentsForArtifact("art_1").find((r) => r.parentCommentId === "cmt_s");
    expect(reply?.author).toBe("agent");
    expect(reply?.content).toMatch(/Applied verbatim/);
    expect(store.getSessionMemory().approvedPatterns).toContain("backoff over fixed delay");
  });

  it("requires appliedInVersion when applying", async () => {
    const store = new FileStore(tmpDir, "s_nover");
    seed(store, "why");
    const res = await handleAnswerQuestion(makeCtx(store), {
      commentId: "cmt_s",
      answer: "applied",
      suggestionState: "applied",
    });
    expect(res.isError).toBe(true);
    expect(store.getComment("cmt_s")!.suggestion?.state).toBe("pending");
  });

  it("counters a suggestion, storing the reason + counter replacement", async () => {
    const store = new FileStore(tmpDir, "s_counter");
    seed(store, "why");
    await handleAnswerQuestion(makeCtx(store), {
      commentId: "cmt_s",
      answer: "Returning null would silently drop the upload.",
      suggestionState: "countered",
      counterReplacement: "throw new UploadFailedError({ cause: lastErr });",
    });
    const c = store.getComment("cmt_s")!;
    expect(c.suggestion?.state).toBe("countered");
    expect(c.suggestion?.counter?.reason).toMatch(/silently drop/);
    expect(c.suggestion?.counter?.replacementText).toMatch(/UploadFailedError/);
  });

  it("honoring an INSISTED suggestion PRESERVES the insisted state and records the override", async () => {
    const store = new FileStore(tmpDir, "s_insist");
    seed(store, "returning early is cleaner");
    // countered → insisted (as the human's insist route would set it).
    store.updateCommentSuggestion("cmt_s", { state: "countered", counter: { reason: "no" } });
    store.updateCommentSuggestion("cmt_s", { state: "insisted", resetAcknowledged: true });
    await handleAnswerQuestion(makeCtx(store), {
      commentId: "cmt_s",
      answer: "Applied your version exactly as you insisted.",
      suggestionState: "applied",
      appliedInVersion: 3,
    });
    const c = store.getComment("cmt_s")!;
    expect(c.suggestion?.state).toBe("insisted");
    expect(c.suggestion?.appliedInVersion).toBe(3);
    expect(store.getSessionMemory().approvedPatterns).toContain("returning early is cleaner");
  });

  it("a plain question comment (no suggestion) still answers normally", async () => {
    const store = new FileStore(tmpDir, "s_q");
    store.addComment({
      id: "cmt_q", artifactId: "art_1", content: "why 10 rounds?", author: "human",
      target: { lineStart: 2, filePath: "a.ts" }, intent: "question",
    });
    const res = await handleAnswerQuestion(makeCtx(store), { commentId: "cmt_q", answer: "cost factor" });
    expect(res.content[0]!.text).toMatch(/Answered cmt_q/);
    expect(store.getComment("cmt_q")!.answeredByCommentId).toBeTruthy();
  });
});
