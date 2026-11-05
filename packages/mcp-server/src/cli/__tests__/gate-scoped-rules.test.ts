/**
 * #621 — three gate bugs found by reading, reproduced here against the real
 * hook: evaluatePreflightHook on real files in a scratch project, then both
 * emitters (the init-written script and the plugin bundle) as real processes.
 * Real git worktrees and real symlinks. No mocks.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseTeamPreferencesFile } from "@deeppairing/shared";
import { canonicalProjectDir } from "../../git-worktree.js";
import { runPreflight } from "../../mcp/preflight-validator.js";
import { loadTeamPreferences } from "../../store/project-signals.js";
import { evaluatePreflightHook, readTeamPreferences, type PreflightFailureSink } from "../preflight-hook-core.js";
import { ensurePreflightHook } from "../setup-tasks.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const pluginHook = path.join(repoRoot, "claude-plugin/server/preflight.mjs");
const hasGit = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
const canSymlink = process.platform !== "win32";

const CONCEPT = "global mutable state";
const EDIT = "introduce global mutable state here";

let base: string;
let root: string;

function newProject(dir: string): string {
  fs.mkdirSync(path.join(dir, ".deeppairing"), { recursive: true });
  return dir;
}

function writeTeam(project: string, preferences: unknown[]): void {
  fs.writeFileSync(path.join(project, ".deeppairing", "team.json"), JSON.stringify({ version: 1, preferences }));
}

function writeStances(project: string, rejectedApproaches: unknown[]): void {
  fs.writeFileSync(path.join(project, ".deeppairing", "preferences.json"), JSON.stringify({ rejectedApproaches }));
}

function scopedRule(project: string, ...paths: string[]): void {
  writeTeam(project, [{ id: "t1", kind: "avoid", concept: CONCEPT, rationale: "breaks test isolation", scope: { paths } }]);
}

function editFires(project: string, filePath: string, newString = EDIT) {
  return evaluatePreflightHook({
    toolName: "Edit",
    toolInput: { file_path: filePath, new_string: newString },
    projectRoot: project,
  });
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dp-gate-621-")));
  root = newProject(path.join(base, "project"));
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("#621.1 a path-scoped team rule against the path Claude Code really sends", () => {
  it("fires on an absolute path inside the scope", () => {
    scopedRule(root, "packages/api/**");
    const d = editFires(root, path.join(root, "packages/api/x.ts"));
    expect(d.fire).toBe(true);
    expect(d.source).toBe("team");
  });

  it("fires on Write and MultiEdit as well as Edit", () => {
    scopedRule(root, "packages/api/**");
    const file_path = path.join(root, "packages/api/x.ts");
    expect(evaluatePreflightHook({ toolName: "Write", toolInput: { file_path, content: EDIT }, projectRoot: root }).source).toBe("team");
    expect(evaluatePreflightHook({ toolName: "MultiEdit", toolInput: { file_path, edits: [{ new_string: EDIT }] }, projectRoot: root }).source).toBe("team");
  });

  it("stays silent on an absolute path outside the scope", () => {
    scopedRule(root, "packages/api/**");
    expect(editFires(root, path.join(root, "packages/web/x.ts")).fire).toBe(false);
  });

  it("keeps working on a relative path", () => {
    scopedRule(root, "packages/api/**");
    expect(editFires(root, "packages/api/x.ts").fire).toBe(true);
    expect(editFires(root, "packages/web/x.ts").fire).toBe(false);
  });

  it("matches where the path lands, not how it is spelled", () => {
    scopedRule(root, "packages/api/**");
    expect(editFires(root, `${root}/packages/web/../api/x.ts`).fire).toBe(true);
    expect(editFires(root, `${root}/packages/api/../web/x.ts`).fire).toBe(false);
    expect(editFires(root, "./packages/api/x.ts").fire).toBe(true);
  });

  it("matches a single-segment glob against a root-level file", () => {
    scopedRule(root, "*.config.ts");
    expect(editFires(root, path.join(root, "vite.config.ts")).fire).toBe(true);
    expect(editFires(root, path.join(root, "src/vite.config.ts")).fire).toBe(false);
  });

  it("keeps firing a leading-** glob on a file at the top of the project, as the absolute path did", () => {
    scopedRule(root, "**/api/**", "**/*.sql");
    expect(editFires(root, path.join(root, "api/x.ts")).fire).toBe(true);
    expect(editFires(root, path.join(root, "packages/api/x.ts")).fire).toBe(true);
    expect(editFires(root, path.join(root, "schema.sql")).fire).toBe(true);
    expect(editFires(root, path.join(root, "web/x.ts")).fire).toBe(false);
  });

  it("a directory ABOVE the project is not part of what a scope sees", () => {
    const nested = newProject(path.join(base, "api", "project"));
    scopedRule(nested, "**/api/**");
    expect(editFires(nested, path.join(nested, "web/x.ts")).fire).toBe(false);
    expect(editFires(nested, path.join(nested, "api/x.ts")).fire).toBe(true);
  });

  it("a file outside the project never satisfies a scope", () => {
    scopedRule(root, "packages/api/**", "**/api/**");
    expect(editFires(root, path.join(base, "other/packages/api/x.ts")).fire).toBe(false);
    expect(editFires(root, `${root}-evil/packages/api/x.ts`).fire).toBe(false);
    expect(editFires(root, "../other/packages/api/x.ts").fire).toBe(false);
  });

  it("an unscoped rule is untouched: it still fires anywhere, outside the project too", () => {
    writeTeam(root, [{ id: "t1", kind: "avoid", concept: CONCEPT, rationale: "breaks test isolation" }]);
    expect(editFires(root, path.join(root, "packages/web/x.ts")).fire).toBe(true);
    expect(editFires(root, path.join(base, "other/x.ts")).fire).toBe(true);
  });

  it("a require rule honours its scope too", () => {
    writeTeam(root, [{ id: "t1", kind: "require", concept: "argon2id for password hashing", rationale: "bcrypt is brute-forceable", scope: { paths: ["packages/auth/**"] } }]);
    const text = "implement password hashing with bcrypt";
    expect(editFires(root, path.join(root, "packages/auth/x.ts"), text).source).toBe("team");
    expect(editFires(root, path.join(root, "packages/web/x.ts"), text).fire).toBe(false);
  });

  describe.runIf(canSymlink)("symlinks", () => {
    it("a symlink into the scope fires where the write really lands", () => {
      fs.mkdirSync(path.join(root, "packages/api"), { recursive: true });
      fs.symlinkSync(path.join(root, "packages/api"), path.join(root, "alias"));
      scopedRule(root, "packages/api/**");
      expect(editFires(root, path.join(root, "alias/new-file.ts")).fire).toBe(true);
    });

    it("a project reached through a symlink fires either way round", () => {
      fs.mkdirSync(path.join(root, "packages/api"), { recursive: true });
      const link = path.join(base, "project-link");
      fs.symlinkSync(root, link);
      scopedRule(root, "packages/api/**");
      expect(editFires(link, path.join(root, "packages/api/x.ts")).fire).toBe(true);
      expect(editFires(root, path.join(link, "packages/api/x.ts")).fire).toBe(true);
      expect(editFires(link, path.join(root, "packages/web/x.ts")).fire).toBe(false);
    });

    it("a symlink leading out of the project doesn't bring an outside file into scope", () => {
      fs.mkdirSync(path.join(base, "elsewhere"), { recursive: true });
      fs.symlinkSync(path.join(base, "elsewhere"), path.join(root, "vendored"));
      scopedRule(root, "packages/api/**");
      expect(editFires(root, path.join(root, "vendored/x.ts")).fire).toBe(false);
    });
  });

  describe.runIf(hasGit)("git linked worktrees", () => {
    function git(cwd: string, ...args: string[]): void {
      const r = spawnSync("git", ["-c", "user.name=dp", "-c", "user.email=dp@example.invalid", ...args], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, HOME: base, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
      });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    }

    beforeEach(() => {
      git(root, "init", "-q", "-b", "main");
      fs.writeFileSync(path.join(root, "README.md"), "x\n");
      git(root, "add", "README.md");
      git(root, "commit", "-q", "-m", "init");
      scopedRule(root, "packages/api/**");
    });

    it("a sibling worktree's path maps onto the main checkout's scope", () => {
      const wt = path.join(base, "sibling");
      git(root, "worktree", "add", "-q", "-b", "feat", wt);
      expect(canonicalProjectDir(wt).projectRoot).toBe(root);
      expect(editFires(root, path.join(wt, "packages/api/x.ts")).fire).toBe(true);
      expect(editFires(root, path.join(wt, "packages/web/x.ts")).fire).toBe(false);
    });

    it("a worktree nested inside the checkout maps too (where `isolation: worktree` puts them)", () => {
      const wt = path.join(root, ".claude/worktrees/agent-1");
      git(root, "worktree", "add", "-q", "-b", "agent-1", wt);
      expect(editFires(root, path.join(wt, "packages/api/x.ts")).fire).toBe(true);
      expect(editFires(root, path.join(wt, "packages/web/x.ts")).fire).toBe(false);
    });
  });
});

describe("#621.2 the hook loads team.json exactly when the MCP loader does", () => {
  const good = { id: "t1", kind: "avoid", concept: CONCEPT, rationale: "breaks test isolation" };

  // Each file carries one good rule beside the variation, so "loaded" is visible
  // and the all-or-nothing rule is what's under test.
  const cases: Array<[string, Record<string, unknown>]> = [
    ["a plain rule", {}],
    ["addedAt: UTC", { addedAt: "2026-01-02T03:04:05Z" }],
    ["addedAt: fractional seconds", { addedAt: "2026-01-02T03:04:05.123Z" }],
    ["addedAt: no seconds", { addedAt: "2026-01-02T03:04Z" }],
    ["addedAt: leap day", { addedAt: "2028-02-29T00:00:00Z" }],
    ["addedAt: a date only", { addedAt: "2026-01-02" }],
    ["addedAt: free text", { addedAt: "last Tuesday" }],
    ["addedAt: an offset", { addedAt: "2026-01-02T03:04:05+01:00" }],
    ["addedAt: no zone", { addedAt: "2026-01-02T03:04:05" }],
    ["addedAt: impossible month", { addedAt: "2026-13-02T03:04:05Z" }],
    ["addedAt: impossible day", { addedAt: "2026-02-30T03:04:05Z" }],
    ["addedAt: not a leap year", { addedAt: "2027-02-29T03:04:05Z" }],
    ["addedAt: hour 24", { addedAt: "2026-01-02T24:00:00Z" }],
    ["addedAt: a number", { addedAt: 1 }],
    ["addedAt: null", { addedAt: null }],
    ["addedAt: empty", { addedAt: "" }],
    ["rationale: empty", { rationale: "" }],
    ["rationale: blank is still text", { rationale: " " }],
    ["rationale: missing", { rationale: undefined }],
    ["rationale: a number", { rationale: 1 }],
    ["id: empty", { id: "" }],
    ["id: missing", { id: undefined }],
    ["concept: empty", { concept: "" }],
    ["kind: unknown", { kind: "forbid" }],
    ["addedBy: a name", { addedBy: "dana" }],
    ["addedBy: empty is allowed", { addedBy: "" }],
    ["addedBy: null", { addedBy: null }],
    ["addedBy: a number", { addedBy: 1 }],
    ["scope: paths", { scope: { paths: ["packages/api/**"] } }],
    ["scope: empty paths", { scope: { paths: [] } }],
    ["scope: empty object", { scope: {} }],
    ["scope: unknown key", { scope: { glob: "x" } }],
    ["scope: null", { scope: null }],
    ["scope: a string", { scope: "packages/api/**" }],
    ["scope: an array", { scope: ["packages/api/**"] }],
    ["scope.paths: a string", { scope: { paths: "packages/api/**" } }],
    ["scope.paths: null", { scope: { paths: null } }],
    ["scope.paths: holds a number", { scope: { paths: [1] } }],
    ["an unknown field", { note: "kept out of the schema" }],
  ];

  it.each(cases)("%s", (_name, variation) => {
    const entry = { ...good, id: "t2", ...variation };
    const file = { version: 1, preferences: [good, entry] };
    fs.writeFileSync(path.join(root, ".deeppairing", "team.json"), JSON.stringify(file));

    const schemaAccepts = parseTeamPreferencesFile(JSON.parse(JSON.stringify(file))) !== null;
    const loaderCount = loadTeamPreferences(path.join(root, ".deeppairing")).length;
    const failures: PreflightFailureSink = [];
    const hookCount = readTeamPreferences(root, failures).length;

    expect(loaderCount).toBe(schemaAccepts ? 2 : 0);
    expect(hookCount).toBe(loaderCount);
    // A rejected file still records its fault for `doctor` (#546).
    expect(failures.map((f) => [f.cls, f.source])).toEqual(schemaAccepts ? [] : [["ledger_corrupt", "team"]]);
  });

  it.each([["a string"], [1], [null], [[]]])("a rule that is %j rejects the whole file", (entry) => {
    const file = { version: 1, preferences: [good, entry] };
    fs.writeFileSync(path.join(root, ".deeppairing", "team.json"), JSON.stringify(file));
    expect(parseTeamPreferencesFile(file)).toBeNull();
    expect(readTeamPreferences(root)).toEqual([]);
  });

  it("a bad addedAt doesn't enforce in the hook, as the loader doesn't", () => {
    writeTeam(root, [{ ...good, addedAt: "last Tuesday" }]);
    expect(loadTeamPreferences(path.join(root, ".deeppairing"))).toEqual([]);
    expect(editFires(root, path.join(root, "src/x.ts")).fire).toBe(false);
  });

  it("a good addedAt still enforces", () => {
    writeTeam(root, [{ ...good, addedAt: "2026-01-02T03:04:05Z" }]);
    expect(editFires(root, path.join(root, "src/x.ts")).source).toBe("team");
  });

  it("a JSONC comment still loads", () => {
    fs.writeFileSync(path.join(root, ".deeppairing", "team.json"), `// our rules\n${JSON.stringify({ version: 1, preferences: [good] })}`);
    expect(readTeamPreferences(root)).toHaveLength(1);
  });
});

describe("#621.3 a short edit against a longer stance", () => {
  const edit = (newString: string) => editFires(root, path.join(root, "src/pay.ts"), newString);

  it.each(["client", "retry", "payment", "Client"])("a lone word from a long stance doesn't ask: %s", (word) => {
    writeStances(root, [{ description: "Add retry to the payment client", reason: "not this layer" }]);
    expect(edit(word).fire).toBe(false);
  });

  it("Write and MultiEdit behave the same", () => {
    writeStances(root, [{ description: "Add retry to the payment client", reason: "not this layer" }]);
    const file_path = path.join(root, "src/pay.ts");
    expect(evaluatePreflightHook({ toolName: "Write", toolInput: { file_path, content: "client" }, projectRoot: root }).fire).toBe(false);
    expect(evaluatePreflightHook({ toolName: "MultiEdit", toolInput: { file_path, edits: [{ new_string: "client" }] }, projectRoot: root }).fire).toBe(false);
  });

  it("the same word after a colon is held to the same bar", () => {
    writeStances(root, [{ description: "Reliability: add retry to the payment client", reason: "not this layer" }]);
    expect(edit("client").fire).toBe(false);
  });

  describe("true catches stay", () => {
    it("an edit naming most of a short stance still asks", () => {
      writeStances(root, [{ description: "redis cache", reason: "ops burden" }]);
      expect(edit("redis").source).toBe("session");
      writeStances(root, [{ description: "redis for caching", reason: "ops burden" }]);
      expect(edit("redis").source).toBe("session");
      writeStances(root, [{ description: "use redis", reason: "ops burden" }]);
      expect(edit("redis").source).toBe("session");
    });

    it("half of a longer stance is still a real fragment of it", () => {
      writeStances(root, [{ description: "Add retry to the payment client", reason: "not this layer" }]);
      expect(edit("the payment client").source).toBe("session");
    });

    it("the whole stance inside an edit asks", () => {
      writeStances(root, [{ description: "Add retry to the payment client", reason: "not this layer" }]);
      expect(edit("// add retry to the payment client here").source).toBe("session");
      expect(edit("add retry to the payment client").source).toBe("session");
    });

    it("the post-colon noun asks on its own", () => {
      writeStances(root, [{ description: "Cache backend: Redis", reason: "ops burden" }]);
      expect(edit("redis").source).toBe("session");
      writeStances(root, [{ description: "Payment layer: In-process LRU", reason: "ops burden" }]);
      expect(edit("in-process lru").source).toBe("session");
    });

    it("the concept lane is untouched", () => {
      writeStances(root, [{ description: "some older label", concept: "payment client retry", reason: "not this layer" }]);
      expect(edit("retry the payment client").source).toBe("session");
    });
  });

  it("a present_* proposal keeps its reverse catch: a title NAMES an approach, an edit fragment doesn't", () => {
    const rejectedApproaches = [{ description: "Use Redis for the session cache", reason: "ops burden", rejectedAt: "2026-01-01T00:00:00Z" }];
    const r = runPreflight({ toolName: "present_options", proposalStrings: ["Redis"], rejectedApproaches, teamPreferences: [] });
    expect(r.blocked).toBe(true);
  });
});

describe.each(["init", "plugin"] as const)("#621 through the %s hook as a real process", (copy) => {
  function hook(script: string, projectDir: string, toolInput: unknown): { stdout: string; decision?: string } {
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: projectDir, DEEPPAIRING_GUARDRAIL_BACKSTOP: "" };
    delete env.DEEPPAIRING_PREFLIGHT_MODE;
    const r = spawnSync(process.execPath, [script], {
      input: JSON.stringify({ tool_name: "Edit", tool_input: toolInput }),
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(r.error).toBeUndefined();
    expect(r.status, r.stderr).toBe(0);
    return { stdout: r.stdout, decision: r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : undefined };
  }

  function script(): string {
    if (copy === "plugin") return pluginHook;
    expect(ensurePreflightHook(root).ok).toBe(true);
    return path.join(root, ".deeppairing/hooks/preflight.mjs");
  }

  it("1: a scoped rule asks on an absolute path in scope and stays quiet outside it", () => {
    const s = script();
    scopedRule(root, "packages/api/**");
    expect(hook(s, root, { file_path: path.join(root, "packages/api/x.ts"), new_string: EDIT }).decision).toBe("ask");
    expect(hook(s, root, { file_path: path.join(root, "packages/web/x.ts"), new_string: EDIT }).stdout).toBe("");
    expect(hook(s, root, { file_path: path.join(base, "other/packages/api/x.ts"), new_string: EDIT }).stdout).toBe("");
  });

  it("2: a bad addedAt stops the hook enforcing the file", () => {
    const s = script();
    writeTeam(root, [{ id: "t1", kind: "avoid", concept: CONCEPT, rationale: "breaks test isolation", addedAt: "last Tuesday" }]);
    expect(hook(s, root, { file_path: path.join(root, "src/x.ts"), new_string: EDIT }).stdout).toBe("");
  });

  it("3: a lone word from a long stance doesn't ask; a short stance's word does", () => {
    const s = script();
    writeStances(root, [{ description: "Add retry to the payment client", reason: "not this layer" }]);
    expect(hook(s, root, { file_path: path.join(root, "src/pay.ts"), new_string: "client" }).stdout).toBe("");
    writeStances(root, [{ description: "redis cache", reason: "ops burden" }]);
    expect(hook(s, root, { file_path: path.join(root, "src/pay.ts"), new_string: "redis" }).decision).toBe("ask");
  });
});
