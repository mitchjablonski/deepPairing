import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Artifact, Comment } from "@deeppairing/shared";
import { DecisionGeneralComments } from "../DecisionGeneralComments";
import { useArtifactStore } from "../../../stores/artifact";

/**
 * #204 (UX L2) — the decision-artifact comment thread honors the write-axis lock.
 * ArtifactPanel derives `commentsReadOnly` from reviewLifecycle and threads it
 * here (the decision branch was the one composer surface that previously ignored
 * it), so a comment/question can't be posted to — and then delivered from — a
 * retracted decision the agent already took back. History stays readable.
 */

function decArt(status: Artifact["status"]): Artifact {
  return {
    id: "dec_1", sessionId: "s", type: "decision", version: 1, parentId: null,
    title: "Pick a store", status,
    content: { context: "Which session store?", decisionId: "dec_store", options: [] },
    agentReasoning: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as Artifact;
}

function cmt(content: string): Comment {
  return {
    id: "c1", sessionId: "s", target: { artifactId: "dec_1" },
    parentCommentId: null, author: "human", content, acknowledged: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  } as unknown as Comment;
}

beforeEach(() => {
  useArtifactStore.getState().reset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ comment: null }) }));
});

describe("DecisionGeneralComments — #204 L2 write-axis lock", () => {
  it("is WRITABLE by default (draft): the composer is present", () => {
    const art = decArt("draft");
    useArtifactStore.setState({ artifacts: [art], comments: {} } as any);
    render(<DecisionGeneralComments artifact={art} comments={[cmt("prior note")]} />);
    expect(screen.getByPlaceholderText(/Add a comment/i)).toBeInTheDocument();
    expect(screen.getByText("prior note")).toBeInTheDocument();
  });

  it("withholds the composer when READ-ONLY (retracted), keeping the prior thread readable", () => {
    const art = decArt("retracted");
    useArtifactStore.setState({ artifacts: [art], comments: {} } as any);
    render(<DecisionGeneralComments artifact={art} comments={[cmt("prior note")]} readOnly />);
    expect(screen.queryByPlaceholderText(/Add a comment/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Send$/i })).not.toBeInTheDocument();
    // History (the posted comment) still renders.
    expect(screen.getByText("prior note")).toBeInTheDocument();
  });
});
