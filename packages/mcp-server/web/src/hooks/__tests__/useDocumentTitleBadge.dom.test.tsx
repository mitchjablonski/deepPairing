import { describe, it, expect, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { useDocumentTitleBadge } from "../useDocumentTitleBadge";
import { useArtifactStore } from "../../stores/artifact";

function Harness() {
  useDocumentTitleBadge();
  return null;
}

const art = (over: any) => ({
  id: over.id, sessionId: "s1", type: "research", version: 1, parentId: null,
  title: "t", status: "draft", content: {}, agentReasoning: null,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...over,
});

beforeEach(() => useArtifactStore.getState().reset());

describe("B2 — tab-title turn badge", () => {
  it("shows '(N) Your turn' while drafts wait and restores when they clear", () => {
    render(<Harness />);
    expect(document.title).toBe("deepPairing — Companion");

    act(() => {
      useArtifactStore.setState((s: any) => ({ artifacts: [...s.artifacts, art({ id: "a1" }), art({ id: "a2" })] }));
    });
    expect(document.title).toBe("(2) Your turn — deepPairing");

    act(() => {
      useArtifactStore.setState((s: any) => ({
        artifacts: s.artifacts.map((a: any) => ({ ...a, status: "approved" })),
      }));
    });
    expect(document.title).toBe("deepPairing — Companion");
  });

  it("reasoning artifacts don't count (no review cycle)", () => {
    render(<Harness />);
    act(() => {
      useArtifactStore.setState((s: any) => ({ artifacts: [...s.artifacts, art({ id: "r1", type: "reasoning" })] }));
    });
    expect(document.title).toBe("deepPairing — Companion");
  });
});
