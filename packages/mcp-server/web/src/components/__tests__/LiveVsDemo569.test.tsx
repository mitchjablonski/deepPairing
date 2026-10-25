import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import App from "../../App";
import { ArtifactPanel } from "../ArtifactPanel";
import { SessionBrowser } from "../SessionBrowser";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { usePreferencesStore } from "../../stores/preferences";
import { usePreflightBlockStore } from "../../stores/preflightBlocks";
import { useHookStatusStore } from "../../stores/hookStatus";
import { useReplayStore } from "../../stores/replay";
import { useToastStore } from "../../stores/toast";
import { classifyProvenance, projectNameFromRoot } from "../../lib/provenance";

/**
 * #569 proposal 1 — real work must be visually unmistakable from demo or
 * sample content. Pilot input: Mitch approved a real brief and a day later
 * asked "the demo example?" — real cards looked identical to demo cards.
 *
 * Signal (existing, no new schema field): `isDemoSessionId` — the `demo_`
 * prefix only POST /api/demo/run mints, plus the repo's checked-in sample ids
 * (the same rule Threads' `fixtureLike` uses) — and the artifact store's
 * `sampleContent` flag for the client-side "try the demo session" fixture.
 * Legacy sessions carry no metadata and default to LIVE.
 *
 * Labelling only: no gate, attention or count may change.
 */
let t = 0;
const at = () => `2026-10-24T00:${String(t++).padStart(2, "0")}:00.000Z`;
const art = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id, sessionId: "s1", type: "research", version: 1, parentId: null, title, status: "approved",
  content: { summary: "s", findings: [] }, agentReasoning: null, createdAt: at(), updatedAt: at(), ...over,
}) as any;

const jsonResponse = (body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
const stubFetch = (sessions: unknown[] = []) =>
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => jsonResponse({ sessions })));

const setConn = (over: Record<string, unknown> = {}) =>
  useConnectionStore.setState({
    connected: true, hydrated: true, sessionId: "s1", projectRoot: null,
    activeSessions: [{ sessionId: "s1", live: true, artifactCount: 1 }],
    staleDaemon: false, snapshotUnavailable: false, sessionConflict: false, agentActivityAt: null, agentActiveSince: null,
    ...over,
  } as any);

beforeEach(() => {
  t = 0;
  useArtifactStore.getState().reset();
  usePreflightBlockStore.setState({ blocks: [], lastSeenAt: null } as any);
  useHookStatusStore.setState({ fires: [] } as any);
  useReplayStore.setState({ active: false, sessionId: null } as any);
  useToastStore.getState().dismissAll();
  setConn();
  usePreferencesStore.setState({ nextUpBar: false, sidebarCollapsed: false } as any);
  stubFetch();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const sessionNav = () => screen.getByRole("navigation", { name: "Sessions" });

describe("#569 P1 — classification", () => {
  it("demo_ and checked-in sample ids are demo; anything else is live; the fixture flag is sample", () => {
    expect(classifyProvenance({ sessionId: "demo_1729" })?.kind).toBe("demo");
    expect(classifyProvenance({ sessionId: "b-demo" })?.kind).toBe("demo");
    expect(classifyProvenance({ sessionId: "sess_abc", projectName: "app" })).toEqual({ kind: "live", projectName: "app", history: false });
    expect(classifyProvenance({ sessionId: "sess_1", sampleContent: true, sampleSessionIds: ["sess_1"] })?.kind).toBe("sample");
    expect(classifyProvenance({ sessionId: null, sampleContent: true })?.kind).toBe("sample"); // offline preview
    expect(classifyProvenance({ sessionId: "s1", sampleContent: true, sampleSessionIds: ["sess_1"] })?.kind).toBe("live"); // id wins
    expect(classifyProvenance({ sessionId: null })).toBeNull();
  });

  it("derives the project name from a POSIX or Windows root without any git call", () => {
    expect(projectNameFromRoot("/home/u/work/my-app")).toBe("my-app");
    expect(projectNameFromRoot("C:\\Users\\u\\my-app\\")).toBe("my-app");
    expect(projectNameFromRoot(null)).toBeNull();
  });
});

describe("#569 P1 — a live session shows the live marker", () => {
  it("session bar carries '● Live · <project>'; no demo banner, tag or border", () => {
    setConn({
      projectRoot: "/home/u/work/my-app",
      activeSessions: [{ sessionId: "s1", live: true, artifactCount: 1, project: "my-app" }],
    });
    useArtifactStore.setState({ artifacts: [art("a1", "Real brief")] } as any);
    render(<App />);
    const chip = within(sessionNav()).getByTestId("provenance-live");
    expect(chip).toHaveTextContent("Live");
    expect(chip).toHaveTextContent("my-app");
    expect(screen.queryByTestId("demo-banner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("demo-tag")).not.toBeInTheDocument();
    expect(screen.queryByTestId("provenance-demo")).not.toBeInTheDocument();
    expect(screen.getByTestId("artifact-panel")).toHaveAttribute("data-provenance", "live");
  });

  it("a live SPEC (brief) carries its own '● Live · <project>' chip in the artifact panel header", () => {
    setConn({
      projectRoot: "/home/u/work/my-app",
      activeSessions: [{ sessionId: "s1", live: true, artifactCount: 1, project: "my-app" }],
    });
    useArtifactStore.setState({
      artifacts: [art("brief", "Worker-stop signal brief", {
        type: "spec", status: "draft",
        content: { objective: "o", requirements: [{ id: "REQ-1", text: "r", rationale: "why", acceptanceCriteria: ["a"] }], tasks: [] },
      })],
      selectedArtifactId: "brief",
    } as any);
    render(<ArtifactPanel />);
    const detail = document.querySelector('[data-artifact-id="brief"]') as HTMLElement;
    const chip = within(detail).getByTestId("provenance-live");
    expect(chip).toHaveTextContent("Live");
    expect(chip).toHaveTextContent("my-app");
    expect(within(detail).queryByTestId("provenance-demo")).not.toBeInTheDocument();
  });

  it("a demo card's header says Demo, not Live", () => {
    setConn({ sessionId: "demo_1", activeSessions: [{ sessionId: "demo_1", live: true, artifactCount: 1 }] });
    useArtifactStore.setState({ artifacts: [art("d", "Scripted", { sessionId: "demo_1" })], selectedArtifactId: "d" } as any);
    render(<ArtifactPanel />);
    const detail = document.querySelector('[data-artifact-id="d"]') as HTMLElement;
    expect(within(detail).getByTestId("provenance-demo")).toHaveTextContent("Demo");
    expect(within(detail).queryByTestId("provenance-live")).not.toBeInTheDocument();
  });

  it("a LEGACY session with no metadata (plain id, no project) defaults to live", () => {
    setConn({ sessionId: "sess_legacy", activeSessions: [{ sessionId: "sess_legacy", artifactCount: 1 }] });
    useArtifactStore.setState({ artifacts: [art("a1", "Old work", { sessionId: "sess_legacy" })] } as any);
    render(<App />);
    expect(within(sessionNav()).getByTestId("provenance-live")).toHaveTextContent("Live");
    expect(screen.queryByTestId("demo-banner")).not.toBeInTheDocument();
  });
});

describe("#569 P1 — a demo session shows the demo treatment everywhere it appears", () => {
  it("session bar tab + chip, and the artifact panel banner (a named region) + border", () => {
    setConn({ sessionId: "demo_1", activeSessions: [{ sessionId: "demo_1", live: true, artifactCount: 1 }] });
    useArtifactStore.setState({ artifacts: [art("a1", "Scripted card", { sessionId: "demo_1" })] } as any);
    render(<App />);
    const nav = sessionNav();
    expect(within(nav).getByTestId("demo-tag")).toHaveTextContent("Demo");
    expect(within(nav).getByTestId("provenance-demo")).toHaveTextContent("Demo");
    expect(within(nav).queryByTestId("provenance-live")).not.toBeInTheDocument();

    const banner = screen.getByRole("region", { name: "Demo content" });
    expect(banner).toHaveTextContent("Demo — sample content, not your project.");
    const panel = screen.getByTestId("artifact-panel");
    expect(panel).toHaveAttribute("data-provenance", "demo");
    expect(panel.contains(banner)).toBe(true);
    expect(panel.className).toContain("border-dashed");
  });

  it("a merged panel labels by the SELECTED artifact's session (demo beside real work)", () => {
    useArtifactStore.setState({
      artifacts: [art("real", "Real brief"), art("demo", "Demo card", { sessionId: "demo_9" })],
      selectedArtifactId: "demo",
    } as any);
    render(<ArtifactPanel />);
    expect(screen.getByTestId("demo-banner")).toBeInTheDocument();
    // The Agents row names the demo session in text.
    expect(within(screen.getByText("Agents:").parentElement!).getByTestId("demo-tag")).toBeInTheDocument();

    act(() => { useArtifactStore.getState().selectArtifact("real"); });
    expect(screen.queryByTestId("demo-banner")).not.toBeInTheDocument();
    expect(screen.getByTestId("artifact-panel")).toHaveAttribute("data-provenance", "live");
  });

  it("past-sessions list tags the demo session by name and leaves real ones untagged", async () => {
    stubFetch([
      { id: "demo_1", createdAt: at(), lastActivity: at(), summary: "Demo run", artifactCount: 4, hasDecisions: true },
      { id: "sess_real", createdAt: at(), lastActivity: at(), summary: "My real work", artifactCount: 2, hasDecisions: false },
    ]);
    render(<SessionBrowser />);
    const demoRow = (await screen.findByText("Demo run")).closest("button")!;
    const realRow = screen.getByText("My real work").closest("button")!;
    expect(within(demoRow).getByTestId("demo-tag")).toHaveTextContent("Demo");
    expect(within(realRow).queryByTestId("demo-tag")).not.toBeInTheDocument();
  });

  it("the client-side 'try the demo session' fixture is labelled sample; reset() drops the label", async () => {
    setConn({ connected: false, sessionId: null, activeSessions: [] });
    const { unmount } = render(<SessionBrowser />);
    fireEvent.click(await screen.findByRole("button", { name: "Or try the demo session" }));
    expect(useArtifactStore.getState().sampleContent).toBe(true);
    unmount();

    render(<ArtifactPanel />);
    const banner = screen.getByRole("region", { name: "Demo content" });
    expect(banner).toHaveAttribute("data-provenance", "sample");
    expect(banner).toHaveTextContent("not your project");

    act(() => { useArtifactStore.getState().reset(); });
    expect(useArtifactStore.getState().sampleContent).toBe(false);
  });

  it("session id wins: a real-session artifact arriving after the sample loads is labelled live", async () => {
    setConn({ connected: false, sessionId: null, activeSessions: [] });
    const { unmount } = render(<SessionBrowser />);
    fireEvent.click(await screen.findByRole("button", { name: "Or try the demo session" }));
    unmount();
    expect(classifyProvenance({ sessionId: "sess_real", sampleContent: true, sampleSessionIds: ["sess_1"] })?.kind).toBe("live");

    act(() => {
      useArtifactStore.getState().addArtifact(art("real_brief", "Real brief", { sessionId: "sess_real" }));
      useArtifactStore.getState().selectArtifact("real_brief");
    });
    expect(useArtifactStore.getState().sampleContent).toBe(false);
    render(<ArtifactPanel />);
    const detail = document.querySelector('[data-artifact-id="real_brief"]') as HTMLElement;
    expect(within(detail).getByTestId("provenance-live")).toHaveTextContent("Live");
    expect(screen.queryByTestId("demo-banner")).not.toBeInTheDocument();
  });

  it("a real session becoming active clears the sample flag", async () => {
    setConn({ connected: false, sessionId: null, activeSessions: [] });
    const { unmount } = render(<SessionBrowser />);
    fireEvent.click(await screen.findByRole("button", { name: "Or try the demo session" }));
    unmount();
    expect(useArtifactStore.getState().sampleContent).toBe(true);
    act(() => { useConnectionStore.setState({ sessionId: "sess_real" } as any); });
    expect(useArtifactStore.getState().sampleContent).toBe(false);
  });
});

describe("#569 P1 — labelling only: no attention or count change", () => {
  it("the same pending plan yields the same Next-up line and tab title in a real and a demo session", async () => {
    usePreferencesStore.setState({ nextUpBar: true } as any);
    const plan = (sid: string) =>
      art("p1", "Review the plan", { sessionId: sid, type: "plan", status: "draft", content: { steps: [] } });

    setConn({ sessionId: "s1", activeSessions: [{ sessionId: "s1", live: true, artifactCount: 1 }] });
    useArtifactStore.setState({ artifacts: [plan("s1")] } as any);
    const real = render(<App />);
    const realLine = screen.getByTestId("next-up-bar").getAttribute("data-line");
    await waitFor(() => expect(document.title).toBe("(1) Your turn — deepPairing"));
    const realTitle = document.title;
    real.unmount();

    useArtifactStore.getState().reset();
    setConn({ sessionId: "demo_1", activeSessions: [{ sessionId: "demo_1", live: true, artifactCount: 1 }] });
    useArtifactStore.setState({ artifacts: [plan("demo_1")] } as any);
    render(<App />);
    expect(screen.getByTestId("next-up-bar").getAttribute("data-line")).toMatch(/^● Review the plan/);
    expect(realLine).toMatch(/^● Review the plan/);
    await waitFor(() => expect(document.title).toBe(realTitle));
  });
});
