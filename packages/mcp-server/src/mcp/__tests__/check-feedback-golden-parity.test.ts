import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { handleCheckFeedback } from "../tools/check-feedback.js";
import type { ToolContext } from "../tools/types.js";
import { FileStore } from "../../store/file-store.js";
import { setGlobalStoreForTests } from "../../store/global-store.js";

/**
 * #188 (PAYDOWN) — BYTE-PARITY pin for the check_feedback delivery refactor.
 *
 * check_feedback's ~820-line handler was refactored (delivery loop extracted to
 * check-feedback-delivery.ts, the scope predicate unified, the dead legacy
 * `target.suggestion` string path deleted). The refactor is a MOVE, not a
 * rewrite: for identical inputs, every check_feedback output — prose text AND
 * structuredContent — must be byte-identical before and after.
 *
 * Each scenario below drives the handler through a distinct lane (the same lanes
 * the delivery loop houses: suggestion state-machine, del-side removed line,
 * cross-file anchors, questionIndex, requirementId, optionId, sectionId/grain,
 * region, followUp — plus session directive, secret note, and the verdict/
 * render-failure/status-change paths). We pin the sha256 of the prose and of
 * JSON.stringify(structuredContent). The GOLDEN hashes were captured against the
 * PRE-refactor tree; any drift in wording or structured shape fails loudly.
 *
 * Date is frozen (toFake:['Date'] only, so the real long-poll timer is
 * untouched) so createdAt / statusHistory `at` / "Oldest pending" ages are
 * deterministic run-to-run. Every scenario either has immediate feedback or no
 * pending draft, so the handler never enters the 30s long-poll.
 *
 * Fakes-not-mocks: real FileStore over a tmp dir; the global-store singleton is
 * redirected to an isolated tmp ledger.
 */

const FIXED_NOW = new Date("2026-07-25T12:00:00.000Z");

let tmpDir: string;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_NOW);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-cf-golden-"));
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
});

afterEach(() => {
  setGlobalStoreForTests(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.useRealTimers();
});

function makeCtx(store: FileStore, args?: Record<string, unknown>): ToolContext {
  void args;
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

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/** A scenario seeds a fresh store and returns the args to pass check_feedback. */
type Scenario = { name: string; seed: (store: FileStore) => void; args?: Record<string, unknown> };

const scenarios: Scenario[] = [
  {
    name: "healthy_proceed",
    seed: () => {},
  },
  {
    name: "session_directive_plus_secret_comment",
    seed: (store) => {
      store.createArtifact({
        id: "art_r",
        type: "research",
        title: "Audit",
        content: { summary: "s", findings: [] },
      });
      store.addComment({ id: "cmt_dir", artifactId: "__session__", content: "focus on auth first", author: "human" });
      store.addComment({
        id: "cmt_sec",
        artifactId: "art_r",
        content: "should I keep AKIAIOSFODNN7EXAMPLE here?",
        author: "human",
        target: { artifactId: "art_r" },
      });
    },
  },
  {
    name: "spec_questions_and_comments_lanes",
    seed: (store) => {
      store.createArtifact({
        id: "art_spec",
        type: "spec",
        title: "Session spec",
        content: {
          summary: "s",
          requirements: [{ id: "REQ-1", text: "sessions expire" }],
          openQuestions: ["Which DB?", "Postgres or SQLite?"],
          findings: [{ category: "c", detail: "d", significance: "low" }],
        },
      });
      // Plain question on the artifact.
      store.addComment({
        id: "cmt_q_plain",
        artifactId: "art_spec",
        content: "does this cover refresh tokens?",
        author: "human",
        intent: "question",
        target: { artifactId: "art_spec" },
      });
      // Question answering an open question (questionIndex).
      store.addComment({
        id: "cmt_q_idx",
        artifactId: "art_spec",
        content: "Postgres",
        author: "human",
        intent: "question",
        target: { artifactId: "art_spec", questionIndex: 0 },
      });
      // Requirement comment.
      store.addComment({
        id: "cmt_req",
        artifactId: "art_spec",
        content: "tighten the TTL wording",
        author: "human",
        target: { artifactId: "art_spec", requirementId: "REQ-1" },
      });
      // Finding comment + line.
      store.addComment({
        id: "cmt_find",
        artifactId: "art_spec",
        content: "this finding is the crux",
        author: "human",
        target: { artifactId: "art_spec", findingIndex: 0, lineStart: 12 },
      });
      // Region comment (labels).
      store.addComment({
        id: "cmt_region",
        artifactId: "art_spec",
        content: "rework this subgraph",
        author: "human",
        target: { artifactId: "art_spec", region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4, labels: ["AuthGate", "Login"] } },
      });
      // Plain comment.
      store.addComment({
        id: "cmt_plain",
        artifactId: "art_spec",
        content: "overall looks close",
        author: "human",
        target: { artifactId: "art_spec" },
      });
    },
  },
  {
    name: "changeset_delline_crossfile_review",
    seed: (store) => {
      store.createArtifact({
        id: "art_cs",
        type: "changeset",
        title: "Move TTL refresh into middleware",
        content: {
          files: [
            {
              path: "auth/middleware.ts",
              changeType: "modified",
              hunks: [
                { lines: [
                  { kind: "ctx", content: "const sid = readSessionCookie(req);", oldLine: 25, newLine: 25 },
                  { kind: "del", content: "const session = await store.get(sid);", oldLine: 26 },
                  { kind: "add", content: "const session = await store.getAndTouch(sid);", newLine: 26 },
                ] },
              ],
            },
            {
              path: "auth/session.ts",
              changeType: "modified",
              hunks: [{ lines: [{ kind: "add", content: "y", newLine: 12 }] }],
            },
          ],
        },
      });
      store.setChangesetFileReview("art_cs", "auth/middleware.ts", "reviewed");
      store.setChangesetFileReview("art_cs", "auth/session.ts", "needs_changes", "widen the Session type");
      // Del-side removed-line comment.
      store.addComment({
        id: "cmt_del",
        artifactId: "art_cs",
        content: "why remove this? the OAuth path needs it",
        author: "human",
        target: { filePath: "auth/middleware.ts", lineStart: 26, side: "old" },
      });
      // New-side line comment.
      store.addComment({
        id: "cmt_newside",
        artifactId: "art_cs",
        content: "getAndTouch looks right",
        author: "human",
        target: { filePath: "auth/middleware.ts", lineStart: 26 },
      });
      // Cross-file anchors comment.
      store.addComment({
        id: "cmt_xfile",
        artifactId: "art_cs",
        content: "these must stay in sync",
        author: "human",
        target: {
          filePath: "auth/session.ts",
          lineStart: 12,
          anchors: [
            { filePath: "auth/session.ts", lineStart: 12 },
            { filePath: "auth/middleware.ts", lineStart: 31 },
          ],
        },
      });
    },
  },
  {
    name: "decision_grain_lanes",
    seed: (store) => {
      store.createArtifact({
        id: "art_dec",
        type: "decision",
        title: "Hashing choice",
        content: {
          question: "Which password hash?",
          options: [
            { id: "opt_a", title: "argon2id", description: "memory-hard", pros: ["tunable", "modern"], cons: ["newer"] },
            { id: "opt_b", title: "bcrypt", description: "battle-tested", pros: ["ubiquitous"], cons: ["dated"] },
          ],
        },
      });
      // Comment on an option.
      store.addComment({
        id: "cmt_opt",
        artifactId: "art_dec",
        content: "worried about memory tuning",
        author: "human",
        target: { optionId: "opt_a" },
      });
      // Grain comment: a pro of an option.
      store.addComment({
        id: "cmt_grain",
        artifactId: "art_dec",
        content: "is this really tunable per-request?",
        author: "human",
        target: { optionId: "opt_a", sectionId: "pro:0" },
      });
      // Grain comment on the decision question itself.
      store.addComment({
        id: "cmt_decq",
        artifactId: "art_dec",
        content: "does scope include API keys?",
        author: "human",
        target: { sectionId: "decision:question" },
      });
    },
  },
  {
    name: "suggestion_state_machine",
    seed: (store) => {
      store.createArtifact({
        id: "art_code",
        type: "code_change",
        title: "modify lib/upload.ts",
        content: { filePath: "lib/upload.ts", changeType: "modify", before: "a", after: "b", reasoning: "r" },
      });
      // Pending suggestion.
      store.addComment({
        id: "cmt_pending",
        artifactId: "art_code",
        content: "backoff over fixed delay",
        author: "human",
        target: { lineStart: 15, lineEnd: 17, filePath: "lib/upload.ts" },
        intent: "suggestion",
        suggestion: {
          originalText: "  catch { await sleep(1000); }",
          replacementText: "  catch (err) { if (!isRetryable(err)) throw err; }",
          lineStart: 15,
          lineEnd: 17,
          state: "pending",
        },
      });
      // Insisted suggestion.
      store.addComment({
        id: "cmt_insist",
        artifactId: "art_code",
        content: "use the exact guard",
        author: "human",
        target: { lineStart: 20, lineEnd: 20, filePath: "lib/upload.ts" },
        intent: "suggestion",
        suggestion: {
          originalText: "foo()",
          replacementText: "guardedFoo()",
          lineStart: 20,
          lineEnd: 20,
          state: "pending",
        },
      });
      store.updateCommentSuggestion("cmt_insist", { state: "countered", counter: { reason: "no", replacementText: "x" } });
      store.acknowledgeComments(["cmt_insist"]);
      store.updateCommentSuggestion("cmt_insist", { state: "insisted", resetAcknowledged: true });
      // Counter-accepted suggestion.
      store.addComment({
        id: "cmt_take",
        artifactId: "art_code",
        content: "attach the cause",
        author: "human",
        target: { lineStart: 30, lineEnd: 30, filePath: "lib/upload.ts" },
        intent: "suggestion",
        suggestion: {
          originalText: "throw e",
          replacementText: "throw wrap(e)",
          lineStart: 30,
          lineEnd: 30,
          state: "pending",
        },
      });
      store.updateCommentSuggestion("cmt_take", { state: "countered", counter: { reason: "prefer cause", replacementText: "throw new Err({ cause: e })" } });
      store.acknowledgeComments(["cmt_take"]);
      store.updateCommentSuggestion("cmt_take", { state: "applied", resetAcknowledged: true });
    },
  },
  {
    name: "followup_on_approved",
    seed: (store) => {
      store.createArtifact({
        id: "art_appr",
        type: "changeset",
        title: "Move TTL refresh into middleware",
        content: { files: [{ path: "auth/middleware.ts", changeType: "modified", hunks: [{ lines: [{ kind: "add", content: "x", newLine: 26 }] }] }] },
      });
      store.updateArtifactStatus("art_appr", "approved", "ui_approve_button");
      // Late follow-up comment.
      store.addComment({
        id: "cmt_fu",
        artifactId: "art_appr",
        content: "one more thought on the sliding window",
        author: "human",
        target: { filePath: "auth/middleware.ts", lineStart: 26 },
      });
      // Late follow-up question.
      store.addComment({
        id: "cmt_fq",
        artifactId: "art_appr",
        content: "does this survive a server restart?",
        author: "human",
        intent: "question",
      });
    },
  },
  {
    name: "resolved_decision_verdict",
    seed: (store) => {
      store.createArtifact({
        id: "art_d2",
        type: "decision",
        title: "Hashing",
        content: {
          question: "Which hash?",
          options: [
            { id: "opt_a", title: "argon2id", description: "memory-hard", concept: { name: "argon2id for password hashing" }, pros: ["modern"], cons: [] },
            { id: "opt_b", title: "bcrypt", description: "battle-tested", concept: { name: "bcrypt for password hashing" }, pros: [], cons: ["dated"] },
          ],
        },
      });
      store.recordDecisionRequest({
        decisionId: "dec_1",
        artifactId: "art_d2",
        context: "password hashing",
        options: [
          { id: "opt_a", title: "argon2id", description: "memory-hard", concept: { name: "argon2id for password hashing" } },
          { id: "opt_b", title: "bcrypt", description: "battle-tested", concept: { name: "bcrypt for password hashing" } },
        ],
      } as never);
      store.resolveDecision("dec_1", "opt_a", "modern + tunable");
    },
  },
  {
    name: "plan_verdict_and_status_change",
    seed: (store) => {
      store.createArtifact({ id: "art_plan", type: "plan", title: "Rollout plan", content: { steps: [] } });
      store.recordPlanReview("art_plan");
      store.resolvePlanReview("art_plan", "approved", "ship it");
      store.updateArtifactStatus("art_plan", "approved", "ui_approve_button");
    },
  },
  {
    name: "rejected_artifacts",
    seed: (store) => {
      store.createArtifact({
        id: "art_rej",
        type: "changeset",
        title: "Risky refactor",
        content: { files: [{ path: "a.ts", changeType: "modified", hunks: [{ lines: [{ kind: "add", content: "x", newLine: 1 }] }] }] },
      });
      store.updateArtifactStatus("art_rej", "rejected", "ui_reject_button");
    },
  },
  {
    name: "render_failures",
    seed: (store) => {
      store.createArtifact({ id: "art_rf", type: "plan", title: "Plan", content: { steps: [] } });
      store.recordRenderFailure({ artifactId: "art_rf", visualId: "vis_a", error: "Parse error on line 2", title: "Auth flow" });
    },
  },
  {
    name: "scoped_wait_still_waiting",
    seed: () => {},
    args: { waitFor: "decision" },
  },
];

describe("#188 — check_feedback byte-parity golden pins", () => {
  // Captured against the PRE-refactor tree. A changed hash means the delivery
  // output drifted — investigate before updating.
  const GOLDEN: Record<string, { prose: string; struct: string }> = {
    healthy_proceed: { prose: "79e2e81c0e941ad0284b66b5d93ed786026552e8697987858453f7feef8517a0", struct: "2c7dca736a65f5e61ffbaa47c1cc42adf0df67b141aba7c549eed86bb8504975" },
    session_directive_plus_secret_comment: { prose: "46ac67ce6930e8c6c33bd503597ebe2d14f8dfe573547e9f1cdb690be9e65cbd", struct: "4f89a4b2432d3fb434f0c8cb9adbdc8af924aad4de0d70fa55156e5fae75a958" },
    spec_questions_and_comments_lanes: { prose: "1431e83d5133fdec0cb39b67410dcc50fe6f892c429fdc30d6723c6f290dd3fc", struct: "7418e7c9b0ebe74c8b6d45a4c1fb84672e95688360cf6d489245ca6b5a989253" },
    changeset_delline_crossfile_review: { prose: "d857d6e1f95fd11b7e099efc16491cd5b2efcc046c409bf6ac650f51e6e428e5", struct: "39b0b63567e30bf275d6b8bdc6683f3ac43fe6e52f46cf90308ccf7d8abecfbd" },
    decision_grain_lanes: { prose: "e5c1ebe0d54881fb6ca9211c1748307b630a2509bdeacb13a792fd697f1f78bc", struct: "af1b9e3a7efab75ae292cea4bc788522c175760d064401fece52fa082b7ae0e1" },
    suggestion_state_machine: { prose: "1201858c420f39ae4f4a2fd42e9c77f4df9c2112391825369203200bee292d7c", struct: "b0a69a290569493aedbc2278abec4ff67d5a1fc5827fde7538d912718e1abde7" },
    followup_on_approved: { prose: "abd1ca53a8f5824cdb1f33c1f01c2d0a64d69ff24995e83071038ca074d06d35", struct: "0e1b3de8b5d11b4ffe5aaec259ecf0bf077c18ddb8e8204667c4dd4aead31dc4" },
    resolved_decision_verdict: { prose: "66ff94bfce4eddb0703f16fa080924be0d54dd3f7d3dbdb85ae8d6d48df957e7", struct: "a5bfa3c9949e4716c3dc0f09395d40240b9f5059b39c064b6958bae1d4cdd980" },
    plan_verdict_and_status_change: { prose: "bfee87aacb63987273a7b2f703de5820f0d112f266fd8f762ed9eee53941e74e", struct: "ad10b0119588526716c2320e5968244a07026f3d016bae2bcb99a54f668e748a" },
    rejected_artifacts: { prose: "d2cec22faf08b855ed911e59d4e23b8604b8a59e134ca8681925fd137533898d", struct: "988d1dab9953f48a3795de587e8c150ab3c0b635e094b137479ebbf17fd67f3c" },
    render_failures: { prose: "cbe1cdcb76ac5ae3b9691c2f28e04cac1fb0b3bf5533152fcd6940c2fb2adf08", struct: "b7505399b99c18364d97d04628c82a0d19d9447340fd4cca99ffd5baf11f5e3e" },
    scoped_wait_still_waiting: { prose: "42908de755d8a870009d285ed377c227e274ef5acdece5ec1c7959d50b51fc65", struct: "eb98a12f4c5188d3d1692a76994501b444968a36afa92bd9069d3e8345584a85" },
  };

  let idx = 0;
  for (const scenario of scenarios) {
    it(`${scenario.name} — prose + structuredContent byte-identical`, async () => {
      const store = new FileStore(tmpDir, `s_golden_${idx++}`);
      scenario.seed(store);
      const res = await handleCheckFeedback(makeCtx(store, scenario.args), scenario.args ?? {});
      const prose = (res.content[0] as { text: string }).text;
      const struct = JSON.stringify(res.structuredContent);
      const proseSha = sha(prose);
      const structSha = sha(struct);
      expect(proseSha, `prose drift for ${scenario.name}\n---PROSE---\n${prose}`).toBe(GOLDEN[scenario.name]!.prose);
      expect(structSha, `struct drift for ${scenario.name}\n---STRUCT---\n${struct}`).toBe(GOLDEN[scenario.name]!.struct);
    });
  }
});
