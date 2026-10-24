/**
 * D2 — split from the 3,009-line server.test.ts along tool-surface seams.
 * Test bodies are verbatim from the monolith; only the harness wiring is new.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { FileStore } from "../../store/file-store.js";
import { authorizeReviewPost } from "../../github/review-authorization.js";
import { setupServerTest, makeCallTool } from "./server-test-harness.js";

const ctx = setupServerTest();
const callTool = makeCallTool(ctx);
let store: FileStore;
beforeEach(() => {
  store = ctx.store;
});

describe("MCP Tool Handlers — revise_artifact", () => {
  it.each(["withdraw_artifact", "revise_artifact"])("%s accepts existing answer evidence and later human feedback remains durable", async (tool) => {
    await callTool("present_findings", { summary: "Finding", findings: [{ category: "other", detail: "x", significance: "low" }] });
    const artifact = store.getArtifacts()[0];
    store.addComment({ id: "evidence_question", artifactId: artifact.id, author: "human", content: "What is the evidence?", intent: "question" });
    const answer = await callTool("answer_question", { commentId: "evidence_question", answer: "Here is the evidence", evidence: [{ filePath: "x.ts", lineStart: 0 }, { filePath: "y.ts", lineStart: "not-a-number" }] });
    expect(answer.isError).toBeFalsy();
    store.forceFlush();
    const prior = ctx.fx.track(new FileStore(ctx.tmpDir, "test_session"));
    const answerComment = prior.getCommentsForArtifact(artifact.id).find((c) => c.author === "agent" && c.parentCommentId === "evidence_question")!;
    expect(answerComment.codeReferences?.map((r) => r.lineStart)).toEqual([0, null]);
    const result = await callTool(tool, { artifactId: artifact.id, mode: "retract", reason: "The account is superseded by new evidence" });
    expect(result.isError).toBeFalsy();
    store.addComment({ id: "later_human", artifactId: artifact.id, author: "human", content: "Keep this feedback after retirement" });
    store.forceFlush();
    const fresh = ctx.fx.track(new FileStore(ctx.tmpDir, "test_session"));
    expect(fresh.getComment("later_human")?.content).toBe("Keep this feedback after retirement");
    expect(fresh.getComment(answerComment.id)).toEqual(answerComment);
  });

  it.each(["retract", "obsolete"])("%s refuses acknowledged but still-open suggestions without draining other feedback", async (mode) => {
    await callTool("present_findings", { summary: "Finding", findings: [{ category: "other", detail: "x", significance: "low" }] });
    const artifact = store.getArtifacts()[0];
    store.addComment({ id: "open_suggestion", artifactId: artifact.id, author: "human", content: "Use the safer edge path", intent: "suggestion", suggestion: { originalText: "old", replacementText: "new", lineStart: 1, lineEnd: 1, state: "countered" } });
    store.acknowledgeComments(["open_suggestion"]);
    store.addComment({ id: "unrelated", artifactId: "other", author: "human", content: "Keep this queued" });
    const before = structuredClone(store.getComment("open_suggestion"));
    const result = await callTool("revise_artifact", { artifactId: artifact.id, mode, reason: "Moving on" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("open suggestion");
    expect(store.getArtifacts()[0].status).toBe("draft");
    expect(store.getComment("open_suggestion")).toEqual(before);
    expect(store.getComment("unrelated")?.acknowledged).toBe(false);
  });

  it("disarm root marker does not answer feedback, and check_feedback still delivers rich lanes", async () => {
    await callTool("present_findings", { summary: "Finding", findings: [{ category: "other", detail: "x", significance: "low" }] });
    const artifact = store.getArtifacts()[0];
    store.createArtifact({ id: "external", type: "changeset", title: "External PR", content: { files: [], reviewIntent: "external" } });
    store.updateArtifactStatus(artifact.id, "approved", "ui_approve_button");
    store.addComment({ id: "still_owed", artifactId: artifact.id, author: "human", content: "Which boundary was tested?", intent: "question" });
    store.addComment({ id: "still_suggested", artifactId: artifact.id, author: "human", content: "Use a timeout", intent: "suggestion", suggestion: { originalText: "old", replacementText: "new", lineStart: 1, lineEnd: 1, state: "pending" } });
    const result = await callTool("revise_artifact", { artifactId: artifact.id, mode: "retract", reason: "Do not send this finding" });
    expect(result.isError).toBeFalsy();
    expect(store.getComment("still_owed")?.acknowledged).toBe(false);
    expect(store.getComment("still_suggested")?.acknowledged).toBe(false);
    const marker = store.getCommentsForArtifact(artifact.id).find((c) => c.author === "agent" && c.content.startsWith("Un-armed"));
    expect(marker?.parentCommentId).toBeFalsy();
    const feedback = await callTool("check_feedback");
    expect((feedback.structuredContent as { questions: Array<{ commentId: string }> }).questions.map((q) => q.commentId)).toContain("still_owed");
    expect(feedback.text).toContain("Use a timeout");
  });

  it("blocks rejected approaches in revisions before superseding or creating artifacts", async () => {
    await callTool("present_findings", { summary: "Inspect dependency injection", findings: [{ category: "Architecture", detail: "Use constructor arguments", significance: "high" }] });
    const old = store.getArtifacts()[0];
    const originalStatus = old.status;
    store.recordRejectedApproach({ description: "global mutable state for config", concept: "global mutable state for config", reason: "Hard to test" });
    const result = await callTool("revise_artifact", {
      artifactId: old.id, mode: "supersede", reason: "New recommendation",
      content: { summary: "Use global mutable state for config", findings: [{ category: "Architecture", detail: "Use a singleton", significance: "high" }] },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("REJECTED_APPROACH_BLOCKED");
    expect(store.getArtifacts()).toHaveLength(1);
    expect(store.getArtifacts()[0].status).toBe(originalStatus);
    expect(store.getCommentsForArtifact(old.id)).toHaveLength(0);
  });

  it("records the policy trace on an allowed revision", async () => {
    await callTool("present_findings", { summary: "Inspect config", findings: [{ category: "Architecture", detail: "Use constructor arguments", significance: "high" }] });
    const old = store.getArtifacts()[0];
    const result = await callTool("revise_artifact", { artifactId: old.id, mode: "supersede", reason: "Clarify",
      content: { summary: "Inject config", findings: [{ category: "Architecture", detail: "Pass config explicitly", significance: "high" }] } });
    expect(result.isError).not.toBe(true);
    const next = store.getArtifacts().find(a => a.parentId === old.id)!;
    expect(store.getPreflightTrace(next.id)).toBeTruthy();
  });

  it("preserves external PR identity on revision without inheriting the reviewed head SHA", async () => {
    store.recordRejectedApproach({
      description: "in-process rate limiting",
      concept: "in-process rate limiting",
      reason: "we use the edge limiter",
    });
    const source = {
      kind: "github-pr",
      number: 123,
      url: "https://github.com/acme/widgets/pull/123",
      headRef: "feat/rate-limit",
      baseRef: "main",
      author: "dana",
      headSha: "0123456789abcdef0123456789abcdef01234567",
    };
    await callTool("present_changeset", {
      title: "PR #123 — in-process rate limiting",
      summary: "Adds in-process rate limiting.",
      files: [{ path: "src/limiter.ts", changeType: "modified", hunks: [] }],
      reviewIntent: "external",
      source,
    });
    const old = store.getArtifacts()[0]!;

    const result = await callTool("revise_artifact", {
      artifactId: old.id,
      mode: "supersede",
      reason: "refresh the displayed diff",
      // The normal replacement shape omits review-only metadata.
      content: {
        summary: "Still uses in-process rate limiting, with a corrected hunk.",
        files: [{ path: "src/limiter.ts", changeType: "modified", hunks: [] }],
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.text).toContain("advisory, not a block");
    const revised = store.getArtifacts().find((a) => a.parentId === old.id)!;
    expect(revised.status).toBe("draft");
    expect((revised.content as any).reviewIntent).toBe("external");
    expect((revised.content as any).source).toEqual({
      kind: "github-pr",
      number: 123,
      url: "https://github.com/acme/widgets/pull/123",
      headRef: "feat/rate-limit",
      baseRef: "main",
      author: "dana",
    });
    expect((revised.content as any).source.headSha).toBeUndefined();

    await callTool("present_findings", {
      title: "Review of PR #123",
      summary: "Finding approved against the earlier immutable head.",
      findings: [{
        category: "Concurrency",
        title: "Limiter update races logout",
        detail: "The limiter update can land after logout.",
        significance: "high",
        severity: "high",
        evidence: [{
          filePath: "src/limiter.ts", lineStart: 1, lineEnd: 1,
          snippet: "updateLimiter()", explanation: "This call races the logout transition.",
        }],
      }],
    });
    const findings = store.getArtifacts().find((a) => a.type === "research")!;
    store.updateArtifactStatus(findings.id, "approved");
    const authorization = authorizeReviewPost(
      { sessionId: "revision-freshness", artifacts: store.getArtifacts() },
      { event: "COMMENT", pr: source.url },
    );
    expect(authorization.ok).toBe(false);
    if (authorization.ok) throw new Error("unreachable");
    expect(authorization.reason).toContain("refresh-required revision");
  });

  it("accepts explicitly refreshed source provenance on an external revision", async () => {
    await callTool("present_changeset", {
      title: "PR #123",
      files: [{ path: "src/limiter.ts", changeType: "modified", hunks: [] }],
      reviewIntent: "external",
      source: {
        kind: "github-pr", number: 123, url: "https://github.com/acme/widgets/pull/123",
        headSha: "0123456789abcdef0123456789abcdef01234567",
      },
    });
    const old = store.getArtifacts()[0]!;
    const freshSha = "89abcdef0123456789abcdef0123456789abcdef";
    const result = await callTool("revise_artifact", {
      artifactId: old.id,
      mode: "supersede",
      reason: "fetched the new PR head",
      content: {
        files: [{ path: "src/limiter.ts", changeType: "modified", hunks: [] }],
        source: {
          kind: "github-pr", number: 123, url: "https://github.com/acme/widgets/pull/123", headSha: freshSha,
        },
      },
    });
    expect(result.isError).toBeFalsy();
    const revised = store.getArtifacts().find((a) => a.parentId === old.id)!;
    expect((revised.content as any).reviewIntent).toBe("external");
    expect((revised.content as any).source.headSha).toBe(freshSha);
    expect(revised.status).toBe("draft");
  });

  it("treats a debrief revision as historical narrative, not a new rejected proposal", async () => {
    await callTool("present_debrief", {
      title: "Debrief — loader",
      summary: "We shipped the loader with the selected cache.",
    });
    const old = store.getArtifacts()[0]!;
    store.recordRejectedApproach({
      description: "in-memory LRU cache",
      concept: "in-memory LRU cache",
      reason: "it diverges per process",
    });

    const result = await callTool("revise_artifact", {
      artifactId: old.id,
      mode: "supersede",
      reason: "record the rejected alternative",
      content: { summary: "We shipped the loader after you rejected the in-memory LRU cache." },
    });
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain("advisory, not a block");
    const revised = store.getArtifacts().find((a) => a.parentId === old.id)!;
    expect(revised.status).toBe("draft");
    expect((revised.content as any).summary).toContain("rejected the in-memory LRU cache");
  });
  describe("revise_artifact — the STYLE echo (review round 1)", () => {
    it("echoes house style on a supersede, so the fix-it path is not the silent one", async () => {
      await callTool("present_findings", {
        summary: "The daemon binds one port.",
        findings: [{ category: "other", detail: "It reads it back.", significance: "low" }],
      });
      const artifact = store.getArtifacts()[0];
      const { text, isError } = await callTool("revise_artifact", {
        artifactId: artifact.id,
        mode: "supersede",
        reason: "tightening the readout",
        content: {
          summary: "The gate fired; the artifact landed anyway.",
          findings: [{ category: "other", detail: "It reads it back.", significance: "low" }],
        },
      });
      expect(isError).toBeFalsy();
      expect(text).toContain("STYLE (clarity");
      expect(text).toContain("Semicolon");
    });

    it("stays silent on a supersede whose prose is clean", async () => {
      await callTool("present_findings", {
        summary: "The daemon binds one port.",
        findings: [{ category: "other", detail: "It reads it back.", significance: "low" }],
      });
      const artifact = store.getArtifacts()[0];
      const { text } = await callTool("revise_artifact", {
        artifactId: artifact.id,
        mode: "supersede",
        reason: "tightening the readout",
        content: {
          summary: "The daemon binds one port per project.",
          findings: [{ category: "other", detail: "The companion reads it back.", significance: "low" }],
        },
      });
      expect(text).not.toContain("STYLE (clarity");
    });
  });

  describe("revise_artifact — mode: obsolete", () => {
    it("marks the artifact obsolete (overcome by new info) so it leaves the review queue", async () => {
      await callTool("present_findings", {
        summary: "early analysis",
        findings: [{ category: "other", detail: "x", significance: "low" }],
      });
      const artifact = store.getArtifacts()[0];

      const { text, isError } = await callTool("revise_artifact", {
        artifactId: artifact.id,
        mode: "obsolete",
        reason: "the spec changed; this no longer applies",
      });

      expect(isError).toBeFalsy();
      expect(text.toLowerCase()).toContain("obsolete");
      expect(store.getArtifacts()[0].status).toBe("obsolete");
      // Neutral agent comment records why (not "Retracted").
      const comments = store.getCommentsForArtifact(artifact.id);
      expect(
        comments.some((c) => c.author === "agent" && c.content.includes("Overcome by new information")),
      ).toBe(true);
    });

    it("errors when trying to obsolete an already-approved artifact", async () => {
      await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "other", detail: "y", significance: "low" }],
      });
      const artifact = store.getArtifacts()[0];
      store.updateArtifactStatus(artifact.id, "approved");
      const { isError, text } = await callTool("revise_artifact", {
        artifactId: artifact.id,
        mode: "obsolete",
        reason: "too late",
      });
      expect(isError).toBe(true);
      expect(text).toContain("too late to obsolete");
    });
  });

  describe("revise_artifact — mode: retract (N4)", () => {
    it("transitions the artifact to retracted and records the reason", async () => {
      await callTool("present_findings", {
        summary: "hasty analysis",
        findings: [{ category: "other", detail: "something", significance: "low" }],
      });
      const artifact = store.getArtifacts()[0];

      const { text, isError } = await callTool("revise_artifact", {
        artifactId: artifact.id,
        mode: "retract",
        reason: "realised I had the wrong file",
      });

      expect(isError).toBeFalsy();
      expect(text).toContain(artifact.id);
      expect(store.getArtifacts()[0].status).toBe("retracted");

      // Agent-authored comment preserves the reason for the human to see
      const comments = store.getCommentsForArtifact(artifact.id);
      expect(comments.length).toBeGreaterThan(0);
      expect(comments.some((c) => c.author === "agent" && c.content.includes("wrong file"))).toBe(true);
    });

    it("errors when the artifact id is unknown", async () => {
      const { isError, text } = await callTool("revise_artifact", {
        artifactId: "art_does_not_exist",
        mode: "retract",
        reason: "oops",
      });
      expect(isError).toBe(true);
      expect(text).toContain("no artifact");
    });

    it("errors when trying to retract an already-approved artifact", async () => {
      await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      const artifact = store.getArtifacts()[0];
      store.updateArtifactStatus(artifact.id, "approved");

      const { isError, text } = await callTool("revise_artifact", {
        artifactId: artifact.id,
        mode: "retract",
        reason: "second thoughts",
      });
      expect(isError).toBe(true);
      expect(text).toContain("too late to retract");
    });

    it("requires artifactId, mode, and reason", async () => {
      const missingReason = await callTool("revise_artifact", { artifactId: "art_x", mode: "retract" });
      expect(missingReason.isError).toBe(true);
      expect(missingReason.text).toContain("reason");

      const missingId = await callTool("revise_artifact", { mode: "retract", reason: "no id" });
      expect(missingId.isError).toBe(true);
      expect(missingId.text).toContain("artifactId");

      const missingMode = await callTool("revise_artifact", { artifactId: "art_x", reason: "no mode" });
      expect(missingMode.isError).toBe(true);
      expect(missingMode.text).toContain("mode");
    });
  });

  describe("revise_artifact — mode: supersede (N4)", () => {
    it("creates a versioned child and retires the old one", async () => {
      await callTool("present_findings", {
        summary: "first pass",
        findings: [{ category: "Security", detail: "weak hash", significance: "high" }],
      });
      const old = store.getArtifacts()[0];

      const { text, isError } = await callTool("revise_artifact", {
        artifactId: old.id,
        mode: "supersede",
        title: "Second pass: actually it's argon2",
        content: {
          summary: "revised: weak hash turned out to be argon2id",
          findings: [{ category: "Security", detail: "already argon2id", significance: "low" }],
        },
        reason: "misidentified the library on first read",
      });

      expect(isError).toBeFalsy();
      expect(text).toContain(old.id);
      expect(text).toContain("v2");

      const artifacts = store.getArtifacts();
      expect(artifacts).toHaveLength(2);

      const retired = artifacts.find((a) => a.id === old.id);
      expect(retired?.status).toBe("superseded");

      const successor = artifacts.find((a) => a.id !== old.id);
      expect(successor?.type).toBe("research");
      expect(successor?.version).toBe(2);
      expect(successor?.parentId).toBe(old.id);
      expect(successor?.status).toBe("draft");

      // Reason is preserved as an agent comment on the OLD artifact
      const retiredComments = store.getCommentsForArtifact(old.id);
      expect(retiredComments.some((c) =>
        c.author === "agent" && c.content.includes("misidentified"))).toBe(true);
    });

    // #225 (N1) — THE SUPERSEDE-SWALLOW fix. The edge-hunt's exact repro: a
    // human posts a plain comment on v1, then the agent supersedes to v2 BEFORE
    // its next check_feedback. Pre-fix, the supersede's getPassiveFeedback() drain
    // ACKNOWLEDGED that undrained comment (and dumped it context-free), so it
    // vanished — never surfaced, never carried. Now it survives UNACKNOWLEDGED and
    // check_feedback delivers it with its v1 context.
    it("#225 — a plain comment on v1 survives supersede UNACKNOWLEDGED and is delivered by the next check_feedback (fail-on-revert)", async () => {
      await callTool("present_findings", {
        summary: "v1",
        findings: [{ category: "bug", detail: "d", significance: "medium" }],
      });
      const v1 = store.getArtifacts()[0];
      await store.addComment({
        id: "cmt_swallow",
        artifactId: v1.id,
        content: "please keep the old behavior",
        author: "human",
        intent: "comment",
      } as any);
      // acknowledged=false at this point (human, freshly posted).
      expect(store.getCommentsForArtifact(v1.id).find((c) => c.id === "cmt_swallow")?.acknowledged).toBeFalsy();

      const { isError } = await callTool("revise_artifact", {
        artifactId: v1.id,
        mode: "supersede",
        reason: "moving on",
        content: { summary: "v2", findings: [{ category: "bug", detail: "d2", significance: "medium" }] },
      });
      expect(isError).toBeFalsy();

      // THE INVARIANT: the supersede itself must NOT have acknowledged the comment.
      expect(store.getCommentsForArtifact(v1.id).find((c) => c.id === "cmt_swallow")?.acknowledged).toBeFalsy();

      // And check_feedback now delivers it — anchored to v1 (its context), in both
      // the prose and the structured comments mirror.
      const res = await callTool("check_feedback");
      expect(res.text).toContain("keep the old behavior");
      expect(res.text).toContain(v1.id);
      const sc = res.structuredContent as any;
      expect(sc.comments.some((c: any) => c.id === "cmt_swallow" && c.artifactId === v1.id)).toBe(true);
    });

    // #225 (N1) — a pending QUESTION on v1 keeps its answer_question obligation.
    it("#225 — a pending question on v1 survives supersede and keeps its answer_question obligation", async () => {
      await callTool("present_findings", {
        summary: "v1",
        findings: [{ category: "bug", detail: "d", significance: "medium" }],
      });
      const v1 = store.getArtifacts()[0];
      await store.addComment({
        id: "cmt_q_swallow",
        artifactId: v1.id,
        content: "Is the old behavior still needed anywhere?",
        author: "human",
        intent: "question",
      } as any);

      await callTool("revise_artifact", {
        artifactId: v1.id,
        mode: "supersede",
        reason: "moving on",
        content: { summary: "v2", findings: [{ category: "bug", detail: "d2", significance: "medium" }] },
      });

      const res = await callTool("check_feedback");
      const sc = res.structuredContent as any;
      // Delivered as a QUESTION (proper obligation), not a bare comment.
      expect(sc.questions.some((q: any) => q.commentId === "cmt_q_swallow")).toBe(true);
      expect(res.text).toContain("old behavior still needed");
    });

    // #225 (N1) — the explicit edge case: a first-class SUGGESTED EDIT pending on
    // v1 at supersede time. Its must-respond obligation must survive too — the next
    // check_feedback delivers it in the suggestions lane, unacknowledged by the
    // supersede.
    it("#225 — a pending suggestion on v1 survives supersede and keeps its must-respond obligation", async () => {
      await callTool("present_findings", {
        summary: "v1",
        findings: [{ category: "bug", detail: "d", significance: "medium" }],
      });
      const v1 = store.getArtifacts()[0];
      await store.addComment({
        id: "cmt_sug_swallow",
        artifactId: v1.id,
        content: "prefer the explicit form",
        author: "human",
        intent: "suggestion",
        target: { artifactId: v1.id, filePath: "src/store.js", lineStart: 15, lineEnd: 15 },
        suggestion: {
          originalText: "Number(id)",
          replacementText: "parseInt(id, 10)",
          lineStart: 15,
          lineEnd: 15,
          state: "pending",
        },
      } as any);

      await callTool("revise_artifact", {
        artifactId: v1.id,
        mode: "supersede",
        reason: "moving on",
        content: { summary: "v2", findings: [{ category: "bug", detail: "d2", significance: "medium" }] },
      });
      // Not swallowed by the supersede.
      expect(store.getCommentsForArtifact(v1.id).find((c) => c.id === "cmt_sug_swallow")?.acknowledged).toBeFalsy();

      const res = await callTool("check_feedback");
      const sc = res.structuredContent as any;
      expect(res.text).toMatch(/Suggested edits \(1\) — you MUST respond/);
      expect((sc.suggestions ?? []).some((s: any) => s.commentId === "cmt_sug_swallow")).toBe(true);
    });

    // #225 (N1, F1) — the residual swallow one level down: after a carry, the
    // NEXT tool's passive drain (getPassiveFeedback on any present_* return) must
    // NOT ack an obligation-bearing carried comment. Scenario: v1 carries a plain
    // comment + a question + a suggestion; supersede to v2; the agent then calls
    // present_findings (its return runs the passive drain). The plain comment
    // drains context-free in that return (unchanged behavior); the QUESTION and
    // SUGGESTION survive UNACKNOWLEDGED and reach the next check_feedback's PRIMARY
    // rich lanes (not merely the #192 carryover backstop).
    it("#225 F1 — a carried suggestion+question survive the NEXT present_*'s passive drain; only the plain comment drains", async () => {
      await callTool("present_findings", {
        summary: "v1",
        findings: [{ category: "bug", detail: "d", significance: "medium" }],
      });
      const v1 = store.getArtifacts()[0];
      await store.addComment({ id: "cmt_plain", artifactId: v1.id, content: "plain drain-me note", author: "human", intent: "comment" } as any);
      await store.addComment({ id: "cmt_q", artifactId: v1.id, content: "does the old path still matter?", author: "human", intent: "question" } as any);
      await store.addComment({
        id: "cmt_sug", artifactId: v1.id, content: "prefer the explicit form", author: "human", intent: "suggestion",
        target: { artifactId: v1.id, filePath: "src/store.js", lineStart: 15, lineEnd: 15 },
        suggestion: { originalText: "Number(id)", replacementText: "parseInt(id, 10)", lineStart: 15, lineEnd: 15, state: "pending" },
      } as any);

      await callTool("revise_artifact", {
        artifactId: v1.id, mode: "supersede", reason: "moving on",
        content: { summary: "v2", findings: [{ category: "bug", detail: "d2", significance: "medium" }] },
      });

      // The NEXT tool call's return runs the passive drain.
      const present = await callTool("present_findings", {
        summary: "next work",
        findings: [{ category: "other", detail: "z", significance: "low" }],
      });
      // Plain comment drained context-free in the present return (pin no-change).
      expect(present.text).toContain("plain drain-me note");
      // The obligation-bearing ones are NOT dumped context-free here.
      expect(present.text).not.toContain("does the old path still matter?");
      expect(present.text).not.toContain("prefer the explicit form");

      const byId = (id: string) => store.getCommentsForArtifact(v1.id).find((c) => c.id === id);
      expect(byId("cmt_plain")?.acknowledged).toBe(true);
      expect(byId("cmt_q")?.acknowledged).toBeFalsy();
      expect(byId("cmt_sug")?.acknowledged).toBeFalsy();

      // check_feedback delivers them via the PRIMARY rich lanes (not carryover).
      const res = await callTool("check_feedback");
      const sc = res.structuredContent as any;
      const q = sc.questions.find((x: any) => x.commentId === "cmt_q");
      expect(q).toBeDefined();
      expect(q.carryover).toBeUndefined(); // primary question lane, not the #192 backstop
      expect((sc.suggestions ?? []).some((s: any) => s.commentId === "cmt_sug")).toBe(true);
      expect(res.text).toMatch(/Suggested edits \(1\) — you MUST respond/);
      // The plain comment was already drained — not re-surfaced.
      expect(sc.comments.every((c: any) => c.id !== "cmt_plain")).toBe(true);
    });

    it("refuses to supersede an already-superseded artifact", async () => {
      await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      const old = store.getArtifacts()[0];
      store.updateArtifactStatus(old.id, "superseded");

      const { isError, text } = await callTool("revise_artifact", {
        artifactId: old.id,
        mode: "supersede",
        content: { summary: "x2", findings: [] },
        reason: "retry",
      });
      expect(isError).toBe(true);
      expect(text).toContain("superseded");
    });

    it("records a new plan review cycle when superseding a plan", async () => {
      await callTool("present_plan", {
        title: "Original plan",
        steps: [{ description: "step A", reasoning: "because" }],
        estimatedChanges: 1,
      });
      const oldPlan = store.getArtifacts()[0];
      expect(store.getPendingPlanReviews().map((p) => p.artifactId)).toContain(oldPlan.id);

      const result = await callTool("revise_artifact", {
        artifactId: oldPlan.id,
        mode: "supersede",
        title: "Revised plan",
        content: {
          steps: [{ description: "step A'", reasoning: "incorporate feedback" }],
          estimatedChanges: 1,
        },
        reason: "human asked for smaller scope",
      });
      expect(result.isError).toBeFalsy();

      const newPlan = store.getArtifacts().find((a) => a.id !== oldPlan.id)!;
      const pending = store.getPendingPlanReviews();
      expect(pending.map((p) => p.artifactId)).toContain(newPlan.id);
      // F1 — the OLD plan's review is now an orphan (its artifact is superseded)
      // and must NOT keep reporting as pending; otherwise check_feedback says
      // "WAITING: plan review pending" forever for an artifact the human can't see.
      expect(pending.map((p) => p.artifactId)).not.toContain(oldPlan.id);
    });

    it("F1 — superseding a decision retires the old pending decision (no orphan WAITING)", async () => {
      await callTool("present_options", {
        context: "pick a store",
        options: [
          { id: "a", title: "Postgres", description: "relational", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "Mongo", description: "document", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      });
      const oldDec = store.getArtifacts()[0];
      expect(store.getPendingDecisions().map((d) => d.artifactId)).toContain(oldDec.id);

      await callTool("revise_artifact", {
        artifactId: oldDec.id,
        mode: "supersede",
        content: {
          context: "pick a store",
          decisionId: "store_v2",
          options: [
            { id: "a", title: "Postgres", description: "relational + jsonb", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
            { id: "c", title: "SQLite", description: "embedded", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
          ],
        },
        reason: "dropped Mongo, added SQLite",
      });
      // Old decision's pending record is gone now that its artifact is superseded.
      expect(store.getPendingDecisions().map((d) => d.artifactId)).not.toContain(oldDec.id);
    });

    it("F1 — superseding a decision WITHOUT a decisionId mints one + records the request (the human's pick isn't lost)", async () => {
      await callTool("present_options", {
        context: "pick a cache",
        options: [
          { id: "a", title: "Redis", description: "shared", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "Memcached", description: "simple", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      });
      const oldDec = store.getArtifacts()[0];

      await callTool("revise_artifact", {
        artifactId: oldDec.id,
        mode: "supersede",
        // NOTE: no decisionId — mirrors the REAL agent input shape (present_options
        // doesn't expose it; it's server-minted). Pre-fix this left no DecisionRecord,
        // so the human's subsequent selection resolved to nothing.
        content: {
          context: "pick a cache",
          options: [
            { id: "a", title: "Redis", description: "shared + TTL", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
            { id: "c", title: "In-process LRU", description: "no deps", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
          ],
        },
        reason: "swapped memcached for an in-process option",
      });

      const newDec = store.getArtifacts().find((a) => a.id !== oldDec.id)!;
      const newDecisionId = (newDec.content as any).decisionId;
      // a server-minted id is baked into content...
      expect(typeof newDecisionId).toBe("string");
      expect(newDecisionId).toMatch(/^dec_/);
      // ...and a backing DecisionRecord exists, so a human selection actually resolves
      expect(store.getDecision(newDecisionId)).toBeTruthy();
      store.resolveDecision(newDecisionId, "a", "stick with Redis");
      expect(store.getDecisionResponse(newDecisionId)?.optionId).toBe("a");
    });

    it("F3 — rejects malformed supersede content via the same validator present_* uses", async () => {
      await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      const old = store.getArtifacts()[0];
      const before = store.getArtifacts().length;
      const { isError, text } = await callTool("revise_artifact", {
        artifactId: old.id,
        mode: "supersede",
        content: { summary: "x2", findings: "not-an-array" }, // the original field bug
        reason: "revise",
      });
      expect(isError).toBe(true);
      expect(text).toContain("INPUT_VALIDATION_FAILED");
      // The malformed shape did NOT land: no v2 created, old one not retired.
      expect(store.getArtifacts().length).toBe(before);
      expect(store.getArtifacts()[0].status).not.toBe("superseded");
    });

    it("#171 — rejects a malformed changeset supersede (files not an array) via the changeset validator", async () => {
      await callTool("present_changeset", {
        title: "Move TTL refresh into middleware",
        files: [
          { path: "auth/middleware.ts", changeType: "modified", hunks: [{ lines: [{ kind: "add", content: "x", newLine: 26 }] }] },
        ],
      });
      const old = store.getArtifacts()[0];
      const before = store.getArtifacts().length;
      const { isError, text } = await callTool("revise_artifact", {
        artifactId: old.id,
        mode: "supersede",
        content: { files: "nope" }, // pre-fix: persisted a silently-empty v2 with no error
        reason: "revise",
      });
      expect(isError).toBe(true);
      expect(text).toContain("INPUT_VALIDATION_FAILED");
      // No v2 landed; the old changeset is untouched.
      expect(store.getArtifacts().length).toBe(before);
      expect(store.getArtifacts()[0].status).not.toBe("superseded");
    });

    it("#171 — a superseded changeset starts with FRESH human review state and reasons", async () => {
      await callTool("present_changeset", {
        title: "Move TTL refresh into middleware",
        files: [
          { path: "auth/middleware.ts", changeType: "modified", hunks: [{ lines: [{ kind: "add", content: "x", newLine: 26 }] }] },
          { path: "auth/session.ts", changeType: "modified", hunks: [{ lines: [{ kind: "add", content: "y", newLine: 12 }] }] },
        ],
      });
      const old = store.getArtifacts()[0];
      // Human reviewed a file on v1.
      store.setChangesetFileReview!(old.id, "auth/middleware.ts", "reviewed");
      expect((store.getArtifacts()[0].content as any).reviewState).toEqual({ "auth/middleware.ts": "reviewed" });

      const { isError } = await callTool("revise_artifact", {
        artifactId: old.id,
        mode: "supersede",
        content: {
          files: [
            { path: "auth/middleware.ts", changeType: "modified", hunks: [{ lines: [{ kind: "add", content: "z", newLine: 26 }] }] },
            { path: "auth/session.ts", changeType: "modified", hunks: [{ lines: [{ kind: "add", content: "y", newLine: 12 }] }] },
          ],
          // The agent echoes v1's review state — a stale ✓ on a changed diff.
          reviewState: { "auth/middleware.ts": "reviewed" },
          // Human-authored objections belong to v1's exact diff too.
          reviewReasons: { "auth/session.ts": "The old refresh ordering races logout." },
        },
        reason: "adjust the middleware check",
      });
      expect(isError).toBeFalsy();
      const v2 = store.getArtifacts().find((a) => a.id !== old.id)!;
      expect(v2.type).toBe("changeset");
      // v2 must not carry v1's ✓ mark — review starts fresh.
      expect((v2.content as any).reviewState).toBeUndefined();
      expect((v2.content as any).reviewReasons).toBeUndefined();
    });

    it("F5 — refuses to supersede a closed (rejected) artifact instead of resurrecting it", async () => {
      await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      const old = store.getArtifacts()[0];
      store.updateArtifactStatus(old.id, "rejected");
      const { isError, text } = await callTool("revise_artifact", {
        artifactId: old.id,
        mode: "supersede",
        content: { summary: "x2", findings: [] },
        reason: "resurrect",
      });
      expect(isError).toBe(true);
      expect(text).toContain("rejected");
      expect(store.getArtifacts()).toHaveLength(1); // no resurrected v2 draft
    });

    it("errors on unknown artifactId", async () => {
      const { isError, text } = await callTool("revise_artifact", {
        artifactId: "art_nope",
        mode: "supersede",
        content: { summary: "x", findings: [] },
        reason: "x",
      });
      expect(isError).toBe(true);
      expect(text).toContain("no artifact");
    });

    it("errors when mode='supersede' is missing content", async () => {
      await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      const old = store.getArtifacts()[0];
      const { isError, text } = await callTool("revise_artifact", {
        artifactId: old.id,
        mode: "supersede",
        reason: "revise it",
      });
      expect(isError).toBe(true);
      expect(text).toContain("content");
    });
  });
});

describe("#589 — revise_artifact refuses bad spec ids (never rewrites them)", () => {
  const req = (id: string) => ({ id, statement: `s ${id}`, rationale: "r", acceptanceCriteria: ["a"] });
  const base = { title: "Worker stop signal", objective: "Tell the lead when a worker stops" };
  const specs = () => store.getArtifacts().filter((a) => a.type === "spec");

  async function presentV1() {
    const r = await callTool("present_spec", {
      ...base,
      requirements: [req("REQ-1")],
      edgePaths: [{ id: "wake", path: "long-poll wake", risk: "races the stop" }, { id: "inert", path: "shared mode", risk: "inert" }],
    });
    expect(r.isError).toBeFalsy();
    return specs()[0]!;
  }
  const revise = (artifactId: string, content: Record<string, unknown>) =>
    callTool("revise_artifact", { artifactId, mode: "supersede", reason: "tighten", content: { ...base, ...content } });

  const BAD: Array<[string, Record<string, unknown>, string]> = [
    ["duplicate requirement ids", { requirements: [req("REQ-1"), req("REQ-1")] }, 'requirements[1].id "REQ-1" duplicates requirements[0].id'],
    ["duplicate edge-path ids", { requirements: [req("REQ-1")], edgePaths: [{ id: "wake", path: "a", risk: "x" }, { id: "wake", path: "b", risk: "y" }] }, 'edgePaths[1].id "wake" duplicates edgePaths[0].id'],
    ["a blank requirement id", { requirements: [req(" ")] }, "requirements[0].id is blank"],
    ["a blank edge-path id", { requirements: [req("REQ-1")], edgePaths: [{ id: " ", path: "a", risk: "x" }] }, "edgePaths[0].id is blank"],
    ["an oversized requirement id", { requirements: [req("R".repeat(65))] }, "is 65 chars — rename it to 64 or fewer chars"],
    ["an oversized edge-path id", { requirements: [req("REQ-1")], edgePaths: [{ id: "9".repeat(70), path: "a", risk: "x" }] }, "is 70 chars — rename it to 64 or fewer chars"],
    ["a numeric edge-path id", { requirements: [req("REQ-1")], edgePaths: [{ id: "3", path: "a", risk: "x" }] }, 'edgePaths[0].id "3" is purely numeric'],
    ["a dangling task link", { requirements: [req("REQ-1")], tasks: [{ description: "t", linkedRequirementIds: ["REQ-2"] }] }, 'tasks[0].linkedRequirementIds[0] "REQ-2" names no requirement in this spec'],
  ];

  it.each(BAD)("ordinary revise: %s is refused atomically", async (_label, content, needle) => {
    const v1 = await presentV1();
    const before = structuredClone(v1);
    const r = await revise(v1.id, content);
    expect(r.isError).toBe(true);
    expect(r._meta).toMatchObject({ code: "INPUT_VALIDATION_FAILED" });
    expect(r.text).toContain("INPUT_VALIDATION_FAILED: spec ids refused");
    expect(r.text).toContain(needle);
    expect(specs()).toHaveLength(1);
    expect(specs()[0]).toEqual(before);
  });

  it.each(BAD)("gate-blocked (admission) revise: %s is refused BEFORE preflight, snapshot or admission", async (_label, content, needle) => {
    const v1 = await presentV1();
    store.recordRejectedApproach({ description: "global mutable state for config", concept: "global mutable state for config", reason: "Hard to test" });
    const blocked = { objective: "Use global mutable state for config" };
    // Control: the same revision with valid ids reaches the gate and is blocked.
    const control = await revise(v1.id, { ...blocked, requirements: [req("REQ-1")] });
    expect(control.isError).toBe(true);
    expect(control.text).toContain("REJECTED_APPROACH_BLOCKED");
    const r = await revise(v1.id, { ...content, ...blocked });
    expect(r.isError).toBe(true);
    expect(r._meta).toMatchObject({ code: "INPUT_VALIDATION_FAILED" });
    expect(r.text).toContain(needle);
    expect(r.text).not.toContain("REJECTED_APPROACH_BLOCKED");
    expect(specs()).toHaveLength(1);
    expect(specs()[0]!.status).toBe("draft");
  });

  it("a revision keeping v1's valid ids is stored as written, and threads on `wake` and REQ-1 carry over", async () => {
    const v1 = await presentV1();
    await store.addComment({ id: "cmt_wake", artifactId: v1.id, content: "re-read after the wake", author: "human", target: { artifactId: v1.id, sectionId: "spec:edge-path:wake" } } as any);
    await store.addComment({ id: "cmt_req", artifactId: v1.id, content: "tighten the poll bound", author: "human", target: { artifactId: v1.id, requirementId: "REQ-1" } } as any);
    const requirements = [req("REQ-1"), req("REQ-2")];
    const edgePaths = [{ id: "inert", path: "shared mode", risk: "inert" }, { id: "wake", path: "long-poll wake", risk: "races the stop" }];
    const r = await revise(v1.id, { requirements, edgePaths, tasks: [{ description: "t", linkedRequirementIds: ["REQ-2"] }] });
    expect(r.isError).toBeFalsy();
    expect(r.text).not.toContain("spec ids");
    const v2 = specs().find((a) => a.parentId === v1.id)!;
    const c = v2.content as any;
    expect(c.requirements).toEqual(requirements);
    expect(c.edgePaths).toEqual(edgePaths);
    const fb = await callTool("check_feedback");
    expect(fb.text).toContain("long-poll wake] re-read after the wake");
    expect(fb.text).toContain("(requirement REQ-1)");
  });

  it("a v1 stored with now-invalid ids: repeating them is refused; the fixed revision lands and the unchanged valid id keeps its thread", async () => {
    const legacy = {
      objective: "legacy",
      requirements: [req("REQ-1"), req("DUP"), req("DUP")],
      edgePaths: [{ id: "5", path: "numeric legacy", risk: "x" }, { id: "wake", path: "long-poll wake", risk: "y" }],
    };
    store.createArtifact({ id: "art_legacy_v1", type: "spec", title: base.title, content: structuredClone(legacy) } as any);
    await store.addComment({ id: "cmt_legacy_wake", artifactId: "art_legacy_v1", content: "keep this", author: "human", target: { artifactId: "art_legacy_v1", sectionId: "spec:edge-path:wake" } } as any);
    // Stored content is never re-validated or rewritten on read.
    expect(store.getArtifacts().find((a) => a.id === "art_legacy_v1")!.content).toEqual(legacy);
    const asIs = await revise("art_legacy_v1", { requirements: legacy.requirements, edgePaths: legacy.edgePaths });
    expect(asIs.isError).toBe(true);
    expect(asIs.text).toContain('requirements[2].id "DUP" duplicates requirements[1].id');
    expect(asIs.text).toContain('edgePaths[0].id "5" is purely numeric');
    expect(specs()).toHaveLength(1);
    const fixed = await revise("art_legacy_v1", {
      requirements: [req("REQ-1"), req("DUP-A"), req("DUP-B")],
      edgePaths: [{ id: "numeric-legacy", path: "numeric legacy", risk: "x" }, { id: "wake", path: "long-poll wake", risk: "y" }],
    });
    expect(fixed.isError).toBeFalsy();
    const v2 = specs().find((a) => a.parentId === "art_legacy_v1")!;
    expect((v2.content as any).edgePaths[1].id).toBe("wake");
    const fb = await callTool("check_feedback");
    expect(fb.text).toContain("long-poll wake] keep this");
  });
});
