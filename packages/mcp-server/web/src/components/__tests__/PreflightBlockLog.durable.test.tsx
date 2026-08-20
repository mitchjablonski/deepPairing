import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PreflightBlockLog } from "../PreflightBlockLog";
import { usePreflightBlockStore, unreadBlockCount } from "../../stores/preflightBlocks";

/**
 * Q2 — THE BLOCK SURVIVES THE TAB.
 *
 * Round 12's HIGH: a REAL preflight block produced a 12s hero toast plus an
 * in-memory, session-scoped store — no server endpoint at all — while the DEMO
 * stashed its synthetic block and replayed it to late joiners forever. So the
 * demo taught an expectation production didn't keep: in a real session the
 * human whose browser wasn't attached when the gate fired (the normal case —
 * the agent works while the tab is closed) saw nothing, ever, and a reload
 * erased whatever they had.
 *
 * These pin the hydrate path end-to-end at the component boundary: a block that
 * fired with nobody watching is on screen after a later page load, live events
 * still merge without duplicating it, and the unread marker uses the same
 * "waiting on you" grammar as the rest of the UI.
 */

const SERVER_BLOCK = {
  id: "blk_server_1",
  at: "2026-08-19T10:00:00.000Z",
  sessionId: "session_alpha",
  source: "session" as const,
  concept: "global mutable state for config",
  proposal: "add a global mutable config singleton",
  reason: "it makes every test order-dependent",
  via: "concept" as const,
};

let fetchMock: ReturnType<typeof vi.fn>;

function mockBlocks(blocks: unknown[]) {
  fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ blocks }) });
  vi.stubGlobal("fetch", fetchMock);
}

beforeEach(() => {
  localStorage.clear();
  usePreflightBlockStore.getState().clear();
  usePreflightBlockStore.setState({ lastSeenAt: null });
  mockBlocks([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PreflightBlockLog — durable hydration (Q2)", () => {
  it("THE POINT: a block that fired with no client attached shows up after a later page load", async () => {
    const user = userEvent.setup();
    mockBlocks([SERVER_BLOCK]);
    render(<PreflightBlockLog />);

    await waitFor(() =>
      expect(usePreflightBlockStore.getState().blocks).toHaveLength(1),
    );
    await user.click(screen.getByRole("button", { name: /show recent gate blocks/i }));

    expect(screen.getByText(/global mutable state for config/)).toBeInTheDocument();
    expect(screen.getByText(/it makes every test order-dependent/)).toBeInTheDocument();
    expect(screen.getByText(/add a global mutable config singleton/)).toBeInTheDocument();
  });

  it("hydrates for EVERY session, not just the demo — and calls the durable route", async () => {
    mockBlocks([SERVER_BLOCK]);
    render(<PreflightBlockLog />);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((c: unknown[]) => String(c[0]).includes("/api/preflight-blocks")),
      ).toBe(true),
    );
  });

  it("says 'this project', because that is now the truth", async () => {
    const user = userEvent.setup();
    render(<PreflightBlockLog />);
    await user.click(screen.getByRole("button", { name: /show recent gate blocks/i }));
    expect(screen.getByText(/this project/i)).toBeInTheDocument();
  });

  it("a live event for a block the server already had does NOT double-append", async () => {
    mockBlocks([SERVER_BLOCK]);
    render(<PreflightBlockLog />);
    await waitFor(() => expect(usePreflightBlockStore.getState().blocks).toHaveLength(1));

    act(() => {
      usePreflightBlockStore.getState().pushBlock({
        source: "session",
        concept: SERVER_BLOCK.concept,
        proposal: SERVER_BLOCK.proposal,
        via: "concept",
        at: SERVER_BLOCK.at,
      });
    });
    expect(usePreflightBlockStore.getState().blocks).toHaveLength(1);
  });

  it("a genuinely NEW live block still lands on top of the hydrated ones", async () => {
    mockBlocks([SERVER_BLOCK]);
    render(<PreflightBlockLog />);
    await waitFor(() => expect(usePreflightBlockStore.getState().blocks).toHaveLength(1));

    act(() => {
      usePreflightBlockStore.getState().pushBlock({
        source: "session",
        concept: "pay-per-request hosting",
        via: "surface",
      });
    });
    const { blocks } = usePreflightBlockStore.getState();
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.concept).toBe("pay-per-request hosting");
  });

  it("a dead daemon degrades to the idle chip instead of breaking the header", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    render(<PreflightBlockLog />);
    await waitFor(() => expect(usePreflightBlockStore.getState().loaded).toBe(true));
    expect(screen.getByRole("button", { name: /^show recent gate blocks$/i })).toBeInTheDocument();
  });
});

describe("PreflightBlockLog — the unread marker (Q2)", () => {
  it("hydrated blocks you have never looked at read as WAITING ON YOU", async () => {
    mockBlocks([SERVER_BLOCK]);
    render(<PreflightBlockLog />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /1 waiting on you/i })).toBeInTheDocument(),
    );
  });

  it("opening the log clears the unread signal — and only opening it does", async () => {
    const user = userEvent.setup();
    mockBlocks([SERVER_BLOCK]);
    render(<PreflightBlockLog />);
    const trigger = await screen.findByRole("button", { name: /1 waiting on you/i });

    await user.click(trigger);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /waiting on you/i })).not.toBeInTheDocument(),
    );
    expect(usePreflightBlockStore.getState().lastSeenAt).toBe(SERVER_BLOCK.at);
  });

  it("the seen boundary persists, so a reload does not re-flag blocks you already read", async () => {
    const user = userEvent.setup();
    mockBlocks([SERVER_BLOCK]);
    const { unmount } = render(<PreflightBlockLog />);
    await user.click(await screen.findByRole("button", { name: /1 waiting on you/i }));
    unmount();

    expect(localStorage.getItem("dp.gateBlocks.lastSeenAt")).toBe(SERVER_BLOCK.at);
    // Fresh page: the store re-reads the boundary from storage.
    usePreflightBlockStore.getState().clear();
    usePreflightBlockStore.setState({
      lastSeenAt: localStorage.getItem("dp.gateBlocks.lastSeenAt"),
    });
    render(<PreflightBlockLog />);
    await waitFor(() => expect(usePreflightBlockStore.getState().blocks).toHaveLength(1));
    expect(screen.queryByRole("button", { name: /waiting on you/i })).not.toBeInTheDocument();
  });

  it("a block that fires AFTER you looked is unread again", () => {
    expect(
      unreadBlockCount({
        blocks: [{ ...SERVER_BLOCK, at: "2026-08-19T11:00:00.000Z" }],
        lastSeenAt: "2026-08-19T10:00:00.000Z",
      }),
    ).toBe(1);
    expect(
      unreadBlockCount({
        blocks: [{ ...SERVER_BLOCK, at: "2026-08-19T09:00:00.000Z" }],
        lastSeenAt: "2026-08-19T10:00:00.000Z",
      }),
    ).toBe(0);
  });
});
