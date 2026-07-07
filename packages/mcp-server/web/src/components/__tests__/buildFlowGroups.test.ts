import { describe, it, expect } from "vitest";
import type { Artifact } from "@deeppairing/shared";
import { buildFlowGroups } from "../ArtifactPanel";

/**
 * Bug4 (v0.1.1 field bug) — the flow sidebar's grouping had four defects:
 *  (1) keyed groups by a 28-char TITLE prefix, so two roots sharing a prefix
 *      silently OVERWROTE each other (a whole flow disappeared);
 *  (2) ignored parentId, so a superseded v1 (filtered out of the visible list)
 *      dangled every ref that pointed at it and v2 fell out as an orphan;
 *  (3) ordered items within a chain newest→oldest;
 *  (4) ordered groups by the chain sink and dumped orphans in a forced-last
 *      "Other".
 */
function art(id: string, over: Partial<Artifact> = {}): Artifact {
  return {
    id, sessionId: "s1", type: "research", version: 1, parentId: null,
    title: `Artifact ${id}`, status: "draft", content: {}, agentReasoning: null,
    createdAt: "2026-04-16T10:00:00.000Z", updatedAt: "2026-04-16T10:00:00.000Z",
    ...over,
  };
}

describe("Bug4 — buildFlowGroups", () => {
  it("keys groups by ROOT ID so two roots sharing a 28-char title prefix both survive", () => {
    const shared = "Investigate the slow checkout endpoint latency"; // > 28 chars
    const r1 = art("r1", { title: shared + " (auth)", createdAt: "2026-04-16T10:00:00.000Z" });
    const r2 = art("r2", { title: shared + " (db)", createdAt: "2026-04-16T10:01:00.000Z" });
    const groups = buildFlowGroups([r1, r2]);
    // Pre-fix these collapsed onto one truncated-title key — one flow vanished.
    expect(groups.size).toBe(2);
    expect([...groups.keys()].sort()).toEqual(["r1", "r2"]);
  });

  it("keeps a superseded v1→v2 chain in ONE flow by resolving the dangling ref", () => {
    // A research root references the decision's v1; v1 was superseded by v2 and
    // filtered out of the visible list. v2 must join the research flow, not
    // dangle as a bottom orphan.
    const research = art("research", { type: "research", relatedArtifactIds: ["dec_v1"], createdAt: "2026-04-16T10:00:00.000Z" });
    const decV1 = art("dec_v1", { type: "decision", status: "superseded", createdAt: "2026-04-16T10:01:00.000Z" });
    const decV2 = art("dec_v2", { type: "decision", parentId: "dec_v1", version: 2, createdAt: "2026-04-16T10:02:00.000Z" });

    const visible = [research, decV2]; // v1 filtered (superseded)
    const all = [research, decV1, decV2];
    const groups = buildFlowGroups(visible, all);

    expect(groups.size).toBe(1);
    const entries = [...groups.entries()];
    const [rootId, items] = entries[0]!;
    expect(rootId).toBe("research"); // root = earliest
    expect(items.map((a) => a.id)).toEqual(["research", "dec_v2"]); // grouped, oldest→newest
  });

  it("orders items within a chain oldest→newest and groups by flow start time", () => {
    // Flow B starts earlier than flow A; each has a 2-item chain.
    const a1 = art("a1", { createdAt: "2026-04-16T10:05:00.000Z", relatedArtifactIds: ["a2"] });
    const a2 = art("a2", { createdAt: "2026-04-16T10:06:00.000Z" });
    const b1 = art("b1", { createdAt: "2026-04-16T10:00:00.000Z", relatedArtifactIds: ["b2"] });
    const b2 = art("b2", { createdAt: "2026-04-16T10:01:00.000Z" });

    const groups = buildFlowGroups([a1, a2, b1, b2]);
    // Group order: flow B (min createdAt 10:00) before flow A (10:05).
    expect([...groups.keys()]).toEqual(["b1", "a1"]);
    // Intra-flow order: oldest → newest.
    expect(groups.get("a1")!.map((x) => x.id)).toEqual(["a1", "a2"]);
    expect(groups.get("b1")!.map((x) => x.id)).toEqual(["b1", "b2"]);
  });

  it("interleaves an orphan by its own createdAt instead of forcing it last", () => {
    const early = art("early", { createdAt: "2026-04-16T10:00:00.000Z" }); // orphan
    const flow1 = art("flow1", { createdAt: "2026-04-16T10:05:00.000Z", relatedArtifactIds: ["flow2"] });
    const flow2 = art("flow2", { createdAt: "2026-04-16T10:06:00.000Z" });
    const groups = buildFlowGroups([flow1, flow2, early]);
    // The orphan sorts to the TOP by createdAt (pre-fix it was dumped in a
    // forced-last "Other" bucket).
    expect([...groups.keys()]).toEqual(["early", "flow1"]);
  });
});
