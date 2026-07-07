import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { Artifact } from "@deeppairing/shared";
import { CommentThread } from "../CommentThread";
import { useArtifactStore } from "../../stores/artifact";

/**
 * Bug1 (v0.1.1 field bug) — a v2 supersede auto-advances the selection to v2's
 * NEW artifact id and remounts CommentThread. The composer draft used to be
 * keyed on the per-version id, so the text typed against v1 was orphaned in
 * sessionStorage and the composer came back empty ("reload" feel). Keying the
 * draft off the STABLE chain-root id makes the in-progress draft survive.
 *
 * Fakes-not-mocks: real store, real useDraft (real sessionStorage), only the
 * network fetch is stubbed (submitComment isn't exercised here).
 */
function artifact(id: string, over: Partial<Artifact> = {}): Artifact {
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
    ...over,
  };
}

describe("Bug1 — composer draft survives a supersede auto-advance", () => {
  beforeEach(() => {
    useArtifactStore.getState().reset();
    try { sessionStorage.clear(); } catch { /* jsdom */ }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
  });

  it("keeps the in-progress draft when the thread remounts on the v2 id", () => {
    // v1 is the root; v2 supersedes it (parentId === v1).
    useArtifactStore.setState({
      artifacts: [
        artifact("v1", { version: 1, status: "superseded" }),
        artifact("v2", { version: 2, parentId: "v1" }),
      ],
    });

    // Compose against v1, then unmount (the real supersede remounts the pane).
    const first = render(<CommentThread artifactId="v1" comments={[]} />);
    const ta1 = screen.getByPlaceholderText(/Add a comment/i) as HTMLTextAreaElement;
    fireEvent.change(ta1, { target: { value: "half-written feedback" } });
    // useDraft flushes the latest value on unmount under the (root-keyed) key.
    first.unmount();
    cleanup();

    // Re-mount on v2 — the id differs, but the root is v1, so the draft loads.
    render(<CommentThread artifactId="v2" comments={[]} />);
    const ta2 = screen.getByPlaceholderText(/Add a comment/i) as HTMLTextAreaElement;
    expect(ta2.value).toBe("half-written feedback");
  });
});
