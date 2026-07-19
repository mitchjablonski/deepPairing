import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleCheckFeedback } from "../tools/check-feedback.js";
import type { ToolContext } from "../tools/types.js";
import { FileStore } from "../../store/file-store.js";
import { setGlobalStoreForTests } from "../../store/global-store.js";

/**
 * #158 — check_feedback tells the AGENT about a scanner-flagged pending
 * artifact too, not just the human: the WAITING prose line gains
 * "⚠ possible secret detected", and the per-artifact pendingArtifacts entry
 * gains a `secretWarnings` LABELS array (never the matched value). Both are
 * spread only when the scan matched, so the healthy payload — locked
 * byte-for-byte by check-feedback-ledger-health.test.ts — is unchanged.
 *
 * Fake, not mock: a real FileStore over a tmp dir.
 */
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-cf-secret-"));
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
});

afterEach(() => {
  setGlobalStoreForTests(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeCtx(store: FileStore): ToolContext {
  const server = { notification: () => {} };
  return {
    server,
    store,
    broadcast: () => {},
    port: 4000,
    helpers: {} as ToolContext["helpers"],
    state: {
      checkFeedbackPollCount: 0,
      reportedRejectedVerdicts: new Set<string>(),
      reportedPlanVerdicts: new Set<string>(),
    },
    progressToken: "tok-1",
  } as unknown as ToolContext;
}

describe("#158 — check_feedback surfaces persisted secret warnings on pending artifacts", () => {
  it("marks the flagged entry (labels only) and leaves the clean entry byte-identical", async () => {
    const store = new FileStore(tmpDir, "s1");
    // #162 — createArtifact now scans content itself (a passed-in
    // secretWarnings param no longer exists and would be ignored anyway), so
    // the flagged fixture carries a REAL secret shape in its content.
    store.createArtifact({
      id: "art_flagged",
      type: "code_change",
      title: "modify src/config.ts",
      content: { filePath: "src/config.ts", changeType: "modify", before: "x", after: 'const key = "AKIAIOSFODNN7EXAMPLE";', reasoning: "r" },
    });
    store.createArtifact({
      id: "art_clean",
      type: "code_change",
      title: "modify src/math.ts",
      content: { filePath: "src/math.ts", changeType: "modify", before: "a", after: "b", reasoning: "r" },
    });
    // An unacknowledged human comment makes feedback "immediate" so the
    // handler skips its 30s long-poll (drafts alone would trigger the wait).
    store.addComment({ id: "cmt_1", artifactId: "__session__", content: "looking now", author: "human" });

    const res = await handleCheckFeedback(makeCtx(store), {});
    const sc = res.structuredContent as {
      pendingArtifacts: Array<{ id: string; secretWarnings?: string[] }>;
    };

    const flagged = sc.pendingArtifacts.find((a) => a.id === "art_flagged");
    const clean = sc.pendingArtifacts.find((a) => a.id === "art_clean");
    expect(flagged?.secretWarnings).toEqual(["AWS access key id"]);
    // Clean entries must not even carry the key (contract: unchanged shape).
    expect(clean).toBeDefined();
    expect("secretWarnings" in clean!).toBe(false);

    // The WAITING prose line carries the inline marker for the flagged draft.
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('"modify src/config.ts" (code_change — ⚠ possible secret detected)');
    expect(text).toContain('"modify src/math.ts" (code_change)');
  });

  it("healthy payload stays clean: no secret text anywhere when nothing is flagged", async () => {
    const store = new FileStore(tmpDir, "s2");
    store.createArtifact({
      id: "art_clean_only",
      type: "code_change",
      title: "modify src/math.ts",
      content: { filePath: "src/math.ts", changeType: "modify", before: "a", after: "b", reasoning: "r" },
    });
    store.addComment({ id: "cmt_2", artifactId: "__session__", content: "ok", author: "human" });

    const res = await handleCheckFeedback(makeCtx(store), {});
    expect(JSON.stringify(res.structuredContent)).not.toMatch(/secretWarnings|possible secret/);
    expect((res.content[0] as { text: string }).text).not.toMatch(/possible secret/);
  });
});

/**
 * #160 — a COMMENT the create-time scan flagged gains a short marker on its
 * rendered check_feedback line: the human's pasted key is now in the agent's
 * context and on disk, and the agent should know. TEXT ONLY — no new
 * structuredContent key (the healthy-payload contract lock in
 * check-feedback-ledger-health.test.ts must pass unchanged), and never the
 * matched value.
 */
describe("#160 — check_feedback marks scanner-flagged comments (text only)", () => {
  const FAKE_AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

  it("appends the ⚠ note to a flagged comment's line — and adds NO structured key", async () => {
    const store = new FileStore(tmpDir, "s3");
    store.createArtifact({
      id: "art_1",
      type: "code_change",
      title: "modify src/config.ts",
      content: { filePath: "src/config.ts", changeType: "modify", before: "x", after: "y", reasoning: "r" },
    });
    // Real FileStore path — addComment itself runs the scan (fake, not mock).
    store.addComment({
      id: "cmt_hot",
      artifactId: "art_1",
      content: `should I keep using ${FAKE_AWS_KEY} here?`,
      author: "human",
      target: { artifactId: "art_1" },
    });
    store.addComment({
      id: "cmt_ok",
      artifactId: "art_1",
      content: "and please rename the helper",
      author: "human",
      target: { artifactId: "art_1" },
    });

    const res = await handleCheckFeedback(makeCtx(store), {});
    const text = (res.content[0] as { text: string }).text;
    // The flagged line carries the note; the clean one doesn't.
    expect(text).toContain("here? ⚠ possible secret in this comment");
    expect(text).toContain("- [art_1] and please rename the helper\n");
    expect(text).not.toContain("rename the helper ⚠");

    // TEXT ONLY: the structured payload's top-level key set is the locked
    // healthy set — no secretWarnings / per-comment warning key appears.
    const sc = res.structuredContent as Record<string, unknown>;
    expect(Object.keys(sc).sort()).toEqual(
      [
        "comments",
        "companionUrl",
        "decisions",
        "pendingArtifacts",
        "questions",
        "rejected",
        "serverVersion",
        "statusChanges",
        "status",
        "suggestedAction",
        "summary",
      ].sort(),
    );
    expect(JSON.stringify(sc)).not.toMatch(/possible secret/);
  });

  it("marks a flagged QUESTION line too, and never echoes the value anywhere", async () => {
    const store = new FileStore(tmpDir, "s4");
    store.createArtifact({
      id: "art_q",
      type: "research",
      title: "Audit",
      content: { summary: "s", findings: [] },
    });
    store.addComment({
      id: "cmt_q",
      artifactId: "art_q",
      content: `why does the scanner dislike ghp_abcdefghijklmnopqrst1234?`,
      author: "human",
      intent: "question",
      target: { artifactId: "art_q" },
    });

    const res = await handleCheckFeedback(makeCtx(store), {});
    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/❓ QUESTION \[art_q\].*⚠ possible secret in this comment/);
    // The note itself must never carry labels-with-values or the match: the
    // comment CONTENT is (necessarily) echoed for the agent to act on, but
    // the warning text is the fixed phrase only.
    expect(text).not.toContain("GitHub personal access token");
  });
});
