import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PreflightBlockLog } from "../PreflightBlockLog";
import { usePreflightBlockStore, type PreflightBlockRecord } from "../../stores/preflightBlocks";

function pushBlock(partial: Partial<Omit<PreflightBlockRecord, "id" | "at">> & { at?: string } = {}) {
  usePreflightBlockStore.getState().pushBlock({
    source: "session",
    concept: "redis for caching",
    via: "concept",
    ...partial,
  });
}

beforeEach(() => {
  usePreflightBlockStore.getState().clear();
});

describe("PreflightBlockLog (#169)", () => {
  it("renders an idle chip with no blocks and no open popover", () => {
    render(<PreflightBlockLog />);
    expect(screen.getByRole("button", { name: /show recent gate blocks/i })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows an empty-state message when opened with no blocks", async () => {
    const user = userEvent.setup();
    render(<PreflightBlockLog />);
    await user.click(screen.getByRole("button", { name: /show recent gate blocks/i }));
    expect(screen.getByText(/no blocks yet/i)).toBeInTheDocument();
  });

  it("persists the block moment — concept, prior reason, proposal, source", async () => {
    const user = userEvent.setup();
    pushBlock({
      concept: "redis for caching",
      proposal: "add a redis cache",
      reason: "wrong question, not wrong options",
      source: "session",
      via: "concept",
    });
    render(<PreflightBlockLog />);
    await user.click(screen.getByRole("button", { name: /show recent gate blocks/i }));

    const dialog = screen.getByRole("dialog", { name: /recent gate blocks/i });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText(/redis for caching/)).toBeInTheDocument();
    expect(screen.getByText(/add a redis cache/)).toBeInTheDocument();
    expect(screen.getByText(/wrong question, not wrong options/)).toBeInTheDocument();
    expect(screen.getByText(/Your personal taste/)).toBeInTheDocument();
    expect(screen.getByText(/matched by underlying concept/)).toBeInTheDocument();
  });

  it("labels a team block with its policy source", async () => {
    const user = userEvent.setup();
    pushBlock({ source: "team", concept: "inline styles", via: "avoid", addedBy: "alex" });
    render(<PreflightBlockLog />);
    await user.click(screen.getByRole("button", { name: /show recent gate blocks/i }));
    expect(screen.getByText(/Team policy · added by alex/)).toBeInTheDocument();
    expect(screen.getByText(/matches a team 'avoid' rule/)).toBeInTheDocument();
  });

  it("#169 F7 — dedupes on (rejectedAt + concept + proposal), independent of the connection lane", () => {
    const base = { source: "session" as const, concept: "redis for caching", proposal: "add a redis cache", via: "concept" as const, rejectedAt: "2026-04-16T10:00:00.000Z" };
    // Same firing pushed twice (per-session fan-out / a replay that slipped the
    // connection-layer dedupe) → ONE record.
    usePreflightBlockStore.getState().pushBlock(base);
    usePreflightBlockStore.getState().pushBlock(base);
    expect(usePreflightBlockStore.getState().blocks).toHaveLength(1);
    // A genuinely different proposal is NOT suppressed.
    usePreflightBlockStore.getState().pushBlock({ ...base, proposal: "add a redis cache to the CDN edge" });
    expect(usePreflightBlockStore.getState().blocks).toHaveLength(2);
  });

  it("caps the popover at the most-recent 6 blocks", async () => {
    const user = userEvent.setup();
    for (let i = 0; i < 9; i++) pushBlock({ concept: `concept-${i}` });
    render(<PreflightBlockLog />);
    await user.click(screen.getByRole("button", { name: /show recent gate blocks/i }));
    // pushBlock prepends, so concept-8 is newest (index 0); first 6 shown.
    expect(screen.getByText(/concept-8/)).toBeInTheDocument();
    expect(screen.getByText(/concept-3/)).toBeInTheDocument();
    expect(screen.queryByText(/concept-2/)).not.toBeInTheDocument();
    expect(screen.queryByText(/concept-0/)).not.toBeInTheDocument();
  });
});
