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
      // I7 — every check_feedback carries the LIVE companion UI URL built from
      // the daemon's real port (harness fixture: 4000), so the polling agent
      // never has to guess it. Field report: an agent hallucinated "5173".
      expect((empty.structuredContent as any).companionUrl).toBe("http://localhost:4000");

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

    it("#140 — a region-anchored diagram comment reaches the agent as TEXT naming the nodes", async () => {
      await callTool("present_findings", {
        title: "Arch", summary: "s",
        findings: [{ category: "arch", title: "F", detail: "d", evidence: "e", significance: "low" }],
      });
      const art = store.getArtifacts()[0];
      store.addComment({
        id: "rc_1", artifactId: art.id, content: "split this box", author: "human",
        target: {
          artifactId: art.id,
          visualId: "vis_1",
          region: { x: 0.1, y: 0.1, w: 0.4, h: 0.2, elementIds: ["flowchart-AuthGate-1"], labels: ["AuthGate", "Login"] },
        },
      } as any);

      const res = await callTool("check_feedback");
      // Text referent — labels, not a screenshot.
      expect(res.text).toContain("on region [AuthGate, Login]");
      const sc = res.structuredContent as any;
      expect(sc.comments[0]).toMatchObject({ id: "rc_1" });
      expect(sc.comments[0].region.labels).toEqual(["AuthGate", "Login"]);
    });

    it("#140 — a region with only ids (no labels, e.g. an unlabeled-node drag) appends NO referent (ids are render-unique noise) and carries no structured region", async () => {
      await callTool("present_findings", {
        title: "Arch", summary: "s",
        findings: [{ category: "arch", title: "F", detail: "d", evidence: "e", significance: "low" }],
      });
      const art = store.getArtifacts()[0];
      store.addComment({
        id: "rc_2", artifactId: art.id, content: "here", author: "human",
        target: { artifactId: art.id, visualId: "v", region: { x: 0, y: 0, w: 0.5, h: 0.5, elementIds: ["dp-mmd-3-4-flowchart-Store-0"] } },
      } as any);
      const res = await callTool("check_feedback");
      // The comment still reaches the agent…
      expect(res.text).toContain("here");
      // …but with no meaningless render-unique id dumped into prose or structure.
      expect(res.text).not.toContain("on region");
      expect("region" in (res.structuredContent as any).comments[0]).toBe(false);
    });

    it("#140 — a non-region comment carries NO region key in structuredContent (byte-for-byte minimal)", async () => {
      await callTool("present_findings", {
        title: "Arch", summary: "s",
        findings: [{ category: "arch", title: "F", detail: "d", evidence: "e", significance: "low" }],
      });
      const art = store.getArtifacts()[0];
      store.addComment({ id: "pc_1", artifactId: art.id, content: "plain", author: "human", target: { artifactId: art.id } } as any);
      const res = await callTool("check_feedback");
      const sc = res.structuredContent as any;
      expect(res.text).not.toContain("on region");
      expect("region" in sc.comments[0]).toBe(false);
    });

    it("#173 — a DECISION region comment reaches the agent with optionId + visualId + rect + label-matched nearNodes", async () => {
      await callTool("present_options", {
        context: "Which session store?",
        options: [
          { id: "opt_redis", title: "Redis", description: "external cache", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "opt_pg", title: "Postgres", description: "in the DB", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      });
      const art = store.getArtifacts()[0];
      // The focused-view region layer anchors to optionId + visualId + region.
      store.addComment({
        id: "drc_1", artifactId: art.id, content: "why straight to Redis?", author: "human", intent: "question",
        target: {
          artifactId: art.id,
          optionId: "opt_redis",
          visualId: "vis_arch",
          region: { x: 0.37, y: 0.42, w: 0.29, h: 0.17, elementIds: ["dp-mmd-7-8-flowchart-AppServer-0"], labels: ["App Server", "Redis"] },
        },
      } as any);

      const res = await callTool("check_feedback");
      // Prose names the option + the region's nodes (label-matched).
      expect(res.text).toContain('option "Redis"');
      expect(res.text).toContain("on region [App Server, Redis]");
      // Structured delivery carries the full anchor with re-render-safe nearNodes.
      const q = (res.structuredContent as any).questions[0];
      expect(q.optionId).toBe("opt_redis");
      expect(q.visualId).toBe("vis_arch");
      expect(q.region).toMatchObject({ x: 0.37, y: 0.42, w: 0.29, h: 0.17, nearNodes: ["App Server", "Redis"] });
      // nearNodes are LABELS, not the render-unique elementIds (#163).
      expect(q.region.elementIds).toBeUndefined();
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

    it("GH#152 — waitFor='decision' with a stale unack comment SURFACES it immediately (never swallows human input)", async () => {
      // Supersedes the pre-GH#152 BB3 behavior. Design principle: a scoped
      // wait says what the agent is HOPING for, but human COMMENTS are always
      // actionable and must never be swallowed. A stale unack comment (even on
      // an unrelated artifact) therefore satisfies waitFor='decision'
      // immediately — the agent reads/triages it, acks it, then polls again
      // with a clean queue and properly waits for the option pick.
      await callTool("present_options", {
        context: "Which pattern?",
        options: [
          { id: "a", title: "A", description: "A", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "B", description: "B", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      });
      // Stash a stale comment on a different artifact — this is human input.
      store.addComment({ id: "cmt_stale", artifactId: "art_other", content: "old chatter", author: "human" });

      const t0 = Date.now();
      const res = await callTool("check_feedback", { waitFor: "decision" });
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(1000); // immediate — not the 30s long-poll
      expect(res.text).toContain("old chatter"); // the comment is surfaced, not swallowed
      // The decision it presented is still flagged pending in the same response.
      expect(res.text).toContain("decision(s) pending");
      // Next poll: the comment is acked/drained, so an empty queue would long-poll.
      expect(store.getUnacknowledgedComments()).toHaveLength(0);
    });

    it("GH#152 — waitFor='decision' wakes on an unrelated comment and RETURNS it (does not swallow it as chatter)", async () => {
      // Supersedes the pre-GH#152 CC5 behavior. Pre-fix, a comment that woke
      // the long-poll under waitFor='decision' was discarded with a "Still
      // waiting… unrelated chatter" message and comments:[] — stranding human
      // input. Now the comment is reported (and acked), the decision is still
      // flagged pending, and the misleading "unrelated chatter" copy is gone.
      await callTool("present_options", {
        context: "Pick a deploy",
        options: [
          { id: "a", title: "A", description: "A", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "B", description: "B", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      });
      // Schedule the comment after 50ms so the long-poll wakes mid-flight.
      setTimeout(() => {
        store.addComment({ id: "cmt_noise", artifactId: "art_other", content: "stray remark", author: "human" });
      }, 50);
      const res = await callTool("check_feedback", { waitFor: "decision" });
      expect(res.text).toContain("stray remark");
      expect(res.text).not.toContain("Still waiting on 'decision'");
      expect(res.text).not.toContain("unrelated chatter");
      const sc = res.structuredContent as any;
      expect(sc.status).toBe("feedback");
      expect(sc.comments.some((c: any) => c.id === "cmt_noise")).toBe(true);
      // Decision still flagged pending so the agent knows to keep waiting for it.
      expect(res.text).toContain("decision(s) pending");
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

    // GH#152 — THE FIELD BUG. Agent presents a decision and polls
    // waitFor='decision'. The human COMMENTS on the decision instead of
    // picking an option. Pre-fix, hasImmediateFor/scopeSatisfied only counted
    // resolved decisions, so the comment was invisible, framed as "unrelated
    // chatter", shipped with comments:[], and the agent polled forever while
    // the human waited for a reply. Now the comment is always actionable.
    describe("GH#152 — a human comment on a pending decision is never swallowed", () => {
      async function presentDecision() {
        await callTool("present_options", {
          context: "Which datastore?",
          options: [
            { id: "pg", title: "Postgres", description: "relational", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
            { id: "mongo", title: "Mongo", description: "document", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
          ],
        });
        return store.getArtifacts().find((a) => a.type === "decision")!;
      }

      it("THE FIELD BUG: waitFor='decision' + a comment ON the decision → returns it, acks it, no 'unrelated chatter'", async () => {
        await client.listTools(); // activate SDK outputSchema validation on every return path
        const decision = await presentDecision();
        // Human comments on the decision artifact rather than selecting.
        store.addComment({
          id: "cmt_on_dec",
          artifactId: decision.id,
          content: "Can we afford the ops overhead of Postgres?",
          author: "human",
          target: { artifactId: decision.id },
        } as any);

        const res = await callTool("check_feedback", { waitFor: "decision" });
        // The comment reaches the agent — in text AND structuredContent.
        expect(res.text).toContain("Can we afford the ops overhead of Postgres?");
        const sc = res.structuredContent as any;
        expect(sc.comments.some((c: any) => c.id === "cmt_on_dec")).toBe(true);
        expect(sc.status).toBe("feedback");
        // It must NOT claim nothing arrived, and must NOT use the removed copy.
        expect(res.text).not.toContain("Still waiting on 'decision'");
        expect(res.text).not.toContain("unrelated chatter");
        expect(res.text).not.toContain("Nothing arrived");
        // BOTH signals present: act on the comment AND the decision is still pending.
        expect(res.text).toContain("decision(s) pending");
        expect(sc.suggestedAction).toContain("Wait for decision selection");
        expect(sc.suggestedAction).toContain("also left a comment");
        // Acknowledged → not re-reported on the next poll.
        expect(store.getUnacknowledgedComments()).toHaveLength(0);
        // Full structuredContent shape preserved (V-fix fields on every path).
        expect(Array.isArray(sc.statusChanges)).toBe(true);
        expect(typeof sc.serverVersion).toBe("string");
      });

      it("waitFor='decision' still works when the human RESOLVES the decision (existing behavior intact)", async () => {
        await client.listTools();
        const decision = await presentDecision();
        const dec = store.getPendingDecisions().find((d) => d.artifactId === decision.id)!;
        store.resolveDecision(dec.decisionId, "pg", "cheapest to operate");

        const res = await callTool("check_feedback", { waitFor: "decision" });
        expect(res.text).toContain("Postgres");
        const sc = res.structuredContent as any;
        expect(sc.decisions.some((d: any) => d.selectedOptionId === "pg")).toBe(true);
        expect(sc.status).toBe("feedback");
      });

      it("a human QUESTION on the pending decision surfaces with an answer_question hint", async () => {
        await client.listTools();
        const decision = await presentDecision();
        store.addComment({
          id: "q_on_dec",
          artifactId: decision.id,
          content: "What's the migration cost of Mongo?",
          author: "human",
          intent: "question",
          target: { artifactId: decision.id },
        } as any);

        const res = await callTool("check_feedback", { waitFor: "decision" });
        expect(res.text).toContain("What's the migration cost of Mongo?");
        expect(res.text).toContain("answer_question");
        const sc = res.structuredContent as any;
        expect(sc.questions.some((q: any) => q.commentId === "q_on_dec")).toBe(true);
        expect(res.text).not.toContain("unrelated chatter");
        // Decision still pending alongside the question.
        expect(res.text).toContain("decision(s) pending");
      });

      it("the genuine nothing-arrived path stays scoped and validates (no comments, no matching signal)", async () => {
        await client.listTools();
        await presentDecision();
        // Nothing added → the 50ms schedule adds a NON-comment, NON-decision
        // signal (a plan approval) that must NOT satisfy waitFor='decision'.
        await callTool("present_plan", {
          title: "Rollout", objective: "ship", steps: [{ description: "s", reasoning: "r" }], estimatedChanges: 1,
        });
        const plan = store.getArtifacts().find((a) => a.type === "plan")!;
        setTimeout(() => store.updateArtifactStatus(plan.id, "approved", "ui_approve_button"), 50);

        const res = await callTool("check_feedback", { waitFor: "decision" });
        // Plan approval is a status-only transition — correctly ignored by the
        // decision scope, so we get the honest still-waiting response.
        expect(res.text).toContain("Still waiting on 'decision'");
        expect(res.text).not.toContain("unrelated chatter");
        const sc = res.structuredContent as any;
        expect(sc).toMatchObject({ status: "waiting", waitFor: "decision" });
        // Full shape preserved even on the early-return path.
        expect(sc.comments).toEqual([]);
        expect(sc.statusChanges).toEqual([]);
        expect(typeof sc.serverVersion).toBe("string");
      });
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

  // V-fix — a HUMAN approval/rejection of a specific artifact must be
  // OBSERVABLE to the agent by id via check_feedback.statusChanges, not just
  // inferable from an aggregate count. The field bug: a superseding v2 draft
  // gets approved and the agent can't see "art_X is now approved".
  describe("check_feedback — statusChanges (V-fix)", () => {
    it("reports a HUMAN draft→approved spec by id, ONCE, in structured + text", async () => {
      await client.listTools(); // activate SDK outputSchema validation
      await callTool("present_spec", {
        title: "Auth spec",
        objective: "Throttle logins",
        requirements: [{ id: "REQ-1", statement: "limit failures", rationale: "brute force", acceptanceCriteria: ["5/10min"], priority: "must" }],
      });
      const spec = store.getArtifacts().find((a) => a.type === "spec")!;

      // Human approves in the companion UI (ui_approve_button is human-driven).
      store.updateArtifactStatus(spec.id, "approved", "ui_approve_button");

      const first = await callTool("check_feedback");
      const sc = first.structuredContent as any;
      expect(sc.statusChanges).toEqual([
        expect.objectContaining({ id: spec.id, type: "spec", status: "approved", previousStatus: "draft" }),
      ]);
      expect(typeof sc.statusChanges[0].at).toBe("string");
      // Loud, unmissable, names the id + new status.
      expect(first.text).toContain("RESOLVED");
      expect(first.text).toContain(spec.id);
      expect(first.text).toContain("approved");
      // A human approval IS actionable — status flips off "waiting".
      expect(sc.status).toBe("feedback");

      // Second poll must NOT repeat it (acknowledged / drained).
      const second = await callTool("check_feedback");
      expect((second.structuredContent as any).statusChanges).toEqual([]);
      expect(second.text).not.toContain("RESOLVED");
    });

    it("THE FIELD BUG: a superseding v2 draft, once HUMAN-approved, is reported by id", async () => {
      await client.listTools();
      await callTool("present_spec", {
        title: "Spec v1",
        objective: "first cut",
        requirements: [{ id: "REQ-1", statement: "s", rationale: "r", acceptanceCriteria: ["a"], priority: "must" }],
      });
      const v1 = store.getArtifacts().find((a) => a.type === "spec")!;

      await callTool("revise_artifact", {
        artifactId: v1.id,
        mode: "supersede",
        title: "Spec v2",
        content: {
          objective: "revised cut",
          requirements: [{ id: "REQ-1", statement: "s2", rationale: "r2", acceptanceCriteria: ["a2"], priority: "must" }],
        },
        reason: "reworked the approach",
      });
      const v2 = store.getArtifacts().find((a) => a.id !== v1.id && a.type === "spec")!;
      expect(v2.status).toBe("draft");
      expect(v2.version).toBe(2);

      // Proves the EXISTING surfacing works: the v2 draft appears by id in
      // pendingArtifacts before any verdict. (An immediate comment makes
      // check_feedback return fast instead of long-polling the pending draft.)
      store.addComment({ id: "c_imm", artifactId: v2.id, content: "reviewing", author: "human" });
      const pending = await callTool("check_feedback");
      const pendIds = (pending.structuredContent as any).pendingArtifacts.map((a: any) => a.id);
      expect(pendIds).toContain(v2.id);
      // The agent-driven v1→superseded transition must NOT be reported.
      expect((pending.structuredContent as any).statusChanges).toEqual([]);

      // Human approves the v2 draft.
      store.updateArtifactStatus(v2.id, "approved", "ui_approve_button");

      const after = await callTool("check_feedback");
      const changes = (after.structuredContent as any).statusChanges;
      expect(changes).toEqual([
        expect.objectContaining({ id: v2.id, type: "spec", status: "approved", previousStatus: "draft" }),
      ]);
      // The v1 superseded (agent_supersede) is never in statusChanges.
      expect(changes.map((c: any) => c.id)).not.toContain(v1.id);
      expect(after.text).toContain(v2.id);
    });

    it("does NOT report an AGENT-driven supersede transition (agent_supersede) in statusChanges", async () => {
      await client.listTools();
      await callTool("present_findings", {
        summary: "first pass",
        findings: [{ category: "Security", detail: "weak hash", significance: "high" }],
      });
      const old = store.getArtifacts()[0];

      await callTool("revise_artifact", {
        artifactId: old.id,
        mode: "supersede",
        title: "Second pass",
        content: { summary: "revised", findings: [{ category: "Security", detail: "argon2id", significance: "low" }] },
        reason: "misread the library",
      });
      // v1 went draft→superseded via agent_supersede; the human did nothing.
      // The v2 successor is a pending draft, so add an immediate comment to
      // make check_feedback return fast instead of long-polling it.
      const successor = store.getArtifacts().find((a) => a.id !== old.id)!;
      store.addComment({ id: "c_imm2", artifactId: successor.id, content: "reviewing", author: "human" });
      const res = await callTool("check_feedback");
      expect((res.structuredContent as any).statusChanges).toEqual([]);
      expect(res.text).not.toContain("RESOLVED");
    });

    it("carries serverVersion matching the MCP serverInfo version", async () => {
      const info = ctx.client.getServerVersion();
      const res = await callTool("check_feedback");
      const version = (res.structuredContent as any).serverVersion;
      expect(typeof version).toBe("string");
      expect(version.length).toBeGreaterThan(0);
      expect(version).toBe(info?.version);
      expect(res.text).toContain(`v${version}`);
    });
  });
});
