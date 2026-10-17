import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act, within } from "@testing-library/react";
import { ToastLayer } from "../ToastLayer";
import { useToastStore, MAX_BLOCK_TOASTS, type PreflightBlockHero } from "../../stores/toast";
import { usePreflightBlockStore } from "../../stores/preflightBlocks";
import { hookGateCopy } from "../../lib/hookGate";

/**
 * #544 — Claude Code's ask dialog doesn't show the hook's reason, so the
 * companion's hero toast is where you see WHY it is asking.
 */
function hookHero(overrides: Partial<PreflightBlockHero> = {}): PreflightBlockHero {
  return {
    source: "session",
    concept: "global mutable state",
    reason: "Keep configuration explicit",
    via: "surface",
    lane: "hook",
    decision: "ask",
    toolName: "Write",
    targetPath: "src/config.ts",
    blockId: "blk_hf_1",
    eligible: false,
    ineligibleReason: "hook_ask",
    ...overrides,
  };
}

function push(hero: PreflightBlockHero, extra: Record<string, unknown> = {}) {
  act(() => {
    useToastStore.getState().push({ kind: "preflight-block", title: "t", hero, ...extra });
  });
}

beforeEach(() => {
  useToastStore.getState().dismissAll();
  usePreflightBlockStore.setState({ logOpen: false });
});

describe("#544 hook-gate hero toast", () => {
  it("an ask names the file, the stance, what you said, and that the terminal won't show it", () => {
    push(hookHero());
    render(<ToastLayer />);
    const card = screen.getByRole("alert");
    expect(card).toHaveAttribute("data-lane", "hook");
    expect(card).toHaveAttribute("data-decision", "ask");
    expect(within(card).getByTestId("hook-gate-title")).toHaveTextContent("Claude Code is asking to write `src/config.ts`");
    expect(within(card).getByTestId("hook-gate-match")).toHaveTextContent("This matches your stance 'global mutable state'.");
    expect(within(card).getByTestId("hook-gate-said")).toHaveTextContent("You said: 'Keep configuration explicit'");
    expect(within(card).getByTestId("hook-gate-next")).toHaveTextContent("The terminal prompt won't show this.");
    // The terminal's Allow is the one-time allowance here: no second button.
    expect(within(card).queryByRole("button", { name: /allow/i })).toBeNull();
    expect(within(card).getByRole("button", { name: "Open the gate log" })).toBeInTheDocument();
  });

  it("a strict-stop deny says it was stopped and nothing was written", () => {
    push(hookHero({ decision: "deny", toolName: "Edit" }));
    render(<ToastLayer />);
    const card = screen.getByRole("alert");
    expect(card).toHaveTextContent("Claude Code stopped an edit to `src/config.ts`");
    expect(card).toHaveTextContent("Nothing was written.");
  });

  it("the guarded-file class reads as a guarded file, not a stance", () => {
    push(hookHero({
      concept: "deepPairing's own state",
      reason: "deepPairing's own state: your stances, team rules, hook scripts and the settings that register them.",
      guardrail: "deeppairing-state",
      targetPath: ".claude/settings.json",
    }));
    render(<ToastLayer />);
    const card = screen.getByRole("alert");
    expect(card).toHaveTextContent("Claude Code is asking to write `.claude/settings.json`");
    expect(card).toHaveTextContent("This file is on deepPairing's guarded list: deepPairing's own state.");
    expect(card).not.toHaveTextContent("matches your stance");
  });

  it("quiet when the one announcer already spoke it (next-up bar on)", () => {
    push(hookHero(), { quiet: true });
    render(<ToastLayer />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("hero-toast")).toHaveTextContent("Claude Code is asking to write");
  });

  it("respects the block-toast cap and steps aside while the gate log is open (#501)", () => {
    for (let i = 0; i < MAX_BLOCK_TOASTS + 2; i++) push(hookHero({ blockId: `blk_${i}`, targetPath: `src/f${i}.ts` }));
    const { rerender } = render(<ToastLayer />);
    expect(screen.getAllByTestId("hero-toast")).toHaveLength(MAX_BLOCK_TOASTS);
    act(() => usePreflightBlockStore.setState({ logOpen: true }));
    rerender(<ToastLayer />);
    expect(screen.queryAllByTestId("hero-toast")).toHaveLength(0);
  });
});

describe("#544 hookGateCopy", () => {
  it("team rules quote the team's reason and keep the rule", () => {
    const c = hookGateCopy({ source: "team", concept: "ORM", reason: "raw SQL only", addedBy: "alex", toolName: "Edit", targetPath: "db.ts" });
    expect(c.title).toBe("Claude Code is asking to edit `db.ts`");
    expect(c.match).toBe("This matches your team's rule 'ORM' (added by alex).");
    expect(c.said).toBe("Your team's reason: 'raw SQL only'");
    expect(c.next).toMatch(/keep the team rule\.$/);
  });

  it("the announcement is plain sentences without code ticks", () => {
    const c = hookGateCopy({ source: "session", concept: "global mutable state", reason: "Keep configuration explicit", toolName: "Write", targetPath: "src/config.ts", decision: "ask" });
    expect(c.announcement).toBe(
      "Claude Code is asking to write src/config.ts. This matches your stance 'global mutable state'. You said: 'Keep configuration explicit'. The terminal prompt won't show this.",
    );
  });
});
