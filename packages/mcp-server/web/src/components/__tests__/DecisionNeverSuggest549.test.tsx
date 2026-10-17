import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DecisionCard } from "../DecisionCard";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { useConnectionGraceStore } from "../../lib/connectionGrace";
import { OFFLINE_ACT_REASON } from "../../hooks/useOfflineReason";
import { hasUnsavedText } from "../../lib/unsavedText";

/**
 * #549 — picking one option no longer rejects the others; each unchosen option
 * on the resolved card offers an explicit, misclick-safe "Never suggest this"
 * that posts ONE option to the never-suggest route.
 */
const event = {
  type: "decision_request" as const,
  decisionId: "dec_abc",
  context: "Which cache?",
  options: [
    { id: "o1", title: "Redis", description: "In-memory store", pros: [], cons: [], effort: "low" as const, risk: "low" as const, recommendation: true },
    { id: "o2", title: "CDN edge cache", description: "Just the edge", pros: [], cons: [], effort: "medium" as const, risk: "medium" as const, recommendation: false },
    { id: "o3", title: "No cache", description: "Do nothing", pros: [], cons: [], effort: "low" as const, risk: "high" as const, recommendation: false },
  ],
};

/** A fake daemon: records every request and answers the never-suggest route. */
let calls: Array<{ url: string; body: unknown }>;
let failNext = false;
beforeEach(() => {
  calls = [];
  failNext = false;
  useArtifactStore.getState().reset();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (failNext) {
      failNext = false;
      return new Response(JSON.stringify({ error: "lock_busy", code: "lock_busy", message: "Busy — try again." }), { status: 503, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ status: "recorded" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  useConnectionStore.setState({ connected: true, hydrated: true, sessionId: "s1", activeSessions: [{ sessionId: "s1", live: true }], disconnectedSince: null } as any);
  useConnectionGraceStore.setState({ everConnected: true, graceOver: false, hydrationStalled: false });
});
afterEach(() => {
  useConnectionGraceStore.setState({ everConnected: false, graceOver: false, hydrationStalled: false });
  vi.unstubAllGlobals();
});

const neverSuggestPosts = () => calls.filter((c) => c.url.includes("/never-suggest"));
const renderResolved = (props: Record<string, unknown> = {}) =>
  render(<DecisionCard event={event} decisionId="dec_abc" artifactId="art1" sessionId="s1" initialResolved={{ optionId: "o1" }} {...props} />);

describe("#549 — Never suggest this", () => {
  it("renders one control per UNCHOSEN option (none on the chosen one) and says 'Not chosen', not 'Rejected'", () => {
    renderResolved();
    expect(screen.getByText(/Not chosen:/)).toBeInTheDocument();
    expect(screen.queryByText(/Rejected:/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Never suggest CDN edge cache" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Never suggest No cache" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Never suggest Redis" })).not.toBeInTheDocument();
  });

  it("is misclick-safe: the first click writes nothing; Cancel/Escape close without a write and refocus the opener", async () => {
    renderResolved();
    await userEvent.click(screen.getByRole("button", { name: "Never suggest CDN edge cache" }));
    expect(neverSuggestPosts()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Remember as rejected" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(neverSuggestPosts()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Never suggest CDN edge cache" })).toHaveFocus();

    await userEvent.keyboard("{Enter}");
    const box = screen.getByLabelText(/Remember “CDN edge cache” as rejected/);
    expect(box).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(neverSuggestPosts()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Never suggest CDN edge cache" })).toHaveFocus();
  });

  it("is keyboard operable end to end: Enter opens, type a reason, Ctrl+Enter records exactly that option with the reason", async () => {
    renderResolved();
    screen.getByRole("button", { name: "Never suggest CDN edge cache" }).focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("invalidation pain");
    expect(hasUnsavedText()).toBe(true); // registered with useUnsavedText while typed
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(neverSuggestPosts()).toHaveLength(1));
    expect(neverSuggestPosts()[0]!.url).toContain("/api/decisions/dec_abc/options/o2/never-suggest");
    expect(neverSuggestPosts()[0]!.body).toEqual({ reason: "invalidation pain" });
    expect(await screen.findByText("✓ Remembered as rejected")).toBeInTheDocument();
    expect(hasUnsavedText()).toBe(false);
    // The other unchosen option is untouched.
    expect(screen.getByRole("button", { name: "Never suggest No cache" })).toBeInTheDocument();
  });

  it("sends no reason when none is typed", async () => {
    renderResolved();
    await userEvent.click(screen.getByRole("button", { name: "Never suggest No cache" }));
    await userEvent.click(screen.getByRole("button", { name: "Remember as rejected" }));
    await waitFor(() => expect(neverSuggestPosts()).toHaveLength(1));
    expect(neverSuggestPosts()[0]!.body).toEqual({});
  });

  it("is offline-gated: confirm disables with the shared reason, the reason box stays editable, and it re-enables on reconnect", async () => {
    renderResolved();
    await userEvent.click(screen.getByRole("button", { name: "Never suggest CDN edge cache" }));
    act(() => { useConnectionStore.setState({ connected: false, disconnectedSince: Date.now() } as any); });
    const confirm = screen.getByRole("button", { name: "Remember as rejected" });
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute("title", OFFLINE_ACT_REASON);
    const box = screen.getByLabelText(/Remember “CDN edge cache” as rejected/);
    await userEvent.type(box, "still typing");
    expect(box).toHaveValue("still typing");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(neverSuggestPosts()).toHaveLength(0);
    act(() => { useConnectionStore.setState({ connected: true, disconnectedSince: null } as any); });
    expect(screen.getByRole("button", { name: "Remember as rejected" })).toBeEnabled();
  });

  it("keeps the panel and the typed reason when the write fails, so the human can retry", async () => {
    renderResolved();
    await userEvent.click(screen.getByRole("button", { name: "Never suggest CDN edge cache" }));
    await userEvent.type(screen.getByLabelText(/as rejected/), "nope");
    failNext = true;
    await userEvent.click(screen.getByRole("button", { name: "Remember as rejected" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Busy — try again.");
    expect(screen.getByLabelText(/as rejected/)).toHaveValue("nope");
    await userEvent.click(screen.getByRole("button", { name: "Remember as rejected" }));
    expect(await screen.findByText("✓ Remembered as rejected")).toBeInTheDocument();
  });

  it("a write-locked (retracted/replayed) resolved card offers no control", () => {
    renderResolved({ writeLocked: true });
    expect(screen.getByText(/Not chosen:/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Never suggest/ })).not.toBeInTheDocument();
  });
});
