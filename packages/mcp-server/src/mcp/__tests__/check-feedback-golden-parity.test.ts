import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { handleCheckFeedback } from "../tools/check-feedback.js";
import type { ToolContext } from "../tools/types.js";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";
import { SERVER_VERSION } from "../../version.js";
import { CHECK_FEEDBACK_GOLDENS } from "./check-feedback-goldens.sha.js";

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

let fx: GlobalStoreFixture;
let tmpDir: string;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_NOW);
  fx = withGlobalStore("dp-cf-golden-");
  tmpDir = fx.dir;
});

afterEach(() => {
  vi.useRealTimers();
  fx.dispose();
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
  {
    // #190 A2 — the explainer delivery lanes: a grain comment (explainer:<key>
    // sectionId → the new describeExplainerSection naming, its OWN namespace)
    // and an ask-anything QUESTION (question-priority lane) on an explainer.
    name: "explainer_grain_and_ask_anything",
    seed: (store) => {
      store.createArtifact({
        id: "art_ex",
        type: "explainer",
        title: "How session authentication works here",
        content: {
          title: "How session authentication works here",
          overview: "A walk of the request path for an authenticated route, top to bottom.",
          sections: [
            { heading: "1. The cookie is read at the edge", body: "requireSession pulls the session id out of the cookie." },
            { heading: "2. The session is looked up and refreshed", body: "getAndTouch fetches and slides the expiry." },
          ],
          suggestedQuestions: ["Where does the session get created?"],
        },
      });
      // Grain comment on an explainer section (explainer:<index>).
      store.addComment({
        id: "cmt_ex_grain",
        artifactId: "art_ex",
        content: "this is the part I always forget",
        author: "human",
        target: { artifactId: "art_ex", sectionId: "explainer:1" },
      });
      // Ask-anything QUESTION on the explainer.
      store.addComment({
        id: "cmt_ex_q",
        artifactId: "art_ex",
        content: "where does the session get created in the first place?",
        author: "human",
        intent: "question",
        target: { artifactId: "art_ex" },
      });
    },
  },
  {
    // #193 E2 — PER-ITEM debrief grain: `debrief:needs-your-eyes:<i>` and
    // `debrief:decisions:<i>` resolve the item's own title (`what`) back with the
    // lane, so the agent hears WHICH flagged item, not just the lane. A
    // lane-level key (`debrief:deferred`, backcompat) still delivers unchanged.
    name: "debrief_per_item_grain",
    seed: (store) => {
      store.createArtifact({
        id: "art_dbi",
        type: "debrief",
        title: "Debrief — per-item grain",
        content: {
          summary: "Moved the TTL refresh into middleware.",
          decisionsMade: [
            { what: "fail closed on expiry", why: "safer default" },
            { what: "clear the cookie on 401", why: "no stale session lingers" },
          ],
          needsYourEyes: [
            { what: "The expiry check in the middleware diff", why: "auth path for every route" },
            { what: "The new session.test.ts", why: "asserts the sliding window" },
          ],
          deferred: [{ what: "Refresh-token rotation", why: "out of scope" }],
        },
      });
      // Per-item grain on needsYourEyes item #2 (0-based index 1).
      store.addComment({
        id: "cmt_dbi_eyes",
        artifactId: "art_dbi",
        content: "checked — the test covers the boundary",
        author: "human",
        target: { artifactId: "art_dbi", sectionId: "debrief:needs-your-eyes:1" },
      });
      // Per-item grain on decisionsMade item #1 (0-based index 0).
      store.addComment({
        id: "cmt_dbi_dec",
        artifactId: "art_dbi",
        content: "agree, fail closed is right",
        author: "human",
        target: { artifactId: "art_dbi", sectionId: "debrief:decisions:0" },
      });
      // Lane-level key (backcompat) — still delivers with the humanized lane name.
      store.addComment({
        id: "cmt_dbi_lane",
        artifactId: "art_dbi",
        content: "maybe pull rotation forward",
        author: "human",
        target: { artifactId: "art_dbi", sectionId: "debrief:deferred" },
      });
    },
  },
  {
    // R5 (round-13 MED) — THE COMMENT-ONLY LANE, the exact re-found repro. A
    // fresh human comment on an APPROVED artifact with NOTHING else pending used
    // to fall through to "You may proceed with implementation." printed beside
    // the comment itself ("redo before merge"). The suggested action must now be
    // the non-proceed comment-only clause; "proceed" must be ABSENT.
    name: "comment_only_on_approved",
    seed: (store) => {
      store.createArtifact({
        id: "art_ok",
        type: "changeset",
        title: "Add rate limiter",
        content: { files: [{ path: "api/limit.ts", changeType: "modified", hunks: [{ lines: [{ kind: "add", content: "x", newLine: 1 }] }] }] },
      });
      store.updateArtifactStatus("art_ok", "approved", "ui_approve_button");
      store.addComment({
        id: "cmt_only",
        artifactId: "art_ok",
        content: "this needs a jitter — please redo before merge",
        author: "human",
        target: { artifactId: "art_ok", filePath: "api/limit.ts", lineStart: 1 },
      });
    },
  },
  {
    // R5 (round-13 MED) — EXTERNAL-REVIEW-AWARE check_feedback. A pending
    // changeset carrying reviewIntent:"external" (Q6 #232) is a colleague's PR on
    // the review surface: "applying the edits" is wrong — the base clause must say
    // "your pair is reviewing PR #N; nothing to apply", and the structured
    // pendingArtifacts entry must carry {reviewIntent:"external", pr}. A benign
    // human comment supplies the immediate feedback so the handler never enters
    // the 30s long-poll (same discipline as the other draft-bearing scenarios).
    name: "external_changeset_pending",
    seed: (store) => {
      store.createArtifact({
        id: "art_ext",
        type: "changeset",
        title: "PR #4213 — add retry backoff",
        content: {
          summary: "colleague's change",
          reviewIntent: "external",
          source: { kind: "github-pr", number: 4213, url: "https://github.com/o/r/pull/4213", author: "priya" },
          files: [{ path: "svc/retry.ts", changeType: "modified", hunks: [{ lines: [{ kind: "add", content: "await backoff()", newLine: 10 }] }] }],
        },
      });
      store.addComment({
        id: "cmt_ext",
        artifactId: "art_ext",
        content: "why retry on 400s?",
        author: "human",
        target: { artifactId: "art_ext", filePath: "svc/retry.ts", lineStart: 10 },
      });
    },
  },
];

describe("#188 — check_feedback byte-parity golden pins", () => {
  // Q3 (golden hardening) — the HASHES live in check-feedback-goldens.sha.ts,
  // deliberately NOT in this file. A scenario edit and a hash edit can no longer
  // be one diff: they are two files, and a reviewer sees both move. Every
  // re-pin is annotated there with the change that moved it.
  const GOLDEN = CHECK_FEEDBACK_GOLDENS;

  it("every scenario has a pin, and every pin has a scenario", () => {
    // The split-file regime's own guard: neither list may drift out from under
    // the other (a scenario silently un-pinned is a golden that guards nothing).
    expect(scenarios.map((s) => s.name).sort()).toEqual(Object.keys(GOLDEN).sort());
  });

  let idx = 0;
  for (const scenario of scenarios) {
    it(`${scenario.name} — prose + structuredContent byte-identical`, async () => {
      const store = fx.track(new FileStore(tmpDir, `s_golden_${idx++}`));
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
