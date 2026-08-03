import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileStore } from "../file-store.js";

/**
 * #187 — the late FOLLOW-UP lane. A HUMAN comment posted to an already-CLOSED-
 * but-commentable (approved) artifact is a follow-up on a STANDING verdict, not
 * review feedback. FileStore.addComment is the single choke-point every comment
 * creator converges on (web POST, verdict-feedback comments, agent comments via
 * the daemon route), so it stamps `followUp` AUTHORITATIVELY from the target
 * artifact's status — the client can neither forge nor suppress it.
 *
 * Only "approved" qualifies (isLateCommentableStatus): a send-back (revised) /
 * reject verdict-feedback comment, a superseded/retracted/obsolete artifact, a
 * draft under review, a session directive, and every agent-authored comment are
 * NEVER stamped.
 */
let tmpDir: string;
let store: FileStore;

function seedArtifact(id: string, type: "changeset" | "code_change" | "decision", status: string) {
  store.createArtifact({ id, type, title: `${type} ${id}`, content: {} });
  if (status !== "draft") store.updateArtifactStatus(id, status as any);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-followup-"));
  store = new FileStore(tmpDir, "s1");
});
afterEach(() => {
  store.dispose();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("#187 — addComment stamps followUp from the target artifact's status", () => {
  it("changeset (the field case): a human comment on an APPROVED changeset carries followUp:true", () => {
    seedArtifact("art_cs", "changeset", "approved");
    const c = store.addComment({
      id: "cmt_1",
      artifactId: "art_cs",
      content: "one more thought on the TTL path",
      author: "human",
      target: { filePath: "auth/middleware.ts", lineStart: 26 },
    });
    expect(c.followUp).toBe(true);
  });

  it("code_change: a human comment on an APPROVED code_change carries followUp:true", () => {
    seedArtifact("art_code", "code_change", "approved");
    const c = store.addComment({ id: "cmt_2", artifactId: "art_code", content: "late nit", author: "human" });
    expect(c.followUp).toBe(true);
  });

  it("decision: a human comment on a RESOLVED (approved) decision carries followUp:true", () => {
    seedArtifact("art_dec", "decision", "approved");
    const c = store.addComment({ id: "cmt_3", artifactId: "art_dec", content: "how does this hold up in 6 months?", author: "human" });
    expect(c.followUp).toBe(true);
  });

  it("DRAFT (under review): a normal review comment has NO followUp key (byte-identical on disk)", () => {
    seedArtifact("art_draft", "changeset", "draft");
    const c = store.addComment({ id: "cmt_4", artifactId: "art_draft", content: "needs work", author: "human" });
    expect("followUp" in c).toBe(false);
  });

  it("TRAP statuses stay unstamped: a comment on superseded/rejected/retracted/obsolete is never a follow-up", () => {
    for (const status of ["superseded", "rejected", "retracted", "obsolete"] as const) {
      seedArtifact(`art_${status}`, "changeset", status);
      const c = store.addComment({ id: `cmt_${status}`, artifactId: `art_${status}`, content: "x", author: "human" });
      expect("followUp" in c, `${status} must not be stamped`).toBe(false);
    }
  });

  it("revised (send-back): the verdict-feedback comment is NEVER stamped — revised is not late-commentable", () => {
    seedArtifact("art_rev", "changeset", "revised");
    const c = store.addComment({ id: "cmt_rev", artifactId: "art_rev", content: "the flagged file: fix X", author: "human" });
    expect("followUp" in c).toBe(false);
  });

  it("STORE-AUTHORITATIVE: a client sending followUp:false on an APPROVED artifact still gets true", () => {
    seedArtifact("art_a", "changeset", "approved");
    const c = store.addComment({
      id: "cmt_forge1",
      artifactId: "art_a",
      content: "you can't hide the lane",
      author: "human",
      followUp: false,
    } as any);
    expect(c.followUp).toBe(true);
  });

  it("STORE-AUTHORITATIVE: a client sending followUp:true on a DRAFT artifact cannot forge the flag", () => {
    seedArtifact("art_d", "changeset", "draft");
    const c = store.addComment({
      id: "cmt_forge2",
      artifactId: "art_d",
      content: "not a follow-up",
      author: "human",
      followUp: true,
    } as any);
    expect("followUp" in c).toBe(false);
  });

  it("agent-authored comments are never stamped (the lane is HUMAN input)", () => {
    seedArtifact("art_ag", "changeset", "approved");
    const c = store.addComment({ id: "cmt_ag", artifactId: "art_ag", content: "agent reply", author: "agent" });
    expect("followUp" in c).toBe(false);
  });

  it("session-level directives (__session__, no artifact) are never stamped", () => {
    const c = store.addComment({ id: "cmt_sess", artifactId: "__session__", content: "switch focus", author: "human" });
    expect("followUp" in c).toBe(false);
  });

  it("SURVIVES A RELOAD: a fresh FileStore over the same dir still reads followUp:true", () => {
    seedArtifact("art_rl", "changeset", "approved");
    store.addComment({ id: "cmt_rl", artifactId: "art_rl", content: "persist me", author: "human" });
    store.forceFlush();
    const rehydrated = new FileStore(tmpDir, "s1");
    const [comment] = rehydrated.getCommentsForArtifact("art_rl");
    expect(comment?.followUp).toBe(true);
    rehydrated.dispose();
  });
});
