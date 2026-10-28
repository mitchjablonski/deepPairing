import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { ToastLayer } from "../ToastLayer";
import { useToastStore, type PreflightBlockHero } from "../../stores/toast";
import { hookGateCopy } from "../../lib/hookGate";

/**
 * Skeleton plans, parity PR 4 — a `skeleton-scope` gate firing reads as what
 * it is: an edit outside the step Claude is filling, which would change the
 * approved skeleton. It names the step and the file, and says to answer in
 * the terminal (Claude Code's dialog doesn't show the reason, upstream #102892).
 */
const facts = { source: "session" as const, guardrail: "skeleton-scope", concept: "Skeleton fence SKEL[2]", toolName: "Edit", targetPath: "src/x.ts", decision: "ask" as const };

describe("skeleton fence toast copy", () => {
  it("names the step and the file, plainly", () => {
    const c = hookGateCopy(facts);
    expect(c.title).toBe("Edit outside step SKEL[2]: this changes the approved skeleton (`src/x.ts`)");
    expect(c.match).toContain("Claude is filling step SKEL[2] of the skeleton you approved");
    expect(c.next).toContain("Answer in the terminal: its prompt won't show this reason.");
    // Not the guarded-file wording.
    expect(c.match).not.toContain("guarded list");
    expect(c.announcement).toContain("Answer in the terminal.");
    expect(c.announcement).not.toContain("`");
  });

  it("several steps, a Write, a subagent and strict-stop each read correctly", () => {
    expect(hookGateCopy({ ...facts, concept: "Skeleton fence SKEL[2], SKEL[2.1]", toolName: "Write" }).title).toBe(
      "Write outside steps SKEL[2], SKEL[2.1]: this changes the approved skeleton (`src/x.ts`)",
    );
    const sub = hookGateCopy({ ...facts, agentType: "builder" });
    expect(sub.match).toContain("The builder subagent is filling step SKEL[2]");
    expect(sub.subagent).toBe("Subagent: builder");
    const deny = hookGateCopy({ ...facts, decision: "deny" });
    expect(deny.title).toBe("Stopped: edit outside step SKEL[2] would change the approved skeleton (`src/x.ts`)");
    expect(deny.next).toContain("Nothing was written.");
  });

  it("#610 M1: the enforced reshape pause reads as one, naming the file", () => {
    const c = hookGateCopy({ ...facts, guardrail: "skeleton-paused", concept: "Skeleton change awaiting approval" });
    expect(c.title).toBe("Skeleton change awaiting your approval: fills are paused (`src/x.ts`)");
    expect(c.match).toContain("you haven't approved the new version yet");
    expect(c.next).toContain("Answer in the terminal");
    const deny = hookGateCopy({ ...facts, guardrail: "skeleton-paused", concept: "Skeleton change awaiting approval", decision: "deny" });
    expect(deny.title).toBe("Stopped: a skeleton change awaits your approval, so fills are paused (`src/x.ts`)");
    expect(deny.next).toContain("Nothing was written.");
  });

  it("other guarded files and stances keep their existing copy", () => {
    const g = hookGateCopy({ ...facts, guardrail: "secrets", concept: ".env files" });
    expect(g.match).toBe("This file is on deepPairing's guarded list: .env files.");
    const s = hookGateCopy({ source: "session", concept: "global mutable state", toolName: "Write", targetPath: "src/config.ts" });
    expect(s.match).toBe("This matches your stance 'global mutable state'.");
  });

  it("the companion toast shows it", () => {
    useToastStore.getState().dismissAll();
    const hero: PreflightBlockHero = {
      source: "session",
      concept: "Skeleton fence SKEL[2]",
      via: "surface",
      lane: "hook",
      decision: "ask",
      toolName: "Edit",
      targetPath: "src/x.ts",
      guardrail: "skeleton-scope",
      blockId: "blk_skel_1",
      eligible: false,
      ineligibleReason: "hook_ask",
    } as PreflightBlockHero;
    render(<ToastLayer />);
    act(() => {
      useToastStore.getState().push({ kind: "preflight-block", title: "t", hero });
    });
    expect(screen.getByText(/Edit outside step SKEL\[2\]: this changes the approved skeleton/)).toBeInTheDocument();
  });
});

beforeEach(() => {
  useToastStore.getState().dismissAll();
});
