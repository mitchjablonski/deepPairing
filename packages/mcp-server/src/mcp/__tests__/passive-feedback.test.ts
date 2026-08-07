import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getPassiveFeedback, isObligationBearingComment } from "../tool-helpers.js";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";

/**
 * #225 (N1, F1) — getPassiveFeedback is the drain appended to every tool return
 * (present_*, withdraw, revise retract/obsolete, log_reasoning). It acknowledges
 * what it surfaces and renders it as a bare context-free line — lossless for a
 * plain comment, but LOSSY for an obligation (a suggested edit's must-respond
 * lane / a question's answer_question lane live ONLY in check_feedback). So it
 * must SKIP obligation-bearing comments, leaving them unacknowledged for the next
 * check_feedback, while still draining plain chatter. Real FileStore (fake, not
 * mock).
 */

let fx: GlobalStoreFixture;
let store: FileStore;
beforeEach(() => {
  fx = withGlobalStore("dp-passive-");
  store = new FileStore(fx.dir, "s1");
  store.createArtifact({ id: "art_1", type: "research", title: "v1", content: { summary: "s", findings: [] } });
});
afterEach(() => {
  fx.dispose();
});

describe("getPassiveFeedback — skips obligation-bearing comments (#225 F1)", () => {
  it("drains a plain comment (acked + surfaced) exactly as before", async () => {
    store.addComment({ id: "cmt_plain", artifactId: "art_1", content: "nit: rename this", author: "human" } as any);
    const out = await getPassiveFeedback(store);
    expect(out).toContain("nit: rename this");
    // Acked — check_feedback won't re-show it.
    expect(store.getCommentsForArtifact("art_1").find((c) => c.id === "cmt_plain")?.acknowledged).toBe(true);
  });

  it("does NOT drain or acknowledge a SUGGESTION — its must-respond lane is preserved", async () => {
    store.addComment({
      id: "cmt_sug",
      artifactId: "art_1",
      content: "prefer explicit",
      author: "human",
      intent: "suggestion",
      target: { artifactId: "art_1", filePath: "a.ts", lineStart: 1, lineEnd: 1 },
      suggestion: { originalText: "x", replacementText: "y", lineStart: 1, lineEnd: 1, state: "pending" },
    } as any);
    const out = await getPassiveFeedback(store);
    expect(out).toBe(""); // nothing drainable
    expect(store.getCommentsForArtifact("art_1").find((c) => c.id === "cmt_sug")?.acknowledged).toBeFalsy();
  });

  it("does NOT drain or acknowledge an unanswered QUESTION — its answer_question lane is preserved", async () => {
    store.addComment({ id: "cmt_q", artifactId: "art_1", content: "why?", author: "human", intent: "question" } as any);
    const out = await getPassiveFeedback(store);
    expect(out).toBe("");
    expect(store.getCommentsForArtifact("art_1").find((c) => c.id === "cmt_q")?.acknowledged).toBeFalsy();
  });

  it("drains ONLY the plain comment when a plain comment, a question, and a suggestion coexist", async () => {
    store.addComment({ id: "cmt_plain", artifactId: "art_1", content: "plain note", author: "human" } as any);
    store.addComment({ id: "cmt_q", artifactId: "art_1", content: "an open question", author: "human", intent: "question" } as any);
    store.addComment({
      id: "cmt_sug", artifactId: "art_1", content: "an edit", author: "human", intent: "suggestion",
      target: { artifactId: "art_1", filePath: "a.ts", lineStart: 1, lineEnd: 1 },
      suggestion: { originalText: "x", replacementText: "y", lineStart: 1, lineEnd: 1, state: "pending" },
    } as any);
    const out = await getPassiveFeedback(store);
    expect(out).toContain("plain note");
    expect(out).not.toContain("an open question");
    expect(out).not.toContain("an edit");
    const byId = (id: string) => store.getCommentsForArtifact("art_1").find((c) => c.id === id);
    expect(byId("cmt_plain")?.acknowledged).toBe(true);
    expect(byId("cmt_q")?.acknowledged).toBeFalsy();
    expect(byId("cmt_sug")?.acknowledged).toBeFalsy();
  });

  it("an ANSWERED question is not an obligation — it drains", () => {
    const answered = { id: "q", content: "?", intent: "question", answeredByCommentId: "a1", target: { artifactId: "art_1" } } as any;
    const open = { id: "q2", content: "?", intent: "question", target: { artifactId: "art_1" } } as any;
    const sug = { id: "s", content: "e", suggestion: { state: "pending" }, target: { artifactId: "art_1" } } as any;
    const plain = { id: "p", content: "c", target: { artifactId: "art_1" } } as any;
    expect(isObligationBearingComment(answered)).toBe(false);
    expect(isObligationBearingComment(open)).toBe(true);
    expect(isObligationBearingComment(sug)).toBe(true);
    expect(isObligationBearingComment(plain)).toBe(false);
  });
});
