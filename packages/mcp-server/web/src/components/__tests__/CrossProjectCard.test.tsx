import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CrossProjectCard } from "../CrossProjectCard";
import { useCrossProjectStore } from "../../stores/crossProject";

/**
 * Q2 — the FIRST-REJECT CARD, the discovery path for a feature that was
 * structurally unreachable.
 *
 * Round 12: `globalLedgerPublish` defaults false and the only writer was the
 * interactive `init` prompt / the `philosophy publish` CLI — neither of which
 * the recommended marketplace install runs. No web control existed at all, yet
 * the README, plugin card and About text claimed cross-project flagging flatly.
 *
 * The card is offered exactly once, immediately after the human's first
 * "Reject & remember" in a project (the one moment the mechanic was just
 * taught), and never again once answered either way. These pin that contract —
 * including the "never again" half, since a settings nag that returns is worse
 * than no card.
 */

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  useCrossProjectStore.getState().reset();
  fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "updated" }) });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The store starts `publish: null` (not loaded); seed the real starting state. */
function publishingOff() {
  act(() => useCrossProjectStore.getState().hydratePublish(false));
}

function firstReject() {
  act(() => useCrossProjectStore.getState().noteStanceRecorded());
}

describe("CrossProjectCard (Q2)", () => {
  it("renders nothing until a stance has actually been recorded", () => {
    publishingOff();
    render(<CrossProjectCard />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("appears after the first reject, and states plainly what publishing means", () => {
    publishingOff();
    render(<CrossProjectCard />);
    firstReject();

    expect(screen.getByRole("dialog", { name: /cross-project memory/i })).toBeInTheDocument();
    expect(screen.getByText(/Stance recorded/i)).toBeInTheDocument();
    expect(screen.getByText(/quotes your reason back/i)).toBeInTheDocument();
    // The privacy disclosure is not optional: name the destination, the payload,
    // and that it stays advisory.
    expect(screen.getByText(/~\/\.deeppairing/)).toBeInTheDocument();
    expect(screen.getByText(/advisory nudge, never a block/i)).toBeInTheDocument();
    expect(screen.getByText(/no code, diffs, or file paths leave this project/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /enable cross-project/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /not now/i })).toBeInTheDocument();
  });

  it("[Enable cross-project] POSTs globalLedgerPublish:true and closes", async () => {
    const user = userEvent.setup();
    publishingOff();
    render(<CrossProjectCard />);
    firstReject();

    await user.click(screen.getByRole("button", { name: /enable cross-project/i }));

    const call = fetchMock.mock.calls.find((c: unknown[]) =>
      String(c[0]).includes("/api/preferences"),
    );
    expect(call).toBeTruthy();
    expect(JSON.parse((call as any[])[1].body)).toEqual({ globalLedgerPublish: true });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(useCrossProjectStore.getState().publish).toBe(true);
  });

  it("['Not now'] closes WITHOUT touching the preference", async () => {
    const user = userEvent.setup();
    publishingOff();
    render(<CrossProjectCard />);
    firstReject();

    await user.click(screen.getByRole("button", { name: /not now/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some((c: unknown[]) => String(c[0]).includes("/api/preferences")),
    ).toBe(false);
    expect(useCrossProjectStore.getState().publish).toBe(false);
  });

  it("THE 'ONCE' CONTRACT: it never returns after a dismiss, however many stances follow", async () => {
    const user = userEvent.setup();
    publishingOff();
    render(<CrossProjectCard />);
    firstReject();
    await user.click(screen.getByRole("button", { name: /not now/i }));

    firstReject();
    firstReject();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("the dismissal survives a reload (persisted, not just in-memory)", () => {
    publishingOff();
    act(() => useCrossProjectStore.getState().dismissCard());

    // Simulate a fresh page: the store's initial state re-reads localStorage.
    expect(localStorage.getItem("dp.crossProjectCard.dismissed")).toBe("1");
    act(() => {
      useCrossProjectStore.setState({
        cardVisible: false,
        dismissed: localStorage.getItem("dp.crossProjectCard.dismissed") === "1",
        publish: false,
      });
    });
    render(<CrossProjectCard />);
    firstReject();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("never offers an opt-in the project already took (publishing ON → no card)", () => {
    act(() => useCrossProjectStore.getState().hydratePublish(true));
    render(<CrossProjectCard />);
    firstReject();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("stays silent while the preference is still unknown — better to miss a prompt than to mis-state the setting", () => {
    render(<CrossProjectCard />); // publish === null (never hydrated)
    firstReject();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("a FAILED save rolls the preference back and still closes the card (the toggle remains in settings)", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    publishingOff();
    render(<CrossProjectCard />);
    firstReject();

    await user.click(screen.getByRole("button", { name: /enable cross-project/i }));
    await waitFor(() => expect(useCrossProjectStore.getState().publish).toBe(false));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
