import { nanoid } from "nanoid";
import type { AgentService, AgentSession } from "./agent-types.js";
import { AGENT_EVENTS, onAgentEvent } from "./agent-types.js";
import type { WorktreeManager, Worktree } from "./worktree-manager.js";
import type { AgentEvent } from "@deeppairing/shared";

export interface Fork {
  id: string;
  parentSessionId: string;
  decisionId: string;
  optionId: string;
  worktree: Worktree | null;
  session: AgentSession | null;
  status: "pending" | "running" | "completed" | "error";
  events: AgentEvent[];
}

export interface ForkRequest {
  parentSessionId: string;
  decisionId: string;
  optionId: string;
  optionTitle: string;
  cwd: string;
  originalPrompt: string;
}

export class ForkManager {
  private forks = new Map<string, Fork>();
  private agentService: AgentService;
  private worktreeManager: WorktreeManager;

  constructor(agentService: AgentService, worktreeManager: WorktreeManager) {
    this.agentService = agentService;
    this.worktreeManager = worktreeManager;
  }

  async createFork(request: ForkRequest): Promise<Fork> {
    const forkId = `fork_${nanoid(10)}`;
    const branchName = `deeppairing-${forkId}`;

    const fork: Fork = {
      id: forkId,
      parentSessionId: request.parentSessionId,
      decisionId: request.decisionId,
      optionId: request.optionId,
      worktree: null,
      session: null,
      status: "pending",
      events: [],
    };

    this.forks.set(forkId, fork);

    // Run fork in background (non-blocking)
    this.executeFork(fork, branchName, request).catch((err) => {
      fork.status = "error";
      fork.events.push({
        type: "error",
        message: err instanceof Error ? err.message : "Fork failed",
      });
    });

    return fork;
  }

  getFork(forkId: string): Fork | undefined {
    return this.forks.get(forkId);
  }

  getForksForDecision(decisionId: string): Fork[] {
    return Array.from(this.forks.values()).filter(
      (f) => f.decisionId === decisionId,
    );
  }

  getForksForSession(sessionId: string): Fork[] {
    return Array.from(this.forks.values()).filter(
      (f) => f.parentSessionId === sessionId,
    );
  }

  async getDiff(forkId: string, basePath: string): Promise<string> {
    const fork = this.forks.get(forkId);
    if (!fork?.worktree) return "";
    return this.worktreeManager.diff(fork.worktree.path, basePath);
  }

  async cleanup(forkId: string): Promise<void> {
    const fork = this.forks.get(forkId);
    if (!fork) return;

    if (fork.session) {
      this.agentService.stopSession(fork.session.id);
    }
    if (fork.worktree) {
      await this.worktreeManager.remove(fork.worktree.path);
    }
    this.forks.delete(forkId);
  }

  private async executeFork(
    fork: Fork,
    branchName: string,
    request: ForkRequest,
  ): Promise<void> {
    // Create worktree
    fork.worktree = await this.worktreeManager.create(request.cwd, branchName);
    fork.status = "running";

    // Start agent session in the worktree
    const prompt = `You are exploring an alternative approach. The human was asked: "${request.originalPrompt}"

The option "${request.optionTitle}" was selected for exploration (ref: ${request.decisionId}).

Please implement this approach in the codebase. Work in the current directory.`;

    fork.session = await this.agentService.startSession({
      prompt,
      cwd: fork.worktree.path,
      sessionId: `${fork.id}_session`,
    });

    // Collect events
    onAgentEvent(fork.session.emitter, (event: AgentEvent) => {
      fork.events.push(event);
    });

    // Wait for completion
    await new Promise<void>((resolve) => {
      fork.session!.emitter.on(AGENT_EVENTS.done, () => {
        fork.status = "completed";
        resolve();
      });
      fork.session!.emitter.on(AGENT_EVENTS.error, () => {
        fork.status = "error";
        resolve();
      });
    });
  }
}
