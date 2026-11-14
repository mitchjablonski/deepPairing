import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { NextPendingLink } from "../NextPendingLink";
import { useArtifactStore } from "../../stores/artifact";
import { useReplayStore } from "../../stores/replay";

let t = 0;
const at = () => `2026-06-01T00:${String(t++).padStart(2, "0")}:00.000Z`;
const art = (id: string, title: string, over: Record<string, unknown> = {}) =>
  ({ id, type: "plan", title, status: "draft", version: 1, createdAt: at(), content: { summary: "s", steps: [] }, ...over }) as any;

beforeEach(() => {
  useArtifactStore.getState().reset();
  useReplayStore.setState({ active: false } as any);
});

describe("NextPendingLink (#642 item 7)", () => {
  it("on a resolved artifact, names the head of the pending queue and opens it on click (no auto-jump)", () => {
    const done = art("done", "Approved plan", { status: "approved" });
    useArtifactStore.setState({ artifacts: [done, art("p1", "First waiting"), art("p2", "Second waiting")], selectedArtifactId: "done" } as any);
    render(<NextPendingLink artifact={done} />);
    // Rendering alone moves nothing.
    expect(useArtifactStore.getState().selectedArtifactId).toBe("done");
    const link = screen.getByRole("button", { name: "Next waiting for you: First waiting, 1 more after it" });
    expect(link).toHaveTextContent("Next: First waiting →");
    fireEvent.click(link);
    expect(useArtifactStore.getState().selectedArtifactId).toBe("p1");
  });

  it("Sol P2 — shown only on verdict receipts: rejected / sent back / dismissed / resolved decision yes; informational draft, superseded, retracted no", () => {
    const waiting = art("p1", "First waiting");
    const cases: [any, boolean][] = [
      [art("rej", "Rejected plan", { status: "rejected" }), true],
      [art("rev", "Sent-back plan", { status: "revised" }), true],
      [art("obs", "Dismissed plan", { status: "obsolete" }), true],
      [art("dec", "Resolved decision", { type: "decision", status: "approved", content: { context: "c", decisionId: "d", options: [] } }), true],
      [art("exp", "Unread explainer", { type: "explainer", status: "draft", content: { summary: "s" } }), false],
      [art("sup", "Old version", { status: "superseded" }), false],
      [art("ret", "Retracted plan", { status: "retracted" }), false],
    ];
    for (const [a, shown] of cases) {
      useArtifactStore.setState({ artifacts: [a, waiting], selectedArtifactId: a.id } as any);
      const { unmount } = render(<NextPendingLink artifact={a} />);
      expect(!!screen.queryByRole("button", { name: /next waiting for you/i })).toBe(shown);
      unmount();
    }
  });

  it("follows queue changes after mount, and leaves focus where it was", () => {
    const done = art("done", "Approved plan", { status: "approved" });
    useArtifactStore.setState({ artifacts: [done, art("p1", "First waiting")], selectedArtifactId: "done" } as any);
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    render(<NextPendingLink artifact={done} />);
    expect(screen.getByRole("button", { name: /next waiting for you: first waiting/i })).toBeInTheDocument();
    // The head is resolved elsewhere → the link names the new head, or disappears.
    act(() => { useArtifactStore.setState({ artifacts: [done, art("p1", "First waiting", { status: "approved" }), art("p2", "Second waiting")] } as any); });
    expect(screen.getByRole("button", { name: /next waiting for you: second waiting/i })).toBeInTheDocument();
    act(() => { useArtifactStore.setState({ artifacts: [done] } as any); });
    expect(screen.queryByRole("button", { name: /next waiting for you/i })).toBeNull();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("is absent while the artifact on screen is itself waiting on you", () => {
    const p1 = art("p1", "First waiting");
    useArtifactStore.setState({ artifacts: [p1, art("p2", "Second waiting")], selectedArtifactId: "p1" } as any);
    render(<NextPendingLink artifact={p1} />);
    expect(screen.queryByRole("button", { name: /next waiting for you/i })).toBeNull();
  });

  it("is absent when nothing else is waiting, and during replay", () => {
    const done = art("done", "Approved plan", { status: "approved" });
    useArtifactStore.setState({ artifacts: [done], selectedArtifactId: "done" } as any);
    const { unmount } = render(<NextPendingLink artifact={done} />);
    expect(screen.queryByRole("button", { name: /next waiting for you/i })).toBeNull();
    unmount();
    useArtifactStore.setState({ artifacts: [done, art("p1", "First waiting")] } as any);
    useReplayStore.setState({ active: true } as any);
    render(<NextPendingLink artifact={done} />);
    expect(screen.queryByRole("button", { name: /next waiting for you/i })).toBeNull();
  });
});
