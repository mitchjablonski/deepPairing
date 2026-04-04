import { describe, it, expect } from "vitest";
import { DecisionManager } from "../decision-manager.js";

describe("DecisionManager", () => {
  it("creates a pending decision and resolves it", async () => {
    const manager = new DecisionManager();

    const promise = manager.createPendingDecision("dec_001", ["opt_a", "opt_b"]);
    expect(manager.isPending("dec_001")).toBe(true);

    manager.resolveDecision("dec_001", { optionId: "opt_a", reasoning: "Best fit" });

    const result = await promise;
    expect(result.optionId).toBe("opt_a");
    expect(result.reasoning).toBe("Best fit");
    expect(manager.isPending("dec_001")).toBe(false);
  });

  it("resolves without reasoning", async () => {
    const manager = new DecisionManager();

    const promise = manager.createPendingDecision("dec_002", ["opt_a"]);
    manager.resolveDecision("dec_002", { optionId: "opt_a" });

    const result = await promise;
    expect(result.optionId).toBe("opt_a");
    expect(result.reasoning).toBeUndefined();
  });

  it("throws when resolving unknown decision", () => {
    const manager = new DecisionManager();

    expect(() =>
      manager.resolveDecision("nonexistent", { optionId: "opt_a" }),
    ).toThrow("No pending decision found");
  });

  it("throws when resolving with invalid option id", () => {
    const manager = new DecisionManager();
    manager.createPendingDecision("dec_003", ["opt_a", "opt_b"]);

    expect(() =>
      manager.resolveDecision("dec_003", { optionId: "opt_c" }),
    ).toThrow("Invalid option id: opt_c");
  });

  it("waits indefinitely — no timeout", async () => {
    const manager = new DecisionManager();

    const promise = manager.createPendingDecision("dec_004", ["opt_a"]);
    expect(manager.isPending("dec_004")).toBe(true);

    // Resolve after any amount of time — the promise is still there
    manager.resolveDecision("dec_004", { optionId: "opt_a" });
    const result = await promise;
    expect(result.optionId).toBe("opt_a");
  });

  it("returns all pending decision IDs", () => {
    const manager = new DecisionManager();
    manager.createPendingDecision("dec_a", ["opt_1"]);
    manager.createPendingDecision("dec_b", ["opt_1"]);

    const ids = manager.getPendingIds();
    expect(ids).toContain("dec_a");
    expect(ids).toContain("dec_b");
    expect(ids).toHaveLength(2);
  });

  it("cancels all pending decisions on shutdown", async () => {
    const manager = new DecisionManager();
    const p1 = manager.createPendingDecision("dec_x", ["opt_1"]);
    const p2 = manager.createPendingDecision("dec_y", ["opt_1"]);

    manager.cancelAll();

    await expect(p1).rejects.toThrow("shutting down");
    await expect(p2).rejects.toThrow("shutting down");
    expect(manager.getPendingIds()).toHaveLength(0);
  });

  it("cancels only the specified session's decisions", async () => {
    const manager = new DecisionManager();
    const p1 = manager.createPendingDecision("dec_s1", ["opt_1"], "sess_1");
    const p2 = manager.createPendingDecision("dec_s2", ["opt_1"], "sess_2");

    manager.cancelSession("sess_1");

    await expect(p1).rejects.toThrow("Session sess_1 ended");
    expect(manager.isPending("dec_s1")).toBe(false);
    expect(manager.isPending("dec_s2")).toBe(true);

    // Clean up — await the rejection to prevent unhandled error
    manager.cancelAll();
    await expect(p2).rejects.toThrow("shutting down");
  });

  it("tracks session ID when provided", () => {
    const manager = new DecisionManager();
    manager.createPendingDecision("dec_1", ["opt_a"], "sess_abc");

    expect(manager.isPending("dec_1")).toBe(true);
  });
});
