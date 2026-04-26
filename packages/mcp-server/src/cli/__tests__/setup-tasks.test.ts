import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureDeepPairingDir,
  ensureGitignoreEntry,
  ensureStopHook,
  ensureCheckpointHook,
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
  it("creates .claude/settings.local.json with the nested-shape hook when missing", () => {
    const result = ensureStopHook(tmpDir);
    expect(result.ok && result.changed).toBe(true);
    const settings = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".claude", "settings.local.json"), "utf-8"),
    );
    // Field bug: legacy installer wrote { command } directly. Claude Code's
    // hook schema actually expects { matcher, hooks: [{ type, command }] }
    // and warns "Invalid settings / hooks: Expected array" otherwise.
    expect(settings.hooks.Stop).toHaveLength(1);
    const entry = settings.hooks.Stop[0];
    expect(entry).toHaveProperty("matcher");
    expect(Array.isArray(entry.hooks)).toBe(true);
    expect(entry.hooks[0].type).toBe("command");
    expect(entry.hooks[0].command).toContain("deepPairing");
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

  it("is a no-op when a deepPairing Stop hook is already present in nested shape", () => {
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".claude", "settings.local.json"),
      JSON.stringify({
        hooks: {
          Stop: [
            { matcher: "", hooks: [{ type: "command", command: "node -e 'deepPairing: existing'" }] },
          ],
        },
      }),
    );
    const result = ensureStopHook(tmpDir);
    expect(result.ok && result.changed).toBe(false);
  });

  it("HEALS a legacy flat-shape Stop entry by dropping it and re-installing nested", () => {
    // Field bug: this installer wrote { command } directly on earlier
    // versions, producing the "Invalid settings / hooks: Expected array"
    // warning. ensureStopHook must heal those on next run, not skip them.
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".claude", "settings.local.json"),
      JSON.stringify({
        hooks: {
          Stop: [
            { command: "node -e 'deepPairing: legacy flat shape'" },
            { command: "node -e 'unrelated user hook'" },
          ],
        },
      }),
    );
    const result = ensureStopHook(tmpDir);
    expect(result.ok).toBe(true);
    expect(result.ok && result.changed).toBe(true);
    expect(result.ok && result.message).toMatch(/replaced legacy flat-shape/i);

    const settings = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".claude", "settings.local.json"), "utf-8"),
    );
    // Stop now has: the user's unrelated hook (untouched) + our new nested
    // entry. The legacy DP flat entry is gone.
    expect(settings.hooks.Stop).toHaveLength(2);
    const userHook = settings.hooks.Stop.find((e: any) => e.command?.includes("unrelated"));
    expect(userHook).toBeDefined();
    const dpHook = settings.hooks.Stop.find((e: any) => Array.isArray(e.hooks));
    expect(dpHook).toBeDefined();
    expect(dpHook.hooks[0].command).toContain("deepPairing");
    // No legacy flat DP entry remains.
    const stillFlat = settings.hooks.Stop.find(
      (e: any) => typeof e.command === "string" && e.command.includes("deepPairing") && !Array.isArray(e.hooks),
    );
    expect(stillFlat).toBeUndefined();
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
    // V2.x — entry is the nested Claude Code hook shape:
    // { matcher, hooks: [{ type: "command", command }] }
    return settings.hooks.Stop[0].hooks[0].command as string;
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

  it("exits 0 when a draft artifact is older than 30 minutes (abandoned, U0.4 age guard)", () => {
    const oldIso = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    writeArtifacts("s1", [{ id: "a1", type: "plan", status: "draft", createdAt: oldIso }]);
    const { exitCode } = runHook();
    expect(exitCode).toBe(0);
  });

  it("exits 2 when a draft artifact is recent (≤30 minutes, U0.4 age guard)", () => {
    const recentIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    writeArtifacts("s1", [{ id: "a1", type: "plan", status: "draft", createdAt: recentIso }]);
    const { exitCode } = runHook();
    expect(exitCode).toBe(2);
  });

  it("exits 2 on draft with no createdAt (backward-compat: pre-U0.4 fixtures still block)", () => {
    writeArtifacts("s1", [{ id: "a1", type: "plan", status: "draft" }]);
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

describe("ensureCheckpointHook (V2)", () => {
  it("installs a PostToolUse entry scoped to Write|Edit|MultiEdit", () => {
    const r = ensureCheckpointHook(tmpDir);
    expect(r.ok && r.changed).toBe(true);
    const settings = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".claude", "settings.local.json"), "utf-8"),
    );
    const entries = settings.hooks.PostToolUse;
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(1);
    expect(entries[0].matcher).toBe("Write|Edit|MultiEdit");
    expect(entries[0].hooks[0].command).toContain("checkpoint.mjs");
  });

  it("writes the executable hook script to .deeppairing/hooks/checkpoint.mjs", () => {
    ensureCheckpointHook(tmpDir);
    const scriptPath = path.join(tmpDir, ".deeppairing", "hooks", "checkpoint.mjs");
    expect(fs.existsSync(scriptPath)).toBe(true);
    const stat = fs.statSync(scriptPath);
    // executable bit set so the shell can run it (belt + suspenders; we
    // invoke via `node ...` so the bit is informational only).
    expect(stat.mode & 0o111).not.toBe(0);
    const body = fs.readFileSync(scriptPath, "utf-8");
    expect(body).toMatch(/deepPairing checkpoint hook/);
  });

  it("is idempotent — second call is a no-op", () => {
    ensureCheckpointHook(tmpDir);
    const r = ensureCheckpointHook(tmpDir);
    expect(r.ok && !r.changed).toBe(true);
  });

  it("co-exists with the Stop hook in the same settings file", () => {
    ensureStopHook(tmpDir);
    ensureCheckpointHook(tmpDir);
    const settings = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".claude", "settings.local.json"), "utf-8"),
    );
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.PostToolUse).toHaveLength(1);
  });

  it("refuses to clobber a malformed settings file", () => {
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".claude", "settings.local.json"), "{ not json");
    const r = ensureCheckpointHook(tmpDir);
    expect(r.ok).toBe(false);
  });
});

describe("Checkpoint hook script — executable behavior (V2)", () => {
  // Run the installed .deeppairing/hooks/checkpoint.mjs directly, piping
  // a PostToolUse-shaped event over stdin (Claude Code's hook protocol).

  function runHookWith(input: object): { exitCode: number; stdout: string; stderr: string } {
    ensureCheckpointHook(tmpDir);
    const scriptPath = path.join(tmpDir, ".deeppairing", "hooks", "checkpoint.mjs");
    try {
      const stdout = execSync(`node ${scriptPath}`, {
        cwd: tmpDir,
        input: JSON.stringify(input),
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { exitCode: 0, stdout, stderr: "" };
    } catch (err: any) {
      return {
        exitCode: err.status ?? 1,
        stdout: err.stdout?.toString() ?? "",
        stderr: err.stderr?.toString() ?? "",
      };
    }
  }

  function writeArtifacts(sessionId: string, artifacts: any[]) {
    const sessionDir = path.join(tmpDir, ".deeppairing", "sessions", sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "artifacts.json"), JSON.stringify(artifacts));
  }

  it("exits 0 when the tool is not Write/Edit/MultiEdit (Read/Bash etc. are no-ops)", () => {
    const r = runHookWith({ tool_name: "Read", tool_input: { file_path: "x.ts" } });
    expect(r.exitCode).toBe(0);
  });

  it("exits 2 nagging the agent on a Write with NO code_change artifact at all", () => {
    writeArtifacts("s1", [
      { id: "art_old", type: "research", status: "approved", createdAt: "2026-04-25T10:00:00Z" },
    ]);
    const r = runHookWith({ tool_name: "Write", tool_input: { file_path: "src/new.ts" } });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("present_code_change");
    expect(r.stdout).toContain("src/new.ts");
  });

  it("exits 0 when a code_change artifact was created in the last minute (fresh checkpoint)", () => {
    writeArtifacts("s1", [
      { id: "art_cc", type: "code_change", status: "approved", createdAt: new Date().toISOString() },
    ]);
    const r = runHookWith({ tool_name: "Edit", tool_input: { file_path: "src/x.ts" } });
    expect(r.exitCode).toBe(0);
  });

  it("exits 2 when the most-recent code_change is older than the freshness window", () => {
    const stale = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    writeArtifacts("s1", [
      { id: "art_cc", type: "code_change", status: "approved", createdAt: stale },
    ]);
    const r = runHookWith({ tool_name: "MultiEdit", tool_input: { file_path: "src/y.ts" } });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toMatch(/Per-Edit Checkpoint/i);
  });

  it("exits 0 when there are no sessions at all (fresh project, nothing to enforce yet)", () => {
    const r = runHookWith({ tool_name: "Write", tool_input: { file_path: "src/x.ts" } });
    expect(r.exitCode).toBe(0);
  });

  // V2.1 (Option C — narrow skip-list). Generated/vendored output and
  // auto-generated lockfiles auto-skip; config / policy files still nag
  // because they represent real decisions a paired human should react to.
  it("V2.1 — auto-skips lockfiles (regenerated from manifests, not human-authored)", () => {
    writeArtifacts("s1", [
      { id: "art_old", type: "research", status: "approved", createdAt: "2026-04-25T10:00:00Z" },
    ]);
    for (const lockfile of ["pnpm-lock.yaml", "uv.lock", "Cargo.lock", "package-lock.json", "go.sum"]) {
      const r = runHookWith({ tool_name: "Write", tool_input: { file_path: `/abs/${lockfile}` } });
      expect(r.exitCode, `${lockfile} should auto-skip`).toBe(0);
    }
  });

  it("V2.1 — auto-skips generated / vendored paths (dist/, build/, node_modules/, .deeppairing/)", () => {
    writeArtifacts("s1", [
      { id: "art_old", type: "research", status: "approved", createdAt: "2026-04-25T10:00:00Z" },
    ]);
    for (const p of [
      "/repo/dist/bundle.js",
      "/repo/build/index.html",
      "/repo/node_modules/x/index.js",
      "/repo/.deeppairing/sessions/foo/x.json",
      "/repo/.next/static/chunk.js",
      "/repo/.vscode/settings.json",
    ]) {
      const r = runHookWith({ tool_name: "Write", tool_input: { file_path: p } });
      expect(r.exitCode, `${p} should auto-skip`).toBe(0);
    }
  });

  it("V2.1 (Option C) — DOES nag on .gitignore (config / policy is a real decision)", () => {
    writeArtifacts("s1", [
      { id: "art_old", type: "research", status: "approved", createdAt: "2026-04-25T10:00:00Z" },
    ]);
    const r = runHookWith({ tool_name: "Write", tool_input: { file_path: "/repo/.gitignore" } });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("present_code_change");
  });

  it("V2.1 (Option C) — DOES nag on .github/workflows/* (CI config is a real decision)", () => {
    writeArtifacts("s1", [
      { id: "art_old", type: "research", status: "approved", createdAt: "2026-04-25T10:00:00Z" },
    ]);
    const r = runHookWith({ tool_name: "Write", tool_input: { file_path: "/repo/.github/workflows/ci.yml" } });
    expect(r.exitCode).toBe(2);
  });

  it("V2.1 (Option C) — DOES nag on package.json (manifest IS the decision; lockfile is mechanical)", () => {
    writeArtifacts("s1", [
      { id: "art_old", type: "research", status: "approved", createdAt: "2026-04-25T10:00:00Z" },
    ]);
    const r = runHookWith({ tool_name: "Write", tool_input: { file_path: "/repo/package.json" } });
    expect(r.exitCode).toBe(2);
  });

  it("V2.1 — does NOT skip real source files", () => {
    writeArtifacts("s1", [
      { id: "art_old", type: "research", status: "approved", createdAt: "2026-04-25T10:00:00Z" },
    ]);
    const r = runHookWith({ tool_name: "Write", tool_input: { file_path: "/repo/src/foo.ts" } });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("present_code_change");
  });

  it("V2.1 — config files still pass when there's a fresh checkpoint (60s window covers incidentals)", () => {
    writeArtifacts("s1", [
      { id: "art_cc", type: "code_change", status: "approved", createdAt: new Date().toISOString() },
    ]);
    const r = runHookWith({ tool_name: "Write", tool_input: { file_path: "/repo/.gitignore" } });
    expect(r.exitCode).toBe(0);
  });
});

describe("runDaemonStartupSetup", () => {
  it("runs all four idempotent setup tasks", () => {
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "node_modules/\n");
    const results = runDaemonStartupSetup(tmpDir);
    expect(results).toHaveLength(4);
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
