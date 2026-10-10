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
import { ensurePreflightHook, ensureStanceAllowAskHook } from "../../cli/setup-tasks.js";
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

  it("malformed or empty payloads fail open (silent, exit 0)", () => {
    const { root, command } = installedProject();
    for (const payload of ["", "{", "not json", '{"tool_input":{}}']) {
      const r = run(command, payload, { CLAUDE_PROJECT_DIR: root });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    }
  });

  it("documented residual: splitting the words gets past it (a substring check, not a parser)", () => {
    const { root, command } = installedProject();
    expect(run(command, bash("s=stance; deeppairing $s allow blk_1"), { CLAUDE_PROJECT_DIR: root }).stdout).toBe("");
  });
});
