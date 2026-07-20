import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleCheckFeedback } from "../tools/check-feedback.js";
import type { ToolContext } from "../tools/types.js";
import { FileStore } from "../../store/file-store.js";
import { setGlobalStoreForTests } from "../../store/global-store.js";

/**
 * #172 — check_feedback delivers pending suggested edits prominently, with the
 * full original/replacement in structuredContent, and demands a response.
 * post-insist it tells the agent to apply verbatim and not re-argue. A fake
 * FileStore over a tmp dir — no mocks.
 */

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-cf-sugg-"));
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
    helpers: {} as ToolContext["helpers"],
    state: {
      checkFeedbackPollCount: 0,
      reportedRejectedVerdicts: new Set<string>(),
      reportedPlanVerdicts: new Set<string>(),
    },
    progressToken: "tok",
  } as unknown as ToolContext;
}

const suggestion = {
  originalText: "  catch { await sleep(1000); }",
  replacementText: "  catch (err) { if (!isRetryable(err)) throw err; }",
  lineStart: 15,
  lineEnd: 17,
  state: "pending" as const,
};

function seedSuggestion(store: FileStore, over: Partial<typeof suggestion> = {}, content = "backoff over fixed delay") {
  store.addComment({
    id: "cmt_s",
    artifactId: "art_1",
    content,
    author: "human",
    target: { lineStart: 15, lineEnd: 17, filePath: "lib/upload.ts" },
    intent: "suggestion",
    suggestion: { ...suggestion, ...over },
  });
}

describe("#172 check_feedback surfaces suggested edits", () => {
  it("delivers a PENDING suggestion prominently + structuredContent with original/replacement/note", async () => {
    const store = new FileStore(tmpDir, "s1");
    seedSuggestion(store);
    const res = await handleCheckFeedback(makeCtx(store), {});
    const text = res.content[0]!.text as string;
    expect(text).toMatch(/SUGGESTED EDIT/);
    expect(text).toMatch(/lib\/upload\.ts:15–17/);
    expect(text).toMatch(/answer_question/);
    const sc = res.structuredContent as { status: string; suggestions?: any[] };
    expect(sc.status).toBe("feedback");
    expect(sc.suggestions).toHaveLength(1);
    expect(sc.suggestions![0]).toMatchObject({
      commentId: "cmt_s",
      state: "pending",
      file: "lib/upload.ts",
      lineStart: 15,
      lineEnd: 17,
      originalText: suggestion.originalText,
      replacementText: suggestion.replacementText,
      note: "backoff over fixed delay",
    });
  });

  it("omits `note` from structuredContent when the why is just the auto summary", async () => {
    const store = new FileStore(tmpDir, "s_nonote");
    seedSuggestion(store, {}, "Suggested edit to lib/upload.ts:15–17");
    const res = await handleCheckFeedback(makeCtx(store), {});
    const sc = res.structuredContent as { suggestions?: any[] };
    expect(sc.suggestions![0].note).toBeUndefined();
  });

  it("post-INSIST — instructs the agent to apply VERBATIM and not re-argue", async () => {
    const store = new FileStore(tmpDir, "s_insist");
    seedSuggestion(store);
    // Agent countered; human insisted (resetAcknowledged re-queues it).
    store.updateCommentSuggestion("cmt_s", { state: "countered", counter: { reason: "no", replacementText: "x" } });
    store.acknowledgeComments(["cmt_s"]);
    store.updateCommentSuggestion("cmt_s", { state: "insisted", resetAcknowledged: true });
    const res = await handleCheckFeedback(makeCtx(store), {});
    const text = res.content[0]!.text as string;
    expect(text).toMatch(/INSISTED EDIT/);
    expect(text).toMatch(/VERBATIM/);
    expect(text).toMatch(/do not re-argue/i);
    const sc = res.structuredContent as { suggestions?: any[] };
    expect(sc.suggestions![0].state).toBe("insisted");
  });

  it("post-TAKE-COUNTER — instructs the agent to apply its counter", async () => {
    const store = new FileStore(tmpDir, "s_take");
    seedSuggestion(store);
    store.updateCommentSuggestion("cmt_s", { state: "countered", counter: { reason: "no", replacementText: "attach cause" } });
    store.acknowledgeComments(["cmt_s"]);
    store.updateCommentSuggestion("cmt_s", { state: "applied", resetAcknowledged: true });
    const res = await handleCheckFeedback(makeCtx(store), {});
    const text = res.content[0]!.text as string;
    expect(text).toMatch(/COUNTER ACCEPTED/);
    expect(text).toMatch(/attach cause/);
  });

  it("an APPLIED-and-stamped suggestion is history — not re-surfaced once acknowledged", async () => {
    const store = new FileStore(tmpDir, "s_done");
    seedSuggestion(store);
    store.updateCommentSuggestion("cmt_s", { state: "applied", appliedInVersion: 2 });
    store.acknowledgeComments(["cmt_s"]);
    const res = await handleCheckFeedback(makeCtx(store), {});
    const sc = res.structuredContent as Record<string, unknown>;
    expect("suggestions" in sc).toBe(false);
  });
});
