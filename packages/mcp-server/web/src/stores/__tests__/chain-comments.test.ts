import { describe, it, expect } from "vitest";
import type { Artifact, Comment } from "@deeppairing/shared";
import { chainArtifactIds, collectChainComments, commentPriorVersion } from "../artifact";

/**
 * Bug2 (v0.1.1 field bug) — comments are bucketed per-version by
 * `target.artifactId`. After a supersede auto-advances the view to v2,
 * `comments[v2.id]` is empty and every comment posted on v1 disappears. The
 * READ-side aggregation walks the version chain (parentId back to root) and
 * re-collects them WITHOUT re-parenting server-side. Pure-helper test — the
 * renderers all delegate to this via useChainComments.
 */
function artifact(id: string, over: Partial<Artifact> = {}): Artifact {
  return {
    id, sessionId: "s1", type: "research", version: 1, parentId: null,
    title: `Artifact ${id}`, status: "draft", content: {}, agentReasoning: null,
    createdAt: "2026-04-16T10:00:00.000Z", updatedAt: "2026-04-16T10:00:00.000Z",
    ...over,
  };
}
function comment(id: string, artifactId: string, createdAt: string): Comment {
  return {
    id, sessionId: "s1", target: { artifactId }, parentCommentId: null,
    author: "human", content: `comment ${id}`, acknowledged: false, createdAt,
  } as Comment;
}

describe("Bug2 — chain comment aggregation", () => {
  const chain: Artifact[] = [
    artifact("v1", { version: 1, status: "superseded" }),
    artifact("v2", { version: 2, parentId: "v1", status: "superseded" }),
    artifact("v3", { version: 3, parentId: "v2" }),
  ];

  it("chainArtifactIds walks parentId from the displayed artifact back to the root", () => {
    expect(chainArtifactIds(chain, "v3")).toEqual(["v3", "v2", "v1"]);
    expect(chainArtifactIds(chain, "v1")).toEqual(["v1"]);
  });

  it("collectChainComments surfaces v1's comment on v3, chronologically merged", () => {
    const comments = {
      v1: [comment("c1", "v1", "2026-04-16T10:00:00.000Z")],
      v2: [comment("c2", "v2", "2026-04-16T10:05:00.000Z")],
      v3: [comment("c3", "v3", "2026-04-16T10:10:00.000Z")],
    };
    // Viewing v3, the old versions' comments must still render.
    const merged = collectChainComments(chain, comments, "v3");
    expect(merged.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
  });

  it("returns the bucket as-is for a v1 (no ancestors) — stable identity for memos", () => {
    const bucket = [comment("c1", "v1", "2026-04-16T10:00:00.000Z")];
    const comments = { v1: bucket };
    expect(collectChainComments(chain, comments, "v1")).toBe(bucket);
  });

  it("does not mutate target.artifactId — the FileStore.targetKey invariant is preserved", () => {
    const comments = { v1: [comment("c1", "v1", "2026-04-16T10:00:00.000Z")] };
    const merged = collectChainComments(chain, comments, "v3");
    expect(merged[0]!.target.artifactId).toBe("v1"); // still tagged to v1
  });

  describe("commentPriorVersion — the shared 'from vN' provenance tag", () => {
    it("returns the source version for a comment aggregated from an earlier version", () => {
      const c = comment("c1", "v1", "2026-04-16T10:00:00.000Z"); // v1 has version 1
      expect(commentPriorVersion(chain, c, "v3")).toBe(1);
      const c2 = comment("c2", "v2", "2026-04-16T10:05:00.000Z"); // v2 has version 2
      expect(commentPriorVersion(chain, c2, "v3")).toBe(2);
    });

    it("returns undefined for a comment that belongs to the current artifact (no mislabel)", () => {
      const c = comment("c3", "v3", "2026-04-16T10:10:00.000Z");
      expect(commentPriorVersion(chain, c, "v3")).toBeUndefined();
    });

    it("returns undefined when the source artifact is unknown", () => {
      const c = comment("c4", "ghost", "2026-04-16T10:00:00.000Z");
      expect(commentPriorVersion(chain, c, "v3")).toBeUndefined();
    });
  });
});
