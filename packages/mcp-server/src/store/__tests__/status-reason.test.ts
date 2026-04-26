/**
 * U7 — every status transition carries a `reason` tag so the daemon log
 * and the in-memory statusHistory record WHO/WHAT triggered the change.
 *
 * Why this matters: the U0.2 field bug ("artifact silently flipped to
 * APPROVED while I was commenting") was hard to diagnose because the
 * status-mutation path had no breadcrumbs. With these tags, the log line
 * directly answers "did this come from the UI button, the elicitation, the
 * decision-resolve handler, or somewhere unexpected?" The
 * `comment_side_effect` sentinel is reserved for "this should never fire";
 * its presence is a smoking gun in code review.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileStore } from "../file-store.js";
import { setGlobalStoreForTests } from "../global-store.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-status-reason-"));
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  setGlobalStoreForTests(null);
});

function withArtifact(): { store: FileStore; id: string } {
  const store = new FileStore(tmpDir, "status_reason_session");
  const a = store.createArtifact({ id: "art_1", type: "plan", title: "T", content: { steps: [] } });
  return { store, id: a.id };
}

describe("FileStore.updateArtifactStatus carries a reason tag (U7)", () => {
  it("writes the reason into the latest statusHistory entry", () => {
    const { store, id } = withArtifact();
    store.updateArtifactStatus(id, "approved", "ui_approve_button");
    const arts = store.getArtifacts();
    const history = (arts[0] as any).statusHistory as Array<{ status: string; reason?: string }>;
    const last = history[history.length - 1];
    expect(last.status).toBe("approved");
    expect(last.reason).toBe("ui_approve_button");
  });

  it("defaults to 'unspecified' when no reason is passed (legacy callers)", () => {
    const { store, id } = withArtifact();
    store.updateArtifactStatus(id, "approved");
    const arts = store.getArtifacts();
    const last = (arts[0] as any).statusHistory.slice(-1)[0];
    expect(last.reason).toBe("unspecified");
  });

  it("preserves the prior history entries' reasons through subsequent transitions", () => {
    const { store, id } = withArtifact();
    store.updateArtifactStatus(id, "approved", "ui_approve_button");
    store.updateArtifactStatus(id, "superseded", "agent_supersede");
    const history = (store.getArtifacts()[0] as any).statusHistory as Array<{ reason?: string }>;
    // Initial draft entry has no reason; the two real transitions do.
    const reasons = history.map((h) => h.reason).filter(Boolean);
    expect(reasons).toEqual(["ui_approve_button", "agent_supersede"]);
  });

  it("sentinel comment_side_effect logs an error to console.error (U7 alarm)", () => {
    const { store, id } = withArtifact();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    store.updateArtifactStatus(id, "approved", "comment_side_effect");
    expect(spy).toHaveBeenCalledOnce();
    const msg = spy.mock.calls[0][0] as string;
    expect(msg).toMatch(/BUG: comment_side_effect/);
    expect(msg).toMatch(/art_1/);
    expect(msg).toMatch(/draft → approved/);
    spy.mockRestore();
  });

  it("does NOT alarm on any non-sentinel reason", () => {
    const { store, id } = withArtifact();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    store.updateArtifactStatus(id, "approved", "ui_approve_button");
    store.updateArtifactStatus(id, "rejected", "ui_reject_button");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("survives roundtrip through atomic flush + reload", () => {
    const { store, id } = withArtifact();
    store.updateArtifactStatus(id, "approved", "elicit_accept");
    store.forceFlush();
    const reloaded = new FileStore(tmpDir, "status_reason_session");
    const arts = reloaded.getArtifacts();
    const last = (arts[0] as any).statusHistory.slice(-1)[0];
    expect(last.reason).toBe("elicit_accept");
  });
});
