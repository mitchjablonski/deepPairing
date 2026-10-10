/**
 * #470 slice 3 (design §3, §10 adversarial 6) — the narrow PreToolUse Bash
 * `ask` on `stance allow`. Launched for real: the installed settings row (and
 * the plugin's hooks.json row) run through /bin/sh exactly as Claude Code
 * would, with a hook payload on stdin. No mocks.
 *
 * NOT covered here, flagged for the reviewer: that a user `Bash(deeppairing:*)`
 * allow rule does not pre-empt the hook's `ask` needs a live headless Claude
 * Code session; the design asks for that check against the live platform.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { diagnoseStanceAllowAskHook, ensurePreflightHook, ensureStanceAllowAskHook, removeStanceAllowAskHook } from "../../cli/setup-tasks.js";
import {
  STANCE_ALLOW_ASK_COMMAND,
  STANCE_ALLOW_ASK_PLUGIN_COMMAND,
  STANCE_ALLOW_ASK_REASON,
  STANCE_ALLOW_ASK_SCRIPT,
} from "../stance-allow-ask.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../..");
const pluginRoot = path.join(repoRoot, "claude-plugin");
const scratch: string[] = [];
afterEach(() => { for (const d of scratch.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function installedProject(): { root: string; command: string } {
  const base = path.join(process.cwd(), "node_modules", ".cache");
  fs.mkdirSync(base, { recursive: true });
  const parent = fs.mkdtempSync(path.join(base, "dp-sx-ask-"));
  scratch.push(parent);
  const root = path.join(parent, "project with spaces"); // the quotes are part of the contract
  fs.mkdirSync(root);
  expect(ensureStanceAllowAskHook(root).ok).toBe(true);
  const settings = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.local.json"), "utf8"));
  const row = settings.hooks.PreToolUse.find((e: { matcher: string }) => e.matcher === "Bash");
  return { root, command: row.hooks[0].command };
}

function run(command: string, payload: unknown, env: Record<string, string>) {
  const started = performance.now();
  const r = spawnSync("/bin/sh", ["-c", command], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8", timeout: 10_000, env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ms: performance.now() - started };
}
const bash = (cmd: string) => ({ session_id: "s", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: cmd, description: "run it" } });
const asks = (r: { stdout: string }) => {
  if (!r.stdout.trim()) return false;
  const out = JSON.parse(r.stdout);
  return out.hookSpecificOutput?.permissionDecision === "ask" && out.hookSpecificOutput?.permissionDecisionReason === STANCE_ALLOW_ASK_REASON;
};

describe("both registrations exist and run the same check", () => {
  it("the plugin's hooks.json declares the Bash row beside (not instead of) the preflight row, and ships the exact script", () => {
    const hooks = JSON.parse(fs.readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf8")).hooks;
    expect(hooks.PreToolUse.map((e: { matcher: string }) => e.matcher)).toEqual(["Write|Edit|MultiEdit", "Bash"]);
    expect(hooks.PreToolUse[1].hooks).toEqual([{ type: "command", command: STANCE_ALLOW_ASK_PLUGIN_COMMAND }]);
    expect(fs.readFileSync(path.join(pluginRoot, "hooks", "stance-allow-ask.sh"), "utf8")).toBe(STANCE_ALLOW_ASK_SCRIPT);
  });

  it("init installs the same script and a canonical Bash row; idempotent; the preflight row and a user's own Bash row survive", () => {
    const { root, command } = installedProject();
    expect(command).toBe(STANCE_ALLOW_ASK_COMMAND);
    expect(fs.readFileSync(path.join(root, ".deeppairing", "hooks", "stance-allow-ask.sh"), "utf8")).toBe(STANCE_ALLOW_ASK_SCRIPT);
    const settingsPath = path.join(root, ".claude", "settings.local.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    settings.hooks.PreToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command: "my-own-bash-audit" }] });
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    expect(ensurePreflightHook(root).ok).toBe(true);
    const again = ensureStanceAllowAskHook(root);
    expect(again).toMatchObject({ ok: true, changed: false });
    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8")).hooks.PreToolUse;
    expect(after.filter((e: { hooks: Array<{ command: string }> }) => e.hooks[0]!.command === STANCE_ALLOW_ASK_COMMAND)).toHaveLength(1);
    expect(after.some((e: { hooks: Array<{ command: string }> }) => e.hooks[0]!.command === "my-own-bash-audit")).toBe(true);
    expect(after.some((e: { matcher: string }) => e.matcher === "Write|Edit|MultiEdit")).toBe(true);
  });
});

describe("agent-originated `stance allow` gets the ask (installed and plugin launch)", () => {
  const VARIANTS = [
    // Fable's published one-liner.
    "printf 'reason\\nallow\\n' | script -qc 'env -u CLAUDECODE deeppairing stance allow blk_1' /dev/null",
    "deeppairing stance allow blk_1",
    "node packages/mcp-server/dist/cli/init.js stance allow blk_1",
    "bash -c \"deeppairing stance allow blk_1\"",
    "python -c \"import os; os.system('deeppairing stance allow blk_1')\"",
    "deeppairing STANCE ALLOW blk_1",
    "deeppairing Stance Allow blk_1",
    "deeppairing stance\tallow blk_1",   // JSON-escaped \t on the wire
    "deeppairing stance\nallow blk_1",   // JSON-escaped \n on the wire
    "deeppairing stance   allow blk_1",
  ];
  it.each(VARIANTS)("installed: %j → ask", (cmd) => {
    const { root, command } = installedProject();
    expect(asks(run(command, bash(cmd), { CLAUDE_PROJECT_DIR: root }))).toBe(true);
  });
  it("a \\u-escaped space or tab still asks (decoded before matching)", () => {
    const { root, command } = installedProject();
    expect(asks(run(command, '{"tool_name":"Bash","tool_input":{"command":"deeppairing stance\\u0020allow x"}}', { CLAUDE_PROJECT_DIR: root }))).toBe(true);
    expect(asks(run(command, '{"tool_name":"Bash","tool_input":{"command":"deeppairing stance\\u0009allow x"}}', { CLAUDE_PROJECT_DIR: root }))).toBe(true);
  });
  it("the plugin's own command asks too", () => {
    expect(asks(run(STANCE_ALLOW_ASK_PLUGIN_COMMAND, bash("deeppairing stance allow blk_1"), { CLAUDE_PLUGIN_ROOT: pluginRoot }))).toBe(true);
  });
});

describe("narrow by construction", () => {
  const base = [
    "ls -la", "git status", "git diff --stat", "pnpm test", "pnpm build", "npm run lint", "grep -ri stance .",
    "grep -rn 'allow' src", "echo allow", "echo stance", "deeppairing stance exceptions", "deeppairing stance exceptions revoke sx_1",
    "deeppairing status", "deeppairing doctor", "cat README.md", "rg 'stance' docs", "sed -n 1,20p a.ts", "awk '{print $1}' f",
    "node -e 'console.log(1)'", "python3 script.py", "curl -s http://localhost/api/state", "docker ps", "make", "cargo test",
    "go test ./...", "tsc --noEmit", "eslint src", "find . -name '*.ts'", "wc -l src/*.ts", "echo 'stance' && echo 'allow'",
    "printf '%s' instance allowance", "git commit -m 'allow stance edits later'", "echo 'stance; allow'", "echo stanceallow",
    "ls allow stance", "mv stance.txt allow.txt", "cat substance allowed", "echo 'circumstance allowing'", "true", "pwd",
  ];
  const corpus = Array.from({ length: 200 }, (_, i) => `${base[i % base.length]}${i >= base.length ? ` # ${i}` : ""}`);

  it("200 ordinary commands: no output, exit 0, within the latency budget", () => {
    const { root, command } = installedProject();
    const times: number[] = [];
    for (const cmd of corpus) {
      const r = run(command, bash(cmd), { CLAUDE_PROJECT_DIR: root });
      expect(r.status, cmd).toBe(0);
      expect(r.stdout, cmd).toBe("");
      times.push(r.ms);
    }
    times.sort((a, b) => a - b);
    // POSIX sh + awk, no node start: the median launch stays well under the
    // ~50 ms a `node` hook costs (generous for a loaded CI box).
    expect(times[Math.floor(times.length / 2)]!).toBeLessThan(150);
  });

  it("a large command (200 KB heredoc) still exits promptly, silent", () => {
    const { root, command } = installedProject();
    const r = run(command, bash(`cat <<'EOF'\n${"x = 1\n".repeat(35_000)}EOF`), { CLAUDE_PROJECT_DIR: root });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.ms).toBeLessThan(5_000);
  });

  it("a payload with no recognisable command stays silent; a matching command asks even if the rest is malformed (the documented contract)", () => {
    const { root, command } = installedProject();
    for (const payload of ["", "{", "not json", '{"tool_input":{}}']) {
      const r = run(command, payload, { CLAUDE_PROJECT_DIR: root });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    }
    expect(asks(run(command, '{"tool_input":{"command":"deeppairing stance allow x"', { CLAUDE_PROJECT_DIR: root }))).toBe(true);
  });

  it("documented residual: splitting the words gets past it (a substring check, not a parser)", () => {
    const { root, command } = installedProject();
    expect(run(command, bash("s=stance; deeppairing $s allow blk_1"), { CLAUDE_PROJECT_DIR: root }).stdout).toBe("");
  });
});

describe("#503 review — quoting, IFS and continuation evasions are normalised; the grant route asks too", () => {
  const EVASIONS = [
    "deeppairing stance 'allow' blk_1",
    'deeppairing stance "allow" blk_1',
    'deeppairing "stance" allow blk_1',
    'deeppairing stance al""low blk_1',
    "deeppairing stance \\allow blk_1",
    "deeppairing stance \\\nallow blk_1",
    "deeppairing stance${IFS}allow blk_1",
    "deeppairing stance$IFS'allow' blk_1",
    "curl -X POST http://localhost:4000/api/preflight-blocks/blk_1/exception -d '{\"reason\":\"x\"}'",
    "wget --post-data='{}' http://127.0.0.1:4000/api/preflight-blocks/blk_1/exception",
    "node -e \"fetch('http://localhost:4000/api/preflight-blocks/blk_1/exception',{method:'POST'})\"",
  ];
  it.each(EVASIONS)("%j → ask", (cmd) => {
    const { root, command } = installedProject();
    expect(asks(run(command, bash(cmd), { CLAUDE_PROJECT_DIR: root }))).toBe(true);
  });

  it("documented false positives (asks on harmless text with the words) are no worse than before", () => {
    const { root, command } = installedProject();
    expect(asks(run(command, bash('grep -rn "stance allow" docs'), { CLAUDE_PROJECT_DIR: root }))).toBe(true);
    expect(asks(run(command, bash("git commit -m 'document stance allow'"), { CLAUDE_PROJECT_DIR: root }))).toBe(true);
    for (const quiet of ["echo 'stance; allow'", "printf instance allowance", "grep -ri stance .", "deeppairing stance exceptions"]) {
      expect(run(command, bash(quiet), { CLAUDE_PROJECT_DIR: root }).stdout, quiet).toBe("");
    }
  });
});

describe("#503 review — the installer owns only its verified entries", () => {
  function project(settings: unknown) {
    const base = path.join(process.cwd(), "node_modules", ".cache");
    fs.mkdirSync(base, { recursive: true });
    const root = fs.mkdtempSync(path.join(base, "dp-sx-own-"));
    scratch.push(root);
    fs.mkdirSync(path.join(root, ".claude"));
    const file = path.join(root, ".claude", "settings.local.json");
    fs.writeFileSync(file, JSON.stringify(settings));
    return { root, file, read: () => JSON.parse(fs.readFileSync(file, "utf8")) };
  }

  it("a mixed row keeps the user's audit command, its matcher and metadata", () => {
    const p = project({ hooks: { PreToolUse: [{ matcher: "Bash", note: "mine", hooks: [{ type: "command", command: "my-audit" }, { type: "command", command: STANCE_ALLOW_ASK_COMMAND }] }] } });
    expect(ensureStanceAllowAskHook(p.root).ok).toBe(true);
    const rows = p.read().hooks.PreToolUse;
    expect(rows).toContainEqual({ matcher: "Bash", note: "mine", hooks: [{ type: "command", command: "my-audit" }] });
    expect(rows.filter((r: { hooks: Array<{ command: string }> }) => r.hooks.some((h) => h.command === STANCE_ALLOW_ASK_COMMAND))).toHaveLength(1);
  });

  it("a user row that merely MENTIONS the script path is not ours and survives", () => {
    const mention = { matcher: "Read", hooks: [{ type: "command", command: 'printf "%s" .deeppairing/hooks/stance-allow-ask.sh' }] };
    const p = project({ hooks: { PreToolUse: [mention] } });
    expect(ensureStanceAllowAskHook(p.root).ok).toBe(true);
    expect(p.read().hooks.PreToolUse).toContainEqual(mention);
  });

  it("an invalid settings shape (hooks: [], PreToolUse not an array) is refused and left untouched", () => {
    for (const bad of [{ hooks: [] }, { hooks: { PreToolUse: {} } }, []]) {
      const p = project(bad);
      const r = ensureStanceAllowAskHook(p.root);
      expect(r.ok).toBe(false);
      expect(p.read()).toEqual(bad);
    }
  });

  it("doctor: missing → ok after install; under the plugin a local row is redundant and removing it keeps user entries", () => {
    const p = project({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-audit" }] }] } });
    expect(diagnoseStanceAllowAskHook(p.root, false)).toBe("missing");
    ensureStanceAllowAskHook(p.root);
    expect(diagnoseStanceAllowAskHook(p.root, false)).toBe("ok");
    expect(diagnoseStanceAllowAskHook(p.root, true)).toBe("redundant");
    expect(removeStanceAllowAskHook(p.root)).toMatchObject({ ok: true, changed: true });
    expect(diagnoseStanceAllowAskHook(p.root, true)).toBe("ok");
    expect(p.read().hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: "my-audit" }] }]);
  });
});
