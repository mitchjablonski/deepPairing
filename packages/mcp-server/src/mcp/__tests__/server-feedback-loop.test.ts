/**
 * D2 — split from the 3,009-line server.test.ts along tool-surface seams.
 * Test bodies are verbatim from the monolith; only the harness wiring is new.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { FileStore } from "../../store/file-store.js";
import { setupServerTest, makeCallTool } from "./server-test-harness.js";

const ctx = setupServerTest();
const callTool = makeCallTool(ctx);
let store: FileStore;
let client: Client;
beforeEach(() => {
  store = ctx.store;
  client = ctx.client;
});

describe("MCP Tool Handlers — feedback loop", () => {
  describe("check_feedback", () => {
    it("returns session status preamble", async () => {
      const { text } = await callTool("check_feedback");
      expect(text).toContain("Session:");
      expect(text).toContain("Suggested action:");
    });

    it("D8 — a questionIndex-targeted answer reaches the agent TAGGED with the question text", async () => {
      // The whole point of answerable open questions: the agent must know
      // WHICH question "Postgres" answers. Pre-fix the loc builder ignored
      // questionIndex and the answer arrived as a bare artifact comment.
      await callTool("present_findings", {
        title: "Research", summary: "s",
        findings: [{ category: "arch", title: "F", detail: "d", evidence: "e", significance: "low" }],
        openQuestions: ["Which DB should we use?"],
      });
      const art = store.getArtifacts()[0];
      store.addComment({
        id: "ans_1", artifactId: art.id, content: "Postgres", author: "human",
        target: { artifactId: art.id, questionIndex: 0, sectionId: "open-question" },
      } as any);

      const res = await callTool("check_feedback");
      expect(res.text).toContain('answers open question #1: "Which DB should we use?"');
      const sc = res.structuredContent as any;
      expect(sc.comments[0]).toMatchObject({ id: "ans_1", questionIndex: 0 });
    });

    it("B3 — carries structuredContent mirroring the prose (status/suggestedAction/summary)", async () => {
      // Activate SDK client-side outputSchema validation: after listTools(),
      // the client THROWS if a check_feedback result omits structuredContent
      // or fails the declared schema — so this test pins schema-validity.
      await client.listTools();
      // Empty session → clean proceed signal, machine-readable.
      const empty = await callTool("check_feedback");
      expect(empty.structuredContent).toMatchObject({ status: "proceed" });
      expect(typeof (empty.structuredContent as any).suggestedAction).toBe("string");

      // A pending draft + a question → status flips and the question is structured.
      await callTool("present_findings", {
        title: "Audit", summary: "s",
        findings: [{ category: "security", title: "F", detail: "d", evidence: "e", significance: "high" }],
      });
      const art = store.getArtifacts()[0];
      store.addComment({
        id: "q_1", artifactId: art.id, content: "why this?", author: "human",
        intent: "question", target: { artifactId: art.id, findingIndex: 0 },
      } as any);

      const res = await callTool("check_feedback");
      const sc = res.structuredContent as any;
      expect(sc.status).toBe("feedback");
      expect(sc.summary.pending).toBe(1);
      expect(sc.pendingArtifacts).toHaveLength(1);
      expect(sc.questions).toHaveLength(1);
      expect(sc.questions[0]).toMatchObject({ commentId: "q_1", findingIndex: 0 });
      // The prose still carries the same info (back-compat surface).
      expect(res.text).toContain("QUESTION");
    });

    it("F1 — warns to WAIT while a code_change is still under review (never 'you may proceed')", async () => {
      // confidence "low" keeps it a draft (no terminal quick-approve) → routed to UI.
      await callTool("present_code_change", {
        filePath: "/src/big.ts", changeType: "modify",
        before: "const x = 1;", after: "const x = 2;", reasoning: "x", confidence: "low",
      });
      const art = store.getArtifacts()[0];
      expect(art.type).toBe("code_change");
      expect(art.status).toBe("draft");
      // an immediate comment makes check_feedback return fast instead of long-polling;
      // suggestedAction still reflects the pending code_change.
      store.addComment({ id: "c_imm", artifactId: art.id, content: "noted", author: "human" });

      const { text } = await callTool("check_feedback");
      expect(text).toContain("Wait for the code change review");
      expect(text).not.toContain("You may proceed with implementation.");
      expect(text).toContain("(code_change)"); // appears in the WAITING line
    });

    it("FN2 — warns 'do NOT apply' (not 'proceed') after a human rejects a code_change, exactly once", async () => {
      await callTool("present_code_change", {
        filePath: "/src/x.ts", changeType: "modify", before: "a", after: "b", reasoning: "x", confidence: "low",
      });
      const art = store.getArtifacts()[0];
      expect(art.type).toBe("code_change");
      // reject with NO feedback comment — detection must still fire (comment-independent)
      store.updateArtifactStatus(art.id, "rejected", "ui_reject");

      const first = await callTool("check_feedback");
      expect(first.text).toContain("REJECTED");
      expect(first.text).not.toContain("You may proceed with implementation.");

      // reported exactly once — the next check no longer re-emits the rejection
      const second = await callTool("check_feedback");
      expect(second.text).not.toContain("REJECTED");
    });

    it("returns unacknowledged comments", async () => {
      // Create an artifact and add a comment
      await callTool("present_findings", {
        summary: "Test",
        findings: [{ category: "Test", detail: "Test", significance: "low" }],
      });
      const artId = store.getArtifacts()[0].id;
      store.addComment({ id: "cmt_1", artifactId: artId, content: "Good work", author: "human" });

      const { text } = await callTool("check_feedback");
      expect(text).toContain("Good work");
    });

    it("returns resolved decisions", async () => {
      await callTool("present_options", {
        context: "Which pattern?",
        options: [
          { id: "a", title: "Service", description: "A", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "Inline", description: "B", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      });
      const dec = store.getPendingDecisions()[0];
      store.resolveDecision(dec.decisionId, "a", "Cleaner");

      const { text } = await callTool("check_feedback");
      expect(text).toContain("Service");
    });

    it("BB3 — waitFor='decision' ignores stale unack comments and waits for the decision", async () => {
      // The agent just called present_options. There's an unrelated old
      // comment sitting in the unack queue (e.g. on a previous artifact).
      // Pre-BB3, check_feedback returned IMMEDIATELY because comments
      // existed — so the agent never got the chance to wait for the user
      // to actually pick an option. With waitFor='decision', the early-
      // return guard is scoped to resolved decisions only.
      await callTool("present_options", {
        context: "Which pattern?",
        options: [
          { id: "a", title: "A", description: "A", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "B", description: "B", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      });
      const decisionArtId = store.getArtifacts()[0].id;
      // Stash a stale comment on a different artifact.
      store.addComment({ id: "cmt_stale", artifactId: "art_other", content: "old chatter", author: "human" });

      // Schedule the decision resolution after 50ms so the long-poll wakes.
      const dec = store.getPendingDecisions()[0];
      setTimeout(() => store.resolveDecision(dec.decisionId, "a", "go with A"), 50);

      const { text } = await callTool("check_feedback", { waitFor: "decision" });
      // The stale comment is still in the queue (we didn't ack it for this
      // poll's purpose), but the wake condition was the resolved decision.
      expect(text).toContain("A");
      // Sanity: the artifact we presented was the one that got resolved.
      expect(decisionArtId).toBeTruthy();
    });

    it("CC5 — waitFor='decision' wakes on an unrelated comment but returns 'still waiting' instead of dumping it", async () => {
      // Pre-CC5: long-poll wakes on ANY signal, then post-wake assembly
      // dumps all comments + decisions regardless of waitFor scope. The
      // agent that asked for a decision-only wake gets a comment-flavored
      // response — surprising, conflicts with the scoped contract.
      await callTool("present_options", {
        context: "Pick a deploy",
        options: [
          { id: "a", title: "A", description: "A", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "B", description: "B", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      });
      // Schedule an unrelated comment (not the decision the agent is
      // waiting for) after 50ms so the long-poll wakes mid-flight.
      setTimeout(() => {
        store.addComment({ id: "cmt_noise", artifactId: "art_other", content: "stray remark", author: "human" });
      }, 50);
      const res = await callTool("check_feedback", { waitFor: "decision" });
      expect(res.text).toContain("Still waiting on 'decision'");
      expect(res.text).not.toContain("stray remark");
      // B3 — the scoped still-waiting path carries the structured mirror too.
      expect(res.structuredContent).toMatchObject({ status: "waiting", waitFor: "decision" });
    });

    it("BB3 — waitFor='comments' returns immediately when there's an unack comment, even with a draft decision", async () => {
      await callTool("present_options", {
        context: "Which?",
        options: [
          { id: "a", title: "A", description: "A", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "B", description: "B", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      });
      store.addComment({ id: "cmt_now", artifactId: "any", content: "look here", author: "human" });
      const t0 = Date.now();
      const { text } = await callTool("check_feedback", { waitFor: "comments" });
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(1000); // immediate, not the 30s long-poll
      expect(text).toContain("look here");
    });

    it("does NOT include session memory inside check_feedback", async () => {
      // Session memory is delivered on the first tool call hint (see
      // first-call-hint test below), never inside check_feedback — mixing
      // WAITING signals with past-violation warnings creates contradictory
      // imperatives for the agent.
      store.recordApprovedPattern({ description: "Service pattern" });
      store.recordRejectedApproach({ description: "Inline refactor" });

      // Burn the first tool call on something other than check_feedback
      await callTool("log_reasoning", {
        action: "warm-up",
        reasoning: "trigger the first-call hint elsewhere",
        confidence: "low",
      });

      const { text } = await callTool("check_feedback");
      expect(text).not.toContain("previous sessions");
      expect(text).not.toContain("Rejected approaches");
    });
  });

  describe("export_session", () => {
    it("returns markdown in the specified format", async () => {
      await callTool("present_findings", {
        summary: "Auth issues",
        findings: [{ category: "Security", detail: "Weak hashing", significance: "high" }],
      });

      const { text } = await callTool("export_session", { format: "full" });
      expect(text).toContain("Session Report");
      expect(text).toContain("Weak hashing");
    });
  });

  describe("answer_question + question prioritization", () => {
    it("prioritizes question comments in check_feedback with an answer hint", async () => {
      await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      const artifact = store.getArtifacts()[0];
      store.addComment({
        id: "cmt_plain",
        artifactId: artifact.id,
        content: "just a note",
        author: "human",
      });
      store.addComment({
        id: "cmt_q1",
        artifactId: artifact.id,
        content: "why did you pick this approach?",
        author: "human",
        intent: "question",
      });

      const { text } = await callTool("check_feedback");
      // Questions section appears and carries the answer hint
      expect(text).toContain("Human questions");
      expect(text).toContain("why did you pick this approach");
      expect(text).toContain("answer_question");
      expect(text).toContain("cmt_q1");
      // Questions are listed before regular comments in the final text
      const qIdx = text.indexOf("Human questions");
      const cIdx = text.indexOf("Human comments");
      expect(qIdx).toBeGreaterThanOrEqual(0);
      expect(cIdx === -1 || qIdx < cIdx).toBe(true);
    });

    it("answer_question links the reply and marks the question answered", async () => {
      await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      const artifact = store.getArtifacts()[0];
      const question = store.addComment({
        id: "cmt_q2",
        artifactId: artifact.id,
        content: "what else did you consider?",
        author: "human",
        intent: "question",
      });

      const { text, isError } = await callTool("answer_question", {
        commentId: question.id,
        answer: "I considered X but rejected it because Y.",
      });

      expect(isError).toBeFalsy();
      expect(text).toContain(question.id);

      // Parent question should now carry answeredByCommentId
      const parent = store.getComment(question.id);
      expect(parent?.answeredByCommentId).toBeTruthy();

      // The answer comment is agent-authored, parented, and acknowledged
      const all = store.getCommentsForArtifact(artifact.id);
      const answer = all.find((c) => c.id === parent?.answeredByCommentId);
      expect(answer).toBeDefined();
      expect(answer?.author).toBe("agent");
      expect(answer?.parentCommentId).toBe(question.id);
      expect(answer?.content).toContain("considered X");
    });

    it("already-answered questions drop out of the priority lane", async () => {
      await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      const artifact = store.getArtifacts()[0];
      const q = store.addComment({
        id: "cmt_q3",
        artifactId: artifact.id,
        content: "what does this do?",
        author: "human",
        intent: "question",
      });
      // Acknowledge so the existing check_feedback exchange doesn't re-surface it first
      store.acknowledgeComments([q.id]);
      await callTool("answer_question", {
        commentId: q.id,
        answer: "It's a guard clause.",
      });

      // Add a fresh plain comment so check_feedback has something to show
      store.addComment({
        id: "cmt_plain2",
        artifactId: artifact.id,
        content: "makes sense",
        author: "human",
      });

      const { text } = await callTool("check_feedback");
      expect(text).not.toContain("Human questions");
      expect(text).toContain("Human comments");
    });

    it("errors when answering an unknown commentId", async () => {
      const { isError, text } = await callTool("answer_question", {
        commentId: "cmt_not_real",
        answer: "hi",
      });
      expect(isError).toBe(true);
      expect(text).toContain("no comment");
    });
  });

  describe("D10 — update_plan_progress (the joint checklist)", () => {
    it("marks steps, persists into content, and reports progress", async () => {
      await callTool("present_plan", {
        title: "Build it",
        objective: "obj",
        steps: [
          { description: "step one", reasoning: "r1" },
          { description: "step two", reasoning: "r2" },
          { description: "step three", reasoning: "r3" },
        ],
        estimatedChanges: 3,
      });
      const plan = store.getArtifacts().find((a) => a.type === "plan")!;
      const res = await callTool("update_plan_progress", {
        artifactId: plan.id,
        updates: [
          { stepIndex: 0, status: "done" },
          { stepIndex: 1, status: "in_progress" },
        ],
      });
      expect(res.isError).toBeFalsy();
      expect(res.text).toContain("1/3 steps complete");
      const steps = (store.getArtifacts().find((a) => a.id === plan.id)!.content as any).steps;
      expect(steps[0].status).toBe("done");
      expect(steps[1].status).toBe("in_progress");
      expect(steps[2].status).toBeUndefined();
    });

    it("warns loudly when progress is marked on an UNAPPROVED plan (F2-class honor-review)", async () => {
      await callTool("present_plan", { title: "P", objective: "o", steps: [{ description: "s", reasoning: "r" }], estimatedChanges: 1 });
      const plan = store.getArtifacts().find((a) => a.type === "plan")!;
      expect(plan.status).toBe("draft");
      const res = await callTool("update_plan_progress", { artifactId: plan.id, updates: [{ stepIndex: 0, status: "in_progress" }] });
      expect(res.isError).toBeFalsy(); // progress IS recorded...
      expect(res.text).toContain("WARNING");
      expect(res.text).toContain("AWAITING REVIEW");
    });

    it("rejects unknown artifacts, non-plans, bad statuses, and out-of-range-only updates", async () => {
      const bad = await callTool("update_plan_progress", { artifactId: "art_nope", updates: [{ stepIndex: 0, status: "done" }] });
      expect(bad.isError).toBe(true);

      await callTool("present_findings", { title: "R", summary: "s", findings: [{ category: "c", title: "t", detail: "d", evidence: "e", significance: "low" }] });
      const research = store.getArtifacts().find((a) => a.type === "research")!;
      const notPlan = await callTool("update_plan_progress", { artifactId: research.id, updates: [{ stepIndex: 0, status: "done" }] });
      expect(notPlan.isError).toBe(true);

      await callTool("present_plan", { title: "P", objective: "o", steps: [{ description: "s", reasoning: "r" }], estimatedChanges: 1 });
      const plan = store.getArtifacts().find((a) => a.type === "plan")!;
      const badStatus = await callTool("update_plan_progress", { artifactId: plan.id, updates: [{ stepIndex: 0, status: "finished" }] });
      expect(badStatus.isError).toBe(true);
      const outOfRange = await callTool("update_plan_progress", { artifactId: plan.id, updates: [{ stepIndex: 99, status: "done" }] });
      expect(outOfRange.isError).toBe(true);
    });
  });
});
