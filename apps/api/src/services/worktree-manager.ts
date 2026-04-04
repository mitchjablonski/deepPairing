import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

const execFileAsync = promisify(execFile);

export interface Worktree {
  path: string;
  branch: string;
}

export interface WorktreeManager {
  create(basePath: string, branchName: string): Promise<Worktree>;
  remove(worktreePath: string): Promise<void>;
  diff(worktreePath: string, basePath: string): Promise<string>;
}

export class GitWorktreeManager implements WorktreeManager {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(os.tmpdir(), "deeppairing-worktrees");
  }

  async create(basePath: string, branchName: string): Promise<Worktree> {
    const worktreePath = path.join(this.baseDir, branchName);

    await fs.mkdir(this.baseDir, { recursive: true });

    await execFileAsync("git", [
      "-C", basePath,
      "worktree", "add",
      worktreePath,
      "-b", branchName,
    ]);

    return { path: worktreePath, branch: branchName };
  }

  async remove(worktreePath: string): Promise<void> {
    // Find the base repo from the worktree
    try {
      const { stdout } = await execFileAsync("git", [
        "-C", worktreePath,
        "rev-parse", "--git-common-dir",
      ]);
      const gitCommonDir = stdout.trim();
      const basePath = path.resolve(gitCommonDir, "..");

      await execFileAsync("git", [
        "-C", basePath,
        "worktree", "remove", worktreePath, "--force",
      ]);
    } catch {
      // Fallback: just remove the directory
      await fs.rm(worktreePath, { recursive: true, force: true });
    }
  }

  async diff(worktreePath: string, basePath: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", [
        "-C", worktreePath,
        "diff", "HEAD",
      ]);
      return stdout;
    } catch {
      return "";
    }
  }
}
