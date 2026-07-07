import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Artifact, Comment } from "@deeppairing/shared";
import { LineCommentChips } from "../LineComments";
import { useArtifactStore } from "../../stores/artifact";

/**
 * Bug2 follow-up — inline line chips aggregate comments across the version
 * chain (the caller passes chain-aggregated comments), so a v1 line comment
 * renders on v2's line N even though that line may hold different content on v2.
 * The chip must carry the same "from vN" provenance the popover CommentBubble
 * shows, so the human isn't misled into thinking the comment was made on the
 * current version. Fakes-not-mocks: real store, only fetch stubbed.
 */
function artifact(id: string, over: Partial<Artifact> = {}): Artifact {
  return {
    id, sessionId: "s1", type: "code_change", version: 1, parentId: null,
    title: `Artifact ${id}`, status: "draft", content: {}, agentReasoning: null,
    createdAt: "2026-04-16T10:00:00.000Z", updatedAt: "2026-04-16T10:00:00.000Z",
    ...over,
  };
}
function lineComment(id: string, artifactId: string, content: string): Comment {
  return {
    id, sessionId: "s1", target: { artifactId, lineStart: 5, lineEnd: 5 },
    parentCommentId: null, author: "human", content, acknowledged: false,
    createdAt: "2026-04-16T10:00:00.000Z",
  } as Comment;
}

beforeEach(() => {
  useArtifactStore.getState().reset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
  useArtifactStore.setState({
    artifacts: [
      artifact("v1", { version: 1, status: "superseded" }),
      artifact("v2", { version: 2, parentId: "v1" }),
    ],
  });
});

describe("Bug2 — inline line chips carry the version provenance tag", () => {
  it("tags a v1 line comment shown on v2's line with 'from v1'", () => {
    render(
      <LineCommentChips
        lineNum={5}
        artifactId="v2" // current version being viewed
        comments={[lineComment("c1", "v1", "off-by-one on the loop bound")]}
      />,
    );
    expect(screen.getByText("off-by-one on the loop bound")).toBeInTheDocument();
    expect(screen.getByText("from v1")).toBeInTheDocument();
  });

  it("does NOT tag a comment that belongs to the current version", () => {
    render(
      <LineCommentChips
        lineNum={5}
        artifactId="v2"
        comments={[lineComment("c2", "v2", "current-version note")]}
      />,
    );
    expect(screen.getByText("current-version note")).toBeInTheDocument();
    expect(screen.queryByText(/^from v/)).not.toBeInTheDocument();
  });
});
