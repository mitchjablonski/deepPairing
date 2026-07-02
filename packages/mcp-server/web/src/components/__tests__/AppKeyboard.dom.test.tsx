/**
 * E3 (L1) — App's global keyboard handler had NO test coverage; a plain-letter
 * shortcut's failure modes (fires while typing, mis-cycles) are exactly what
 * refactors silently break.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import App from "../../App";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";

const art = (id: string, status = "draft") =>
  ({
    id, sessionId: "s1", type: "research", version: 1, parentId: null,
    title: id, status, content: {}, agentReasoning: null,
    createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
  }) as any;

describe("E3 (L1) — the n shortcut", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ sessions: [] }), { status: 200, headers: { "Content-Type": "application/json" } })),
    ));
    useArtifactStore.getState().reset();
    useArtifactStore.setState({
      artifacts: [art("a1"), art("a2", "approved"), art("a3")],
      selectedArtifactId: "a1",
    });
    useConnectionStore.setState({ connected: true, hydrated: true } as any);
  });

  it("n cycles the pending (draft) queue and wraps", () => {
    render(<App />);
    // a1 selected; pending = [a1, a3] → n lands on a3
    fireEvent.keyDown(document, { key: "n" });
    expect(useArtifactStore.getState().selectedArtifactId).toBe("a3");
    // wraps back to a1
    fireEvent.keyDown(document, { key: "n" });
    expect(useArtifactStore.getState().selectedArtifactId).toBe("a1");
  });

  it("n typed into a textarea does NOT cycle (typing guard)", () => {
    render(<App />);
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    ta.focus();
    fireEvent.keyDown(ta, { key: "n" });
    expect(useArtifactStore.getState().selectedArtifactId).toBe("a1");
    ta.remove();
  });

  it("a modifier chord never drives artifact state (Ctrl+N, Cmd+J...)", () => {
    render(<App />);
    fireEvent.keyDown(document, { key: "n", ctrlKey: true });
    fireEvent.keyDown(document, { key: "j", metaKey: true });
    expect(useArtifactStore.getState().selectedArtifactId).toBe("a1");
  });
});
