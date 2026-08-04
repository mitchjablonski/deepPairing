/**
 * #190 — the DEBRIEF artifact through the tool + check_feedback surfaces:
 *   - present_debrief is NON-BLOCKING (records a draft + returns immediately).
 *   - a rejected debrief gets the "Do NOT apply" posture, not "You may proceed"
 *     (the #195/#169/#171 bug class — without `debrief` in freshlyRejected it
 *     would fall through to proceed the instant the human rejects it).
 *   - a debrief GRAIN comment (`debrief:<key>` sectionId) is delivered naming
 *     the section (the new describeDebriefSection lane).
 *   - an ask-anything QUESTION lands in the question-priority lane.
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

async function presentDebrief(): Promise<string> {
  await callTool("present_debrief", {
    title: "Debrief — sliding-window session TTL",
    summary: "We moved the TTL refresh into one middleware so every route inherits it.",
    sections: [
      { title: "Centralized the refresh", body: "requireSession now calls getAndTouch.", concepts: [{ name: "sliding window" }] },
    ],
    decisionsMade: [{ what: "fail closed on expiry", why: "safer default" }],
    needsYourEyes: [{ what: "the expiry check", why: "auth path", artifactRef: "art_x" }],
    openQuestions: ["Should the window survive a server restart?"],
  });
  return store.getArtifacts().find((a) => a.type === "debrief")!.id;
}

describe("present_debrief — non-blocking record", () => {
  it("records a draft debrief and returns immediately with a review pointer", async () => {
    const res = await callTool("present_debrief", {
      title: "Debrief — X",
      summary: "what we built and why",
    });
    // Non-blocking: the tool returned prose, no error, and the artifact exists as
    // a draft awaiting human review (it did NOT wait for a verdict).
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain("primary comprehension surface");
    const arts = store.getArtifacts();
    expect(arts).toHaveLength(1);
    expect(arts[0]!.type).toBe("debrief");
    expect(arts[0]!.status).toBe("draft");
  });
});

describe("check_feedback — rejected debrief (#190)", () => {
  it("a rejected debrief gets the 'Do NOT apply' posture, not 'You may proceed'", async () => {
    const id = await presentDebrief();
    await store.updateArtifactStatus(id, "rejected", "ui_reject_button" as any);

    const res = await callTool("check_feedback");
    const sc = res.structuredContent as any;

    expect(sc.suggestedAction).not.toContain("You may proceed");
    expect(sc.suggestedAction).toContain("Do NOT apply");
    expect(sc.status).toBe("feedback");
    expect(sc.rejected.map((r: any) => r.id)).toContain(id);
    expect(sc.rejected.find((r: any) => r.id === id).type).toBe("debrief");
    expect(res.text).toContain("❌ REJECTED");
  });
});

describe("check_feedback — debrief comment delivery (#190)", () => {
  it("names a debrief grain comment's section and routes an ask-anything question to the question lane", async () => {
    const id = await presentDebrief();
    // Grain comment on the first section.
    await store.addComment({
      id: "cmt_grain",
      artifactId: id,
      content: "the single choke point is exactly right",
      author: "human",
      target: { artifactId: id, sectionId: "debrief:0" },
    } as any);
    // Ask-anything question.
    await store.addComment({
      id: "cmt_ask",
      artifactId: id,
      content: "does getAndTouch add a write on every request?",
      author: "human",
      intent: "question",
      target: { artifactId: id },
    } as any);

    const res = await callTool("check_feedback");
    const sc = res.structuredContent as any;

    // The grain comment's prose names the section (describeDebriefSection).
    expect(res.text).toContain("section #1");
    // The ask-anything question is in the question-priority lane.
    expect(sc.questions.map((q: any) => q.commentId)).toContain("cmt_ask");
    expect(res.text).toContain("QUESTION");
    // The grain comment is delivered in the comments lane.
    expect(sc.comments.map((c: any) => c.id)).toContain("cmt_grain");
  });

  it("names a NAMED debrief block (needs-your-eyes) grain when commented", async () => {
    const id = await presentDebrief();
    await store.addComment({
      id: "cmt_nye",
      artifactId: id,
      content: "I'll look at the expiry check now",
      author: "human",
      target: { artifactId: id, sectionId: "debrief:needs-your-eyes" },
    } as any);
    const res = await callTool("check_feedback");
    // describeDebriefSection humanizes a non-numeric key (dashes → spaces).
    expect(res.text).toContain("needs your eyes");
  });
});
