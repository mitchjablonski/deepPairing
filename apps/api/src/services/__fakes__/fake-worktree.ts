import type { WorktreeManager, Worktree } from "../worktree-manager.js";

export class FakeWorktreeManager implements WorktreeManager {
  private worktrees = new Map<string, Worktree>();
  private diffs = new Map<string, string>();

  async create(basePath: string, branchName: string): Promise<Worktree> {
    const worktree: Worktree = {
      path: `/tmp/deeppairing-worktrees/${branchName}`,
      branch: branchName,
    };
    this.worktrees.set(worktree.path, worktree);
    return worktree;
  }

  async remove(worktreePath: string): Promise<void> {
    this.worktrees.delete(worktreePath);
  }

  async diff(worktreePath: string, _basePath: string): Promise<string> {
    return this.diffs.get(worktreePath) ?? "";
  }

  /** Test helper: set a fake diff for a worktree */
  setDiff(worktreePath: string, diff: string): void {
    this.diffs.set(worktreePath, diff);
  }

  /** Test helper: check if worktree exists */
  exists(worktreePath: string): boolean {
    return this.worktrees.has(worktreePath);
  }

  /** Test helper: get all worktrees */
  getAll(): Worktree[] {
    return Array.from(this.worktrees.values());
  }
}
