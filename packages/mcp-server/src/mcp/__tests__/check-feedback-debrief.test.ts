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

describe("present_debrief — dangling drill-in refs (#225 N1, item 4)", () => {
  it("WARNS (not rejects) about refs that resolve to no artifact, naming only the fabricated ones", async () => {
    // A real, live artifact to reference (its ref must NOT warn).
    await callTool("present_findings", {
      summary: "real work",
      findings: [{ category: "bug", detail: "d", significance: "low" }],
    });
    const real = store.getArtifacts().find((a) => a.type === "research")!;

    // A withdrawn (retracted) artifact — it still EXISTS as a record, so a ref to
    // it resolves and must NOT be flagged (withdrawn refs may be legit history).
    await callTool("present_findings", {
      summary: "to withdraw",
      findings: [{ category: "bug", detail: "d", significance: "low" }],
    });
    const toWithdraw = store.getArtifacts().find((a) => a.type === "research" && a.id !== real.id)!;
    await callTool("withdraw_artifact", { artifactId: toWithdraw.id, reason: "not needed" });

    const res = await callTool("present_debrief", {
      title: "Debrief with dangling refs",
      summary: "references a mix of live, withdrawn, and fabricated ids",
      sections: [{ title: "s", body: "b", changesetRef: "art_alsoFake", artifactRefs: [real.id] }],
      needsYourEyes: [
        { what: "the live one", why: "resolves", artifactRef: real.id },
        { what: "the withdrawn one", why: "history", artifactRef: toWithdraw.id },
        { what: "a fabricated one", why: "typo", artifactRef: "art_DOESNOTEXIST" },
      ],
    });

    // Not rejected — the debrief is created.
    expect(res.isError).toBeFalsy();
    expect(store.getArtifacts().some((a) => a.type === "debrief")).toBe(true);

    // Warns, counts 2, names BOTH fabricated ids.
    expect(res.text).toContain("don't resolve to a live artifact");
    expect(res.text).toMatch(/2 references/);
    expect(res.text).toContain("art_DOESNOTEXIST");
    expect(res.text).toContain("art_alsoFake");
    // Does NOT name the live or the withdrawn (still-resolving) ref.
    expect(res.text).not.toContain(real.id);
    expect(res.text).not.toContain(toWithdraw.id);
  });

  it("emits NO warning when every ref resolves", async () => {
    await callTool("present_findings", {
      summary: "real work",
      findings: [{ category: "bug", detail: "d", significance: "low" }],
    });
    const real = store.getArtifacts().find((a) => a.type === "research")!;
    const res = await callTool("present_debrief", {
      title: "Clean debrief",
      summary: "all refs resolve",
      sections: [{ title: "s", body: "b", artifactRefs: [real.id] }],
      needsYourEyes: [{ what: "x", why: "y", artifactRef: real.id }],
    });
    expect(res.isError).toBeFalsy();
    expect(res.text).not.toContain("don't resolve");
    expect(res.text).not.toContain("⚠");
  });
});

describe("check_feedback — rejected debrief (#190)", () => {
  it("a rejected debrief gets the 'Do NOT apply' posture, not 'You may proceed'", async () => {
    const id = await presentDebrief();
    await store.updateArtifactStatus(id, "rejected", "ui_reject_button" as any);

    const res = await callTool("check_feedback");
    const sc = res.structuredContent as any;

    // M3 — busy poll: suggestedAction rides the prose only (struct drops it).
    expect(res.text).not.toContain("You may proceed");
    expect(res.text).toContain("Do NOT apply");
    expect(sc.suggestedAction).toBeUndefined();
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
