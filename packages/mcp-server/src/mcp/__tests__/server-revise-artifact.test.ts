/**
 * D2 — split from the 3,009-line server.test.ts along tool-surface seams.
 * Test bodies are verbatim from the monolith; only the harness wiring is new.
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

describe("MCP Tool Handlers — revise_artifact", () => {
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

    it("#171 — a superseded changeset starts with FRESH review state (echoed reviewState is stripped)", async () => {
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
        },
        reason: "adjust the middleware check",
      });
      expect(isError).toBeFalsy();
      const v2 = store.getArtifacts().find((a) => a.id !== old.id)!;
      expect(v2.type).toBe("changeset");
      // v2 must not carry v1's ✓ mark — review starts fresh.
      expect((v2.content as any).reviewState).toBeUndefined();
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
