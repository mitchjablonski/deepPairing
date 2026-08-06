import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PendingBanner } from "../PendingBanner";
import { useArtifactStore } from "../../stores/artifact";

const art = (over: any) =>
  ({ id: "a", type: "research", title: "t", status: "draft", version: 1, createdAt: "2026-01-01T00:00:00.000Z", content: { summary: "s", findings: [] }, ...over }) as any;

beforeEach(() => {
  useArtifactStore.getState().reset();
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
