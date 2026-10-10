import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import App from "../../App";
import { ResearchArtifact } from "../artifacts/ResearchArtifact";
import { SuggestionCard } from "../SuggestionCard";
import { ConversationRail } from "../ConversationRail";
import { RequestComposerBanner, OPEN_REQUEST_COMPOSER_EVENT } from "../RequestComposerBanner";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { usePreferencesStore } from "../../stores/preferences";
import { usePreflightBlockStore } from "../../stores/preflightBlocks";
import { useReplayStore } from "../../stores/replay";
import { useConnectionGraceStore, HYDRATION_STALL_MS } from "../../lib/connectionGrace";
import { OFFLINE_ACT_REASON } from "../../hooks/useOfflineReason";
import { PlanArtifact } from "../artifacts/PlanArtifact";
import { ReasoningCard } from "../artifacts/ReasoningCard";
import { AutonomySlider } from "../AutonomySlider";
import { ArtifactStatusActions } from "../artifacts/ArtifactStatusActions";
import { reloadPage, HYDRATION_STALLED_ANNOUNCEMENT, RELOAD_TITLE } from "../../lib/connectionGrace";
import { ReloadConfirmDialog } from "../ReloadConfirmDialog";
import { ArtifactPanel } from "../ArtifactPanel";
import { ToastLayer } from "../ToastLayer";
import { useToastStore } from "../../stores/toast";

/**
 * #477 — the act paths #467 left ungated, through the SAME shared offline
 * condition (lib/connectionGrace) and the same visible reason; and the D8 edge
 * where a connected tab's first snapshot never applies.
 */
const now = "2026-06-01T00:00:00.000Z";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify({ sessions: [] }), { status: 200, headers: { "Content-Type": "application/json" } }))));
  useArtifactStore.getState().reset();
  usePreflightBlockStore.setState({ blocks: [], lastSeenAt: null } as any);
  useReplayStore.setState({ active: false } as any);
  useConnectionStore.setState({
    connected: true, hydrated: true, sessionId: "s1", activeSessions: [{ sessionId: "s1", live: true }],
    staleDaemon: false, snapshotUnavailable: false, sessionConflict: false, agentActivityAt: null, disconnectedSince: null,
  } as any);
  useConnectionGraceStore.setState({ everConnected: true, graceOver: false, hydrationStalled: false });
  usePreferencesStore.setState({ nextUpBar: false } as any);
});
afterEach(() => {
  try { sessionStorage.clear(); } catch { /* private mode */ }
  useConnectionGraceStore.setState({ everConnected: false, graceOver: false, hydrationStalled: false });
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const goOffline = () => useConnectionStore.setState({ connected: false, disconnectedSince: Date.now() } as any);
const reconnect = () => useConnectionStore.setState({ connected: true, disconnectedSince: null } as any);
const expectGated = (el: HTMLElement) => {
  expect(el).toBeDisabled();
  expect(el.getAttribute("title")).toBe(OFFLINE_ACT_REASON);
};

describe("#477 — the remaining act paths gate offline, with the reason, and re-enable", () => {
  it("ResearchArtifact: a finding's Approve verdict", () => {
    const art = {
      id: "r1", sessionId: "s1", type: "research", version: 1, parentId: null, title: "Audit", status: "draft",
      content: { summary: "s", findings: [{ category: "Data", title: "Low hit rate", detail: "d", significance: "high" }] },
      agentReasoning: null, createdAt: now, updatedAt: now,
    } as any;
    useArtifactStore.setState({ artifacts: [art] } as any);
    render(<ResearchArtifact artifact={art} />);
    act(() => goOffline());
    expectGated(screen.getByRole("button", { name: "Approve finding 1" }));
    act(() => reconnect());
    expect(screen.getByRole("button", { name: "Approve finding 1" })).toBeEnabled();
  });

  it("SuggestionCard: Take the counter / Insist on mine", () => {
    const comment = {
      id: "cmt_s", sessionId: "s1", target: { artifactId: "art_1", lineStart: 3, lineEnd: 3, filePath: "a.ts" },
      parentCommentId: null, author: "human", content: "x", intent: "suggestion", acknowledged: false, createdAt: now,
      suggestion: { originalText: "a", replacementText: "b", lineStart: 3, lineEnd: 3, state: "countered" },
    } as any;
    render(<SuggestionCard comment={comment} replies={[]} />);
    act(() => goOffline());
    expectGated(screen.getByRole("button", { name: "Take the counter" }));
    expectGated(screen.getByRole("button", { name: "Insist on mine" }));
    act(() => reconnect());
    expect(screen.getByRole("button", { name: "Take the counter" })).toBeEnabled();
  });

  it("ConversationRail: a thread reply's send (the typed reply is kept)", () => {
    useArtifactStore.setState({
      artifacts: [{ id: "a1", sessionId: "s1", type: "research", version: 1, parentId: null, title: "A1", status: "draft", content: { summary: "x", findings: [] }, agentReasoning: null, createdAt: now, updatedAt: now }],
      comments: { a1: [{ id: "c1", sessionId: "s1", target: { artifactId: "a1" }, parentCommentId: null, author: "agent", content: "Here is why", acknowledged: false, createdAt: now }] },
    } as any);
    render(<ConversationRail onClose={() => {}} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Reply in this thread" })[0]!);
    const box = screen.getByPlaceholderText(/Continue the thread/);
    fireEvent.change(box, { target: { value: "draft follow-up" } });
    act(() => goOffline());
    expectGated(screen.getByRole("button", { name: "Reply" }));
    expect((screen.getByPlaceholderText(/Continue the thread/) as HTMLTextAreaElement).value).toBe("draft follow-up");
    act(() => reconnect());
    expect(screen.getByRole("button", { name: "Reply" })).toBeEnabled();
  });

  it("RequestComposer: Send request (the typed request is kept)", () => {
    render(<RequestComposerBanner />);
    act(() => { window.dispatchEvent(new CustomEvent(OPEN_REQUEST_COMPOSER_EVENT)); });
    const input = screen.getByRole("textbox", { name: "Your request to Claude" });
    fireEvent.change(input, { target: { value: "Explain the cache" } });
    act(() => goOffline());
    // The composer row renders only while connected? It must stay mounted offline.
    const send = screen.getByRole("button", { name: "Send request" });
    expectGated(send);
    expect((screen.getByRole("textbox", { name: "Your request to Claude" }) as HTMLInputElement).value).toBe("Explain the cache");
    act(() => reconnect());
    expect(screen.getByRole("button", { name: "Send request" })).toBeEnabled();
  });
});

describe("#477 — a connected tab whose first snapshot never applies", () => {
  it(`bar ON: past ${HYDRATION_STALL_MS / 1000}s the hold becomes the one still-loading line with Reload; a late hydration clears it`, () => {
    vi.useFakeTimers({ now: Date.now() });
    usePreferencesStore.setState({ nextUpBar: true } as any);
    useConnectionStore.setState({ connected: true, hydrated: false } as any);
    render(<App />);
    const line = () => screen.getByTestId("next-up-bar").getAttribute("data-line");
    expect(line()).toBe("Checking what needs you…");
    act(() => { vi.advanceTimersByTime(HYDRATION_STALL_MS - 500); });
    expect(line()).toBe("Checking what needs you…"); // not before the bound
    act(() => { vi.advanceTimersByTime(1000); });
    expect(line()).toBe("⚠ Still loading this session — it's taking longer than usual. It may still finish.");
    expect(screen.getByTestId("next-up-reload")).toHaveTextContent("Reload");
    act(() => useConnectionStore.setState({ hydrated: true } as any));
    expect(line()).not.toMatch(/Still loading/);
    expect(screen.queryByTestId("next-up-reload")).not.toBeInTheDocument();
  });

  it("bar OFF: the same truthful banner with Reload, cleared by a late hydration", () => {
    vi.useFakeTimers({ now: Date.now() });
    useConnectionStore.setState({ connected: true, hydrated: false } as any);
    render(<App />);
    act(() => { vi.advanceTimersByTime(HYDRATION_STALL_MS + 500); });
    const banner = screen.getByTestId("hydration-stalled");
    // #487 review — honest: it may still finish; Reload is an offer.
    expect(banner).toHaveTextContent("Still loading this session — it's taking longer than usual. It may still finish. Reload");
    expect(banner.textContent).not.toMatch(/couldn't|never loaded/i);
    expect(banner.textContent).not.toMatch(/reload\.\s*Reload/i); // no "…reload. Reload"
    expect(banner.closest("[role='status']")).not.toBeNull();
    act(() => useConnectionStore.setState({ hydrated: true } as any));
    expect(screen.queryByTestId("hydration-stalled")).not.toBeInTheDocument();
  });
});

describe("#487 review — the act paths the first pass missed", () => {
  it("PlanArtifact: 'Approve with modifications' (the plan verdict)", () => {
    const plan = {
      id: "p1", sessionId: "s1", type: "plan", version: 1, parentId: null, title: "Plan", status: "draft",
      content: { steps: [{ description: "one", reasoning: "r" }, { description: "two", reasoning: "r" }] },
      agentReasoning: null, createdAt: now, updatedAt: now,
    } as any;
    useArtifactStore.setState({ artifacts: [plan] } as any);
    render(<PlanArtifact artifact={plan} />);
    // Uncheck a step (its aria-pressed toggle) → the custom approve appears.
    fireEvent.click(document.querySelectorAll("[aria-pressed='true']")[1] as HTMLElement);
    act(() => goOffline());
    expectGated(screen.getByRole("button", { name: "Approve with modifications" }));
    act(() => reconnect());
    expect(screen.getByRole("button", { name: "Approve with modifications" })).toBeEnabled();
  });

  it("ReasoningCard: 'Ask why' on a road not taken (the typed question is kept)", () => {
    const rc = {
      id: "rc1", sessionId: "s1", type: "reasoning", version: 1, parentId: null, title: "Why", status: "draft",
      content: { action: "a", reasoning: "r", alternativeDetails: [{ title: "Use a lock", whyRejected: "contention" }] },
      agentReasoning: null, createdAt: now, updatedAt: now,
    } as any;
    render(<ReasoningCard artifact={rc} />);
    fireEvent.click(screen.getByRole("button", { name: /Ask why/ }));
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "why not a lock?" } });
    act(() => goOffline());
    const send = screen.getAllByRole("button").find((b) => b.getAttribute("title") === OFFLINE_ACT_REASON)!;
    expect(send).toBeDisabled();
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("why not a lock?");
  });

  it("AutonomySlider: the autonomy level (a settings POST)", () => {
    render(<AutonomySlider />);
    fireEvent.click(screen.getAllByRole("button")[0]!); // open the level menu
    act(() => goOffline());
    const levels = screen.getAllByRole("button").filter((b) => b.getAttribute("title") === OFFLINE_ACT_REASON);
    expect(levels.length).toBeGreaterThan(0);
    for (const b of levels) expect(b).toBeDisabled();
  });
});

describe("#487 review — drafts across the 'still loading' Reload", () => {
  it("the request being typed survives a reload (useDraft) and reopens", () => {
    const first = render(<RequestComposerBanner />);
    act(() => { window.dispatchEvent(new CustomEvent(OPEN_REQUEST_COMPOSER_EVENT)); });
    fireEvent.change(screen.getByRole("textbox", { name: "Your request to Claude" }), { target: { value: "Explain the cache" } });
    first.unmount(); // a reload, as far as React state is concerned
    render(<RequestComposerBanner />);
    expect((screen.getByRole("textbox", { name: "Your request to Claude" }) as HTMLInputElement).value).toBe("Explain the cache");
  });

  it("a counter-reply draft survives a reload (useDraft) and reopens", () => {
    const comment = {
      id: "cmt_d", sessionId: "s1", target: { artifactId: "art_1", lineStart: 3, lineEnd: 3, filePath: "a.ts" },
      parentCommentId: null, author: "human", content: "x", intent: "suggestion", acknowledged: false, createdAt: now,
      suggestion: { originalText: "a", replacementText: "b", lineStart: 3, lineEnd: 3, state: "countered" },
    } as any;
    const first = render(<SuggestionCard comment={comment} replies={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Reply…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Reply to Claude's counter" }), { target: { value: "keep mine because…" } });
    first.unmount();
    render(<SuggestionCard comment={comment} replies={[]} />);
    expect((screen.getByRole("textbox", { name: "Reply to Claude's counter" }) as HTMLTextAreaElement).value).toBe("keep mine because…");
  });

  it("the footer comment (not a useDraft) makes Reload ask first in the app's dialog — Keep is the default; Esc keeps", () => {
    const reload = vi.fn();
    const confirm = vi.fn();
    vi.stubGlobal("confirm", confirm);
    Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, reload } });
    const art = { id: "art_f", sessionId: "s1", type: "research", version: 1, parentId: null, title: "T", status: "draft", content: {}, agentReasoning: null, createdAt: now, updatedAt: now } as any;
    render(<><ArtifactStatusActions artifact={art} /><ReloadConfirmDialog /></>);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "half-written review note" } });
    act(() => reloadPage());
    const dialog = screen.getByRole("dialog", { name: /Reload and discard unsent text/ });
    expect(confirm).not.toHaveBeenCalled(); // never window.confirm (Enter there discards)
    expect(reload).not.toHaveBeenCalled();
    // Esc keeps.
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    // Keep is the FIRST button (the focus trap's default focus): Enter keeps.
    act(() => reloadPage());
    const buttons = screen.getAllByRole("button").filter((b) => screen.getByRole("dialog").contains(b));
    expect(buttons[0]).toHaveTextContent("Keep my text");
    fireEvent.click(buttons[0]!);
    expect(reload).not.toHaveBeenCalled();
    // Only an explicit "Reload anyway" discards.
    act(() => reloadPage());
    fireEvent.click(screen.getByRole("button", { name: "Reload anyway" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("#487 review (Fable)", () => {
  const STALL = "Still loading this session — it's taking longer than usual. It may still finish.";

  it("MED 1 — stalled with artifacts: the panel shows them; the bar is ONE line (no prefix, no Decide/summary)", () => {
    vi.useFakeTimers({ now: Date.now() });
    usePreferencesStore.setState({ nextUpBar: true } as any);
    useConnectionStore.setState({ connected: true, hydrated: false } as any);
    // Broadcasts after a missed snapshot: artifacts exist, the snapshot never applied.
    useArtifactStore.setState({ artifacts: [{ id: "d1", sessionId: "s1", type: "decision", version: 1, parentId: null, title: "Pick a store", status: "draft", content: { context: "c", decisionId: "x", options: [{ id: "a", title: "A", description: "d", pros: [], cons: [], effort: "low", risk: "low", recommendation: true }] }, agentReasoning: null, createdAt: now, updatedAt: now }] } as any);
    render(<App />);
    act(() => { vi.advanceTimersByTime(HYDRATION_STALL_MS + 500); });
    expect(screen.getByTestId("next-up-bar").getAttribute("data-line")).toBe(`⚠ ${STALL}`);
    expect(screen.getByTestId("next-up-bar").textContent).not.toMatch(/Decide|DECIDE/);
    expect(screen.queryByTestId("hydration-unknown")).not.toBeInTheDocument();
    expect(screen.getAllByText("Pick a store").length).toBeGreaterThan(0); // the panel renders it
  });

  it("MED 2 — bar ON: the stall is announced ONCE through the bar's announcer", () => {
    vi.useFakeTimers({ now: Date.now() });
    usePreferencesStore.setState({ nextUpBar: true } as any);
    useConnectionStore.setState({ connected: true, hydrated: false } as any);
    render(<App />);
    act(() => { vi.advanceTimersByTime(HYDRATION_STALL_MS + 500); });
    expect(screen.getByTestId("next-up-announcer")).toHaveTextContent(HYDRATION_STALLED_ANNOUNCEMENT);
    expect(screen.getByTestId("next-up-reload").getAttribute("title")).toBe(RELOAD_TITLE); // LOW 5
  });

  it("MED 3 — a rail reply registers as unsaved text, so Reload asks first", () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, reload } });
    useArtifactStore.setState({
      artifacts: [{ id: "a1", sessionId: "s1", type: "research", version: 1, parentId: null, title: "A1", status: "draft", content: { summary: "x", findings: [] }, agentReasoning: null, createdAt: now, updatedAt: now }],
      comments: { a1: [{ id: "c1", sessionId: "s1", target: { artifactId: "a1" }, parentCommentId: null, author: "agent", content: "Here is why", acknowledged: false, createdAt: now }] },
    } as any);
    render(<><ConversationRail onClose={() => {}} /><ReloadConfirmDialog /></>);
    fireEvent.click(screen.getAllByRole("button", { name: "Reply in this thread" })[0]!);
    fireEvent.change(screen.getByPlaceholderText(/Continue the thread/), { target: { value: "unsent reply" } });
    act(() => reloadPage());
    expect(screen.getByTestId("reload-confirm")).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it("MED 4 — offline controls LOOK disabled: the title rename is a real disabled button; Retire carries disabled styles", () => {
    const art = { id: "r1", sessionId: "s1", type: "research", version: 1, parentId: null, title: "Audit", status: "draft", content: { summary: "s", findings: [] }, agentReasoning: null, createdAt: now, updatedAt: now } as any;
    useArtifactStore.setState({ artifacts: [art], selectedArtifactId: "r1" } as any);
    render(<><ArtifactPanel /><ToastLayer /></>);
    act(() => goOffline());
    const rename = screen.getByRole("heading", { name: "Audit" }).querySelector("button")!;
    expect(rename).toBeDisabled();
    expect(rename.className).toContain("disabled:cursor-default");
    act(() => { useToastStore.getState().push({ kind: "preflight-block", title: "Blocked", ttl: 0, hero: { source: "session", concept: "redis", via: "concept" } } as any); });
    const retire = screen.getByRole("button", { name: /Retire this stance/ });
    expect(retire).toBeDisabled();
    expect(retire.className).toMatch(/disabled:opacity-50 disabled:cursor-not-allowed disabled:no-underline/);
  });

  it("LOW 7 — a tab that has NEVER connected shows no request composer (even past the grace)", () => {
    useConnectionGraceStore.setState({ everConnected: false, graceOver: true, hydrationStalled: false });
    useConnectionStore.setState({ connected: false } as any);
    render(<RequestComposerBanner />);
    expect(screen.queryByTestId("request-composer")).not.toBeInTheDocument();
  });
});
