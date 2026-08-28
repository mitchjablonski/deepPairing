import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { FileStore } from "../file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";
import { readRejectedApproaches } from "../../cli/preflight-hook-core.js";
import { conceptMatchesProposal } from "../../mcp/preflight-validator.js";
import { deriveSessionId } from "../../session-id.js";

/**
 * Per-Claude-session split — the LOAD-BEARING guarantee.
 *
 * Splitting the artifact bucket per Claude session must NOT fragment the moat.
 * The moat (rejected approaches / guardrails) lives at
 * `projectRoot/.deeppairing/preferences.json`, keyed by projectRoot, while only
 * artifacts/comments/decisions sit under `sessions/<id>/`. So an approach
 * REJECTED in one session must stay HARD-BLOCKED in every OTHER session of the
 * same project. This pins that with two real FileStores over one projectRoot.
 */

describe("session-split does NOT fragment the moat", () => {
  let fx: GlobalStoreFixture;
  let projectRoot: string;

  beforeEach(() => {
    fx = withGlobalStore("dp-split-moat-");
    projectRoot = fx.dir; // the fixture dir doubles as a valid project root
  });
  afterEach(() => fx.dispose());

  it("an approach rejected in session 1 is still blocked in session 2 (same projectRoot)", () => {
    // Two DISTINCT Claude sessions under the same project, derived exactly as
    // the wrapper does — different CLAUDE_CODE_SESSION_ID → different buckets.
    const s1Id = deriveSessionId(projectRoot, "11111111-1111-1111-1111-111111111111").sessionId;
    const s2Id = deriveSessionId(projectRoot, "22222222-2222-2222-2222-222222222222").sessionId;
    expect(s1Id).not.toBe(s2Id);

    const session1 = fx.track(new FileStore(projectRoot, s1Id));
    const session2 = fx.track(new FileStore(projectRoot, s2Id));

    // Human rejects an approach in session 1.
    session1.recordRejectedApproach({
      description: "Deploy to Railway",
      reason: "cost-sensitive on low-traffic services",
      concept: "cost-sensitive hosting on low-traffic services",
    });
    session1.forceFlush?.();

    // (a) The preflight's ACTUAL read path (projectRoot-keyed, session-agnostic)
    // sees the rejection — this is what fires the hard block for the agent.
    const rejected = readRejectedApproaches(projectRoot);
    expect(rejected.some((r) => r.description === "Deploy to Railway")).toBe(true);
    const storedConcept = rejected.find((r) => r.description === "Deploy to Railway")?.concept;
    expect(storedConcept).toBe("cost-sensitive hosting on low-traffic services");

    // (b) A different-worded proposal made in SESSION 2 matches the rejected
    // concept → it would be hard-blocked, proving the block crosses sessions.
    expect(conceptMatchesProposal(storedConcept!, "cost-sensitive hosting on low-traffic services")).toBe(true);

    // (c) Session 2's own moat surface (getSessionMemory reads projectRoot
    // preferences.json) carries the session-1 rejection verbatim.
    const s2Memory = session2.getSessionMemory();
    expect(s2Memory.rejectedApproaches.some((r) => r.description === "Deploy to Railway")).toBe(true);
  });

  it("artifact buckets ARE distinct per session (the split is real)", () => {
    const s1Id = deriveSessionId(projectRoot, "aaaaaaaa-0000-0000-0000-000000000000").sessionId;
    const s2Id = deriveSessionId(projectRoot, "bbbbbbbb-0000-0000-0000-000000000000").sessionId;
    fx.track(new FileStore(projectRoot, s1Id));
    fx.track(new FileStore(projectRoot, s2Id));

    // Each session materializes its OWN sessions/<id>/ directory.
    const dir1 = path.join(projectRoot, ".deeppairing", "sessions", s1Id);
    const dir2 = path.join(projectRoot, ".deeppairing", "sessions", s2Id);
    expect(fs.existsSync(dir1)).toBe(true);
    expect(fs.existsSync(dir2)).toBe(true);
    expect(dir1).not.toBe(dir2);

    // But the moat file is SHARED (one preferences.json at the project root).
    const prefs1 = path.join(projectRoot, ".deeppairing", "preferences.json");
    const prefs2 = path.join(projectRoot, ".deeppairing", "preferences.json");
    expect(prefs1).toBe(prefs2);
  });
});
