import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HookStatus } from "../HookStatus";
import { useHookStatusStore, type HookFire } from "../../stores/hookStatus";

function fire(partial: Partial<HookFire>): HookFire {
  return {
    at: new Date().toISOString(),
    hook: "stop",
    exitCode: 0,
    reason: "pass: nothing pending",
    ...partial,
  };
}

beforeEach(() => {
  useHookStatusStore.getState().reset();
});

describe("HookStatus", () => {
  it("renders idle dot when no fires have happened yet", () => {
    render(<HookStatus />);
    const trigger = screen.getByRole("button", { name: /show recent hook fires/i });
    expect(trigger).toBeInTheDocument();
    // Popover not open by default.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens a popover with fires on click", async () => {
    const user = userEvent.setup();
    useHookStatusStore.getState().pushFire(fire({ hook: "stop", reason: "pass: clean" }));
    useHookStatusStore.getState().pushFire(
      fire({
        at: new Date(Date.now() - 1000).toISOString(),
        hook: "checkpoint",
        exitCode: 2,
        reason: "nag: Edit on src/foo.ts without checkpoint",
      }),
    );
    render(<HookStatus />);
    await user.click(screen.getByRole("button", { name: /show recent hook fires/i }));
    const dialog = screen.getByRole("dialog", { name: /recent hook fires/i });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText("stop")).toBeInTheDocument();
    expect(screen.getByText("checkpoint")).toBeInTheDocument();
    expect(screen.getByText(/pass: clean/)).toBeInTheDocument();
    expect(screen.getByText(/nag: Edit on src\/foo\.ts/)).toBeInTheDocument();
  });

  it("shows an empty-state message when popover opens with no fires", async () => {
    const user = userEvent.setup();
    render(<HookStatus />);
    await user.click(screen.getByRole("button", { name: /show recent hook fires/i }));
    expect(screen.getByText(/no hook fires yet/i)).toBeInTheDocument();
  });

  it("labels exitCode 2 as nag and exitCode 0 as pass", async () => {
    const user = userEvent.setup();
    useHookStatusStore.getState().pushFire(fire({ exitCode: 2, reason: "the agent kept editing" }));
    useHookStatusStore.getState().pushFire(
      fire({
        at: new Date(Date.now() - 5000).toISOString(),
        exitCode: 0,
        reason: "all clear",
      }),
    );
    render(<HookStatus />);
    await user.click(screen.getByRole("button", { name: /show recent hook fires/i }));
    // Badges have a tone class; reasons don't. Scope by tone class to avoid
    // ambiguity with reason copy that happens to contain "nag" or "pass".
    expect(screen.getByText("nag")).toHaveClass("text-accent-amber");
    expect(screen.getByText("pass")).toHaveClass("text-accent-green");
  });

  it("caps the popover at the most-recent 5 fires", async () => {
    const user = userEvent.setup();
    const now = Date.now();
    for (let i = 0; i < 8; i++) {
      useHookStatusStore.getState().pushFire(
        fire({
          at: new Date(now - i * 1000).toISOString(),
          hook: `hook${i}`,
          reason: `reason ${i}`,
        }),
      );
    }
    render(<HookStatus />);
    await user.click(screen.getByRole("button", { name: /show recent hook fires/i }));
    // pushFire prepends, so the store order is hook7,hook6,...,hook0 — i.e.
    // the LAST pushed fire is at index 0. The popover slices the first 5,
    // so hook7..hook3 are visible and hook2..hook0 are off-screen.
    expect(screen.getByText("hook7")).toBeInTheDocument();
    expect(screen.getByText("hook3")).toBeInTheDocument();
    expect(screen.queryByText("hook2")).not.toBeInTheDocument();
    expect(screen.queryByText("hook0")).not.toBeInTheDocument();
  });

  it("toggles closed on a second click of the trigger", async () => {
    const user = userEvent.setup();
    render(<HookStatus />);
    const trigger = screen.getByRole("button", { name: /show recent hook fires/i });
    await user.click(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(trigger);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    render(<HookStatus />);
    await user.click(screen.getByRole("button", { name: /show recent hook fires/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("dedupes a fire that arrives twice with the same at + hook", () => {
    const at = new Date().toISOString();
    const store = useHookStatusStore.getState();
    store.pushFire(fire({ at, hook: "stop", reason: "first" }));
    store.pushFire(fire({ at, hook: "stop", reason: "duplicate" }));
    expect(useHookStatusStore.getState().fires).toHaveLength(1);
    expect(useHookStatusStore.getState().fires[0].reason).toBe("first");
  });
});
