/**
 * #190 A2 — the EXPLAINER artifact through the tool + check_feedback surfaces:
 *   - present_explainer is NON-BLOCKING (records a draft + returns immediately).
 *   - a rejected explainer gets the "Do NOT apply" posture, not "You may proceed"
 *     (the #195 bug class — without `explainer` in freshlyRejected it would fall
 *     through to proceed the instant the human rejects the walk-through).
 *   - an explainer GRAIN comment (`explainer:<key>` sectionId) is delivered
 *     naming the section (the new describeExplainerSection lane), in its OWN
 *     namespace (never colliding with debrief:/decision:).
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

async function presentExplainer(): Promise<string> {
  await callTool("present_explainer", {
    title: "How session authentication works here",
    overview: "A walk of the request path for an authenticated route, top to bottom.",
    sections: [
      { heading: "1. The cookie is read at the edge", body: "requireSession pulls the session id out of the cookie." },
      { heading: "2. The session is looked up and refreshed", body: "getAndTouch fetches and slides the expiry." },
    ],
    suggestedQuestions: ["Where does the session get created?"],
  });
  return store.getArtifacts().find((a) => a.type === "explainer")!.id;
}

describe("present_explainer — non-blocking record", () => {
  it("records a draft explainer and returns immediately with a review pointer", async () => {
    const res = await callTool("present_explainer", {
      title: "How X works",
      overview: "the walk-through of X",
      sections: [{ heading: "1. start", body: "here's where it begins" }],
    });
    // Non-blocking: the tool returned prose, no error, and the artifact exists as
    // a draft awaiting human review (it did NOT wait for a verdict).
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain("read-only walk-through");
    const arts = store.getArtifacts();
    expect(arts).toHaveLength(1);
    expect(arts[0]!.type).toBe("explainer");
    expect(arts[0]!.status).toBe("draft");
  });
});

describe("present_explainer — pull-first call-to-action nudge (#193 E2)", () => {
  it("warns (not rejects) when an explainer has zero suggestedQuestions", async () => {
    const res = await callTool("present_explainer", {
      title: "How X works",
      overview: "the walk-through of X",
      sections: [{ heading: "1. start", body: "here's where it begins" }],
      // no suggestedQuestions
    });
    // A WARNING, never a rejection: the artifact still records.
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain("No suggestedQuestions");
    expect(store.getArtifacts().find((a) => a.type === "explainer")!.status).toBe("draft");
  });

  it("suppresses the nudge when suggestedQuestions seed the ask-anything chips", async () => {
    const res = await callTool("present_explainer", {
      title: "How Y works",
      overview: "the walk-through of Y",
      sections: [{ heading: "1. start", body: "begins here" }],
      suggestedQuestions: ["Where does it start?"],
    });
    expect(res.isError).toBeFalsy();
    expect(res.text).not.toContain("No suggestedQuestions");
  });
});

describe("check_feedback — rejected explainer (#190 A2)", () => {
  it("a rejected explainer gets the 'Do NOT apply' posture, not 'You may proceed'", async () => {
    const id = await presentExplainer();
    await store.updateArtifactStatus(id, "rejected", "ui_reject_button" as any);

    const res = await callTool("check_feedback");
    const sc = res.structuredContent as any;

    expect(sc.suggestedAction).not.toContain("You may proceed");
    expect(sc.suggestedAction).toContain("Do NOT apply");
    expect(sc.status).toBe("feedback");
    expect(sc.rejected.map((r: any) => r.id)).toContain(id);
    expect(sc.rejected.find((r: any) => r.id === id).type).toBe("explainer");
    expect(res.text).toContain("❌ REJECTED");
  });
});

describe("check_feedback — explainer comment delivery (#190 A2)", () => {
  it("names an explainer grain comment's section and routes an ask-anything question to the question lane", async () => {
    const id = await presentExplainer();
    // Grain comment on the SECOND section (explainer:1 → "section #2").
    await store.addComment({
      id: "cmt_grain",
      artifactId: id,
      content: "this is the part I always forget",
      author: "human",
      target: { artifactId: id, sectionId: "explainer:1" },
    } as any);
    // Ask-anything question.
    await store.addComment({
      id: "cmt_ask",
      artifactId: id,
      content: "where does the session get created in the first place?",
      author: "human",
      intent: "question",
      target: { artifactId: id },
    } as any);

    const res = await callTool("check_feedback");
    const sc = res.structuredContent as any;

    // The grain comment's prose names the section (describeExplainerSection).
    expect(res.text).toContain("section #2");
    // The ask-anything question is in the question-priority lane.
    expect(sc.questions.map((q: any) => q.commentId)).toContain("cmt_ask");
    expect(res.text).toContain("QUESTION");
    // The grain comment is delivered in the comments lane.
    expect(sc.comments.map((c: any) => c.id)).toContain("cmt_grain");
  });

  it("names a NAMED explainer block (overview) grain when commented", async () => {
    const id = await presentExplainer();
    await store.addComment({
      id: "cmt_ov",
      artifactId: id,
      content: "great framing up top",
      author: "human",
      target: { artifactId: id, sectionId: "explainer:overview" },
    } as any);
    const res = await callTool("check_feedback");
    // describeExplainerSection humanizes a non-numeric key.
    expect(res.text).toContain("overview");
  });
});
