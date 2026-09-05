import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureCheckpointHook,
  ensurePreflightHook,
  ensureStopHook,
} from "../setup-tasks.js";

const scratchRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const parent of scratchRoots.splice(0)) {
    fs.rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30_000);

describe("installed hook launch contract", () => {
  it("launches every generated hook through a POSIX shell and native Node", () => {
    // Keep a space in the project path: the quotes around $CLAUDE_PROJECT_DIR
    // are part of the supported launcher contract, not decoration.
    const scratchBase = path.join(process.cwd(), "node_modules", ".cache");
    fs.mkdirSync(scratchBase, { recursive: true });
    const parent = fs.mkdtempSync(path.join(scratchBase, "dp-hook-smoke-"));
    scratchRoots.push(parent);
    const projectRoot = path.join(parent, "project with spaces");
    fs.mkdirSync(projectRoot);
    vi.spyOn(os, "homedir").mockReturnValue(parent);

    expect(ensureStopHook(projectRoot).ok).toBe(true);
    expect(ensureCheckpointHook(projectRoot).ok).toBe(true);
    expect(ensurePreflightHook(projectRoot).ok).toBe(true);

    const settings = JSON.parse(
      fs.readFileSync(path.join(projectRoot, ".claude", "settings.local.json"), "utf8"),
    );
    const commands = [
      settings.hooks.Stop[0].hooks[0].command,
      settings.hooks.PostToolUse[0].hooks[0].command,
      settings.hooks.PreToolUse[0].hooks[0].command,
    ] as string[];
    const configuredGitBash = process.env.CLAUDE_CODE_GIT_BASH_PATH;
    const defaultGitBash = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");
    const shell = process.platform === "win32"
      ? configuredGitBash || (fs.existsSync(defaultGitBash) ? defaultGitBash : "bash.exe")
      : "/bin/sh";
    const shellArgs = process.platform === "win32"
      ? ["--noprofile", "--norc", "-c"]
      : ["-c"];
    const shellProjectRoot = projectRoot.replaceAll("\\", "/");

    for (const command of commands) {
      expect(command).toMatch(/^node "\$CLAUDE_PROJECT_DIR\//);
    }

    const payloads = [
      "{}",
      JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "src/smoke.ts" } }),
      JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "src/smoke.ts", new_string: "export const smoke = true;" } }),
    ];
    for (const [index, command] of commands.entries()) {
      const result = spawnSync(shell, [...shellArgs, command], {
        cwd: parent,
        env: { ...process.env, CLAUDE_PROJECT_DIR: shellProjectRoot },
        input: payloads[index],
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain("hook error");
      expect(result.stderr).not.toContain("hook error");
      expect(result.stderr).not.toContain("ReferenceError");
    }

    const hookState = JSON.parse(
      fs.readFileSync(path.join(projectRoot, ".deeppairing", "hooks-state.json"), "utf8"),
    );
    expect(hookState.fires).toEqual(expect.arrayContaining([
      expect.objectContaining({ hook: "stop", exitCode: 0, reason: expect.not.stringMatching(/^error:/) }),
      expect.objectContaining({ hook: "checkpoint", exitCode: 0, reason: expect.not.stringMatching(/^error:/) }),
    ]));

    for (const name of ["stop.mjs", "checkpoint.mjs", "preflight.mjs"]) {
      const script = path.join(projectRoot, ".deeppairing", "hooks", name);
      expect(fs.existsSync(script)).toBe(true);
      if (process.platform !== "win32") {
        expect(fs.statSync(script).mode & 0o111).not.toBe(0);
      }
    }
  }, 30_000);
});
