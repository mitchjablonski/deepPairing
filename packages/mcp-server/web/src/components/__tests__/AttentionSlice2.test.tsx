import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../../App";
import { ArtifactPanel } from "../ArtifactPanel";
import { DiagnosticsMenu } from "../DiagnosticsMenu";
import { PendingBanner } from "../PendingBanner";
import { NARROW_VIEWPORT_QUERY } from "../../hooks/useMediaQuery";
import { useDocumentTitleBadge } from "../../hooks/useDocumentTitleBadge";
import { openGateLogEntry, gateEntryDomId } from "../../lib/stanceException";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { usePreferencesStore } from "../../stores/preferences";
import { unreadBlockCount, usePreflightBlockStore, type PreflightBlockRecord } from "../../stores/preflightBlocks";
import { useReplayStore } from "../../stores/replay";

/**
 * #430 slice 2, Sol's conditions 1-4. D1: the bar-OFF Agents row becomes the
 * sidebar menu while the sidebar is expanded, and stays a filter. D2: a held
 * terminal ask gets a real Why, meaning viewed and never answered, plus the
 * focus return it needs. Real stores and a fake daemon, no module mocks.
 */
const art = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id, sessionId: "s1", type: "research", version: 1, parentId: null, title, status: "approved",
  content: { summary: "s", findings: [] }, agentReasoning: null,
  createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z", ...over,
}) as any;

const ask = (id: string, at: string, over: Partial<PreflightBlockRecord> = {}): PreflightBlockRecord => ({
  id, at, source: "session", concept: `stance ${id}`, via: "concept", lane: "hook", decision: "ask",
  toolName: "Edit", targetPath: "db/m.sql", ...over,
});
const stance = (id: string, at: string): PreflightBlockRecord => ({ id, serverId: id, at, source: "session", concept: `row ${id}`, via: "concept" });
const minute = (n: number) => `2026-06-01T01:${String(n).padStart(2, "0")}:00.000Z`;

/** A fake daemon: answers every route, records every request. */
function fakeDaemon(hydrate: () => Promise<PreflightBlockRecord[]> | PreflightBlockRecord[] = () => []) {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    const body = url.includes("/api/preflight-blocks") ? { blocks: await hydrate() } : { sessions: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  return { mutations: () => calls.filter((c) => c.method !== "GET" && c.method !== "HEAD") };
}

/** A controllable viewport: only the narrow query answers and fires. */
function fakeViewport(initialNarrow: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  let narrow = initialNarrow;
  window.matchMedia = ((query: string) => ({
    get matches() { return query === NARROW_VIEWPORT_QUERY && narrow; },
    media: query,
    addEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => { if (query === NARROW_VIEWPORT_QUERY) listeners.add(l); },
    removeEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => { listeners.delete(l); },
  })) as unknown as typeof window.matchMedia;
  return (next: boolean) => {
    narrow = next;
    act(() => { for (const l of listeners) l({ matches: next } as MediaQueryListEvent); });
  };
}

const realMatchMedia = window.matchMedia;

beforeEach(() => {
  useArtifactStore.getState().reset();
  try { localStorage.removeItem("dp.gateBlocks.lastSeenAt"); } catch { /* unavailable */ }
  usePreflightBlockStore.setState({ blocks: [], liveRev: {}, lastSeenAt: null, loaded: true, focusRequest: null, logOpen: false });
  useReplayStore.setState({ active: false, exiting: false, cursor: "" });
  useConnectionStore.setState({
    connected: true, hydrated: true, sessionId: "s1", activeSessions: [{ sessionId: "s1", live: true, artifactCount: 1 }],
  } as any);
  usePreferencesStore.setState({ nextUpBar: false, sidebarCollapsed: false } as any);
});

afterEach(() => {
  useReplayStore.setState({ active: false, exiting: false, cursor: "" });
  vi.unstubAllGlobals();
  window.matchMedia = realMatchMedia;
});

const setArtifacts = (artifacts: unknown[]) => act(() => { useArtifactStore.setState({ artifacts } as any); });
const menu = () => screen.getByTestId("agents-filter-menu") as HTMLSelectElement;
const inSidebar = (id: string) => document.querySelector(`nav[aria-label='Artifacts'] [data-artifact-item="${id}"]`);
const activeRowButton = () => document.querySelector<HTMLElement>("[data-agents-active]");

describe("#430 slice 2 D1 — the Agents filter with the bar OFF", () => {
  const two = () => [art("a1", "From agent one"), art("a2", "From agent two", { sessionId: "s2" })];

  it("is a labelled native select in the sidebar with total counts, and it filters", () => {
    fakeDaemon();
    setArtifacts([...two(), art("a3", "Superseded", { status: "superseded" })]);
    render(<ArtifactPanel />);
    expect(screen.queryByText("Agents:")).not.toBeInTheDocument();
    const select = screen.getByRole("combobox", { name: /^Agents/ }) as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect(select.closest("nav[aria-label='Artifacts']")).not.toBeNull();
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["All (2)", "Agent 1 (1)", "Agent 2 (1)"]);
    fireEvent.change(select, { target: { value: "s2" } });
    expect(inSidebar("a1")).toBeNull();
    expect(inSidebar("a2")).not.toBeNull();
    fireEvent.change(select, { target: { value: "all" } });
    expect(inSidebar("a1")).not.toBeNull();
  });

  it("names a demo session in its option text", () => {
    fakeDaemon();
    setArtifacts([art("a1", "Real"), art("d1", "Sample", { sessionId: "demo_1" })]);
    render(<ArtifactPanel />);
    expect(Array.from(menu().options).map((o) => o.textContent)).toEqual(["All (2)", "Agent 1 (1)", "Agent 2 · Demo (1)"]);
  });

  it("keeps the row when collapsed or narrow", () => {
    fakeDaemon();
    setArtifacts(two());
    usePreferencesStore.setState({ sidebarCollapsed: true } as any);
    const { unmount } = render(<ArtifactPanel />);
    expect(screen.getByText("Agents:")).toBeInTheDocument();
    expect(screen.queryByTestId("agents-filter-menu")).not.toBeInTheDocument();
    unmount();
    usePreferencesStore.setState({ sidebarCollapsed: false } as any);
    fakeViewport(true);
    render(<ArtifactPanel />);
    expect(screen.getByText("Agents:")).toBeInTheDocument();
    expect(screen.queryByTestId("agents-filter-menu")).not.toBeInTheDocument();
  });

  it("filtering changes neither the banner count nor the tab title", () => {
    fakeDaemon();
    const Title = () => { useDocumentTitleBadge(); return null; };
    setArtifacts([art("a1", "One", { status: "draft" }), art("a2", "Two", { status: "draft", sessionId: "s2" }), art("a3", "Three", { status: "draft", sessionId: "s2" })]);
    render(<><Title /><PendingBanner /><ArtifactPanel /></>);
    expect(screen.getByText("3 items waiting for you")).toBeInTheDocument();
    expect(document.title).toBe("(3) Your turn — deepPairing");
    fireEvent.change(menu(), { target: { value: "s1" } });
    expect(screen.getByText("3 items waiting for you")).toBeInTheDocument();
    expect(document.title).toBe("(3) Your turn — deepPairing");
  });

  it("keeps the selection across collapse and resize, and focus moves with the control", () => {
    fakeDaemon();
    const setNarrow = fakeViewport(false);
    setArtifacts(two());
    render(<ArtifactPanel />);
    fireEvent.change(menu(), { target: { value: "s2" } });
    menu().focus();

    act(() => usePreferencesStore.getState().toggleSidebar());
    expect(activeRowButton()).toHaveTextContent("Agent 2 (1)");
    expect(activeRowButton()).toHaveFocus();
    expect(inSidebar("a1")).toBeNull();

    act(() => usePreferencesStore.getState().toggleSidebar());
    expect(menu().value).toBe("s2");
    expect(menu()).toHaveFocus();

    setNarrow(true);
    expect(activeRowButton()).toHaveTextContent("Agent 2 (1)");
    expect(activeRowButton()).toHaveFocus();
    setNarrow(false);
    expect(menu().value).toBe("s2");
    expect(menu()).toHaveFocus();
  });

  it("collapsing doesn't pull focus from anywhere else", () => {
    fakeDaemon();
    setArtifacts(two());
    render(<><input aria-label="composer" /><ArtifactPanel /></>);
    const composer = screen.getByRole("textbox", { name: "composer" });
    composer.focus();
    act(() => usePreferencesStore.getState().toggleSidebar());
    expect(composer).toHaveFocus();
  });

  it("a sibling arriving keeps focus on the menu; the first sibling leaves focus where it was", () => {
    fakeDaemon();
    setArtifacts([art("a1", "One")]);
    render(<><input aria-label="composer" /><ArtifactPanel /></>);
    const composer = screen.getByRole("textbox", { name: "composer" });
    composer.focus();
    setArtifacts(two());
    expect(composer).toHaveFocus();
    const select = menu();
    select.focus();
    setArtifacts([...two(), art("a3", "From agent three", { sessionId: "s3" })]);
    expect(menu()).toBe(select);
    expect(select).toHaveFocus();
    expect(select.options).toHaveLength(4);
  });

  it("a sibling leaving keeps focus; a filter on it falls back to All, and the last one hands focus to a visible control", () => {
    fakeDaemon();
    const three = [...two(), art("a3", "From agent three", { sessionId: "s3" })];
    setArtifacts(three);
    render(<ArtifactPanel />);
    fireEvent.change(menu(), { target: { value: "s3" } });
    menu().focus();

    setArtifacts(two());
    expect(menu()).toHaveFocus();
    expect(menu().value).toBe("all");
    expect(inSidebar("a1")).not.toBeNull();

    setArtifacts([art("a1", "From agent one")]);
    expect(screen.queryByTestId("agents-filter-menu")).not.toBeInTheDocument();
    expect(inSidebar("a1")).not.toBeNull();
    expect(document.activeElement).toBe(document.querySelector("[data-sidebar-toggle]"));
  });

  it("a row button leaving moves focus to the row's active button", () => {
    fakeDaemon();
    usePreferencesStore.setState({ sidebarCollapsed: true } as any);
    setArtifacts([...two(), art("a3", "From agent three", { sessionId: "s3" })]);
    render(<ArtifactPanel />);
    const third = screen.getByRole("button", { name: /^Agent 3 \(/ });
    fireEvent.click(third);
    third.focus();
    setArtifacts(two());
    expect(activeRowButton()).toHaveTextContent("All (2)");
    expect(activeRowButton()).toHaveFocus();
  });

  it("opening another session's lead works despite an active filter", async () => {
    fakeDaemon();
    setArtifacts([art("a1", "Lead from agent one", { status: "draft" }), art("a2", "From agent two", { status: "draft", sessionId: "s2", createdAt: "2026-06-02T00:00:00.000Z" })]);
    render(<><PendingBanner /><ArtifactPanel /></>);
    fireEvent.change(menu(), { target: { value: "s2" } });
    expect(inSidebar("a1")).toBeNull();
    await userEvent.click(within(screen.getByRole("region", { name: "Waiting for you" })).getByTitle("Lead from agent one"));
    expect(useArtifactStore.getState().selectedArtifactId).toBe("a1");
    await waitFor(() => expect(document.querySelector('[data-artifact-id="a1"]')).not.toBeNull());
    expect(menu().value).toBe("s2");
    expect(inSidebar("a1")).toBeNull();
  });

  it("replay still hides later artifacts while the menu keeps its totals", () => {
    fakeDaemon();
    setArtifacts([art("a1", "Early"), art("a2", "Late", { sessionId: "s2", createdAt: "2026-06-03T00:00:00.000Z" })]);
    useReplayStore.setState({ active: true, cursor: "2026-06-02T00:00:00.000Z" });
    render(<ArtifactPanel />);
    expect(inSidebar("a1")).not.toBeNull();
    expect(inSidebar("a2")).toBeNull();
    expect(Array.from(menu().options).map((o) => o.textContent)).toEqual(["All (2)", "Agent 1 (1)", "Agent 2 (1)"]);
  });

  it("the n shortcut stays out of the menu", async () => {
    fakeDaemon();
    setArtifacts([art("a1", "One", { status: "draft" }), art("a2", "Two", { sessionId: "s2" })]);
    act(() => useArtifactStore.getState().selectArtifact(null));
    render(<App />);
    fireEvent.keyDown(await screen.findByTestId("agents-filter-menu"), { key: "n" });
    expect(useArtifactStore.getState().selectedArtifactId).toBeNull();
  });
});

describe("#430 slice 2 D2 — Why on a held terminal ask", () => {
  const Harness = () => (
    <>
      <DiagnosticsMenu onOpenLedger={() => {}} />
      <PendingBanner />
      <input aria-label="composer" />
      <button type="button">elsewhere</button>
    </>
  );
  const why = () => screen.queryByRole("button", { name: "Why this is held" });
  const diagnostics = () => screen.getByRole("button", { name: /diagnostics/i });
  const seedBlocks = (blocks: PreflightBlockRecord[], over: { loaded?: boolean } = {}) =>
    usePreflightBlockStore.setState({ blocks, ...over });
  const entry = (id: string) => document.getElementById(gateEntryDomId(id));
  const entryFocused = (id: string) => waitFor(() => expect(document.activeElement?.id).toBe(gateEntryDomId(id)));
  const copyOfLine = () => screen.getByTestId("pending-next").getAttribute("data-next-copy");
  const draft = () => art("d1", "Next draft", { status: "draft", createdAt: "2026-06-01T05:00:00.000Z" });

  it("appears only for a held terminal lead, outside the chip group, one Tab past the row", async () => {
    fakeDaemon();
    setArtifacts([art("d0", "Draft zero", { status: "draft" }), art("d1", "Draft one", { status: "draft" })]);
    seedBlocks([stance("plain", minute(1)), ask("denied", minute(2), { decision: "deny" })]);
    const { unmount } = render(<Harness />);
    expect(why()).toBeNull();
    unmount();

    setArtifacts([draft(), art("d2", "Another draft", { status: "draft", createdAt: "2026-06-01T05:01:00.000Z" })]);
    seedBlocks([ask("b1", minute(1))]);
    render(<Harness />);
    const button = why()!;
    expect(button).toHaveTextContent(/^Why$/);
    expect(button.closest(".overflow-x-auto")).toBeNull();
    // Not one of the chips, which sit together in their own group.
    expect(button.parentElement?.querySelector(".overflow-x-auto")?.textContent).toContain("Next draft");
    screen.getByRole("group", { name: /answer in the terminal/i }).focus();
    await userEvent.tab();
    expect(button).toHaveFocus();
  });

  it("opens at the entry, marks every held record seen, keeps the instruction, and sends no mutation", async () => {
    const daemon = fakeDaemon();
    setArtifacts([draft()]);
    seedBlocks([ask("newer", minute(5)), ask("older", minute(1))]);
    render(<Harness />);
    expect(copyOfLine()).toContain("HELD IN TERMINAL");
    why()!.focus();
    await userEvent.keyboard("{Enter}");
    await entryFocused("older");

    const state = usePreflightBlockStore.getState();
    expect(state.lastSeenAt).toBe(minute(5)); // log-wide, not just the lead
    expect(unreadBlockCount(state)).toBe(0);
    expect(state.blocks.every((b) => b.seenAt === undefined && b.allowance === undefined)).toBe(true);
    expect(why()).toBeNull();
    expect(copyOfLine()).not.toContain("HELD IN TERMINAL");
    expect(copyOfLine()).toContain("Next draft");
    // Durable history and the terminal instruction are still there.
    expect(entry("newer")).not.toBeNull();
    expect(within(entry("older")!).getByTestId("gate-hook-next")).toHaveTextContent(/Allow it there/);
    expect(daemon.mutations()).toEqual([]);
  });

  it("a hold arriving after the log opened isn't acknowledged until Why is used on it", async () => {
    const daemon = fakeDaemon();
    setArtifacts([draft()]);
    seedBlocks([ask("first", minute(1))]);
    render(<Harness />);
    await userEvent.click(why()!);
    await entryFocused("first");

    act(() => usePreflightBlockStore.getState().pushBlock({
      serverId: "second", at: minute(9), source: "session", concept: "stance second", via: "concept", lane: "hook", decision: "ask", targetPath: "db/n.sql",
    }));
    expect(usePreflightBlockStore.getState().lastSeenAt).toBe(minute(1));
    expect(unreadBlockCount(usePreflightBlockStore.getState())).toBe(1);
    expect(why()).not.toBeNull();

    // The log is already open, so no opening moment marks it: this request does.
    why()!.focus();
    await userEvent.keyboard("{Enter}");
    await entryFocused("second");
    expect(usePreflightBlockStore.getState().lastSeenAt).toBe(minute(9));
    expect(why()).toBeNull();
    expect(daemon.mutations()).toEqual([]);
  });

  it.each([
    ["another session", ask("blk_other", minute(1), { sessionId: "s2" }), "blk_other"],
    ["a demo session, no server id", ask("blk:demo/1", minute(1), { sessionId: "demo_1", eligible: false, ineligibleReason: "demo_session" }), "blk:demo/1"],
    ["a server id that differs from the record id", ask("blk_client", minute(1), { serverId: "srv_1" }), "srv_1"],
  ])("resolves an entry from %s", async (_name, block, target) => {
    const daemon = fakeDaemon();
    setArtifacts([art("a1", "One"), art("d1", "Sample", { sessionId: "demo_1" })]);
    seedBlocks([block]);
    render(<Harness />);
    await userEvent.click(why()!);
    await entryFocused(target);
    expect(daemon.mutations()).toEqual([]);
  });

  it.each([
    ["replay", { active: true, exiting: false }],
    ["replay-exit recovery", { active: true, exiting: true }],
    ["the exiting flag alone", { active: false, exiting: true }],
  ])("is withheld during %s, and the held row stays", (_name, replay) => {
    fakeDaemon();
    useReplayStore.setState(replay);
    setArtifacts([draft()]);
    seedBlocks([ask("b1", minute(1))]);
    render(<Harness />);
    expect(why()).toBeNull();
    expect(copyOfLine()).toContain("HELD IN TERMINAL");
    expect(usePreflightBlockStore.getState().focusRequest).toBeNull();
    act(() => useReplayStore.setState({ active: false, exiting: false }));
    expect(why()).not.toBeNull();
  });

  it("reaches an entry past the initial list", async () => {
    fakeDaemon();
    setArtifacts([draft()]);
    seedBlocks([...Array.from({ length: 7 }, (_, i) => stance(`row${i}`, minute(20 - i))), ask("deep", minute(1))]);
    render(<Harness />);
    await userEvent.click(why()!);
    await entryFocused("deep");
    expect(screen.getAllByTestId("gate-block-entry")).toHaveLength(8);
  });

  it("opened before hydration, it waits: no early boundary, then the real entry past the initial list", async () => {
    let land: (rows: PreflightBlockRecord[]) => void = () => {};
    fakeDaemon(() => new Promise((resolve) => { land = resolve; }));
    setArtifacts([draft()]);
    seedBlocks([ask("live", minute(1))], { loaded: false });
    render(<Harness />);
    await userEvent.click(why()!);
    await screen.findByTestId("gate-block-log");
    expect(usePreflightBlockStore.getState().lastSeenAt).toBeNull();
    expect(why()).not.toBeNull();

    await act(async () => { land(Array.from({ length: 7 }, (_, i) => stance(`row${i}`, minute(30 - i)))); });
    await entryFocused("live");
    expect(usePreflightBlockStore.getState().lastSeenAt).toBe(minute(30));
    expect(why()).toBeNull();
  });

  it("closing before hydration cancels the request: it can't reopen later", async () => {
    let land: (rows: PreflightBlockRecord[]) => void = () => {};
    fakeDaemon(() => new Promise((resolve) => { land = resolve; }));
    setArtifacts([draft()]);
    seedBlocks([ask("live", minute(1))], { loaded: false });
    render(<Harness />);
    const button = why()!;
    await userEvent.click(button);
    await screen.findByTestId("gate-block-log");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("gate-block-log")).not.toBeInTheDocument();
    expect(button).toHaveFocus(); // still mounted, still a real control
    await act(async () => { land([]); });
    expect(usePreflightBlockStore.getState().focusRequest).toBeNull();
    expect(screen.queryByTestId("gate-block-log")).not.toBeInTheDocument();
    expect(usePreflightBlockStore.getState().lastSeenAt).toBeNull();
    expect(why()).toBe(button);
  });

  it("a missing target says so in the log and holds focus there; Esc then returns to ⋯", async () => {
    const daemon = fakeDaemon();
    seedBlocks([stance("present", minute(1))]);
    render(<Harness />);
    act(() => openGateLogEntry("gone"));
    const log = await screen.findByTestId("gate-block-log");
    await waitFor(() => expect(log).toHaveFocus());
    expect(screen.getByTestId("gate-entry-missing")).toHaveTextContent(/isn't in this log any more/);
    expect(entry("present")).not.toBeNull();
    await userEvent.keyboard("{Escape}");
    expect(diagnostics()).toHaveFocus();
    expect(daemon.mutations()).toEqual([]);
  });

  it("an empty log with a missing target doesn't claim no blocks ever fired", async () => {
    fakeDaemon();
    render(<Harness />);
    act(() => openGateLogEntry("gone"));
    await screen.findByTestId("gate-entry-missing");
    expect(screen.queryByText(/No blocks yet/)).not.toBeInTheDocument();
  });

  it("a target pruned by hydration falls back the same way", async () => {
    fakeDaemon(() => Array.from({ length: 25 }, (_, i) => stance(`row${i}`, minute(30 + i))));
    setArtifacts([draft()]);
    seedBlocks([ask("oldest", minute(1))], { loaded: false });
    render(<Harness />);
    await userEvent.click(why()!);
    await screen.findByTestId("gate-entry-missing");
    expect(screen.getByTestId("gate-block-log")).toHaveFocus();
    expect(entry("oldest")).toBeNull();
    expect(why()).toBeNull();
  });

  describe("Why unmounting without being pressed", () => {
    // Blocking, like the ask, and older, so it takes the lead (oldest first in the tier).
    const olderDecision = () => art("old", "Older sibling decision", {
      type: "decision", status: "draft", sessionId: "s2", createdAt: "2026-06-01T00:30:00.000Z",
      content: { context: "c", options: [], decisionId: "dec_old" },
    });
    const focusedWhy = (blocks: PreflightBlockRecord[], artifacts: unknown[]) => {
      fakeDaemon();
      setArtifacts(artifacts);
      seedBlocks(blocks);
      render(<Harness />);
      const button = why()!;
      button.focus();
      expect(button).toHaveFocus();
      return button;
    };

    it("an older draft taking the lead moves focus to the banner's first stop", () => {
      const button = focusedWhy([ask("b1", minute(1))], [draft()]);
      setArtifacts([draft(), olderDecision()]);
      expect(button.isConnected).toBe(false);
      expect(document.activeElement).toBe(within(screen.getByRole("region", { name: "Waiting for you" })).getByTitle("Older sibling decision"));
    });

    it("a grant writing seenAt with no drafts left moves focus to ⋯", () => {
      const button = focusedWhy([ask("b1", minute(1), { serverId: "b1" })], [art("a1", "Done")]);
      act(() => usePreflightBlockStore.getState().applyReceipt("b1", { id: "sx_1", state: "allowed" } as any, minute(2)));
      expect(button.isConnected).toBe(false);
      expect(screen.queryByRole("region", { name: "Waiting for you" })).not.toBeInTheDocument();
      expect(diagnostics()).toHaveFocus();
    });

    it("the cap pruning the ask moves focus to the banner's first stop", () => {
      const button = focusedWhy([ask("b1", minute(1))], [draft()]);
      act(() => usePreflightBlockStore.setState({ blocks: Array.from({ length: 25 }, (_, i) => stance(`row${i}`, minute(30 + i))) }));
      expect(button.isConnected).toBe(false);
      expect(document.activeElement).toBe(within(screen.getByRole("region", { name: "Waiting for you" })).getByTitle("Next draft"));
    });

    it("focus elsewhere is left alone", () => {
      const button = focusedWhy([ask("b1", minute(1))], [draft()]);
      const composer = screen.getByRole("textbox", { name: "composer" });
      composer.focus();
      setArtifacts([draft(), olderDecision()]);
      expect(button.isConnected).toBe(false);
      expect(composer).toHaveFocus();
    });
  });

  describe("focus return", () => {
    const openedAtEntry = async () => {
      fakeDaemon();
      setArtifacts([draft()]);
      seedBlocks([ask("b1", minute(1))]);
      const view = render(<Harness />);
      const button = why()!;
      await userEvent.click(button);
      await entryFocused("b1");
      expect(button.isConnected).toBe(false);
      return view;
    };

    it("Escape goes to ⋯, not a detached Why or body", async () => {
      await openedAtEntry();
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByTestId("gate-block-log")).not.toBeInTheDocument();
      expect(diagnostics()).toHaveFocus();
    });

    it("closing with the gate chip stays on the chip", async () => {
      await openedAtEntry();
      const chip = screen.getByRole("button", { name: /show recent gate blocks/i });
      await userEvent.click(chip);
      expect(screen.queryByTestId("gate-block-log")).not.toBeInTheDocument();
      expect(chip).toHaveFocus();
    });

    it("closing with ⋯ stays on ⋯", async () => {
      await openedAtEntry();
      await userEvent.click(diagnostics());
      expect(screen.queryByTestId("gate-block-log")).not.toBeInTheDocument();
      expect(diagnostics()).toHaveFocus();
    });

    it("a click outside keeps the clicked control", async () => {
      await openedAtEntry();
      const elsewhere = screen.getByRole("button", { name: "elsewhere" });
      await userEvent.click(elsewhere);
      expect(screen.queryByTestId("gate-block-log")).not.toBeInTheDocument();
      expect(elsewhere).toHaveFocus();
    });

    it("Escape with focus elsewhere closes the log and leaves focus alone", async () => {
      await openedAtEntry();
      const composer = screen.getByRole("textbox", { name: "composer" });
      composer.focus();
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByTestId("gate-block-log")).not.toBeInTheDocument();
      expect(composer).toHaveFocus();
    });
  });
});
