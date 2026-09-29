import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import App from "../../App";
import { ArtifactPanel } from "../ArtifactPanel";
import { DiagnosticsMenu } from "../DiagnosticsMenu";
import { NextUpBar } from "../NextUpBar";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { usePreferencesStore } from "../../stores/preferences";
import { usePreflightBlockStore } from "../../stores/preflightBlocks";
import { useHookStatusStore } from "../../stores/hookStatus";
import { useReplayStore } from "../../stores/replay";
import { useToastStore } from "../../stores/toast";
import { LANE_MARKS, NOTHING_GLYPH } from "../../lib/laneMarks";
import { pushStaleDaemonToast, STALE_DAEMON_TOAST_TITLE } from "../../lib/daemon-restart";

/**
 * #430 PR 5 (docs/design/attention-hierarchy.md §5, §8 PR 5).
 *
 * Setting-gated — ONLY with the Next-up bar ON: the request row collapses to a
 * header "Ask" button (pips + resume bridge move into the bar), the demo CTA
 * and wrap card render inside the bar, and the `Agents:` row becomes a filter
 * menu in the sidebar header. OFF: each stays exactly where it is today.
 *
 * Unflagged: the ⋯ dot keys on unread blocks + both nag kinds; the session dot
 * pulses only while the agent works; one stale-daemon toast helper. (The shared
 * approve countdown is pinned in its hosts' own test files.)
 *
 * PR 4 review nits: the lane label shows on keyboard focus; the bar's empty
 * state has its own glyph (◇), so ○ only ever means Read.
 */
let t = 0;
const at = () => `2026-06-01T00:${String(t++).padStart(2, "0")}:00.000Z`;
const art = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id, sessionId: "s1", type: "research", version: 1, parentId: null, title, status: "approved",
  content: { summary: "s", findings: [] }, agentReasoning: null, createdAt: at(), updatedAt: at(), ...over,
}) as any;
const request = (id: string, text: string, served?: string) =>
  ({ id, sessionId: "s1", text, intent: "explain", createdAt: at(), ...(served ? { servedByArtifactId: served } : {}) }) as any;

const stubFetch = () => vi.stubGlobal("fetch", vi.fn().mockImplementation(() =>
  Promise.resolve(new Response(JSON.stringify({ sessions: [] }), { status: 200, headers: { "Content-Type": "application/json" } }))));

const setConn = (over: Record<string, unknown> = {}) =>
  useConnectionStore.setState({
    connected: true, hydrated: true, sessionId: "s1", activeSessions: [{ sessionId: "s1", live: true, artifactCount: 1 }],
    staleDaemon: false, snapshotUnavailable: false, sessionConflict: false, agentActivityAt: null, agentActiveSince: null,
    ...over,
  } as any);

beforeEach(() => {
  t = 0;
  useArtifactStore.getState().reset();
  usePreflightBlockStore.setState({ blocks: [], lastSeenAt: null } as any);
  useHookStatusStore.setState({ fires: [] } as any);
  useReplayStore.setState({ active: false } as any);
  useToastStore.getState().dismissAll();
  setConn();
  usePreferencesStore.setState({ nextUpBar: false, sidebarCollapsed: false } as any);
  stubFetch();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const bar = () => screen.getByTestId("next-up-bar");
const expandBar = () => fireEvent.click(within(bar()).getByRole("button", { name: "Expand next-up details" }));

describe("#430 PR 5 — requests: row (OFF) vs header Ask + bar (ON)", () => {
  const seed = () => {
    useArtifactStore.setState({
      artifacts: [art("a_served", "Auth explainer")],
      requests: [request("r1", "explain auth", "a_served"), request("r2", "plan the limiter")],
    } as any);
  };

  it("OFF: the composer row renders with its pips; no header Ask button", () => {
    seed();
    render(<App />);
    const row = screen.getByTestId("request-composer");
    expect(within(row).getByTestId("request-pips")).toBeInTheDocument();
    expect(screen.queryByTestId("header-ask")).not.toBeInTheDocument();
  });

  it("ON: no standing row; the header Ask opens the same composer; pips live in the bar's ⌄ with the served jump", () => {
    usePreferencesStore.setState({ nextUpBar: true } as any);
    seed();
    render(<App />);
    expect(screen.queryByTestId("request-composer")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("header-ask"));
    const composer = screen.getByTestId("request-composer");
    expect(within(composer).getByRole("textbox", { name: "Your request to Claude" })).toBeInTheDocument();
    expect(within(composer).queryByTestId("request-pips")).not.toBeInTheDocument();
    fireEvent.click(within(composer).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("request-composer")).not.toBeInTheDocument();

    // The unserved request is a Waiting item; every pip (served included) is in ⌄.
    expect(bar().getAttribute("data-line")).toMatch(/^◌ WAITING ON CLAUDE/);
    expandBar();
    expect(within(bar()).getByText("Waiting on Claude (1)").parentElement).toHaveTextContent("plan the limiter");
    const reqs = within(bar()).getByTestId("next-up-requests");
    const served = within(reqs).getAllByRole("button").find((b) => b.getAttribute("data-served") === "true")!;
    fireEvent.click(served);
    expect(useArtifactStore.getState().selectedArtifactId).toBe("a_served");
  });

  it("resume bridge (no agent live, a pending request): OFF in the row, ON in the bar", () => {
    setConn({ activeSessions: [{ sessionId: "s1", live: false, artifactCount: 1 }] });
    seed();
    const { unmount } = render(<App />);
    expect(within(screen.getByTestId("request-composer")).getByTestId("request-resume-prompt")).toBeInTheDocument();
    unmount();
    usePreferencesStore.setState({ nextUpBar: true } as any);
    render(<App />);
    expect(within(bar()).getByTestId("request-resume-prompt")).toHaveTextContent("Copy request resume prompt");
  });
});

describe("#430 PR 5 — demo CTA and wrap card", () => {
  it("demo CTA — OFF: its own row; ON: inline in the quiet bar, dismissible, still in ⌄ after", () => {
    setConn({ sessionId: "demo_1", activeSessions: [{ sessionId: "demo_1", live: true, artifactCount: 1 }] });
    useArtifactStore.setState({ artifacts: [art("a1", "Done", { sessionId: "demo_1" })] } as any);
    const { unmount } = render(<App />);
    expect(screen.getByTestId("demo-next-step")).toBeInTheDocument();
    expect(screen.queryByTestId("next-up-bar")).not.toBeInTheDocument();
    unmount();

    usePreferencesStore.setState({ nextUpBar: true } as any);
    render(<App />);
    const card = within(bar()).getByTestId("demo-next-step");
    expect(screen.getAllByTestId("demo-next-step")).toHaveLength(1); // not also a row
    fireEvent.click(within(card).getByRole("button", { name: "Dismiss demo next step" }));
    expect(screen.queryByTestId("demo-next-step")).not.toBeInTheDocument();
    expandBar();
    expect(within(bar()).getByTestId("demo-next-step")).toBeInTheDocument(); // nothing lost
  });

  it("demo CTA — ON with a decision pending: not inline (never pushes a decision), but in ⌄", () => {
    usePreferencesStore.setState({ nextUpBar: true } as any);
    setConn({ sessionId: "demo_1", activeSessions: [{ sessionId: "demo_1", live: true, artifactCount: 1 }] });
    useArtifactStore.setState({ artifacts: [art("d1", "Pick a store", { sessionId: "demo_1", type: "decision", status: "draft", content: { context: "c", decisionId: "d", options: [] } })] } as any);
    render(<App />);
    expect(screen.queryByTestId("demo-next-step")).not.toBeInTheDocument();
    expandBar();
    expect(within(bar()).getByTestId("demo-next-step")).toBeInTheDocument();
  });

  it("wrap card — OFF: below the banners; ON: inside the bar", () => {
    setConn({ activeSessions: [{ sessionId: "s1", live: false, artifactCount: 1 }] });
    useArtifactStore.setState({ artifacts: [art("a1", "Done")] } as any);
    const { unmount } = render(<App />);
    expect(screen.getByRole("status", { name: "Session wrapped" })).toBeInTheDocument();
    unmount();
    usePreferencesStore.setState({ nextUpBar: true } as any);
    render(<App />);
    expect(within(bar()).getByRole("status", { name: "Session wrapped" })).toBeInTheDocument();
    expect(screen.getAllByRole("status", { name: "Session wrapped" })).toHaveLength(1);
  });
});

describe("#430 PR 5 — the Agents row becomes a filter menu (ON)", () => {
  const seed = () => useArtifactStore.setState({
    artifacts: [art("a1", "From agent one"), art("a2", "From agent two", { sessionId: "s2" })],
  } as any);

  it("OFF: the Agents: row, unchanged", () => {
    seed();
    render(<ArtifactPanel />);
    expect(screen.getByText("Agents:")).toBeInTheDocument();
    expect(screen.queryByTestId("agents-filter-menu")).not.toBeInTheDocument();
  });

  it("ON: a menu in the sidebar header with the same options, and it filters", () => {
    usePreferencesStore.setState({ nextUpBar: true } as any);
    seed();
    render(<ArtifactPanel />);
    expect(screen.queryByText("Agents:")).not.toBeInTheDocument();
    const menu = screen.getByTestId("agents-filter-menu") as HTMLSelectElement;
    expect(menu.closest("nav[aria-label='Artifacts']")).not.toBeNull();
    expect(Array.from(menu.options).map((o) => o.textContent)).toEqual(["All (2)", "Agent 1 (1)", "Agent 2 (1)"]);
    fireEvent.change(menu, { target: { value: "s2" } });
    expect(screen.queryAllByText("From agent one").filter((el) => el.closest("[data-artifact-item]"))).toHaveLength(0);
    expect(screen.queryAllByText("From agent two").filter((el) => el.closest("[data-artifact-item]")).length).toBeGreaterThan(0);
  });

  it("ON with the sidebar collapsed: the row stays (no header room), so the filter is never lost", () => {
    usePreferencesStore.setState({ nextUpBar: true, sidebarCollapsed: true } as any);
    seed();
    render(<ArtifactPanel />);
    expect(screen.getByText("Agents:")).toBeInTheDocument();
    expect(screen.queryByTestId("agents-filter-menu")).not.toBeInTheDocument();
  });
});

describe("#430 PR 5 — unflagged fixes", () => {
  const block = (id: string, iso: string) => ({ id, at: iso, source: "session", concept: "redis" }) as any;

  it("⋯ dot keys on UNREAD blocks: it clears once the blocks are seen (it never cleared before)", () => {
    usePreflightBlockStore.setState({ blocks: [block("b1", "2026-06-01T00:00:00.000Z")], lastSeenAt: null } as any);
    const { rerender } = render(<DiagnosticsMenu onOpenLedger={() => {}} />);
    expect(screen.getByTestId("diagnostics-attention-dot")).toBeInTheDocument();
    act(() => usePreflightBlockStore.setState({ lastSeenAt: "2026-06-01T00:00:01.000Z" } as any));
    rerender(<DiagnosticsMenu onOpenLedger={() => {}} />);
    expect(screen.queryByTestId("diagnostics-attention-dot")).not.toBeInTheDocument();
  });

  it("⋯ dot keys on BOTH nag kinds: an 'ask' fire (no exitCode) lights it, like HookStatus's own dot", () => {
    useHookStatusStore.setState({ fires: [{ at: "2026-06-01T00:00:00.000Z", hook: "preflight", reason: "migrations/", kind: "ask" }] } as any);
    render(<DiagnosticsMenu onOpenLedger={() => {}} />);
    expect(screen.getByTestId("diagnostics-attention-dot")).toBeInTheDocument();
  });

  it("the bound session's dot pulses only while the agent is working", () => {
    useArtifactStore.setState({ artifacts: [art("a1", "Done")] } as any);
    const { unmount } = render(<App />);
    const idle = screen.getByTestId("session-dot");
    expect(idle.getAttribute("data-working")).toBe("false");
    expect(idle.className).not.toContain("animate-pulse");
    unmount();
    setConn({ agentActivityAt: Date.now() });
    render(<App />);
    const working = screen.getByTestId("session-dot");
    expect(working.getAttribute("data-working")).toBe("true");
    expect(working.className).toContain("animate-pulse");
  });

  it("one stale-daemon toast: the REST path twice plus the WS helper stack to exactly one", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response(
      JSON.stringify({ error: "Project hash mismatch", code: "project_hash_mismatch" }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    ))));
    const s = useArtifactStore.getState();
    await s.submitComment("a1", "hi").catch(() => {});
    await s.submitComment("a1", "again").catch(() => {});
    pushStaleDaemonToast(); // what the WS onFatalMismatch path calls
    const stale = useToastStore.getState().toasts.filter((x) => x.title === STALE_DAEMON_TOAST_TITLE);
    expect(stale).toHaveLength(1);
    expect(stale[0]!.action?.label).toBe("Reload to re-bind");
    expect(stale[0]!.ttl).toBe(0);
  });
});

describe("#430 PR 5 — PR 4 review nits", () => {
  it("keyboard focus on a sidebar row shows its lane label as a visible tooltip; a click does not; no extra tab stop", () => {
    useArtifactStore.setState({ artifacts: [art("d1", "Pick a store", { type: "decision", status: "draft", content: { context: "c", decisionId: "d", options: [] } })] } as any);
    render(<ArtifactPanel />);
    const row = document.querySelector("[data-artifact-item='d1']") as HTMLElement;
    // The glyph is not its own tab stop.
    expect(row.querySelectorAll("[tabindex]")).toHaveLength(0);

    fireEvent.mouseDown(row);
    act(() => row.focus());
    expect(screen.queryByTestId("lane-focus-tooltip")).not.toBeInTheDocument();
    act(() => row.blur());

    fireEvent.keyDown(document.body, { key: "Tab" });
    act(() => row.focus());
    const tip = screen.getByTestId("lane-focus-tooltip");
    expect(tip).toHaveTextContent(LANE_MARKS.decide.label);
    expect(tip.getAttribute("aria-hidden")).toBe("true"); // the row's name already carries it
    act(() => row.blur());
    expect(screen.queryByTestId("lane-focus-tooltip")).not.toBeInTheDocument();
  });

  it("collapsed rail: keyboard focus shows the label too", () => {
    usePreferencesStore.setState({ sidebarCollapsed: true } as any);
    useArtifactStore.setState({ artifacts: [art("w1", "Backfill plan", { status: "revised" })] } as any);
    render(<ArtifactPanel />);
    const row = document.querySelector("[data-artifact-item='w1']") as HTMLElement;
    fireEvent.keyDown(document.body, { key: "Tab" });
    act(() => row.focus());
    expect(screen.getByTestId("lane-focus-tooltip")).toHaveTextContent(LANE_MARKS.waiting.label);
  });

  it("the bar's empty state is ◇, not ○ — ○ only ever means Read", () => {
    usePreferencesStore.setState({ nextUpBar: true } as any);
    render(<NextUpBar />);
    expect(bar().getAttribute("data-line")!.startsWith(`${NOTHING_GLYPH} Nothing needs you`)).toBe(true);
    expect(NOTHING_GLYPH).not.toBe(LANE_MARKS.read.glyph);
    expect(Object.values(LANE_MARKS).map((m) => m.glyph)).not.toContain(NOTHING_GLYPH);
  });
});
