import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PendingBanner } from "../PendingBanner";
import { NextUpBar } from "../NextUpBar";
import { TurnIndicator } from "../TurnIndicator";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { usePreflightBlockStore } from "../../stores/preflightBlocks";
import { useReplayStore } from "../../stores/replay";

const art = (over: any) =>
  ({ id: "a", type: "research", title: "t", status: "draft", version: 1, createdAt: "2026-01-01T00:00:00.000Z", content: { summary: "s", findings: [] }, ...over }) as any;

beforeEach(() => {
  useArtifactStore.getState().reset();
});
// #430 slice 1 (Sol review) — store reset() resets data, not methods: a spy on
// `updateArtifactStatus` would otherwise carry an earlier test's call history
// into the next one. Restore every spy so each test sees a fresh method.
afterEach(() => {
  vi.restoreAllMocks();
});

describe("PendingBanner", () => {
  it("hides when nothing is waiting", () => {
    useArtifactStore.getState().addArtifact(art({ id: "a1", status: "approved" }));
    const { container } = render(<PendingBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("counts drafts of all reviewable types (incl. code_change, not just decision/plan)", () => {
    useArtifactStore.getState().addArtifact(art({ id: "cc", type: "code_change", title: "edit x", status: "draft", content: { filePath: "x", changeType: "modify", before: "a", after: "b", reasoning: "r" } }));
    // J2b (#212) — a single draft is auto-selected on arrival, which would step
    // the banner down. Deselect so this test still asserts the count rule (that
    // code_change is a counted reviewable type) rather than the step-down.
    useArtifactStore.getState().selectArtifact(null);
    render(<PendingBanner />);
    expect(screen.getByText(/1 item waiting for you/i)).toBeInTheDocument();
  });

  it("#192 (usability L8) — with 5 pending, shows a '+N more' affordance for the chips beyond the first 3", async () => {
    for (let i = 0; i < 5; i++) {
      useArtifactStore.getState().addArtifact(
        art({ id: `d${i}`, type: "decision", title: `draft ${i}`, status: "draft", content: { context: "x", options: [], decisionId: `dec${i}` } }),
      );
    }
    render(<PendingBanner />);
    expect(screen.getByText(/5 items waiting for you/i)).toBeInTheDocument();
    // The debrief/explainer created last must not silently fall off: a "+2 more"
    // affordance jumps to the first hidden draft.
    const more = screen.getByRole("button", { name: /2 more waiting/i });
    expect(more).toHaveTextContent("+2 more");
    await userEvent.click(more);
    expect(useArtifactStore.getState().selectedArtifactId).toBe("d3");
  });

  it("#192 — no '+N more' affordance when 3 or fewer are pending", () => {
    for (let i = 0; i < 3; i++) {
      useArtifactStore.getState().addArtifact(
        art({ id: `d${i}`, type: "decision", title: `draft ${i}`, status: "draft", content: { context: "x", options: [], decisionId: `dec${i}` } }),
      );
    }
    render(<PendingBanner />);
    expect(screen.queryByText(/more waiting/i)).not.toBeInTheDocument();
  });

  it("J2b (#212) — suppresses when the ONE pending draft is the card in view (auto-selected)", () => {
    // The probe's exact scenario: a session with a single pending artifact. It
    // is auto-selected on arrival, so the card itself is the CTA — the banner
    // would just restate it (plus the header count pill). It steps down.
    useArtifactStore.getState().addArtifact(art({ id: "only", type: "code_change", title: "edit x", status: "draft", content: { filePath: "x", changeType: "modify", before: "a", after: "b", reasoning: "r" } }));
    // sanity: the single draft is indeed the selected/in-view artifact
    expect(useArtifactStore.getState().selectedArtifactId).toBe("only");
    const { container } = render(<PendingBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("J2b — STILL shows (scent) when the single pending draft is NOT the one in view", () => {
    // An approved artifact is added first and auto-selected; the later draft is
    // pending but off-screen — the banner is the scent that lets you reach it.
    useArtifactStore.getState().addArtifact(art({ id: "seen", status: "approved" }));
    useArtifactStore.getState().addArtifact(art({ id: "draft1", type: "decision", title: "pick a cache", status: "draft", content: { context: "x", options: [], decisionId: "dec" } }));
    expect(useArtifactStore.getState().selectedArtifactId).toBe("seen"); // draft not in view
    render(<PendingBanner />);
    expect(screen.getByText(/1 item waiting for you/i)).toBeInTheDocument();
  });

  it("J2b — STILL shows for 2+ pending even when one of them is in view", () => {
    // The step-down is single-card only; with 2+ the chip strip is the only
    // per-item triage surface, so the banner stays.
    useArtifactStore.getState().addArtifact(art({ id: "d1", type: "decision", title: "a", status: "draft", content: { context: "x", options: [], decisionId: "dec1" } }));
    useArtifactStore.getState().addArtifact(art({ id: "d2", type: "decision", title: "b", status: "draft", content: { context: "x", options: [], decisionId: "dec2" } }));
    expect(useArtifactStore.getState().selectedArtifactId).toBe("d1"); // one is in view
    render(<PendingBanner />);
    expect(screen.getByText(/2 items waiting for you/i)).toBeInTheDocument();
  });

  it("J2b (#212, review LOW) — an armed 'Dismiss?' chip does NOT survive a suppress → reappear cycle", async () => {
    // The suppression is an in-component early return, so the instance never
    // unmounts. Without the disarm effect a chip left in the armed state would
    // reappear pre-armed, collapsing the two-step confirm to one click across a
    // hidden interval. Repro: arm → suppress (select the draft) → reappear
    // (deselect) → the chip must be DISARMED.
    useArtifactStore.getState().addArtifact(art({ id: "seen", status: "approved" }));
    useArtifactStore.getState().addArtifact(art({ id: "d1", type: "decision", title: "pick a cache", status: "draft", content: { context: "x", options: [], decisionId: "dec" } }));
    // "seen" is auto-selected first, so d1 (the single draft) is NOT in view →
    // the banner shows and its dismiss chip is armable.
    expect(useArtifactStore.getState().selectedArtifactId).toBe("seen");
    render(<PendingBanner />);

    // Arm the chip.
    await userEvent.click(screen.getByRole("button", { name: /^dismiss pick a cache$/i }));
    expect(screen.getByText("Dismiss?")).toBeInTheDocument();

    // Suppress: select the single draft → it is now the card in view.
    act(() => { useArtifactStore.getState().selectArtifact("d1"); });
    expect(screen.queryByText("Dismiss?")).not.toBeInTheDocument(); // banner hidden

    // Reappear: deselect back to the approved sibling.
    act(() => { useArtifactStore.getState().selectArtifact("seen"); });
    // The chip is DISARMED — back to the "✕" affordance, not "Dismiss?".
    expect(screen.getByRole("button", { name: /^dismiss pick a cache$/i })).toBeInTheDocument();
    expect(screen.queryByText("Dismiss?")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /confirm dismiss/i })).not.toBeInTheDocument();
  });

  it("UX5 — quick Dismiss is two-step: first click confirms, second marks obsolete", async () => {
    useArtifactStore.getState().addArtifact(art({ id: "d1", type: "decision", title: "pick a cache", status: "draft", content: { context: "x", options: [], decisionId: "dec" } }));
    // J2b (#212) — deselect so the single draft isn't stepped down (the banner's
    // dismiss chip is what this test exercises).
    useArtifactStore.getState().selectArtifact(null);
    const spy = vi.spyOn(useArtifactStore.getState(), "updateArtifactStatus").mockResolvedValue();
    render(<PendingBanner />);

    // first click only asks to confirm — the irreversible obsolete is NOT fired
    await userEvent.click(screen.getByRole("button", { name: /dismiss pick a cache/i }));
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByText("Dismiss?")).toBeInTheDocument();

    // second click commits
    await userEvent.click(screen.getByRole("button", { name: /confirm dismiss pick a cache/i }));
    expect(spy).toHaveBeenCalledWith("d1", "obsolete");
  });
});

/**
 * #430 slice 1 — the default view's needs-you line. The lead chip is the
 * attention model's `next` (most consequential first), with why / if-ignored /
 * after copy from lib/attentionCopy — the SAME copy the opt-in Next-up bar
 * shows. Counts, the 3-chip cap, "+N more" and the two-step dismiss stay.
 */
describe("#430 slice 1 — PendingBanner's lead line", () => {
  const BRIEF_CONTEXT = "Decide alone: naming\nWill ask: none\nRisk class: escalated\nWhy: touches the Stop hook\nReview: packet";
  const finding = art({ id: "f_old", type: "research", title: "Old finding", createdAt: "2026-01-01T00:00:00.000Z", content: { summary: "Cache misses 88%", findings: [] } });
  const brief = art({
    id: "brief", type: "spec", title: "Worker-stop notice", createdAt: "2026-01-02T00:00:00.000Z",
    content: { objective: "Tell the lead when a worker stops", requirements: [], context: BRIEF_CONTEXT, tasks: [{ title: "a" }, { title: "b" }, { title: "c" }] },
  });
  const BRIEF_LINE = "REVIEW Worker-stop notice · Risk: escalated · Approval required before this work proceeds · Approve → the brief's 3 tasks can proceed · Request changes → Claude revises the brief";

  beforeEach(() => {
    useConnectionStore.setState({
      connected: true, hydrated: true, sessionId: "s1", activeSessions: [{ sessionId: "s1", live: true }],
      staleDaemon: false, snapshotUnavailable: false, sessionConflict: false,
    } as any);
    usePreflightBlockStore.setState({ blocks: [], lastSeenAt: null } as any);
    useReplayStore.setState({ active: false } as any);
  });
  const seed = (...artifacts: any[]) => useArtifactStore.setState({ artifacts: artifacts.map((a) => ({ sessionId: "s1", ...a })), selectedArtifactId: null });

  it("the delegate brief is blocking: it leads over an OLDER finding, with risk and conditional 'Approve → … N tasks can proceed'", () => {
    seed(finding, brief);
    render(<PendingBanner />);
    const lead = screen.getByTestId("pending-next");
    expect(lead.getAttribute("data-next-copy")).toBe(BRIEF_LINE);
    expect(lead).toHaveTextContent("Risk: escalated");
    expect(lead).toHaveTextContent("Approval required before this work proceeds");
    expect(screen.getByTestId("pending-why")).toHaveTextContent("Why Tell the lead when a worker stops");
    // The lead CHIP is `next` too (first chip), and the count is unchanged.
    const chips = screen.getByRole("region", { name: "Waiting for you" }).querySelectorAll("button[title]");
    expect(chips[0]!.getAttribute("title")).toBe("Worker-stop notice");
    expect(screen.getByText(/2 items waiting for you/)).toBeInTheDocument();
  });

  it("a later decision outranks an older finding; the finding chip stays and its line says it is not blocking when alone", () => {
    const d = art({ id: "d1", type: "decision", title: "Pick a store", createdAt: "2026-01-03T00:00:00.000Z", content: { context: "Two stores fit", options: [], decisionId: "dec" } });
    seed(finding, d);
    const { unmount } = render(<PendingBanner />);
    expect(screen.getByTestId("pending-next").getAttribute("data-next-copy")).toMatch(/^DECIDE Pick a store · Your choice is needed before this work proceeds · Claude continues with the option you pick$/);
    expect(screen.getByRole("button", { name: /^dismiss old finding$/i })).toBeInTheDocument();
    unmount();
    seed(finding, art({ id: "other", status: "approved", title: "Done" }));
    render(<PendingBanner />);
    expect(screen.getByTestId("pending-if-ignored")).toHaveTextContent("Not blocking — Claude can keep working");
  });

  it("a demo item is tagged Demo; a live one is not; the count is unchanged", () => {
    seed(art({ id: "demo_d", sessionId: "demo_1", type: "research", title: "Scripted finding", content: { summary: "s", findings: [] } }), art({ id: "other", status: "approved", title: "Done" }));
    const { unmount } = render(<PendingBanner />);
    expect(within(screen.getByTestId("pending-next")).getByTestId("demo-tag")).toHaveTextContent("Demo");
    expect(screen.getByText(/1 item waiting for you/)).toBeInTheDocument();
    unmount();
    seed(finding, art({ id: "other", status: "approved", title: "Done" }));
    render(<PendingBanner />);
    expect(screen.queryByTestId("demo-tag")).not.toBeInTheDocument();
  });

  it("no pulse — on the banner or on TurnIndicator's 'Your turn' pill", () => {
    seed(finding, brief);
    const { container } = render(<><PendingBanner /><TurnIndicator /></>);
    expect(container.querySelector(".animate-pulse")).toBeNull();
    expect(screen.getByRole("button", { name: /Your turn/ })).toBeInTheDocument();
  });

  it("PendingBanner (bar OFF) and the Next-up bar (bar ON) render the SAME copy for the same item", () => {
    seed(finding, brief);
    const { unmount } = render(<PendingBanner />);
    const banner = screen.getByTestId("pending-next").getAttribute("data-next-copy");
    const bannerAfter = screen.getByTestId("pending-after").textContent;
    unmount();
    render(<NextUpBar />);
    const bar = screen.getByTestId("next-up-bar");
    expect(bar.getAttribute("data-next-copy")).toBe(banner);
    expect(banner).toBe(BRIEF_LINE);
    expect(screen.getByTestId("next-up-if-ignored")).toHaveTextContent("Approval required before this work proceeds");
    expect(screen.getByTestId("next-up-risk")).toHaveTextContent("Risk: escalated");
    expect(within(bar).getByText(bannerAfter!)).toBeInTheDocument();
  });

  it("reach governs the copy: exited / replay never promise the build", () => {
    seed(finding, brief);
    useConnectionStore.setState({ activeSessions: [{ sessionId: "s1", live: false }] } as any);
    const { unmount } = render(<PendingBanner />);
    expect(screen.getByTestId("pending-next").getAttribute("data-next-copy")).not.toContain("can proceed");
    expect(screen.getByTestId("pending-if-ignored")).toHaveTextContent("Claude has exited — this waits for the session to resume");
    unmount();
    useReplayStore.setState({ active: true } as any);
    render(<PendingBanner />);
    expect(screen.getByTestId("pending-after")).toHaveTextContent("Replay is read-only");
  });

  it("a terminal-held hook `ask` is blocking: it leads over an older finding, says answer in the terminal, has no chip; the count is drafts only", () => {
    seed(finding, art({ id: "other", status: "approved", title: "Done" }));
    usePreflightBlockStore.setState({ blocks: [{ id: "b1", at: "2026-01-05T00:00:00.000Z", source: "session", concept: "migrations", via: "concept", lane: "hook", decision: "ask", targetPath: "db/m.sql" }], lastSeenAt: null } as any);
    render(<PendingBanner />);
    const lead = screen.getByTestId("pending-next");
    expect(lead.getAttribute("data-next-copy")).toBe('HELD IN TERMINAL "migrations": Claude Code asked about db/m.sql · Claude Code asked in the terminal — answer it there; nothing here releases it · Answer in the terminal — approving here does not release it');
    expect(screen.getByText(/1 item waiting for you/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /migrations/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^dismiss old finding$/i })).toBeInTheDocument();
  });

  const terminalAsk = { id: "b1", at: "2026-01-05T00:00:00.000Z", source: "session", concept: "migrations", via: "concept", lane: "hook", decision: "ask", targetPath: "db/m.sql" };
  const HELD_LINE = 'HELD IN TERMINAL "migrations": Claude Code asked about db/m.sql · Claude Code asked in the terminal — answer it there; nothing here releases it · Answer in the terminal — approving here does not release it';

  it("a terminal-held lead shows with ZERO draft cards (no count, no chips)", () => {
    seed(art({ id: "other", status: "approved", title: "Done" }));
    usePreflightBlockStore.setState({ blocks: [terminalAsk], lastSeenAt: null } as any);
    render(<PendingBanner />);
    expect(screen.getByRole("region", { name: "Waiting for you" })).toBeInTheDocument();
    expect(screen.getByTestId("pending-next").getAttribute("data-next-copy")).toBe(HELD_LINE);
    expect(screen.queryByText(/waiting for you/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /dismiss/i })).not.toBeInTheDocument();
  });

  it("a terminal-held lead is not suppressed by a selected sole draft (artifact-only step-down)", () => {
    seed(finding);
    act(() => { useArtifactStore.getState().selectArtifact("f_old"); });
    usePreflightBlockStore.setState({ blocks: [terminalAsk], lastSeenAt: null } as any);
    const { rerender } = render(<PendingBanner />);
    expect(screen.getByTestId("pending-next").getAttribute("data-next-copy")).toBe(HELD_LINE);
    expect(screen.getByText(/1 item waiting for you/)).toBeInTheDocument();
    // Without the hold, the ordinary J2b step-down still applies.
    act(() => usePreflightBlockStore.setState({ blocks: [], lastSeenAt: null } as any));
    rerender(<PendingBanner />);
    expect(screen.queryByRole("region", { name: "Waiting for you" })).not.toBeInTheDocument();
  });

  it("keyboard: the lead chip opens with Enter; dismiss is two-step by keyboard and focus stays on the chip", async () => {
    seed(finding, brief);
    const spy = vi.spyOn(useArtifactStore.getState(), "updateArtifactStatus").mockResolvedValue();
    render(<PendingBanner />);
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toHaveAttribute("title", "Worker-stop notice");
    await user.keyboard("{Enter}");
    expect(useArtifactStore.getState().selectedArtifactId).toBe("brief");
    act(() => { useArtifactStore.getState().selectArtifact(null); });
    const dismiss = screen.getByRole("button", { name: /^dismiss worker-stop notice$/i });
    dismiss.focus();
    await user.keyboard("{Enter}");
    expect(spy).not.toHaveBeenCalled();
    const confirm = screen.getByRole("button", { name: /^confirm dismiss worker-stop notice$/i });
    expect(document.activeElement).toBe(confirm);
    await user.keyboard("{Enter}");
    expect(spy).toHaveBeenCalledWith("brief", "obsolete");
  });
});

