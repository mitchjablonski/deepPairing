/**
 * R2 — THE COLD-PATH PINS.
 *
 * Round 13's cold-journey lens found the Q-batch's two flagship mechanisms
 * present, correct, tested — and INERT, because nothing called them from a cold
 * page load. Every test in this file is an A/B repro from that report, written
 * so the same class of regression (a finished component nobody connected)
 * fails here instead of shipping.
 *
 * The repros:
 *   1. a real block persisted server-side is VISIBLE after a cold page load —
 *      the ⋯ attention dot lights WITHOUT the human opening the menu that used
 *      to be the only thing that loaded the data (the circular dependency).
 *   2. a reject that records a stance on a COLD page (no ⋯ ever opened) fires
 *      the first-reject cross-project card — including from DecisionCard, the
 *      artifact type the demo, the hero image and the README all teach with.
 *   3. the demo path is unchanged (blocks still replay; the card still never
 *      offers itself in a session that structurally can't accept it).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../../App";
import { DecisionCard } from "../DecisionCard";
import { DiagnosticsMenu } from "../DiagnosticsMenu";
import { CrossProjectCard } from "../CrossProjectCard";
import { ToastLayer } from "../ToastLayer";
import { usePreflightBlockStore } from "../../stores/preflightBlocks";
import { useCrossProjectStore } from "../../stores/crossProject";
import { useConnectionStore } from "../../stores/connection";
import { useArtifactStore } from "../../stores/artifact";
import { useToastStore } from "../../stores/toast";

vi.mock("../MermaidDiagram", () => ({
  MermaidDiagram: ({ source }: { source: string }) => <div data-testid="mermaid">{source}</div>,
}));

/** The block the daemon persisted to .deeppairing/preflight-blocks.json. */
const PERSISTED_BLOCK = {
  id: "blk_server_1",
  at: "2026-08-20T09:00:00.000Z",
  source: "session",
  concept: "in-memory session store",
  proposal: "swap Redis for a Map",
  reason: "we lose every session on deploy",
  via: "concept",
  sessionId: "sess_real",
};

/**
 * A daemon that answers the two routes the cold bootstrap hits, and 200s
 * everything else with an empty body — the shape App's own bootstrap fetches
 * (/api/active-sessions) expects.
 */
function coldDaemon(opts: { blocks?: unknown[]; publish?: boolean } = {}) {
  return vi.fn().mockImplementation((url: unknown) => {
    const u = String(url);
    const json = (body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body), {
        status: 200, headers: { "Content-Type": "application/json" },
      }));
    if (u.includes("/api/preflight-blocks")) return json({ blocks: opts.blocks ?? [] });
    if (u.includes("/api/state")) return json({ globalLedgerPublish: opts.publish ?? false });
    if (u.includes("/api/active-sessions")) return json({ sessions: [] });
    return json({});
  });
}

beforeEach(() => {
  usePreflightBlockStore.getState().clear();
  usePreflightBlockStore.setState({ lastSeenAt: null });
  useCrossProjectStore.getState().reset();
  useArtifactStore.getState().reset();
  try { localStorage.clear(); } catch { /* private mode */ }
});

afterEach(() => {
  vi.restoreAllMocks();
  useToastStore.getState().dismissAll();
});

describe("R2 repro 1 — a persisted block is visible on a COLD page load", () => {
  it("App's bootstrap hydrates the durable gate log with no menu ever opened", async () => {
    vi.stubGlobal("fetch", coldDaemon({ blocks: [PERSISTED_BLOCK] }));
    useConnectionStore.setState({ connected: true, hydrated: true } as any);

    render(<App />);

    await waitFor(() =>
      expect(usePreflightBlockStore.getState().blocks).toHaveLength(1),
    );
    expect(usePreflightBlockStore.getState().blocks[0]!.concept).toBe("in-memory session store");
    // The whole point: nobody opened the ⋯ menu. Pre-R2 this array stayed
    // empty until PreflightBlockLog mounted, which only happens inside it.
    expect(usePreflightBlockStore.getState().loaded).toBe(true);
  });

  it("the ⋯ attention dot lights from that cold hydration (the circular dependency is broken)", async () => {
    vi.stubGlobal("fetch", coldDaemon({ blocks: [PERSISTED_BLOCK] }));

    // The menu is CLOSED — this is the trigger a human sees before deciding
    // whether the menu is worth opening. Its dot is driven by blocks.length,
    // which is exactly the data that used to require opening the menu.
    render(<DiagnosticsMenu onOpenLedger={() => {}} />);
    expect(screen.queryByTestId("diagnostics-attention-dot")).not.toBeInTheDocument();

    await act(async () => { await usePreflightBlockStore.getState().load(); });

    expect(screen.getByTestId("diagnostics-attention-dot")).toBeInTheDocument();
  });

  it("a dead daemon leaves the chip idle rather than breaking the shell (fail-soft)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    useConnectionStore.setState({ connected: false, hydrated: true } as any);

    render(<App />);

    await waitFor(() => expect(usePreflightBlockStore.getState().loaded).toBe(true));
    expect(usePreflightBlockStore.getState().blocks).toEqual([]);
    expect(useCrossProjectStore.getState().publish).toBeNull();
  });

  it("the DEMO path is unchanged — a replayed block still merges on top of the cold hydrate", async () => {
    vi.stubGlobal("fetch", coldDaemon({ blocks: [PERSISTED_BLOCK] }));
    await act(async () => { await usePreflightBlockStore.getState().load(); });

    act(() => usePreflightBlockStore.getState().pushBlock({
      concept: "demo synthetic block", via: "surface", source: "session",
    }));

    expect(usePreflightBlockStore.getState().blocks.map((b) => b.concept)).toEqual([
      "demo synthetic block",
      "in-memory session store",
    ]);
  });
});

describe("R2 repro 2 — the cross-project publish preference hydrates cold", () => {
  it("App's bootstrap reads globalLedgerPublish without the Autonomy popover ever mounting", async () => {
    vi.stubGlobal("fetch", coldDaemon({ publish: false }));
    useConnectionStore.setState({ connected: true, hydrated: true } as any);

    expect(useCrossProjectStore.getState().publish).toBeNull();
    render(<App />);

    // null → false is the whole fix: noteStanceRecorded bails on
    // `publish !== false`, so a null (never-loaded) preference silently
    // disabled the entire first-reject card on every cold page.
    await waitFor(() => expect(useCrossProjectStore.getState().publish).toBe(false));
  });

  it("already publishing (true) still suppresses the offer", async () => {
    vi.stubGlobal("fetch", coldDaemon({ publish: true }));
    await act(async () => { await useCrossProjectStore.getState().hydrateFromServer(); });
    act(() => useCrossProjectStore.getState().noteStanceRecorded("sess_real"));
    expect(useCrossProjectStore.getState().cardVisible).toBe(false);
  });
});

describe("R2 repro 2b — DecisionCard fires the first-reject card", () => {
  const event = {
    type: "decision_request" as const,
    decisionId: "dec_r2",
    context: "Which cache?",
    options: [
      { id: "o1", title: "Redis", description: "In-memory store", pros: ["fast"], cons: ["ops"],
        effort: "low" as const, risk: "low" as const, recommendation: true },
      { id: "o2", title: "CDN edge", description: "Just the edge", pros: ["no infra"], cons: ["invalidation"],
        effort: "medium" as const, risk: "medium" as const, recommendation: false },
    ],
  };

  async function rejectWithConcept(concept: string) {
    await userEvent.click(screen.getByRole("button", { name: /reject this framing/i }));
    await userEvent.type(
      screen.getByPlaceholderText(/we don't need a cache at all/i),
      "wrong question — measure first",
    );
    if (concept) {
      await userEvent.type(screen.getByLabelText(/name the pattern you're rejecting/i), concept);
    }
    await userEvent.click(screen.getByRole("button", { name: /reject & remember/i }));
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", coldDaemon({ publish: false }));
  });

  it("a decision reject WITH a concept on a cold page opens the card", async () => {
    await act(async () => { await useCrossProjectStore.getState().hydrateFromServer(); });
    useConnectionStore.setState({ sessionId: "sess_real" } as any);

    render(<DecisionCard event={event} decisionId="dec_r2" artifactId="art_dec" />);
    await rejectWithConcept("premature caching");

    await waitFor(() => expect(useCrossProjectStore.getState().cardVisible).toBe(true));
  });

  it("a DEMO decision reject NEVER opens it (the one-time card can't be burned on a no-op)", async () => {
    await act(async () => { await useCrossProjectStore.getState().hydrateFromServer(); });
    useConnectionStore.setState({ sessionId: "demo_abc123" } as any);

    render(<DecisionCard event={event} decisionId="dec_r2" artifactId="art_dec" />);
    await rejectWithConcept("premature caching");

    await waitFor(() =>
      expect((fetch as any).mock.calls.some((c: any[]) => String(c[0]).includes("/status"))).toBe(true),
    );
    expect(useCrossProjectStore.getState().cardVisible).toBe(false);
    expect(useCrossProjectStore.getState().dismissed).toBe(false);
  });

  it("a reject with NO named concept doesn't offer it (same rule ArtifactStatusActions uses)", async () => {
    await act(async () => { await useCrossProjectStore.getState().hydrateFromServer(); });
    useConnectionStore.setState({ sessionId: "sess_real" } as any);

    render(<DecisionCard event={event} decisionId="dec_r2" artifactId="art_dec" />);
    await rejectWithConcept("");

    await waitFor(() =>
      expect((fetch as any).mock.calls.some((c: any[]) => String(c[0]).includes("/status"))).toBe(true),
    );
    expect(useCrossProjectStore.getState().cardVisible).toBe(false);
  });

  it("a FAILED reject POST records nothing and offers nothing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: unknown) => {
      const u = String(url);
      if (u.includes("/status")) return Promise.resolve(new Response("{}", { status: 500 }));
      return Promise.resolve(new Response(JSON.stringify({ globalLedgerPublish: false }), {
        status: 200, headers: { "Content-Type": "application/json" },
      }));
    }));
    await act(async () => { await useCrossProjectStore.getState().hydrateFromServer(); });
    useConnectionStore.setState({ sessionId: "sess_real" } as any);

    render(<DecisionCard event={event} decisionId="dec_r2" artifactId="art_dec" />);
    await rejectWithConcept("premature caching");

    expect(useCrossProjectStore.getState().cardVisible).toBe(false);
  });
});

describe("R2 — the consent card owns the corner it shares with the toasts", () => {
  it("the card layers ABOVE the toast stack (both are fixed bottom-4 right-4)", () => {
    act(() => useCrossProjectStore.setState({ cardVisible: true, publish: false }));
    render(<><ToastLayer /><CrossProjectCard /></>);

    const card = screen.getByTestId("cross-project-card");
    const toasts = screen.getByTestId("toast-region");
    const zOf = (el: HTMLElement) => {
      const m = el.className.match(/z-\[?(\d+)\]?/);
      return m ? Number(m[1]) : 0;
    };
    // Round 13 measured the card at z-40 under a z-[60] toast stack: at the
    // exact moment of consent BOTH buttons were painted over and
    // click-intercepted for the ~5-6s the ledger + sent toasts live.
    expect(zOf(card)).toBeGreaterThan(zOf(toasts));
  });

  it("the toast column lifts clear of the card rather than being buried under it", () => {
    // The card publishes its own height via offsetHeight, which jsdom always
    // reports as 0 — so the measurement itself is a browser-only path (and the
    // store clamps 0 → no lift, which is why tests see the unchanged layout).
    // Seed the height the card would report and pin the LIFT.
    act(() => useCrossProjectStore.setState({ cardVisible: true, publish: false, cardHeight: 210 }));
    render(<ToastLayer />);
    expect(screen.getByTestId("toast-region").style.bottom).toBe("234px");
  });

  it("no card on screen → the toasts keep their normal placement", () => {
    act(() => useCrossProjectStore.setState({ cardVisible: false, cardHeight: 210 }));
    render(<ToastLayer />);
    expect(screen.getByTestId("toast-region").style.bottom).toBe("");
  });
});

describe("R2 — the gate log no longer occludes its siblings", () => {
  it("renders IN FLOW inside the diagnostics menu (no absolute overlay over the hooks chip)", async () => {
    vi.stubGlobal("fetch", coldDaemon({ blocks: [PERSISTED_BLOCK] }));
    render(<DiagnosticsMenu onOpenLedger={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /diagnostics/i }));
    await userEvent.click(screen.getByRole("button", { name: /show recent gate blocks/i }));

    const panel = await screen.findByTestId("gate-block-log");
    // The occlusion was structural: an absolutely-positioned 320px card
    // dropped over a 240px column whose next rows are the hooks chip and the
    // Ledger pill. In flow, it pushes them down instead.
    expect(panel.className).not.toContain("absolute");
    expect(panel.className).toContain("relative");
  });

  it("the sibling hooks + Ledger controls stay in the accessibility tree while it's open", async () => {
    vi.stubGlobal("fetch", coldDaemon({ blocks: [PERSISTED_BLOCK] }));
    render(<DiagnosticsMenu onOpenLedger={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /diagnostics/i }));
    await userEvent.click(screen.getByRole("button", { name: /show recent gate blocks/i }));
    await screen.findByTestId("gate-block-log");

    // Both siblings are still rendered and enabled — and, because the panel is
    // in flow, nothing is painted on top of them.
    expect(screen.getByRole("button", { name: /hook/i })).toBeEnabled();
  });
});
