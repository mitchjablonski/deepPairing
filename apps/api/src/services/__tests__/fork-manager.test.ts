import { describe, it, expect } from "vitest";
import { ForkManager } from "../fork-manager.js";
import { FakeAgentService } from "../__fakes__/fake-agent.js";
import { FakeWorktreeManager } from "../__fakes__/fake-worktree.js";

function createForkManager() {
  const agentService = new FakeAgentService("research");
  const worktreeManager = new FakeWorktreeManager();
  const forkManager = new ForkManager(agentService, worktreeManager);
  return { forkManager, agentService, worktreeManager };
}

describe("ForkManager", () => {
  it("creates a fork with a unique ID", async () => {
    const { forkManager } = createForkManager();

    const fork = await forkManager.createFork({
      parentSessionId: "sess_1",
      decisionId: "dec_1",
      optionId: "opt_a",
      optionTitle: "Option A",
      cwd: "/tmp/project",
      originalPrompt: "Refactor auth",
    });

    expect(fork.id).toMatch(/^fork_/);
    expect(fork.parentSessionId).toBe("sess_1");
    expect(fork.decisionId).toBe("dec_1");
    expect(fork.optionId).toBe("opt_a");
  });

  it("creates a worktree for the fork", async () => {
    const { forkManager, worktreeManager } = createForkManager();

    const fork = await forkManager.createFork({
      parentSessionId: "sess_1",
      decisionId: "dec_1",
      optionId: "opt_a",
      optionTitle: "Option A",
      cwd: "/tmp/project",
      originalPrompt: "Refactor",
    });

    // Wait a tick for the background execution to start
    await new Promise((r) => setTimeout(r, 50));

    expect(worktreeManager.getAll().length).toBe(1);
    const refreshedFork = forkManager.getFork(fork.id);
    expect(refreshedFork?.worktree).not.toBeNull();
  });

  it("runs the agent in the fork and collects events", async () => {
    const { forkManager } = createForkManager();

    const fork = await forkManager.createFork({
      parentSessionId: "sess_1",
      decisionId: "dec_1",
      optionId: "opt_b",
      optionTitle: "Option B",
      cwd: "/tmp/project",
      originalPrompt: "Refactor",
    });

    // Wait for the fake agent to complete (research scenario ~150ms * 12 events + overhead)
    await new Promise((r) => setTimeout(r, 4000));

    const updated = forkManager.getFork(fork.id);
    expect(updated?.status).toBe("completed");
    expect(updated?.events.length).toBeGreaterThan(0);
  }, 10000);

  it("retrieves forks by decision ID", async () => {
    const { forkManager } = createForkManager();

    await forkManager.createFork({
      parentSessionId: "sess_1",
      decisionId: "dec_1",
      optionId: "opt_a",
      optionTitle: "A",
      cwd: "/tmp",
      originalPrompt: "test",
    });

    await forkManager.createFork({
      parentSessionId: "sess_1",
      decisionId: "dec_1",
      optionId: "opt_b",
      optionTitle: "B",
      cwd: "/tmp",
      originalPrompt: "test",
    });

    await forkManager.createFork({
      parentSessionId: "sess_1",
      decisionId: "dec_2",
      optionId: "opt_x",
      optionTitle: "X",
      cwd: "/tmp",
      originalPrompt: "test",
    });

    const forksForDec1 = forkManager.getForksForDecision("dec_1");
    expect(forksForDec1).toHaveLength(2);

    const forksForDec2 = forkManager.getForksForDecision("dec_2");
    expect(forksForDec2).toHaveLength(1);
  });

  it("retrieves forks by session ID", async () => {
    const { forkManager } = createForkManager();

    await forkManager.createFork({
      parentSessionId: "sess_1",
      decisionId: "dec_1",
      optionId: "opt_a",
      optionTitle: "A",
      cwd: "/tmp",
      originalPrompt: "test",
    });

    await forkManager.createFork({
      parentSessionId: "sess_2",
      decisionId: "dec_2",
      optionId: "opt_b",
      optionTitle: "B",
      cwd: "/tmp",
      originalPrompt: "test",
    });

    expect(forkManager.getForksForSession("sess_1")).toHaveLength(1);
    expect(forkManager.getForksForSession("sess_2")).toHaveLength(1);
  });

  it("cleans up a fork", async () => {
    const { forkManager, worktreeManager } = createForkManager();

    const fork = await forkManager.createFork({
      parentSessionId: "sess_1",
      decisionId: "dec_1",
      optionId: "opt_a",
      optionTitle: "A",
      cwd: "/tmp",
      originalPrompt: "test",
    });

    await new Promise((r) => setTimeout(r, 50));

    await forkManager.cleanup(fork.id);
    expect(forkManager.getFork(fork.id)).toBeUndefined();
    expect(worktreeManager.getAll()).toHaveLength(0);
  });

  it("returns diff from worktree", async () => {
    const { forkManager, worktreeManager } = createForkManager();

    const fork = await forkManager.createFork({
      parentSessionId: "sess_1",
      decisionId: "dec_1",
      optionId: "opt_a",
      optionTitle: "A",
      cwd: "/tmp/project",
      originalPrompt: "test",
    });

    await new Promise((r) => setTimeout(r, 50));

    const updated = forkManager.getFork(fork.id)!;
    worktreeManager.setDiff(updated.worktree!.path, "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new");

    const diff = await forkManager.getDiff(fork.id, "/tmp/project");
    expect(diff).toContain("--- a/file.ts");
  });
});
