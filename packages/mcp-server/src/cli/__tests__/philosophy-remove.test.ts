/**
 * `dp philosophy remove <concept>` — the first-class way OUT of the ledger.
 *
 * Field bug context: there was no way to remove a stance short of hand-editing
 * ~/.deeppairing/philosophy/v1.json (the override valve is local-blocks-only).
 * These tests spawn the REAL CLI (under tsx) with HOME pointed at a scratch
 * dir — never the real one — and pin: removal deletes the whole concept entry,
 * prints what was removed + the backup path, backs the ledger up first, and a
 * nonexistent concept is a clean error with zero writes.
 *
 * Env note (J1): the spawned CLI constructs a default GlobalStore, whose
 * default-path guard refuses the real HOME under VITEST/NODE_ENV=test. Scrub
 * both from the spawned env (per the guard's own guidance) — HOME already
 * points at the scratch dir, so the guard's protection is redundant here.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(here, "../init.ts");
const tsxBin = path.resolve(here, "../../../node_modules/.bin/tsx");

let projectDir: string;
let scratchHome: string;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-rm-proj-"));
  scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), "dp-rm-home-"));
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(scratchHome, { recursive: true, force: true });
});

const scratchLedgerPath = () => path.join(scratchHome, ".deeppairing", "philosophy", "v1.json");

function seedScratchLedger(): void {
  const ledger = {
    version: 1,
    concepts: {
      "global mutable state for config": {
        key: "global mutable state for config",
        concept: "global mutable state for config",
        instances: [
          { project: "repo-a", sessionId: "s1", verdict: "rejected", reason: "broke testability", at: "2026-07-01T10:00:00.000Z" },
          { project: "repo-b", sessionId: "s2", verdict: "rejected", at: "2026-07-05T10:00:00.000Z" },
        ],
        firstSeenAt: "2026-07-01T10:00:00.000Z",
        lastSeenAt: "2026-07-05T10:00:00.000Z",
      },
      "keep me": {
        key: "keep me",
        concept: "keep me",
        instances: [{ project: "repo-a", sessionId: "s1", verdict: "approved", at: "2026-07-02T10:00:00.000Z" }],
        firstSeenAt: "2026-07-02T10:00:00.000Z",
        lastSeenAt: "2026-07-02T10:00:00.000Z",
      },
    },
  };
  fs.mkdirSync(path.dirname(scratchLedgerPath()), { recursive: true });
  fs.writeFileSync(scratchLedgerPath(), JSON.stringify(ledger, null, 2));
}

function runRemove(args: string[]): { status: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: scratchHome,
    USERPROFILE: scratchHome, // Windows homedir()
  };
  // J1 — see header. HOME is scratch; the guard would otherwise kill the CLI.
  delete env.VITEST;
  delete env.NODE_ENV;
  try {
    const stdout = execFileSync(tsxBin, [cliEntry, "philosophy", "remove", ...args], {
      encoding: "utf-8",
      cwd: projectDir,
      env,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("`dp philosophy remove <concept>`", () => {
  it("removes the whole concept entry, prints what was removed + the backup path", () => {
    seedScratchLedger();
    const { status, stdout } = runRemove(["global", "mutable", "state", "for", "config"]);
    expect(status).toBe(0);
    // Prints WHAT was removed (concept + how much history)...
    expect(stdout).toContain("global mutable state for config");
    expect(stdout).toMatch(/2 instance/);
    // ...and WHERE the backup went.
    expect(stdout).toMatch(/\.removed-\d+/);
    const backupMatch = stdout.match(/(\/\S+\.removed-\S+)/);
    expect(backupMatch).toBeTruthy();
    expect(fs.existsSync(backupMatch![1]!)).toBe(true);

    // The concept is gone; unrelated stances survive; JSON stays valid.
    const after = JSON.parse(fs.readFileSync(scratchLedgerPath(), "utf-8"));
    expect(after.concepts["global mutable state for config"]).toBeUndefined();
    expect(after.concepts["keep me"]).toBeTruthy();
  });

  it("errors cleanly on a nonexistent concept — no write, no backup", () => {
    seedScratchLedger();
    const before = fs.readFileSync(scratchLedgerPath());
    const { status, stderr } = runRemove(["never", "recorded"]);
    expect(status).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("no stance");
    expect(fs.readFileSync(scratchLedgerPath()).equals(before)).toBe(true);
    const dir = path.dirname(scratchLedgerPath());
    expect(fs.readdirSync(dir).filter((f) => f.includes(".removed-"))).toHaveLength(0);
  });

  it("errors with usage when no concept is given", () => {
    const { status, stderr } = runRemove([]);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/remove/i);
  });

  it("is listed in `--help` alongside the other philosophy subcommands", () => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: scratchHome, USERPROFILE: scratchHome };
    delete env.VITEST;
    delete env.NODE_ENV;
    const stdout = execFileSync(tsxBin, [cliEntry, "--help"], { encoding: "utf-8", cwd: projectDir, env });
    expect(stdout).toMatch(/philosophy remove/);
  });
});
