import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileStore } from "../file-store.js";

/**
 * #160 — comments are scanned for secret shapes at create time.
 *
 * The scanner's own threat-model comment (secret-scan.ts) has named comment
 * bodies as a leak surface since V4, but nothing ever scanned them: a human
 * pasting an API key into a comment landed in `.deeppairing/sessions/*` on
 * disk, was broadcast over the WebSocket, and flowed into the agent's context
 * via check_feedback — with zero warning anywhere. Unlike the artifact paths
 * (agent-authored), a comment with a secret is HUMAN-authored, so the fix
 * lives at the single choke-point every comment creator converges on:
 * FileStore.addComment (web POST /api/comments, verdict-feedback comments,
 * and agent comments via the daemon's internal route all end here).
 *
 * The persisted warning is labels/pattern/line ONLY — NEVER the matched value.
 * Fixture secret is AWS's documented example key, never a real credential.
 */
const FAKE_AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

let tmpDir: string;
let store: FileStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-cmt-secret-"));
  store = new FileStore(tmpDir, "s1");
});

afterEach(() => {
  store.dispose();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("#160 — addComment scans the comment body for secret shapes", () => {
  it("persists labels-only secretWarnings (with the 1-based line) on a flagged comment", () => {
    const comment = store.addComment({
      id: "cmt_1",
      artifactId: "art_1",
      content: `here is the config I'm using:\n\nAWS_ACCESS_KEY_ID=${FAKE_AWS_KEY}\nis that wrong?`,
      author: "human",
    });
    expect(comment.secretWarnings).toEqual([
      { pattern: "AKIA", label: "AWS access key id", line: 3 },
    ]);
    // The warning metadata must never carry the matched value itself.
    expect(JSON.stringify(comment.secretWarnings)).not.toContain(FAKE_AWS_KEY);
  });

  it("stores NO secretWarnings key on a clean comment (stored JSON unchanged)", () => {
    const comment = store.addComment({
      id: "cmt_2",
      artifactId: "art_1",
      content: "looks good, ship it",
      author: "human",
    });
    expect("secretWarnings" in comment).toBe(false);
  });

  it("also scans AGENT-authored comments (revise reasons / answers can paste a key too)", () => {
    const comment = store.addComment({
      id: "cmt_3",
      artifactId: "art_1",
      content: `the token in question is ghp_abcdefghijklmnopqrst1234`,
      author: "agent",
    });
    expect(comment.secretWarnings?.map((w) => w.label)).toEqual([
      "GitHub personal access token",
    ]);
  });

  it("SURVIVES A RELOAD: a fresh FileStore over the same dir still reads the warning", () => {
    store.addComment({
      id: "cmt_4",
      artifactId: "art_1",
      content: `key: ${FAKE_AWS_KEY}`,
      author: "human",
    });
    store.forceFlush();

    const rehydrated = new FileStore(tmpDir, "s1");
    const [comment] = rehydrated.getCommentsForArtifact("art_1");
    expect(comment?.secretWarnings?.map((w) => w.label)).toEqual(["AWS access key id"]);
    rehydrated.dispose();
  });
});
