import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DiagnosticsMenu } from "../DiagnosticsMenu";
import { usePreflightBlockStore } from "../../stores/preflightBlocks";
import { useHookStatusStore } from "../../stores/hookStatus";

/**
 * #189 (Fix 1) — the DiagnosticsMenu demoted the gate + hook chips into the ⋯
 * overflow, but those chips exist to keep a PERSISTENT firing visible past its
 * toast (#169 / X7). With the menu closed (the default) that signal must still
 * be rendered somewhere — an amber dot on the ⋯ trigger — or the demotion
 * re-buries exactly what those surfaces un-buried.
 */
beforeEach(() => {
  usePreflightBlockStore.getState().clear();
  useHookStatusStore.getState().reset();
  // The metrics fetch only fires when the menu opens (CompoundingBadge). These
  // tests keep the menu CLOSED, so no network — but stub fetch defensively.
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
});

describe("DiagnosticsMenu — closed-trigger attention dot", () => {
  it("shows NO dot and a plain label when nothing has fired", () => {
    render(<DiagnosticsMenu onOpenLedger={() => {}} />);
    expect(screen.queryByTestId("diagnostics-attention-dot")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open diagnostics menu/i })).toBeInTheDocument();
  });

  it("shows the amber dot + 'attention needed' label after a gate block is recorded (menu still closed)", () => {
    render(<DiagnosticsMenu onOpenLedger={() => {}} />);
    act(() => {
      usePreflightBlockStore.getState().pushBlock({
        source: "session", concept: "premature caching", via: "concept", reason: "measure first",
      });
    });
    expect(screen.getByTestId("diagnostics-attention-dot")).toBeInTheDocument();
    // a11y — the state is announced through the trigger's accessible name.
    expect(screen.getByRole("button", { name: /attention needed/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^open diagnostics menu$/i })).not.toBeInTheDocument();
  });

  it("#212 (J4) — carries the SINGLE Ledger entry: opening the menu reveals it, and clicking opens the Ledger", async () => {
    // The top-level header Ledger button was cut; this overflow entry is now the
    // only in-header door to the drawer. It must render (labelled "Open the
    // Ledger") when the menu opens and invoke onOpenLedger.
    const onOpenLedger = vi.fn();
    render(<DiagnosticsMenu onOpenLedger={onOpenLedger} />);
    await userEvent.click(screen.getByRole("button", { name: /open diagnostics menu/i }));
    // CompoundingBadge resolves its /api/metrics fetch (stubbed above) then
    // renders the zero-state "Ledger" entry.
    const ledger = await screen.findByRole("button", { name: /open the ledger/i });
    expect(ledger).toHaveTextContent(/Ledger/);
    await userEvent.click(ledger);
    expect(onOpenLedger).toHaveBeenCalledTimes(1);
  });

  it("shows the dot when the latest hook fire is a nag (exitCode 2), and none for a pass", () => {
    const { rerender } = render(<DiagnosticsMenu onOpenLedger={() => {}} />);
    act(() => {
      useHookStatusStore.getState().pushFire({ at: "2026-08-03T00:00:00.000Z", hook: "stop", exitCode: 0, reason: "ok" });
    });
    rerender(<DiagnosticsMenu onOpenLedger={() => {}} />);
    expect(screen.queryByTestId("diagnostics-attention-dot")).not.toBeInTheDocument();

    act(() => {
      useHookStatusStore.getState().pushFire({ at: "2026-08-03T00:01:00.000Z", hook: "checkpoint", exitCode: 2, reason: "unmet checkpoint" });
    });
    expect(screen.getByTestId("diagnostics-attention-dot")).toBeInTheDocument();
  });
});
