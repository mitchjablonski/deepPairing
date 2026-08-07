import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { handleWithdrawArtifact } from "../tools/withdraw-artifact.js";
import type { ToolContext } from "../tools/types.js";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";

/**
 * G1 (#198c) — withdraw_artifact retracts the agent's OWN draft, but the
 * load-bearing guard REFUSES the withdrawal when the draft carries unanswered
 * human feedback (never a way to dodge review). Real FileStore (fake, not mock).
 */

let fx: GlobalStoreFixture;
let tmpDir: string;
beforeEach(() => {
  fx = withGlobalStore("dp-withdraw-");
  tmpDir = fx.dir;
});
afterEach(() => {
  fx.dispose();
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

function seedDraft(store: FileStore, id = "art_1") {
  return store.createArtifact({
    id,
    type: "research",
    title: "Draft to withdraw",
    content: { summary: "s", findings: [] },
  });
}

describe("#198c withdraw_artifact", () => {
  it("withdraws a clean draft: status → retracted + an agent 'Withdrawn' note; not an error", async () => {
    const store = fx.track(new FileStore(tmpDir, "s1"));
    seedDraft(store);
    const res = await handleWithdrawArtifact(makeCtx(store), { artifactId: "art_1", reason: "framed it wrong" });
    expect(res.isError).toBeFalsy();
    expect((res.content[0]!.text as string)).toMatch(/Withdrew art_1/);
    const art = (await store.getArtifacts()).find((a) => a.id === "art_1")!;
    expect(art.status).toBe("retracted");
    // The reason is stamped on content so the status panel renders it inline
    // (the honest status surface) — this is the ONE place the reason lives.
    expect((art.content as { retractReason?: string }).retractReason).toBe("framed it wrong");
    // #204 (UX L1) — the agent comment is now a bare "Withdrawn." THREAD MARKER,
    // NOT a second copy of the reason: the inline status surface already carries
    // it ~150px away, so repeating the full sentence in an adjacent comment was
    // the same words rendered twice. The marker still exists (a successor threads
    // onto it) but no longer echoes the reason.
    const comments = await store.getCommentsForArtifact("art_1");
    expect(comments.some((c) => c.author === "agent" && c.content === "Withdrawn.")).toBe(true);
    expect(comments.some((c) => c.author === "agent" && c.content.includes("framed it wrong"))).toBe(false);
  });

  it("NEVER writes the ledger", async () => {
    const store = fx.track(new FileStore(tmpDir, "s1"));
    seedDraft(store);
    await handleWithdrawArtifact(makeCtx(store), { artifactId: "art_1", reason: "mistake" });
    const mem = await store.getSessionMemory();
    expect(mem.rejectedApproaches).toHaveLength(0);
    expect(mem.approvedPatterns).toHaveLength(0);
  });

  it("REFUSES when the draft has an unanswered human question", async () => {
    const store = fx.track(new FileStore(tmpDir, "s1"));
    seedDraft(store);
    store.addComment({
      id: "cmt_q",
      artifactId: "art_1",
      content: "why this approach?",
      author: "human",
      intent: "question",
      target: { artifactId: "art_1" },
    });
    const res = await handleWithdrawArtifact(makeCtx(store), { artifactId: "art_1", reason: "eh" });
    expect(res.isError).toBe(true);
    expect((res.content[0]!.text as string)).toMatch(/REFUSED/);
    expect((res.content[0]!.text as string)).toMatch(/unanswered question/);
    // Status is untouched — still a draft.
    expect((await store.getArtifacts()).find((a) => a.id === "art_1")!.status).toBe("draft");
  });

  // #225 (N1, item 3) — a single unanswered question is ONE object; it must not
  // be double-counted as both "unanswered question" AND "unread comment" (a
  // question is a human comment with acknowledged=false, so it landed in both
  // buckets pre-fix, yielding the nonsense "1 unanswered question and 1 unread
  // comment").
  it("#225 — does NOT double-count a single unanswered question as also an unread comment", async () => {
    const store = fx.track(new FileStore(tmpDir, "s1"));
    seedDraft(store);
    store.addComment({
      id: "cmt_q",
      artifactId: "art_1",
      content: "why this approach?",
      author: "human",
      intent: "question",
      target: { artifactId: "art_1" },
    });
    const res = await handleWithdrawArtifact(makeCtx(store), { artifactId: "art_1", reason: "eh" });
    const text = res.content[0]!.text as string;
    expect(text).toMatch(/1 unanswered question/);
    // The SAME object must NOT also be tallied as an unread comment.
    expect(text).not.toMatch(/unread comment/);
  });

  // #225 (N1, item 3) — the MIXED case stays accurate: a genuinely separate
  // unread comment alongside a question reports BOTH.
  it("#225 — a separate unread comment alongside a question still reports both", async () => {
    const store = fx.track(new FileStore(tmpDir, "s1"));
    seedDraft(store);
    store.addComment({
      id: "cmt_q",
      artifactId: "art_1",
      content: "why this approach?",
      author: "human",
      intent: "question",
      target: { artifactId: "art_1" },
    });
    store.addComment({
      id: "cmt_c",
      artifactId: "art_1",
      content: "also, consider the edge case",
      author: "human",
      target: { artifactId: "art_1" },
    });
    const res = await handleWithdrawArtifact(makeCtx(store), { artifactId: "art_1", reason: "eh" });
    const text = res.content[0]!.text as string;
    expect(text).toMatch(/1 unanswered question/);
    expect(text).toMatch(/1 unread comment/);
  });

  it("REFUSES when the draft has an undrained (unread) human comment", async () => {
    const store = fx.track(new FileStore(tmpDir, "s1"));
    seedDraft(store);
    store.addComment({
      id: "cmt_c",
      artifactId: "art_1",
      content: "consider the edge case",
      author: "human",
      target: { artifactId: "art_1" },
    });
    const res = await handleWithdrawArtifact(makeCtx(store), { artifactId: "art_1", reason: "eh" });
    expect(res.isError).toBe(true);
    expect((res.content[0]!.text as string)).toMatch(/unread comment/);
  });

  it("allows withdrawal once the human comment has been drained (acknowledged)", async () => {
    const store = fx.track(new FileStore(tmpDir, "s1"));
    seedDraft(store);
    store.addComment({
      id: "cmt_c",
      artifactId: "art_1",
      content: "a note",
      author: "human",
      target: { artifactId: "art_1" },
    });
    // The agent's check_feedback drains it (acknowledged) — a plain comment isn't
    // a question, so once seen it no longer blocks withdrawal.
    await store.acknowledgeComments(["cmt_c"]);
    const res = await handleWithdrawArtifact(makeCtx(store), { artifactId: "art_1", reason: "moving on" });
    expect(res.isError).toBeFalsy();
    expect((await store.getArtifacts()).find((a) => a.id === "art_1")!.status).toBe("retracted");
  });

  it("rejects a non-draft artifact (already approved)", async () => {
    const store = fx.track(new FileStore(tmpDir, "s1"));
    seedDraft(store);
    store.updateArtifactStatus("art_1", "approved", "ui_approve_button");
    const res = await handleWithdrawArtifact(makeCtx(store), { artifactId: "art_1", reason: "too late" });
    expect(res.isError).toBe(true);
    expect((res.content[0]!.text as string)).toMatch(/is approved, not a draft/);
  });

  it("requires an artifactId and a reason", async () => {
    const store = fx.track(new FileStore(tmpDir, "s1"));
    seedDraft(store);
    const noId = await handleWithdrawArtifact(makeCtx(store), { reason: "x" });
    expect(noId.isError).toBe(true);
    const noReason = await handleWithdrawArtifact(makeCtx(store), { artifactId: "art_1" });
    expect(noReason.isError).toBe(true);
    expect((noReason.content[0]!.text as string)).toMatch(/reason/);
  });

  it("rejects an unknown artifact id", async () => {
    const store = fx.track(new FileStore(tmpDir, "s1"));
    const res = await handleWithdrawArtifact(makeCtx(store), { artifactId: "art_nope", reason: "x" });
    expect(res.isError).toBe(true);
    expect((res.content[0]!.text as string)).toMatch(/no artifact with id/);
  });
});
