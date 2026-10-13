import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { Artifact } from "@deeppairing/shared";
import { NextUpBar } from "../NextUpBar";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { usePreflightBlockStore } from "../../stores/preflightBlocks";
import { useReplayStore } from "../../stores/replay";

const artifact = (id: string, index: number, high = false): Artifact => ({
  id, sessionId: "keyboard", type: high ? "decision" : "research", title: `Review ${id}`,
  version: 1, parentId: null, status: "draft", agentReasoning: null,
  content: high ? { context: "Synthetic context", decisionId: id, stakes: "high", options: [] } : { summary: "Synthetic research", findings: [] },
  createdAt: `2026-01-01T00:0${index}:00.000Z`, updatedAt: `2026-01-01T00:0${index}:00.000Z`,
});
const toggle = () => screen.getByRole("button", { name: /^(Expand|Collapse) next-up details$/ });
const queueButtons = () => within(document.getElementById("next-up-details")!).getAllByRole("button");
const queueButton = (index = 0) => {
  const button = queueButtons()[index];
  if (!button) throw new Error(`Missing queue button ${index}`);
  return button;
};

beforeEach(() => {
  useArtifactStore.getState().reset();
  useArtifactStore.setState({ artifacts: [artifact("one", 1), artifact("two", 2), artifact("three", 3)], selectedArtifactId: "one" });
  useConnectionStore.setState({ connected: true, hydrated: true, sessionId: "keyboard", activeSessions: [{ sessionId: "keyboard", live: true, title: "Synthetic keyboard session", project: "Synthetic project", artifactCount: 3 }], staleDaemon: false, snapshotUnavailable: false, sessionConflict: false });
  usePreflightBlockStore.setState({ blocks: [], lastSeenAt: null });
  useReplayStore.setState({ active: false });
});

describe("#529 — Next-up disclosure keyboard ownership", () => {
  it("moves through queue buttons without selecting, stops at boundaries, and keeps Tab native", () => {
    render(<NextUpBar />);
    fireEvent.click(toggle());
    const one = queueButton(0), two = queueButton(1), three = queueButton(2);
    one.focus();
    fireEvent.keyDown(one, { key: "ArrowUp" });
    expect(one).toHaveFocus();
    fireEvent.keyDown(one, { key: "ArrowDown" });
    expect(two).toHaveFocus();
    fireEvent.keyDown(two, { key: "End" });
    expect(three).toHaveFocus();
    fireEvent.keyDown(three, { key: "ArrowDown" });
    expect(three).toHaveFocus();
    fireEvent.keyDown(three, { key: "Home" });
    expect(one).toHaveFocus();
    expect(useArtifactStore.getState().selectedArtifactId).toBe("one");
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    one.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
  });

  it("Escape consumes the expanded queue and returns to the disclosure", () => {
    render(<NextUpBar />);
    const opener = toggle();
    opener.focus();
    fireEvent.click(opener);
    const one = queueButton();
    one.focus();
    const events: string[] = [];
    const global = (event: KeyboardEvent) => events.push(event.key);
    window.addEventListener("keydown", global);
    try { fireEvent.keyDown(one, { key: "Escape" }); }
    finally { window.removeEventListener("keydown", global); }
    expect(document.getElementById("next-up-details")).toBeNull();
    expect(opener).toHaveFocus();
    expect(events).toEqual([]);
  });

  it("returns to the high-decision opener while it remains available", () => {
    useArtifactStore.setState({ artifacts: [artifact("one", 1), artifact("two", 2, true), artifact("three", 3, true)] });
    render(<NextUpBar />);
    const high = screen.getByRole("button", { name: "+2 high decision" });
    high.focus();
    fireEvent.click(high);
    expect(high).toHaveAttribute("aria-expanded", "true");
    const two = queueButton();
    two.focus();
    fireEvent.keyDown(two, { key: "Escape" });
    expect(high).toHaveFocus();
    expect(high).toHaveAttribute("aria-expanded", "false");
  });

  it("uses a stable disclosure when Why's opener disappears after marking a hold seen", () => {
    useArtifactStore.setState({ artifacts: [] });
    usePreflightBlockStore.setState({ blocks: [{ id: "hold", at: "2026-01-01T00:00:00Z", source: "session", concept: "Synthetic hold", via: "concept" }] });
    render(<NextUpBar />);
    const why = screen.getByRole("button", { name: "Why" });
    why.focus();
    fireEvent.click(why);
    expect(why.isConnected).toBe(false);
    expect(toggle()).toHaveFocus();
    fireEvent.keyDown(toggle(), { key: "Escape" });
    expect(toggle()).toHaveFocus();
    expect(document.getElementById("next-up-details")).toBeNull();
  });

  it("returns to a connected explicit-event opener, falling back if it was removed", () => {
    const { rerender } = render(<><button key="opener">External opener</button><NextUpBar key="bar" /></>);
    const opener = screen.getByRole("button", { name: "External opener" });
    opener.focus();
    act(() => window.dispatchEvent(new CustomEvent("dp:open-next-up")));
    fireEvent.keyDown(screen.getByRole("region", { name: "Next up" }), { key: "Escape" });
    expect(opener).toHaveFocus();
    act(() => window.dispatchEvent(new CustomEvent("dp:open-next-up")));
    rerender(<><NextUpBar key="bar" /></>);
    fireEvent.keyDown(screen.getByRole("region", { name: "Next up" }), { key: "Escape" });
    expect(toggle()).toHaveFocus();
  });

  it("leaves modifier chords, editables and non-queue card controls alone", () => {
    render(<NextUpBar quietCards={{ demo: () => <><textarea aria-label="Synthetic card input" /><button>Card action</button></> }} />);
    fireEvent.click(toggle());
    const one = queueButton();
    one.focus();
    for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"]) {
      const event = new KeyboardEvent("keydown", { key: "ArrowDown", [modifier]: true, bubbles: true, cancelable: true });
      one.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(one).toHaveFocus();
    }
    for (const control of [screen.getByRole("textbox", { name: "Synthetic card input" }), screen.getByRole("button", { name: "Card action" })]) {
      control.focus();
      const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
      control.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(control).toHaveFocus();
    }
  });

  it("does not steal focus on arrivals or removal after the user moved elsewhere", () => {
    render(<><button>Outside</button><NextUpBar /></>);
    fireEvent.click(toggle());
    queueButton().focus();
    act(() => useArtifactStore.getState().addArtifact(artifact("four", 4)));
    expect(queueButtons()[0]).toHaveFocus();
    const outside = screen.getByRole("button", { name: "Outside" });
    outside.focus();
    act(() => useArtifactStore.getState().updateArtifact("one", "obsolete"));
    expect(outside).toHaveFocus();
    expect(useArtifactStore.getState().selectedArtifactId).toBe("one");
  });

  it("recovers only an actually focused explicit opener when it disappears", () => {
    const { rerender } = render(<NextUpBar quietCards={{ wrap: <div>Synthetic recap</div> }} />);
    const recap = screen.getByRole("button", { name: "Recap ⌄" });
    recap.focus();
    fireEvent.click(recap);
    rerender(<NextUpBar />);
    expect(recap.isConnected).toBe(false);
    expect(toggle()).toHaveFocus();
    fireEvent.keyDown(toggle(), { key: "Escape" });
    expect(document.getElementById("next-up-details")).toBeNull();
  });

  it("relinquishes opener ownership after leaving the bar, including a later body focus", () => {
    const { rerender } = render(<><button>Outside</button><NextUpBar quietCards={{ wrap: <div>Synthetic recap</div> }} /></>);
    const recap = screen.getByRole("button", { name: "Recap ⌄" });
    recap.focus();
    fireEvent.click(recap);
    const outside = screen.getByRole("button", { name: "Outside" });
    outside.focus();
    outside.blur();
    expect(document.activeElement).toBe(document.body);
    rerender(<><button>Outside</button><NextUpBar /></>);
    expect(recap.isConnected).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });
});
