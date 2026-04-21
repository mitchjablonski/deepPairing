import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
