import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import App from "../../App";
import { NextUpBar } from "../NextUpBar";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { usePreferencesStore } from "../../stores/preferences";
import { usePreflightBlockStore } from "../../stores/preflightBlocks";
import { useReplayStore } from "../../stores/replay";

/**
 * #430 PR 2 (docs/design/attention-hierarchy.md §4, §7, §8 PR 2) — the Next-up
 * bar: behind a default-OFF preference, rendered only from computeAttention.
 * The expected lines are the doc's §4.3 wording (the same tokens as the worked
 * table pinned in lib/__tests__/attention.test.ts).
 */
let t = 0;
const at = () => `2026-06-01T00:${String(t++).padStart(2, "0")}:00.000Z`;
const art = (id: string, type: string, title: string, over: Record<string, unknown> = {}) => ({
  id, sessionId: "s1", type, version: 1, parentId: null, title, status: "draft",
  content: {}, agentReasoning: null, createdAt: at(), updatedAt: at(), ...over,
}) as any;
const decision = (id: string, title: string, stakes?: string) =>
  art(id, "decision", title, { content: { context: `Context for ${title}`, decisionId: `d_${id}`, stakes, options: [] } });
const question = (id: string, artifactId: string) => ({
  id, sessionId: "s1", target: { artifactId }, parentCommentId: null, author: "human",
  content: `Question ${id}?`, acknowledged: false, createdAt: at(), intent: "question",
}) as any;

beforeEach(() => {
  t = 0;
  useArtifactStore.getState().reset();
  usePreflightBlockStore.setState({ blocks: [], lastSeenAt: null } as any);
  useReplayStore.setState({ active: false } as any);
  useConnectionStore.setState({ connected: true, hydrated: true, sessionId: "s1", activeSessions: [{ sessionId: "s1", live: true }], staleDaemon: false, snapshotUnavailable: false, sessionConflict: false } as any);
  usePreferencesStore.setState({ nextUpBar: false });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const line = () => screen.getByTestId("next-up-bar").getAttribute("data-line");
const tokens = () => Array.from(screen.getByTestId("next-up-bar").querySelectorAll("[data-token]")).map((e) => e.textContent).join(" · ");

describe("#430 PR 2 — the setting", () => {
  const stubFetch = () => vi.stubGlobal("fetch", vi.fn().mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify({ sessions: [] }), { status: 200, headers: { "Content-Type": "application/json" } }))));

  it("OFF (the default): the App renders no bar at all", () => {
    stubFetch();
    useArtifactStore.setState({ artifacts: [decision("d1", "Store choice", "high")] });
    render(<App />);
    expect(screen.queryByTestId("next-up-bar")).not.toBeInTheDocument();
  });

  it("ON: the App renders the bar under the session tabs (PR 3: the pending banner is absorbed)", () => {
    stubFetch();
    usePreferencesStore.setState({ nextUpBar: true });
    useArtifactStore.setState({ artifacts: [decision("d1", "Store choice", "high"), art("r1", "research", "A finding")] });
    render(<App />);
    const bar = screen.getByTestId("next-up-bar");
    const nav = screen.getByRole("navigation", { name: "Sessions" });
    expect(nav.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/items? waiting for you/)).not.toBeInTheDocument(); // #430 PR 3 absorbed it
  });
});

describe("#430 PR 2 — states A–G render the design's exact line", () => {
  it("A — an urgent (high) decision is the oldest item; another high one waits behind it", () => {
    useArtifactStore.setState({ artifacts: [decision("d1", "Store choice", "high"), decision("d2", "Cache TTL", "high"), art("e1", "explainer", "How it reads")] });
    render(<NextUpBar />);
    expect(line()).toBe("▲ Store choice · +1 high decision · Decide 2 · Read 1");
    expect(tokens()).toBe(line());
    expect(screen.getByText("DECIDE")).toBeInTheDocument(); // word + glyph, not colour only
    expect(screen.getByText(/Claude continues with the option you pick/)).toBeInTheDocument();
  });

  it("B — review queue, oldest-first: an older finding leads and the later high decision is pinned as '+1 high decision'", () => {
    useArtifactStore.setState({ artifacts: [art("r1", "research", "Oldest finding"), decision("d1", "Store choice", "high")] });
    render(<NextUpBar />);
    // §5 lane glyph: a REVIEW leads with ●, a decision with ▲.
    expect(line()).toBe("● Oldest finding · +1 high decision · Decide 2");
    expect(screen.getByText("REVIEW")).toBeInTheDocument();
  });

  it("C — info only", () => {
    useArtifactStore.setState({ artifacts: [art("e1", "explainer", "One"), art("e2", "reasoning", "Two")] });
    render(<NextUpBar />);
    expect(line()).toBe("○ Nothing needs you · Read 2");
  });

  it("D — waiting on the agent (live)", () => {
    useArtifactStore.setState({ artifacts: [art("a1", "research", "Done", { status: "approved" })], comments: { a1: [question("q1", "a1")] } });
    render(<NextUpBar />);
    expect(line()).toBe("◌ WAITING ON CLAUDE");
    expect(screen.getByText(/Claude answers on its next check/)).toBeInTheDocument();
  });

  it("E — the agent exited with your questions open", () => {
    useConnectionStore.setState({ activeSessions: [{ sessionId: "s1", live: false }] } as any);
    useArtifactStore.setState({ artifacts: [art("a1", "research", "Done", { status: "approved" })], comments: { a1: [question("q1", "a1"), question("q2", "a1")] } });
    render(<NextUpBar />);
    expect(line()).toBe("◌ WAITING ON CLAUDE");
    expect(screen.getByText(/answered when the session resumes/)).toBeInTheDocument();
  });

  it("F — held by your stance: read-only with Why, no Retire in the bar", () => {
    usePreflightBlockStore.setState({ blocks: [{ id: "b1", at: at(), source: "session", concept: "global mutable state", proposal: "Add a ConfigStore singleton", via: "concept" }], lastSeenAt: null } as any);
    render(<NextUpBar />);
    expect(line()).toBe("■ HELD");
    expect(screen.queryByRole("button", { name: /retire/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Why" }));
    expect(screen.getByText(/"global mutable state" stopped: Add a ConfigStore singleton/)).toBeInTheDocument();
    expect(screen.getByText(/lives in the ⋯ gate log/)).toBeInTheDocument();
  });

  it("G — disconnected with work pending: the failure prefix comes first and the decision is still named", () => {
    useConnectionStore.setState({ connected: false } as any);
    useArtifactStore.setState({ artifacts: [decision("d1", "Store choice", "high")] });
    render(<NextUpBar />);
    expect(line()).toBe("⚠ DISCONNECTED · ▲ Store choice · Decide 1");
  });

  it("replay prefixes a hold (the doc's 'REPLAY · ■ HELD' row)", () => {
    useReplayStore.setState({ active: true } as any);
    usePreflightBlockStore.setState({ blocks: [{ id: "b1", at: at(), source: "session", concept: "x", via: "concept" }], lastSeenAt: null } as any);
    render(<NextUpBar />);
    expect(line()).toBe("REPLAY · ■ HELD");
  });
});

describe("#430 PR 2 — pinned '+N high decision' and truncation order", () => {
  it("the pinned tokens never shrink; why shrinks before after, after before the title", () => {
    useArtifactStore.setState({ artifacts: [decision("d1", "Store choice", "high"), decision("d2", "Cache TTL", "high")] });
    render(<NextUpBar />);
    const high = screen.getByRole("button", { name: "+1 high decision" });
    expect(high.className).toContain("shrink-0");
    const title = screen.getByText("▲ Store choice");
    const why = screen.getByText(/· Context for Store choice/);
    const after = screen.getByText(/· Claude continues/);
    const shrink = (el: HTMLElement) => Number(el.style.flexShrink);
    expect(shrink(why)).toBeGreaterThan(shrink(after));
    expect(shrink(after)).toBeGreaterThan(shrink(title));
    fireEvent.click(high);
    expect(screen.getByText("High-stakes decisions (1)")).toBeInTheDocument();
  });
});

describe("#430 PR 2 — one announcer, no movement", () => {
  it("announces only when next.id changes — not on mount, not when counts move", () => {
    useArtifactStore.setState({ artifacts: [art("r1", "research", "First")] });
    render(<NextUpBar />);
    const announcer = screen.getByTestId("next-up-announcer");
    expect(announcer.textContent).toBe("");
    // A NEWER item joins: counts change, next (oldest) does not.
    act(() => useArtifactStore.getState().addArtifact(art("r2", "research", "Second")));
    expect(announcer.textContent).toBe("");
    // The oldest is approved → next moves to "Second".
    act(() => useArtifactStore.getState().updateArtifact("r1", "approved"));
    expect(announcer.textContent).toBe("Next up: review — Second");
    expect(document.querySelectorAll('[aria-live="polite"][data-testid="next-up-announcer"]')).toHaveLength(1);
  });

  it("a next change never moves selection or scroll; Open does, on an explicit click", () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    const winScroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    useArtifactStore.setState({ artifacts: [art("r1", "research", "First"), art("r2", "research", "Second")], selectedArtifactId: "r2" });
    render(<NextUpBar />);
    act(() => useArtifactStore.getState().updateArtifact("r1", "approved"));
    expect(useArtifactStore.getState().selectedArtifactId).toBe("r2");
    expect(scrollSpy).not.toHaveBeenCalled();
    expect(winScroll).not.toHaveBeenCalled();
    act(() => useArtifactStore.getState().selectArtifact("r1"));
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(useArtifactStore.getState().selectedArtifactId).toBe("r2");
  });

  it("the bar is keyboard reachable: Open, '+N high decision' and ⌄ are real buttons; ⌄ reports aria-expanded", () => {
    useArtifactStore.setState({ artifacts: [decision("d1", "Store choice", "high"), decision("d2", "Cache TTL", "high")] });
    render(<NextUpBar />);
    const toggle = screen.getByRole("button", { name: "Expand next-up details" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    toggle.focus();
    expect(document.activeElement).toBe(toggle);
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Collapse next-up details" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("region", { name: "Next up" })).toBeInTheDocument();
  });
});

describe("#451 review follow-ups", () => {
  const stubFetch = () => vi.stubGlobal("fetch", vi.fn().mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify({ sessions: [] }), { status: 200, headers: { "Content-Type": "application/json" } }))));

  it("1 — the lane word is part of the accessible text (not aria-hidden)", () => {
    useArtifactStore.setState({ artifacts: [decision("d1", "Store choice", "high")] });
    render(<NextUpBar />);
    const word = screen.getByText("DECIDE");
    expect(word.closest("[aria-hidden='true']")).toBeNull();
    expect(screen.getByRole("region", { name: "Next up" }).textContent).toMatch(/DECIDE\s*▲ Store choice/);
  });

  it("2 — 'Jump to next up' skip link: first in the App when the bar is on, focuses the bar; absent when off", () => {
    stubFetch();
    usePreferencesStore.setState({ nextUpBar: true });
    useArtifactStore.setState({ artifacts: [decision("d1", "Store choice", "high")] });
    const { unmount } = render(<App />);
    const link = screen.getByRole("link", { name: "Jump to next up" });
    const focusables = document.querySelectorAll("a[href], button, textarea, input, [tabindex='0']");
    expect(focusables[0]).toBe(link);
    fireEvent.click(link);
    expect(document.activeElement).toBe(screen.getByTestId("next-up-bar"));
    unmount();
    usePreferencesStore.setState({ nextUpBar: false });
    render(<App />);
    expect(screen.queryByRole("link", { name: "Jump to next up" })).not.toBeInTheDocument();
  });

  it("3 — lane glyphs: ▲ for a decision, ● for a review", () => {
    useArtifactStore.setState({ artifacts: [art("p1", "plan", "Rollout plan")] });
    render(<NextUpBar />);
    expect(line()).toBe("● Rollout plan · Decide 1");
  });

  it.each([
    ["staleDaemon", "⚠ STALE DAEMON"],
    ["snapshotUnavailable", "⚠ SNAPSHOT UNAVAILABLE"],
    ["sessionConflict", "⚠ SESSION CONFLICT"],
  ] as const)("4 — %s drives the failure prefix", (flag, prefix) => {
    useConnectionStore.setState({ [flag]: true } as any);
    useArtifactStore.setState({ artifacts: [decision("d1", "Store choice", "high")] });
    render(<NextUpBar />);
    expect(line()).toBe(`${prefix} · ▲ Store choice · Decide 1`);
  });

  it("4 — a REST project_hash_mismatch (the stale-daemon toast) sets staleDaemon", async () => {
    useConnectionStore.setState({ staleDaemon: false } as any);
    useArtifactStore.setState({ artifacts: [art("r1", "research", "A")] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "project_hash_mismatch", error: "stale" }), { status: 409, headers: { "Content-Type": "application/json" } })));
    await expect(useArtifactStore.getState().renameArtifact("r1", "B")).rejects.toBeTruthy();
    await vi.waitFor(() => expect(useConnectionStore.getState().staleDaemon).toBe(true));
  });

  it("5 — opening a hold's Why marks it seen (the gate log's lastSeenAt) and still shows the record", () => {
    usePreflightBlockStore.setState({ blocks: [{ id: "b1", at: at(), source: "session", concept: "global mutable state", proposal: "Add a singleton", via: "concept" }], lastSeenAt: null } as any);
    render(<NextUpBar />);
    fireEvent.click(screen.getByRole("button", { name: "Why" }));
    expect(usePreflightBlockStore.getState().lastSeenAt).not.toBeNull();
    expect(line()).toBe("○ Nothing needs you");
    expect(screen.getByText(/"global mutable state" stopped: Add a singleton/)).toBeInTheDocument();
  });
});

