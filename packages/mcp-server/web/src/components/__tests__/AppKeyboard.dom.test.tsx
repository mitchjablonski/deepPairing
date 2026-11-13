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
import { useReplayStore, replayRehydrateSettled } from "../../stores/replay";

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

  it.each([null, "done"])("n/N use consequence/oldest/id order from selection %s", (selectedArtifactId) => {
    const finding = { ...art("finding"), createdAt: "2026-01-01T00:00:00.000Z" };
    const plan = { ...art("plan"), type: "plan", content: { steps: [] }, createdAt: "2026-07-01T00:01:00.000Z" };
    const decision = (id: string) => ({ ...art(id), type: "decision", content: { context: "Choose", options: [] } });
    useArtifactStore.setState({
      artifacts: [finding, plan, decision("d_b"), art("done", "approved"), decision("d_a")],
      selectedArtifactId,
    });
    render(<App />);
    for (const expected of ["d_a", "d_b", "plan", "finding", "d_a"]) {
      fireEvent.keyDown(document, { key: "n" });
      expect(useArtifactStore.getState().selectedArtifactId).toBe(expected);
    }
    act(() => { useArtifactStore.getState().selectArtifact(selectedArtifactId); });
    for (const expected of ["finding", "plan", "d_b", "d_a", "finding"]) {
      fireEvent.keyDown(document, { key: "N" });
      expect(useArtifactStore.getState().selectedArtifactId).toBe(expected);
    }
  });

  it("n/N re-read canonical order when a higher-tier artifact arrives mid-cycle", () => {
    const findingA = { ...art("finding-a"), createdAt: "2026-01-01T00:00:00.000Z" };
    const findingB = { ...art("finding-b"), createdAt: "2026-03-01T00:00:00.000Z" };
    const plan = { ...art("plan"), type: "plan", content: { steps: [] }, createdAt: "2026-02-01T00:00:00.000Z" };
    const decision = (id: string) => ({ ...art(id), type: "decision", content: { context: "Choose", options: [] } });
    useArtifactStore.setState({
      // Shuffled insertion order; initial canonical order is plan, finding-a, finding-b.
      artifacts: [findingB, plan, findingA],
      selectedArtifactId: "finding-a",
    });
    render(<App />);

    fireEvent.keyDown(document, { key: "n" });
    expect(useArtifactStore.getState().selectedArtifactId).toBe("finding-b");
    act(() => { useArtifactStore.getState().addArtifact(decision("decision-d")); });
    // The higher-tier arrival does not steal focus. Current canonical order is
    // plan, decision-d, finding-a, finding-b; timestamp order differs.
    expect(useArtifactStore.getState().selectedArtifactId).toBe("finding-b");
    fireEvent.keyDown(document, { key: "n" });
    expect(useArtifactStore.getState().selectedArtifactId).toBe("plan");
    fireEvent.keyDown(document, { key: "n" });
    expect(useArtifactStore.getState().selectedArtifactId).toBe("decision-d");
    fireEvent.keyDown(document, { key: "N" });
    expect(useArtifactStore.getState().selectedArtifactId).toBe("plan");
    fireEvent.keyDown(document, { key: "N" });
    expect(useArtifactStore.getState().selectedArtifactId).toBe("finding-b");
  });

  it.each([
    ["n", "decision-a"],
    ["N", "finding-old"],
  ] as const)("%s starts at the fresh queue edge when selection becomes nonpending", (key, expected) => {
    const finding = { ...art("finding-old"), createdAt: "2026-01-01T00:00:00.000Z" };
    const plan = { ...art("plan"), type: "plan", content: { steps: [] } };
    const decision = (id: string) => ({ ...art(id), type: "decision", content: { context: "Choose", options: [] } });
    useArtifactStore.setState({
      artifacts: [finding, plan, decision("decision-b"), decision("decision-a")],
      selectedArtifactId: "plan",
    });
    render(<App />);

    act(() => { useArtifactStore.getState().updateArtifact("plan", "approved"); });
    expect(useArtifactStore.getState().selectedArtifactId).toBe("plan");
    fireEvent.keyDown(document, { key });
    expect(useArtifactStore.getState().selectedArtifactId).toBe(expected);
  });

  it.each(["n", "N"] as const)("%s leaves selection unchanged when the pending queue empties", (key) => {
    useArtifactStore.setState({ artifacts: [art("only")], selectedArtifactId: "only" });
    render(<App />);

    act(() => { useArtifactStore.getState().updateArtifact("only", "approved"); });
    fireEvent.keyDown(document, { key });
    expect(useArtifactStore.getState().selectedArtifactId).toBe("only");
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
  afterEach(async () => {
    useReplayStore.getState().exitReplay();
    await replayRehydrateSettled();
  });

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

  it("Escape exits replay when no overlay is open", async () => {
    render(<App />);
    useReplayStore.setState({ active: true } as any);
    fireEvent.keyDown(document, { key: "Escape" });
    await replayRehydrateSettled();
    expect(useReplayStore.getState().active).toBe(false);
  });
});

describe("#207 (I2 review) — the q QuickAsk clamp honors the write-axis", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ sessions: [] }), { status: 200, headers: { "Content-Type": "application/json" } })),
    ));
    useArtifactStore.getState().reset();
    useConnectionStore.setState({ connected: true, hydrated: true } as any);
  });
  afterEach(async () => {
    useReplayStore.getState().exitReplay();
    await replayRehydrateSettled();
  });

  const openModal = () => document.querySelector('textarea[placeholder*="question" i]');

  it("q on a RETRACTED selection does NOT open the ask composer (would post to a withdrawn artifact)", () => {
    useArtifactStore.setState({ artifacts: [art("a1", "retracted")], selectedArtifactId: "a1" });
    render(<App />);
    fireEvent.keyDown(document, { key: "q" });
    expect(openModal()).toBeNull();
  });

  it("q on a DRAFT selection opens the ask composer (review lane)", () => {
    useArtifactStore.setState({ artifacts: [art("a1", "draft")], selectedArtifactId: "a1" });
    render(<App />);
    fireEvent.keyDown(document, { key: "q" });
    expect(openModal()).not.toBeNull();
  });

  it("q on an APPROVED selection STILL opens the composer (the #187 late follow-up lane must keep working)", () => {
    useArtifactStore.setState({ artifacts: [art("a1", "approved")], selectedArtifactId: "a1" });
    render(<App />);
    fireEvent.keyDown(document, { key: "q" });
    expect(openModal()).not.toBeNull();
  });

  it("q during REPLAY is inert even on a draft (frozen frame)", () => {
    useArtifactStore.setState({ artifacts: [art("a1", "draft")], selectedArtifactId: "a1" });
    render(<App />);
    useReplayStore.setState({ active: true } as any);
    fireEvent.keyDown(document, { key: "q" });
    expect(openModal()).toBeNull();
  });
});

describe("H1 — jumps close the rail that covers their target", () => {
  it("dp:focus-artifact while the Comment threads rail is open closes it", () => {
    render(<App />);
    // open the rail via its header button (#204 M4 — renamed "Comment threads")
    fireEvent.click(screen.getByRole("button", { name: /comment threads/i }));
    act(() => {
      window.dispatchEvent(new CustomEvent("dp:focus-artifact", { detail: { artifactId: "a1" } }));
    });
    // the rail's dialog is gone — the selection is visible, not behind a backdrop
    expect(screen.queryByRole("dialog", { name: /comment threads/i })).toBeNull();
    expect(useArtifactStore.getState().selectedArtifactId).toBe("a1");
  });
});
