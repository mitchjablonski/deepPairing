import { describe, it, expect, beforeEach } from "vitest";
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
    expect(useHookStatusStore.getState().fires[0]!.reason).toBe("first");
  });
});

/**
 * Q2 — the chip stops lying about the guardrail lane.
 *
 * Round 12: every guardrail fire rendered as a GREEN "pass", because
 * recordHookFire wrote no exitCode and this component keyed on
 * `exitCode === 2` alone. A PreToolUse guardrail that stopped and ASKED about a
 * write to `migrations/` looked exactly like a hook that did nothing — the one
 * lane this chip exists to make legible.
 *
 * The `kind` field (stamped at the record site) is the first authority. Records
 * WITHOUT it must keep their pre-Q2 rendering byte-for-byte: inferring "pass"
 * from silence is what caused the bug, so absence is never widened.
 */
describe("Q2 — hook fires render honestly (kind: 'ask' | 'pass')", () => {
  it("kind:'ask' renders as amber 'asked', NOT green 'pass' — even with exitCode 0", async () => {
    const user = userEvent.setup();
    useHookStatusStore.getState().pushFire(
      fire({ hook: "checkpoint", exitCode: 0, kind: "ask", reason: "guardrail: migrations/002.sql" }),
    );
    render(<HookStatus />);
    await user.click(screen.getByRole("button", { name: /show recent hook fires/i }));
    const asked = screen.getByText("asked");
    expect(asked).toBeInTheDocument();
    expect(asked).toHaveClass("text-accent-amber");
    expect(screen.queryByText("pass")).not.toBeInTheDocument();
  });

  it("kind:'pass' stays green", async () => {
    const user = userEvent.setup();
    useHookStatusStore.getState().pushFire(fire({ exitCode: 0, kind: "pass", reason: "nothing pending" }));
    render(<HookStatus />);
    await user.click(screen.getByRole("button", { name: /show recent hook fires/i }));
    const pass = screen.getByText("pass");
    expect(pass).toHaveClass("text-accent-green");
  });

  it("END-TO-END with Q1's writer: the EXACT record recordHookFire emits renders amber 'asked'", async () => {
    const user = userEvent.setup();
    // Byte-for-byte the object cli/preflight-hook-core.ts pushes onto
    // hooks-state.json for a guardrail fire: hook "preflight", kind "ask",
    // a `guardrail:<category>` reason, and NO exitCode at all. That missing
    // exitCode is precisely what made this render green before.
    useHookStatusStore.getState().pushFire({
      at: new Date().toISOString(),
      hook: "preflight",
      kind: "ask",
      reason: "guardrail:migrations",
    } as HookFire);
    render(<HookStatus />);
    await user.click(screen.getByRole("button", { name: /show recent hook fires/i }));
    expect(screen.getByText("asked")).toHaveClass("text-accent-amber");
    expect(screen.getByText("preflight")).toBeInTheDocument();
    expect(screen.queryByText("pass")).not.toBeInTheDocument();
  });

  it("BACK-COMPAT: a record with NO kind keeps the pre-Q2 exitCode rendering exactly", async () => {
    const user = userEvent.setup();
    useHookStatusStore.getState().pushFire(fire({ at: new Date().toISOString(), exitCode: 0, reason: "old pass" }));
    useHookStatusStore.getState().pushFire(
      fire({ at: new Date(Date.now() - 1000).toISOString(), hook: "checkpoint", exitCode: 2, reason: "old nag" }),
    );
    render(<HookStatus />);
    await user.click(screen.getByRole("button", { name: /show recent hook fires/i }));
    expect(screen.getByText("pass")).toHaveClass("text-accent-green");
    expect(screen.getByText("nag")).toHaveClass("text-accent-amber");
    expect(screen.queryByText("asked")).not.toBeInTheDocument();
  });
});
