import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import App from "../../App";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { WAITING_TONE } from "../../lib/waitingTone";

/**
 * #430 PR 1c (design §5, §2.7 item 2) — ONE unanswered-question count: the
 * Comment-threads button's. The header pill's duplicate ❓ badge is gone; the
 * button keeps the old badge's jump by opening the rail on its Unanswered
 * filter, and it survives the pill returning null (e.g. disconnected).
 */
const art = (id: string) => ({
  id, sessionId: "s1", type: "research", version: 1, parentId: null, title: id, status: "approved",
  content: {}, agentReasoning: null, createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
}) as any;
const question = (id: string, over: Record<string, unknown> = {}) => ({
  id, sessionId: "s1", target: { artifactId: "a1" }, parentCommentId: null, author: "human",
  content: `q ${id}`, acknowledged: false, createdAt: "2026-07-01T00:01:00.000Z", intent: "question", ...over,
}) as any;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify({ sessions: [] }), { status: 200, headers: { "Content-Type": "application/json" } })),
  ));
  useArtifactStore.getState().reset();
  useArtifactStore.setState({ artifacts: [art("a1")], selectedArtifactId: "a1", comments: { a1: [question("q1"), question("q2")] } });
});
afterEach(() => vi.unstubAllGlobals());

describe("#430 PR 1c — the one unanswered-question count", () => {
  it("lives on the Comment-threads button (waiting token), and the header pill has no ❓ duplicate", () => {
    useConnectionStore.setState({ connected: true, hydrated: true } as any);
    render(<App />);
    const btn = screen.getByRole("button", { name: /Open comment threads rail — 2 unanswered questions/ });
    const count = btn.querySelector("span[class*='rounded-full']")!;
    expect(count.textContent).toBe("2");
    expect(count.className).toContain(WAITING_TONE.dot);
    // The old header ❓ badge ("❓ 2 questions waiting") is gone.
    expect(screen.queryByText("❓")).not.toBeInTheDocument();
  });

  it("opens the rail on its Unanswered filter — each question is one click from its artifact", () => {
    useConnectionStore.setState({ connected: true, hydrated: true } as any);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Open comment threads rail — 2 unanswered/ }));
    const rail = within(screen.getByRole("dialog"));
    const unansweredPill = rail.getByRole("button", { name: /^Unanswered/ });
    expect(unansweredPill.className).toContain("bg-accent-blue-dim");
    expect(rail.getByText("q q1")).toBeInTheDocument();
  });

  it("is still there when the header pill renders nothing (disconnected)", () => {
    useConnectionStore.setState({ connected: false, hydrated: true } as any);
    render(<App />);
    expect(screen.getByRole("button", { name: /Open comment threads rail — 2 unanswered questions/ })).toBeInTheDocument();
  });
});
