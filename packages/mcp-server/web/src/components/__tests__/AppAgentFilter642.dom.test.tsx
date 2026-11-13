import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Artifact } from "@deeppairing/shared";
import App from "../../App";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { useReplayStore } from "../../stores/replay";
import { usePreferencesStore } from "../../stores/preferences";
import { useSiblingSyncStore } from "../../lib/siblingSync";
import { usePreflightBlockStore } from "../../stores/preflightBlocks";

const art = (id: string, sessionId = "A", over: Partial<Artifact> = {}): Artifact => ({
  id, sessionId, title: "Duplicate title", type: "research", status: "draft", version: 1, parentId: null,
  content: { summary: id, findings: [] }, agentReasoning: null,
  createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z", ...over,
} as Artifact);
const menu = () => screen.getByTestId("agents-filter-menu") as HTMLSelectElement;
const choose = (owner: string) => fireEvent.change(menu(), { target: { value: owner } });
const selected = () => useArtifactStore.getState().selectedArtifactId;
const pane = (id: string) => document.querySelector('[data-artifact-id="' + id + '"]');
const seed = (artifacts = [art("a1"), art("a2"), art("b1", "B")]) => {
  useArtifactStore.setState({ artifacts, selectedArtifactId: "b1" });
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ sessions: [], blocks: [] }),
    { status: 200, headers: { "Content-Type": "application/json" } })));
  useArtifactStore.getState().reset();
  useArtifactStore.setState({ agentFilter: "all", filterBinding: null, navigationEpoch: 0, exactNavigationId: null });
  useReplayStore.setState({ active: false, exiting: false, cursor: "" });
  usePreferencesStore.setState({ sidebarCollapsed: false, nextUpBar: false });
  useSiblingSyncStore.setState({ settled: true });
  usePreflightBlockStore.setState({ blocks: [], lastSeenAt: null, loaded: true });
  useConnectionStore.setState({ connected: true, hydrated: true, hydratedBinding: "bound@/project", sessionId: "bound",
    projectRoot: "/project", activeSessions: [{ sessionId: "bound", live: true, artifactCount: 3 }] } as any);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("#642 mounted App filter-following navigation", () => {
  it("chooses the first canonical pending by owner identity and partitions global pending counts", async () => {
    seed([art("a-find"), art("b1", "B"), art("a-decision", "A", { type: "decision", content: { context: "choose", options: [] } as any })]);
    render(<App />);
    choose("A");
    expect(selected()).toBe("a-decision");
    expect(menu().value).toBe("A");
    expect(screen.getByTestId("agent-filter-scope")).toHaveTextContent("2 pending here · 1 in other agents");
    expect(screen.getByTestId("pending-banner")).toHaveTextContent("3 items waiting for you");
    await waitFor(() => expect(pane("a-decision")).not.toBeNull());
    expect(pane("b1")).toBeNull();
  });

  it("n/N use the fresh scoped queue after arrivals, resolution, removal and nonpending selection", () => {
    seed(); render(<App />); choose("A");
    fireEvent.keyDown(document, { key: "n" }); expect(selected()).toBe("a2");
    act(() => useArtifactStore.getState().addArtifact(art("a0", "A", { type: "decision", content: { context: "choose", options: [] } as any })));
    expect(selected()).toBe("a2");
    fireEvent.keyDown(document, { key: "n" }); expect(selected()).toBe("a0");
    act(() => useArtifactStore.getState().updateArtifact("a0", "approved"));
    fireEvent.keyDown(document, { key: "N" }); expect(selected()).toBe("a2");
    act(() => useArtifactStore.setState({ artifacts: useArtifactStore.getState().artifacts.filter((a) => a.id !== "a2") }));
    fireEvent.keyDown(document, { key: "n" }); expect(selected()).toBe("a1");
    act(() => useArtifactStore.getState().updateArtifact("a1", "approved"));
    fireEvent.keyDown(document, { key: "n" }); expect(selected()).toBe("a1");
    expect(menu().value).toBe("A");
  });

  it("j/k retain visible insertion order and clamp, with native select and modifier suppression", () => {
    seed(); render(<App />); choose("A");
    fireEvent.keyDown(menu(), { key: "n" }); expect(selected()).toBe("a1");
    fireEvent.keyDown(document, { key: "j", ctrlKey: true }); expect(selected()).toBe("a1");
    fireEvent.keyDown(document, { key: "j" }); expect(selected()).toBe("a2");
    fireEvent.keyDown(document, { key: "j" }); expect(selected()).toBe("a2");
    fireEvent.keyDown(document, { key: "k" }); expect(selected()).toBe("a1");
  });

  it.each(["collapsed", "narrow"])("scoped navigation remains live in the %s App layout", (layout) => {
    if (layout === "collapsed") usePreferencesStore.setState({ sidebarCollapsed: true });
    if (layout === "narrow") vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: query === "(max-width: 900px)", media: query, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
    }));
    seed(); render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^Agent 1 \(/ }));
    expect(selected()).toBe("a1");
    fireEvent.keyDown(document, { key: "n" }); expect(selected()).toBe("a2");
    fireEvent.keyDown(document, { key: "j" }); expect(selected()).toBe("a2");
    fireEvent.keyDown(document, { key: "N" }); expect(selected()).toBe("a1");
  });

  it("Show all keeps a valid receipt rather than jumping to another agent's pending head", () => {
    seed([art("receipt", "A", { status: "approved" }), art("b1", "B")]);
    render(<App />); choose("A"); choose("all");
    expect(selected()).toBe("receipt");
  });

  it("keeps a valid scoped receipt when no pending remains, otherwise chooses the first visible fallback", () => {
    seed([art("receipt", "A", { status: "approved" }), art("b1", "B")]);
    render(<App />); choose("A"); expect(selected()).toBe("receipt");
    fireEvent.keyDown(document, { key: "n" }); expect(selected()).toBe("receipt");
    choose("A"); expect(selected()).toBe("receipt");
    expect(screen.getByTestId("agent-filter-scope")).toHaveTextContent("0 pending here · 1 in other agents");
  });

  it("retains unavailable choice across a same-session snapshot reset without showing another owner's detail", async () => {
    seed(); render(<App />); choose("A");
    act(() => { useArtifactStore.getState().reset(); useArtifactStore.setState({ artifacts: [art("b1", "B")], selectedArtifactId: "b1" }); });
    expect(menu().value).toBe("A");
    expect(screen.getByTestId("agent-filter-empty")).toBeInTheDocument();
    expect(pane("b1")).toBeNull();
    const recover = screen.getByRole("button", { name: "Show all agents" }); recover.focus();
    fireEvent.click(recover);
    expect(menu().value).toBe("all"); expect(selected()).toBe("b1");
    await waitFor(() => expect(pane("b1")).not.toBeNull());
    expect(document.activeElement).not.toBe(document.body);
  });

  it("resets only for an actual bound-session/project switch and retains root enrichment/catalog loss", () => {
    useConnectionStore.setState({ projectRoot: null }); seed(); render(<App />); choose("A");
    act(() => useConnectionStore.setState({ projectRoot: "/project", activeSessions: [] }));
    expect(menu().value).toBe("A");
    act(() => useConnectionStore.setState({ connected: false, hydrated: false }));
    act(() => useConnectionStore.setState({ connected: true, hydrated: true }));
    expect(menu().value).toBe("A");
    act(() => useConnectionStore.setState({ projectRoot: "/another" })); expect(menu().value).toBe("all");
    choose("A");
    act(() => useConnectionStore.setState({ sessionId: "different" })); expect(menu().value).toBe("all");
  });

  it("explicit global high token opens follow owner atomically, same-agent stays scoped, All stays All", () => {
    const extra = Array.from({ length: 5 }, (_, i) => art("p" + i, "A", { type: "plan", content: { steps: [] } as any }));
    seed([...extra, art("b-high", "B", { type: "decision", content: { context: "choose", stakes: "high", options: [] } as any })]);
    render(<App />); choose("A");
    const publications: { owner: string; id: string | null }[] = [];
    const stop = useArtifactStore.subscribe((s) => publications.push({ owner: s.agentFilter, id: s.selectedArtifactId }));
    fireEvent.click(screen.getByRole("button", { name: /1 high-stakes decision waiting/ })); stop();
    expect(publications).toEqual([{ owner: "B", id: "b-high" }]);
    expect(menu().value).toBe("B"); expect(selected()).toBe("b-high");
    expect(useConnectionStore.getState().sessionId).toBe("bound");
    act(() => window.dispatchEvent(new CustomEvent("dp:focus-artifact", { detail: { artifactId: "b-high" } })));
    expect(menu().value).toBe("B");
    choose("all");
    act(() => window.dispatchEvent(new CustomEvent("dp:focus-artifact", { detail: { artifactId: "b-high" } })));
    expect(menu().value).toBe("all"); expect(selected()).toBe("b-high");
  });

  it("replay navigation respects cutoff and scoped n/N, rejecting a future explicit open", () => {
    seed([art("a1"), art("a-future", "A", { createdAt: "2026-07-01T00:00:00.000Z" }), art("b1", "B")]);
    useReplayStore.setState({ active: true, cursor: "2026-06-02T00:00:00.000Z" });
    render(<App />); choose("A");
    fireEvent.keyDown(document, { key: "n" }); expect(selected()).toBe("a1");
    fireEvent.keyDown(document, { key: "j" }); expect(selected()).toBe("a1");
    act(() => window.dispatchEvent(new CustomEvent("dp:focus-artifact", { detail: { artifactId: "a-future" } })));
    expect(selected()).toBe("a1"); expect(menu().value).toBe("A");
    act(() => useReplayStore.setState({ active: false, cursor: "" }));
    fireEvent.keyDown(document, { key: "n" }); expect(selected()).toBe("a-future");
  });

  it("preserves scoped explicit superseded-version detail and clears exact intent on filter navigation", async () => {
    seed([art("a-old", "A", { status: "superseded" }), art("a-current", "A", { parentId: "a-old" }), art("b1", "B")]);
    render(<App />); choose("B");
    act(() => useArtifactStore.getState().openArtifactExact("a-old"));
    expect(menu().value).toBe("A"); expect(selected()).toBe("a-old");
    await waitFor(() => expect(pane("a-old")).not.toBeNull());
    choose("A"); expect(selected()).toBe("a-current"); expect(useArtifactStore.getState().exactNavigationId).toBeNull();
  });

  it.each(["filter", "selection", "binding", "replay"])("a delayed changeset verdict cannot hijack newer %s intent", async (intent) => {
    let finish!: () => void;
    const update = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const original = useArtifactStore.getState().updateArtifactStatus;
    const cs = art("a-cs", "A", { type: "changeset", content: { summary: "change", files: [{ path: "a.ts", changeType: "modified", hunks: [] }], reviewState: { "a.ts": "needs_changes" }, reviewReasons: { "a.ts": "fix" } } as any });
    seed([cs, art("a2"), art("b1", "B"), art("b2", "B")]);
    useArtifactStore.setState({ updateArtifactStatus: update });
    try {
      render(<App />); choose("A");
      fireEvent.click(await screen.findByTestId("send-back"));
      await waitFor(() => expect(update).toHaveBeenCalled());
      if (intent === "filter") choose("B");
      if (intent === "selection") act(() => window.dispatchEvent(new CustomEvent("dp:focus-artifact", { detail: { artifactId: "a2" } })));
      if (intent === "binding") act(() => useConnectionStore.setState({ sessionId: "different" }));
      if (intent === "replay") act(() => useReplayStore.setState({ active: true, cursor: "2026-06-02T00:00:00.000Z" }));
      const before = selected();
      await act(async () => { finish(); });
      expect(selected()).toBe(before);
    } finally { useArtifactStore.setState({ updateArtifactStatus: original }); }
  });
});
