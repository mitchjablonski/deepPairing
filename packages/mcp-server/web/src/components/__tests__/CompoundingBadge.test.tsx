import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CompoundingBadge } from "../CompoundingBadge";

function mockMetrics(blocks: number, writes: number) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      counts: {
        preflightBlocks: { total: blocks, bySource: { session: blocks, team: 0 } },
        ledgerWrites: { total: writes, rejected: writes, approved: 0 },
      },
    }),
  });
}

afterEach(() => vi.restoreAllMocks());

describe("CompoundingBadge", () => {
  it("E3 (L6) — shows a muted zero-state at 0/0 (was: self-hiding, so new users never learned the meter existed)", async () => {
    vi.stubGlobal("fetch", mockMetrics(0, 0));
    render(<CompoundingBadge onOpen={() => {}} />);
    expect(await screen.findByText(/taste ledger/)).toBeInTheDocument();
    // The counts only render once there's real signal.
    expect(screen.queryByText("🛡 0")).toBeNull();
  });

  it("surfaces the cumulative blocks · writes and opens Your taste on click", async () => {
    vi.stubGlobal("fetch", mockMetrics(14, 23));
    const onOpen = vi.fn();
    render(<CompoundingBadge onOpen={onOpen} />);
    const btn = await screen.findByRole("button", { name: /cumulative taste/i });
    expect(btn.textContent).toContain("14"); // 🛡 blocks
    expect(btn.textContent).toContain("23"); // 🧭 ledger writes
    await userEvent.click(btn);
    expect(onOpen).toHaveBeenCalled();
  });
});
