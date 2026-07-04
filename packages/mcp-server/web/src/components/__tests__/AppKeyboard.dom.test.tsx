/**
 * E3 (L1) — App's global keyboard handler had NO test coverage; a plain-letter
 * shortcut's failure modes (fires while typing, mis-cycles) are exactly what
 * refactors silently break.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, act, screen } from "@testing-library/react";
import App from "../../App";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { useReplayStore } from "../../stores/replay";

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

describe("F9 (L3) — replay clamps + Escape exit", () => {
  afterEach(() => useReplayStore.getState().exitReplay());

  it("`a` is inert while replay is active (no shortcut event dispatched)", () => {
    render(<App />);
    useReplayStore.setState({ active: true } as any);
    const fired: Event[] = [];
    const listener = (e: Event) => fired.push(e);
    window.addEventListener("dp:artifact-shortcut", listener);
    try {
      fireEvent.keyDown(document, { key: "a" });
      expect(fired).toHaveLength(0);
    } finally {
      window.removeEventListener("dp:artifact-shortcut", listener);
    }
  });

  it("Escape exits replay when no overlay is open", () => {
    render(<App />);
    useReplayStore.setState({ active: true } as any);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(useReplayStore.getState().active).toBe(false);
  });
});

describe("H1 — jumps close the rail that covers their target", () => {
  it("dp:focus-artifact while the Conversation rail is open closes it", () => {
    render(<App />);
    // open the rail via its header button
    fireEvent.click(screen.getByRole("button", { name: /conversation/i }));
    act(() => {
      window.dispatchEvent(new CustomEvent("dp:focus-artifact", { detail: { artifactId: "a1" } }));
    });
    // the rail's dialog is gone — the selection is visible, not behind a backdrop
    expect(screen.queryByRole("dialog", { name: /conversation/i })).toBeNull();
    expect(useArtifactStore.getState().selectedArtifactId).toBe("a1");
  });
});
