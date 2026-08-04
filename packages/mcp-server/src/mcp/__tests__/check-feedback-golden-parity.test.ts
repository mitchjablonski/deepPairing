import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { handleCheckFeedback } from "../tools/check-feedback.js";
import type { ToolContext } from "../tools/types.js";
import { FileStore } from "../../store/file-store.js";
import { setGlobalStoreForTests } from "../../store/global-store.js";
import { SERVER_VERSION } from "../../version.js";

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
 * VERSION-NORMALIZED: `SERVER_VERSION` is stripped from the hashed content — the
 * prose preamble carries `deepPairing v${SERVER_VERSION}` and the struct carries
 * `serverVersion`, so a raw hash would churn every release (this project bumps
 * per release). We replace the version with "<version>" before hashing (the same
 * technique the ledger-health GOLDEN_HEALTHY_STRUCT_SHA256 pin uses), so the
 * goldens guard real content without becoming per-release churn.
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
    name: "decision_region_optionId",
    seed: (store) => {
      store.createArtifact({
        id: "art_dregion",
        type: "decision",
        title: "Auth topology",
        content: {
          question: "Where does the gate live?",
          options: [
            { id: "opt_a", title: "argon2id", description: "memory-hard", pros: [], cons: [] },
          ],
          visuals: [{ id: "vis_1", type: "diagram", source: "flowchart TD\n  AuthGate-->Login" }],
        },
      });
      // A region comment on an OPTION's diagram: optionId + visualId + region
      // with labels → exercises structuredRegionFields' optionId branch
      // ({ optionId, visualId, region:{ x,y,w,h, nearNodes } }).
      store.addComment({
        id: "cmt_dregion",
        artifactId: "art_dregion",
        content: "this gate node needs a fallback",
        author: "human",
        target: {
          optionId: "opt_a",
          visualId: "vis_1",
          region: { x: 0.15, y: 0.25, w: 0.35, h: 0.45, labels: ["AuthGate", "Login"] },
        },
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
  {
    // #190 — the debrief delivery lanes: a grain comment (debrief:<key>
    // sectionId → the new describeDebriefSection naming), an ask-anything
    // QUESTION (question-priority lane), and a question answering an open
    // question (questionIndex lane) on a debrief artifact.
    name: "debrief_grain_and_ask_anything",
    seed: (store) => {
      store.createArtifact({
        id: "art_db",
        type: "debrief",
        title: "Debrief — sliding-window session TTL",
        content: {
          summary: "We moved the TTL refresh into one middleware so every route inherits it.",
          sections: [
            { title: "Centralized the refresh", body: "requireSession now calls getAndTouch.", concepts: [{ name: "sliding window" }] },
          ],
          decisionsMade: [{ what: "fail closed on expiry", why: "safer default" }],
          needsYourEyes: [{ what: "the expiry check", why: "auth path for every route", artifactRef: "art_db" }],
          openQuestions: ["Should the window survive a server restart?"],
        },
      });
      // Grain comment on a debrief section (debrief:<index>).
      store.addComment({
        id: "cmt_db_grain",
        artifactId: "art_db",
        content: "the single choke point is exactly right",
        author: "human",
        target: { artifactId: "art_db", sectionId: "debrief:0" },
      });
      // Ask-anything QUESTION on the debrief.
      store.addComment({
        id: "cmt_db_q",
        artifactId: "art_db",
        content: "does getAndTouch add a write on every request?",
        author: "human",
        intent: "question",
        target: { artifactId: "art_db" },
      });
      // Question answering the debrief's open question (questionIndex lane).
      store.addComment({
        id: "cmt_db_oq",
        artifactId: "art_db",
        content: "in-memory is fine for now",
        author: "human",
        intent: "question",
        target: { artifactId: "art_db", questionIndex: 0 },
      });
    },
  },
];

describe("#188 — check_feedback byte-parity golden pins", () => {
  // Captured against the PRE-refactor tree. A changed hash means the delivery
  // output drifted — investigate before updating.
  const GOLDEN: Record<string, { prose: string; struct: string }> = {
    healthy_proceed: { prose: "8b519f1b41c0dd6d65a0a092bd981e011cb48e90d827b736ce6ad78a6a6ccf48", struct: "e2bd0b9559c88cb3a4a6bb303b4b3ce005fdc806e14b52880423527d5ec83736" },
    session_directive_plus_secret_comment: { prose: "3c067c69713b33cc6da5303c3ed93b500c65017ee3aacc48638e65a30acd536c", struct: "f10ff7f3a5549450c324e1bd0cb4daa9c6ddeb48d4c8d5deef68174fb353debd" },
    spec_questions_and_comments_lanes: { prose: "8e9a2e3c83e53f8ad477bd0d2650c0487d9a0a6a1e62b1f00c82ad61478c254b", struct: "593f35123c8c74c6722ffbfd3c40f9c1a8a0a2162b6ceca04126ede1fc28ea37" },
    changeset_delline_crossfile_review: { prose: "177b5f2e9d46cbaf13a578d0a3a456e09072d3fc997c57db57873e48282236f6", struct: "52eac441e8fb3e3a059952b25e2850913a451e2308d4c81c94be84fbcf9b64cd" },
    decision_grain_lanes: { prose: "47142a2cbf1bc293b48a63875d81db0080ec1822a4e5c2ec95ea32b5a9030819", struct: "1fdd5b45ff8415848c9406e533d0c30084caeb9630d1d2f55cd2ef7fb29659a5" },
    decision_region_optionId: { prose: "162a7e68d53e4e7e2e7f1ba22827cec76f4dc9679447b2914cdf42dd3a0c2bbd", struct: "d863bd052d6a93b1f655b7a6536bf9365e11ec43be78a8bf4f1dae8bf0221884" },
    suggestion_state_machine: { prose: "39ebef78697961ab901ba3dea151657bbf7b6dfd9fafdc0df92d570ba06af62f", struct: "84cde744d7a2a55f8fd37ccf48962056ca6c49ce16d424782ae81de0aaa99f69" },
    followup_on_approved: { prose: "fd47ec30f3eef24c0a26909e211e986a6696d7a9f5d2bfb0e6fed4c8513d8c0b", struct: "2d83a1251c891c04e9a019f2215547c515d64fb872dd53ed05befe59ac138133" },
    resolved_decision_verdict: { prose: "35b87b2f5e5249c83f92a667d105809398b39a701780e3cf2ec7404d70dc7f80", struct: "3a93d12770210ce1228b184f02f6627b28857f3a9055af5a5f30dcca18d9ef81" },
    plan_verdict_and_status_change: { prose: "1168802c54dedd2053a9540b75c0e0781130a5613a6c0fa3a5bbd5fcee811659", struct: "dc469333b628b4536c30aeb870f16cd8d2ce5f78421c961197b989f839c92d9f" },
    rejected_artifacts: { prose: "2c6c6c46465869df2603d0a58f09cc6c406809743dd8022ebf4db1557c0c3214", struct: "3bb03742768b09b798adc570b129bdaca3703de7420844d72bd1b0b01e2e1a40" },
    render_failures: { prose: "2af7667132a1640f6544a8af05ce2d17268cb943bf6aeec20394ff51ccc5388b", struct: "0318b2371be9db67905f81389222fd07b7366b8086ce578c43ada8553f3f8db1" },
    scoped_wait_still_waiting: { prose: "42908de755d8a870009d285ed377c227e274ef5acdece5ec1c7959d50b51fc65", struct: "3fdcaf7107f306723a8d731c2c0484a09a172aa22cc4473fd4998950df2d47ce" },
    // #190 — NEW golden (13→14): captured against THIS tree's debrief delivery.
    debrief_grain_and_ask_anything: { prose: "44ff3814640812b73a02392dca742d42f4976784218104110186351495913bc9", struct: "a427507adc25895fc03114459c742c97d7b844062c1e20a80fd67d495f977183" },
  };

  let idx = 0;
  for (const scenario of scenarios) {
    it(`${scenario.name} — prose + structuredContent byte-identical`, async () => {
      const store = new FileStore(tmpDir, `s_golden_${idx++}`);
      scenario.seed(store);
      const res = await handleCheckFeedback(makeCtx(store, scenario.args), scenario.args ?? {});
      // VERSION-NORMALIZED — strip SERVER_VERSION from BOTH surfaces (see the
      // file header): the prose preamble carries `deepPairing v${SERVER_VERSION}`
      // and the struct carries `serverVersion`. Object-spread keeps serverVersion
      // in its original key position, so only the value changes (order-stable).
      const prose = ((res.content[0] as { text: string }).text).split(SERVER_VERSION).join("<version>");
      const struct = JSON.stringify({
        ...(res.structuredContent as Record<string, unknown>),
        serverVersion: "<version>",
      });
      const proseSha = sha(prose);
      const structSha = sha(struct);
      expect(proseSha, `prose drift for ${scenario.name}\n---PROSE---\n${prose}`).toBe(GOLDEN[scenario.name]!.prose);
      expect(structSha, `struct drift for ${scenario.name}\n---STRUCT---\n${struct}`).toBe(GOLDEN[scenario.name]!.struct);
    });
  }
});
