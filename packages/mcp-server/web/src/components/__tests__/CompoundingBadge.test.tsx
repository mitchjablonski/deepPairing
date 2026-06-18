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
  it("stays hidden until there's signal (0 blocks + 0 writes)", async () => {
    vi.stubGlobal("fetch", mockMetrics(0, 0));
    const { container } = render(<CompoundingBadge onOpen={() => {}} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(container.firstChild).toBeNull();
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
