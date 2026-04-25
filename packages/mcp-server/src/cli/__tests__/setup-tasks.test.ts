import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureDeepPairingDir,
  ensureGitignoreEntry,
  ensureStopHook,
  runDaemonStartupSetup,
} from "../setup-tasks.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-setup-tasks-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("ensureDeepPairingDir", () => {
  it("creates the directory when missing", () => {
    const result = ensureDeepPairingDir(tmpDir);
    expect(result.ok).toBe(true);
    expect(result.ok && result.changed).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".deeppairing"))).toBe(true);
  });

  it("is a no-op when the directory already exists", () => {
    fs.mkdirSync(path.join(tmpDir, ".deeppairing"));
    const result = ensureDeepPairingDir(tmpDir);
    expect(result.ok).toBe(true);
    expect(result.ok && result.changed).toBe(false);
  });
});

describe("ensureGitignoreEntry", () => {
  it("appends .deeppairing/ when .gitignore exists without it", () => {
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "node_modules/\n");
    const result = ensureGitignoreEntry(tmpDir);
    expect(result.ok && result.changed).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, ".gitignore"), "utf-8");
    expect(content).toContain(".deeppairing/");
    expect(content).toContain("node_modules/"); // didn't clobber
  });

  it("is a no-op when .gitignore already lists .deeppairing/", () => {
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "node_modules/\n.deeppairing/\n");
    const result = ensureGitignoreEntry(tmpDir);
    expect(result.ok && result.changed).toBe(false);
  });

  it("does NOT create .gitignore from scratch (init does, daemon shouldn't)", () => {
    const result = ensureGitignoreEntry(tmpDir);
    expect(result.ok && result.changed).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".gitignore"))).toBe(false);
  });

  it("appends a leading newline if .gitignore doesn't end with one", () => {
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "node_modules/"); // no trailing newline
    ensureGitignoreEntry(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, ".gitignore"), "utf-8");
    expect(content).toBe("node_modules/\n.deeppairing/\n");
  });
});

describe("ensureStopHook", () => {
  it("creates .claude/settings.local.json with the hook when missing", () => {
    const result = ensureStopHook(tmpDir);
    expect(result.ok && result.changed).toBe(true);
    const settings = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".claude", "settings.local.json"), "utf-8"),
    );
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Stop[0].command).toContain("deepPairing");
  });

  it("appends to existing hooks without clobbering other settings", () => {
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".claude", "settings.local.json"),
      JSON.stringify({ unrelated: "keep me", hooks: { PreToolUse: [{ command: "other" }] } }),
    );
    const result = ensureStopHook(tmpDir);
    expect(result.ok && result.changed).toBe(true);
    const settings = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".claude", "settings.local.json"), "utf-8"),
    );
    expect(settings.unrelated).toBe("keep me");
    expect(settings.hooks.PreToolUse).toEqual([{ command: "other" }]);
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  it("is a no-op when a deepPairing Stop hook is already present", () => {
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".claude", "settings.local.json"),
      JSON.stringify({ hooks: { Stop: [{ command: "node -e 'deepPairing: existing'" }] } }),
    );
    const result = ensureStopHook(tmpDir);
    expect(result.ok && result.changed).toBe(false);
  });

  it("refuses to clobber a malformed settings.local.json", () => {
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".claude", "settings.local.json"), "{ not json");
    const result = ensureStopHook(tmpDir);
    expect(result.ok).toBe(false);
    // Original (malformed) file is intact
    expect(fs.readFileSync(path.join(tmpDir, ".claude", "settings.local.json"), "utf-8")).toBe("{ not json");
  });
});

describe("Stop hook command — executable behavior (Part C)", () => {
  // The Stop hook is an inline `node -e "..."` blob baked into
  // .claude/settings.local.json. The other tests verify that we INSTALL it
  // correctly; these execute the SAME command against fixture session data
  // and assert exit codes — which is what Claude Code actually keys off of.
  //
  // Exit 0 → agent is allowed to stop.
  // Exit 2 → "deepPairing: pending artifacts need review" → agent must continue.
  //
  // If the artifact JSON schema, status names, or trigger types ever shift,
  // these tests catch it before the hook silently no-ops in production.

  function getHookCommand(): string {
    ensureStopHook(tmpDir);
    const settings = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".claude", "settings.local.json"), "utf-8"),
    );
    return settings.hooks.Stop[0].command as string;
  }

  function runHook(): { exitCode: number; stdout: string } {
    const cmd = getHookCommand();
    try {
      const stdout = execSync(cmd, { cwd: tmpDir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
      return { exitCode: 0, stdout };
    } catch (err: any) {
      return { exitCode: err.status ?? 1, stdout: err.stdout?.toString() ?? "" };
    }
  }

  function writeArtifacts(sessionId: string, artifacts: any[]) {
    const sessionDir = path.join(tmpDir, ".deeppairing", "sessions", sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "artifacts.json"), JSON.stringify(artifacts));
  }

  it("exits 0 when there are no sessions at all", () => {
    const { exitCode } = runHook();
    expect(exitCode).toBe(0);
  });

  it("exits 0 when sessions exist but no artifacts are draft", () => {
    writeArtifacts("s1", [
      { id: "a1", type: "research", status: "approved" },
      { id: "a2", type: "plan", status: "rejected" },
    ]);
    const { exitCode } = runHook();
    expect(exitCode).toBe(0);
  });

  it("exits 2 when a draft research artifact exists", () => {
    writeArtifacts("s1", [{ id: "a1", type: "research", status: "draft" }]);
    const { exitCode, stdout } = runHook();
    expect(exitCode).toBe(2);
    expect(stdout).toContain("deepPairing");
    expect(stdout).toContain("check_feedback");
  });

  it("exits 2 for any of: research, spec, plan, decision, code_change in draft", () => {
    for (const type of ["research", "spec", "plan", "decision", "code_change"]) {
      // Clean slate per type
      const sessionsDir = path.join(tmpDir, ".deeppairing", "sessions");
      if (fs.existsSync(sessionsDir)) fs.rmSync(sessionsDir, { recursive: true, force: true });
      writeArtifacts("s1", [{ id: "a1", type, status: "draft" }]);
      const { exitCode } = runHook();
      expect(exitCode, `type=${type} should block stop`).toBe(2);
    }
  });

  it("exits 0 when only a draft reasoning artifact exists (reasoning has no review cycle)", () => {
    writeArtifacts("s1", [{ id: "a1", type: "reasoning", status: "draft" }]);
    const { exitCode } = runHook();
    expect(exitCode).toBe(0);
  });

  it("exits 2 if ANY session has a draft artifact (multi-session)", () => {
    writeArtifacts("s1", [{ id: "a1", type: "research", status: "approved" }]);
    writeArtifacts("s2", [{ id: "a2", type: "plan", status: "draft" }]);
    const { exitCode } = runHook();
    expect(exitCode).toBe(2);
  });

  it("exits 0 when artifacts.json is malformed (degrade gracefully, do not block forever)", () => {
    const sessionDir = path.join(tmpDir, ".deeppairing", "sessions", "s1");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "artifacts.json"), "{ not json");
    const { exitCode } = runHook();
    expect(exitCode).toBe(0);
  });
});

describe("runDaemonStartupSetup", () => {
  it("runs all three idempotent setup tasks", () => {
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "node_modules/\n");
    const results = runDaemonStartupSetup(tmpDir);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.ok)).toBe(true);
    // Re-running is a no-op
    const second = runDaemonStartupSetup(tmpDir);
    expect(second.every((r) => r.ok && !r.changed)).toBe(true);
  });

  it("does NOT touch CLAUDE.md (intentional — that stays opt-in via init)", () => {
    fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "Original content\n");
    runDaemonStartupSetup(tmpDir);
    expect(fs.readFileSync(path.join(tmpDir, "CLAUDE.md"), "utf-8")).toBe("Original content\n");
  });
});
