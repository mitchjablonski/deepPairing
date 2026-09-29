import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import App from "../../App";
import { CommandPalette } from "../CommandPalette";
import { TurnIndicator } from "../TurnIndicator";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { usePreferencesStore } from "../../stores/preferences";
import { usePreflightBlockStore } from "../../stores/preflightBlocks";
import { useReplayStore } from "../../stores/replay";
import { resumePromptFor } from "../ResumeQuestionsBanner";

/**
 * #430 PR 3 (docs/design/attention-hierarchy.md §5, §7, §8 PR 3) — with the
 * Next-up bar ON it absorbs PendingBanner, ResumeQuestionsBanner and
 * TurnIndicator's "your turn"; OFF, everything is exactly as before. One polite
 * announcer per attention change. Nothing the absorbed surfaces carried is lost.
 */
let t = 0;
const at = () => `2026-06-01T00:${String(t++).padStart(2, "0")}:00.000Z`;
const art = (id: string, type: string, title: string, over: Record<string, unknown> = {}) => ({
  id, sessionId: "s1", type, version: 1, parentId: null, title, status: "draft",
  content: type === "research" ? { summary: "s", findings: [] } : {}, agentReasoning: null, createdAt: at(), updatedAt: at(), ...over,
}) as any;
const question = (id: string, artifactId: string) => ({
  id, sessionId: "s1", target: { artifactId }, parentCommentId: null, author: "human",
  content: `Question ${id}?`, acknowledged: false, createdAt: at(), intent: "question",
}) as any;

beforeEach(() => {
  t = 0;
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify({ sessions: [] }), { status: 200, headers: { "Content-Type": "application/json" } }))));
  useArtifactStore.getState().reset();
  usePreflightBlockStore.setState({ blocks: [], lastSeenAt: null } as any);
  useReplayStore.setState({ active: false } as any);
  useConnectionStore.setState({
    connected: true, hydrated: true, sessionId: "s1", activeSessions: [{ sessionId: "s1", live: true }],
    staleDaemon: false, snapshotUnavailable: false, sessionConflict: false, agentActivityAt: null,
  } as any);
  usePreferencesStore.setState({ nextUpBar: false });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const seedReviewQueue = () =>
  useArtifactStore.setState({ artifacts: [art("r1", "research", "First finding"), art("r2", "research", "Second finding"), art("r3", "research", "Third finding"), art("r4", "research", "Fourth finding")], selectedArtifactId: null });
const seedExitedWithQuestions = () => {
  useConnectionStore.setState({ activeSessions: [{ sessionId: "s1", live: false }] } as any);
  useArtifactStore.setState({
    artifacts: [art("a1", "research", "Done", { status: "approved" }), art("a2", "research", "Also done", { status: "approved" })],
    comments: { a2: [question("q1", "a2")], a1: [question("q2", "a1")] },
  });
};

describe("#430 PR 3 — setting OFF: exactly as before", () => {
  it("PendingBanner, TurnIndicator's 'your turn' and ResumeQuestionsBanner all render; no bar", () => {
    seedReviewQueue();
    const { unmount } = render(<App />);
    expect(screen.getByText(/4 items waiting for you/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Your turn —/ })).toBeInTheDocument();
    expect(screen.queryByTestId("next-up-bar")).not.toBeInTheDocument();
    unmount();
    useArtifactStore.getState().reset();
    seedExitedWithQuestions();
    render(<App />);
    expect(screen.getByText(/2 questions waiting for Claude/)).toBeInTheDocument();
  });
});

describe("#430 PR 3 — setting ON: absorbed, no duplicates", () => {
  beforeEach(() => usePreferencesStore.setState({ nextUpBar: true }));

  it("no PendingBanner, no 'your turn' pill; TurnIndicator keeps agent state only and is not a live region", () => {
    seedReviewQueue();
    render(<App />);
    expect(screen.getByTestId("next-up-bar")).toBeInTheDocument();
    expect(screen.queryByText(/items? waiting for you/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Your turn/ })).not.toBeInTheDocument();
  });

  it("TurnIndicator with agentStateOnly: no 'your turn' even with drafts pending, agent state shown, not a live region", () => {
    seedReviewQueue();
    useConnectionStore.setState({ connected: true } as any);
    render(<TurnIndicator agentStateOnly />);
    expect(screen.queryByText(/Your turn/)).not.toBeInTheDocument();
    const agentState = screen.getByText(/Up to date|Agent working|Connected — waiting/);
    expect(agentState.closest("[aria-live]")).toBeNull();
    expect(agentState.closest("[role='status']")).toBeNull();
  });

  it("no ResumeQuestionsBanner when the agent exited with questions open", () => {
    seedExitedWithQuestions();
    render(<App />);
    expect(screen.queryByText(/questions waiting for Claude/)).not.toBeInTheDocument();
    expect(screen.getByTestId("next-up-bar").getAttribute("data-line")).toBe("◌ WAITING ON CLAUDE");
  });

  const liveTexts = () =>
    Array.from(document.querySelectorAll('[aria-live="polite"], [role="status"]')).map((el) => el.textContent?.trim() ?? "");

  it("ONE announcement for one attention change: the bar speaks; the arrival region and TurnIndicator do not", async () => {
    useArtifactStore.setState({ artifacts: [art("old", "research", "Old", { status: "approved" })] });
    render(<App />);
    // Let the arrival tracker settle past its hydration window (750ms).
    await act(async () => { await new Promise((r) => setTimeout(r, 900)); });
    const before = liveTexts();
    act(() => useArtifactStore.getState().addArtifact(art("new", "research", "Fresh finding")));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const after = liveTexts();
    // Every NEW non-empty announcement anywhere on the page.
    const changed = after.filter((text) => text && !before.includes(text));
    expect(changed).toEqual(["Next up: review — Fresh finding"]);
    expect(screen.getByTestId("arrival-live-region").textContent).toBe("");
  });

  it("OFF, the same arrival is still announced by the arrival region (unchanged)", async () => {
    usePreferencesStore.setState({ nextUpBar: false });
    useArtifactStore.setState({ artifacts: [art("old", "research", "Old", { status: "approved" })] });
    render(<App />);
    await act(async () => { await new Promise((r) => setTimeout(r, 900)); });
    act(() => useArtifactStore.getState().addArtifact(art("new", "research", "Fresh finding")));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(screen.getByTestId("arrival-live-region").textContent).toBe("New artifact: Fresh finding");
  });
});

describe("#430 PR 3 — palette commands", () => {
  it("'Next pending' walks the Decide queue oldest-first and wraps — with the bar OFF too", () => {
    seedReviewQueue();
    const { unmount } = render(<CommandPalette onClose={() => {}} />);
    expect(screen.queryByText(/Open review queue/)).not.toBeInTheDocument(); // bar off → not offered
    fireEvent.click(screen.getByText(/Next pending \(4 waiting on you, oldest first\)/));
    expect(useArtifactStore.getState().selectedArtifactId).toBe("r1");
    unmount();
    useArtifactStore.setState({ selectedArtifactId: "r4" });
    render(<CommandPalette onClose={() => {}} />);
    fireEvent.click(screen.getByText(/Next pending/));
    expect(useArtifactStore.getState().selectedArtifactId).toBe("r1");
  });

  it("'Open review queue' (bar ON only) expands the bar and focuses it", () => {
    usePreferencesStore.setState({ nextUpBar: true });
    seedReviewQueue();
    render(<App />);
    render(<CommandPalette onClose={() => {}} />);
    fireEvent.click(screen.getByText("Open review queue (Next-up bar)"));
    expect(screen.getByRole("button", { name: "Collapse next-up details" }).getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(screen.getByTestId("next-up-bar"));
  });
});

describe("#430 PR 3 — nothing lost: each absorbed piece is reachable from the bar", () => {
  beforeEach(() => usePreferencesStore.setState({ nextUpBar: true }));

  it("PendingBanner: count → 'Decide N'; jump chips and '+N more' → the expanded queue; dismiss → Open → the review footer", () => {
    seedReviewQueue();
    render(<App />);
    const bar = within(screen.getByTestId("next-up-bar"));
    expect(bar.getByText("Decide 4")).toBeInTheDocument(); // the count
    fireEvent.click(bar.getByRole("button", { name: "Expand next-up details" }));
    for (const title of ["First finding", "Second finding", "Third finding", "Fourth finding"]) {
      expect(bar.getByRole("button", { name: title })).toBeInTheDocument(); // chips + "+N more", complete
    }
    fireEvent.click(bar.getByRole("button", { name: "Third finding" }));
    expect(useArtifactStore.getState().selectedArtifactId).toBe("r3"); // per-item jump
    fireEvent.click(bar.getByRole("button", { name: "Open" }));
    expect(useArtifactStore.getState().selectedArtifactId).toBe("r1");
    // The chip's ✕ (dismiss → obsolete) lives on in the review footer the bar routes to.
    const compact = screen.queryByRole("button", { name: /Respond \/ Request changes \/ Reject/ });
    if (compact) fireEvent.click(compact);
    expect(screen.getByText("Dismiss — overcome by new information")).toBeInTheDocument();
  });

  it("TurnIndicator 'your turn': next item + Open (the pill's jump) and the Decide count", () => {
    seedReviewQueue();
    render(<App />);
    expect(screen.getByTestId("next-up-bar").getAttribute("data-line")).toBe("● First finding · Decide 4");
  });

  it("ResumeQuestionsBanner: count, exited-agent wording, jump to the oldest question, and Copy resume prompt", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    seedExitedWithQuestions();
    render(<App />);
    const bar = within(screen.getByTestId("next-up-bar"));
    expect(bar.getByText(/Exited with 2 of your questions open/)).toBeInTheDocument(); // count
    expect(bar.getByText(/answered when the session resumes/)).toBeInTheDocument(); // exited wording
    expect(screen.getByText(/Agent exited — resume to continue/)).toBeInTheDocument(); // header agent state stays
    fireEvent.click(bar.getByRole("button", { name: "Open" }));
    expect(useArtifactStore.getState().selectedArtifactId).toBe("a2"); // oldest question (q1 on a2)
    await act(async () => { fireEvent.click(bar.getByRole("button", { name: /Copy resume prompt/ })); });
    expect(writeText).toHaveBeenCalledWith(resumePromptFor(2));
  });
});
