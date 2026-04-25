import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useArtifactStore } from "../artifact";
import type { Artifact, Comment } from "@deeppairing/shared";

function artifact(id: string, overrides: Partial<Artifact> = {}): Artifact {
  return {
    id,
    sessionId: "s1",
    type: "research",
    version: 1,
    parentId: null,
    title: `Artifact ${id}`,
    status: "draft",
    content: {},
    agentReasoning: null,
    createdAt: "2026-04-16T10:00:00.000Z",
    updatedAt: "2026-04-16T10:00:00.000Z",
    ...overrides,
  };
}

function comment(id: string, artifactId: string, overrides: Partial<Comment> = {}): Comment {
  return {
    id,
    sessionId: "s1",
    target: { artifactId },
    parentCommentId: null,
    author: "human",
    content: `comment ${id}`,
    acknowledged: false,
    createdAt: "2026-04-16T10:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  useArtifactStore.getState().reset();
  // Silence network calls from mutators we don't exercise in these tests
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("artifact store — addArtifact", () => {
  it("appends the artifact and auto-selects the first one", () => {
    useArtifactStore.getState().addArtifact(artifact("a1"));
    const state = useArtifactStore.getState();
    expect(state.artifacts).toHaveLength(1);
    expect(state.selectedArtifactId).toBe("a1");
  });

  it("does NOT clobber the selection when a later artifact arrives", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1"));
    s.addArtifact(artifact("a2"));
    expect(useArtifactStore.getState().selectedArtifactId).toBe("a1");
  });

  it("marks newly-arrived artifacts as unread when something else is selected", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1"));
    // a1 is selected; a2 should show up in unreadIds
    s.addArtifact(artifact("a2"));
    expect(useArtifactStore.getState().unreadIds).toEqual(["a2"]);
    // a3 piles on
    s.addArtifact(artifact("a3"));
    expect(useArtifactStore.getState().unreadIds).toEqual(["a2", "a3"]);
  });

  it("dedupes by id — repeated artifact_created events don't multiply (U0.1)", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1"));
    s.addArtifact(artifact("a1"));
    s.addArtifact(artifact("a1"));
    expect(useArtifactStore.getState().artifacts).toHaveLength(1);
  });

  it("merges fields on re-add so a status-bearing rebroadcast can update in place", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1", { title: "v1", status: "draft" }));
    s.addArtifact(artifact("a1", { title: "v1", status: "approved" }));
    expect(useArtifactStore.getState().artifacts[0].status).toBe("approved");
  });
});

describe("artifact store — selectArtifact", () => {
  it("clears the selected artifact's unreadIds entry", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1"));
    s.addArtifact(artifact("a2"));
    expect(useArtifactStore.getState().unreadIds).toContain("a2");
    s.selectArtifact("a2");
    expect(useArtifactStore.getState().selectedArtifactId).toBe("a2");
    expect(useArtifactStore.getState().unreadIds).not.toContain("a2");
  });

  it("accepts null to deselect", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1"));
    s.selectArtifact(null);
    expect(useArtifactStore.getState().selectedArtifactId).toBeNull();
  });
});

describe("artifact store — updateArtifact", () => {
  it("patches status in place, leaving other fields intact", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1", { title: "Keep me" }));
    s.updateArtifact("a1", "approved");
    const a = useArtifactStore.getState().artifacts[0];
    expect(a.status).toBe("approved");
    expect(a.title).toBe("Keep me");
  });

  it("updates version when provided", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1", { version: 1 }));
    s.updateArtifact("a1", "superseded", 2);
    expect(useArtifactStore.getState().artifacts[0].version).toBe(2);
  });

  it("is a no-op for unknown ids (no throw)", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1"));
    expect(() => s.updateArtifact("art_nope", "approved")).not.toThrow();
    expect(useArtifactStore.getState().artifacts[0].status).toBe("draft");
  });
});

describe("artifact store — addComment", () => {
  it("groups comments by target artifact id", () => {
    const s = useArtifactStore.getState();
    s.addComment(comment("c1", "a1"));
    s.addComment(comment("c2", "a1"));
    s.addComment(comment("c3", "a2"));
    const { comments } = useArtifactStore.getState();
    expect(comments["a1"]).toHaveLength(2);
    expect(comments["a2"]).toHaveLength(1);
    expect(comments["a1"][0].id).toBe("c1");
    expect(comments["a1"][1].id).toBe("c2");
  });

  it("can carry __session__ target for free-form messages", () => {
    const s = useArtifactStore.getState();
    s.addComment(comment("c1", "__session__"));
    expect(useArtifactStore.getState().comments["__session__"]).toHaveLength(1);
  });

  it("dedupes by id — repeated WS broadcasts for the same comment don't multiply (U0.1)", () => {
    // Field bug: a single posted comment visibly multiplied while the user
    // sat on the page because the WebSocket replayed `comment_added` (or
    // re-hydrated initial state) and the store blindly appended each time.
    const s = useArtifactStore.getState();
    const c = comment("c_dup", "a1");
    s.addComment(c);
    s.addComment(c);
    s.addComment({ ...c, content: "ignored — same id wins" });
    const { comments } = useArtifactStore.getState();
    expect(comments["a1"]).toHaveLength(1);
    expect(comments["a1"][0].id).toBe("c_dup");
  });
});

describe("artifact store — reset", () => {
  it("wipes artifacts, comments, selection, and unreadIds", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1"));
    s.addArtifact(artifact("a2"));
    s.addComment(comment("c1", "a1"));
    s.reset();
    const after = useArtifactStore.getState();
    expect(after.artifacts).toEqual([]);
    expect(after.comments).toEqual({});
    expect(after.selectedArtifactId).toBeNull();
    expect(after.unreadIds).toEqual([]);
  });
});
