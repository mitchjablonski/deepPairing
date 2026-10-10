/**
 * #470 slice 3 — `deeppairing stance allow` / `stance exceptions`. The CLI
 * goes through the REAL daemon routes (the StanceWorld daemon composition,
 * discovered via the daemon.json it writes) and never writes state itself.
 * Fakes, not mocks: a recording terminal (scripted answers, a recording
 * pager) satisfies the StanceIo interface; the real pager runner is exercised
 * with a real `sh` $PAGER.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { StanceWorld, holdStance, FAKE_PORT } from "../../daemon/__tests__/stance-exceptions.harness.js";
import { defaultPager, renderSnapshot, runStanceCommand, unifiedDiff, type StanceIo } from "../stance-allow.js";

let world: StanceWorld | undefined;
afterEach(async () => { await world?.dispose(); world = undefined; });

const STANCE = "global mutable state";
const ARGS = { filePath: "src/config.ts", changeType: "modify", before: "let config = {};\nconst a = 1;", after: "export function loadConfig() { return {}; }\nconst a = 1;", reasoning: "Remove global mutable state from the config loader" };
const ANSI = /\x1b\[/;

function terminal(target: { dir: string }, over: Partial<StanceIo> & { answers?: string[] } = {}) {
  const events: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const paged: string[] = [];
  const answers = [...(over.answers ?? ["the removal is the point", "allow"])];
  const io: StanceIo = {
    projectRoot: target.dir,
    env: { NO_COLOR: "1" },
    stdinIsTTY: true,
    stdoutIsTTY: true,
    write: (t) => { out.push(t); },
    writeErr: (t) => { err.push(t); },
    readLine: async (prompt) => { events.push(`prompt:${prompt.trim()}`); return answers.shift() ?? null; },
    page: async (text) => { events.push("page"); paged.push(text); return 0; },
    fetch: (...a) => globalThis.fetch(...a),
    ...over,
  };
  return { io, events, out, err, paged };
}

async function blocked(): Promise<{ blockId: string; sessionId: string; call: () => Promise<{ isError?: boolean }> }> {
  world = new StanceWorld("dp-sx-cli-");
  world.daemon.writeDaemonInfo(FAKE_PORT); // the CLI discovers the daemon like any client
  const w = await world.wrapper();
  holdStance(world.store(w.sessionId), STANCE);
  expect((await w.call("present_code_change", ARGS)).isError).toBe(true);
  return { blockId: (await world.newestBlock()).id, sessionId: w.sessionId, call: () => w.call("present_code_change", ARGS) };
}

describe("stance allow — daemon-routed (A1), interactive, previewed", () => {
  it("pages the preview FIRST (unified diff, never JSON, no colour under NO_COLOR), then asks reason → `allow`, then grants through the real route as `cli`", async () => {
    const b = await blocked();
    const t = terminal(world!);
    expect(await runStanceCommand(["allow", b.blockId], t.io)).toBe(0);
    expect(t.events).toEqual(["page", expect.stringMatching(/^prompt:Why is this one fine\?/), expect.stringMatching(/^prompt:Type allow/)]);
    const page = t.paged[0]!;
    expect(page).toContain(`Allow one proposal past '${STANCE}'`);
    expect(page).toContain("--- a/src/config.ts");
    expect(page).toContain("+++ b/src/config.ts");
    expect(page).toMatch(/@@ -1,\d+ \+1,\d+ @@/);
    expect(page).toContain("-let config = {};");
    expect(page).toContain("+export function loadConfig() { return {}; }");
    expect(page).not.toMatch(ANSI);
    expect(page).not.toMatch(/^\s*\{"/m);
    const allowances = await world!.allowances();
    expect(allowances).toHaveLength(1);
    expect(allowances[0]).toMatchObject({ grantedVia: "cli", state: "allowed", reason: "the removal is the point" });
    // …and the agent's identical retry is admitted, labelled CLI.
    const retry = await b.call();
    expect(retry.isError).toBeFalsy();
  });

  it("names the precondition when `before` came from history", async () => {
    world = new StanceWorld("dp-sx-cli-");
    world.daemon.writeDaemonInfo(FAKE_PORT);
    const w = await world.wrapper();
    holdStance(world.store(w.sessionId), STANCE);
    const { before: _omit, ...noBefore } = ARGS;
    await w.call("present_code_change", noBefore);
    const t = terminal(world);
    expect(await runStanceCommand(["allow", (await world.newestBlock()).id], t.io)).toBe(0);
    expect(t.paged[0]).toContain("`before` is empty: there was no earlier change to src/config.ts");
  });

  it("colours the diff when NO_COLOR is unset", () => {
    expect(unifiedDiff("a.ts", "x", "y", {})).toMatch(ANSI);
    expect(unifiedDiff("a.ts", "x", "y", { NO_COLOR: "1" })).not.toMatch(ANSI);
  });

  it("renders non-code snapshots as readable text with pros and cons, never JSON", () => {
    const text = renderSnapshot({ kind: "create", type: "decision", title: "Config owner", content: { context: "Who owns config?", options: [{ title: "Inject", description: "pass it", pros: ["testable"], cons: ["churn"] }] } }, { NO_COLOR: "1" });
    expect(text).toContain("• Inject");
    expect(text).toContain("Pros: testable");
    expect(text).toContain("Cons: churn");
    expect(text).not.toMatch(/[{}]/);
  });

  it.each([
    ["stdin is not a TTY", { stdinIsTTY: false }, ["allow"], "interactive terminal"],
    ["stdout is not a TTY", { stdoutIsTTY: false }, ["allow"], "interactive terminal"],
    ["inside Claude Code", { env: { CLAUDECODE: "1" } }, ["allow"], "inside Claude Code"],
    ["in CI", { env: { CI: "true" } }, ["allow"], "in CI"],
    ["with --reason", {}, ["allow", "--reason", "x"], "no flags"],
    ["with -y", {}, ["allow", "-y"], "no flags"],
  ] as const)("refuses %s, and nothing changes", async (_label, over, argv, message) => {
    const b = await blocked();
    const t = terminal(world!, over as Partial<StanceIo>);
    const args = argv.length === 1 ? [...argv, b.blockId] : [argv[0], b.blockId, ...argv.slice(1)];
    expect(await runStanceCommand(args as string[], t.io)).toBe(1);
    expect(t.err.join("")).toContain(message);
    expect(t.paged).toHaveLength(0);
    expect(await world!.allowances()).toEqual([]);
  });

  it.each([
    ["a missing reason", [""]],
    ["a two-character reason", ["ab"]],
    ["no typed `allow`", ["a fine reason", "yes"]],
  ])("refuses %s after the preview, and nothing changes", async (_label, answers) => {
    const b = await blocked();
    const t = terminal(world!, { answers: answers as string[] });
    expect(await runStanceCommand(["allow", b.blockId], t.io)).toBe(1);
    expect(await world!.allowances()).toEqual([]);
  });

  it("a pager that fails refuses (it never falls back to dumping the preview)", async () => {
    const b = await blocked();
    const t = terminal(world!, { page: async () => 3 });
    expect(await runStanceCommand(["allow", b.blockId], t.io)).toBe(1);
    expect(t.err.join("")).toContain("pager exited with 3");
    expect(await world!.allowances()).toEqual([]);
  });

  it("fails closed with no daemon: nothing to discover, nothing granted", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-sx-nodaemon-"));
    try {
      const err: string[] = [];
      const io = { ...terminal({ dir }).io, writeErr: (t: string) => { err.push(t); } };
      expect(await runStanceCommand(["allow", "blk_x"], io)).toBe(1);
      expect(err.join("")).toContain("isn't running");
      expect(await runStanceCommand(["exceptions"], io)).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an unknown block id is refused (404 from the daemon)", async () => {
    await blocked();
    const t = terminal(world!);
    expect(await runStanceCommand(["allow", "blk_nope"], t.io)).toBe(1);
    expect(t.err.join("")).toContain("No block blk_nope");
  });

  it("`stance exceptions` lists through the daemon, and `revoke` turns one off", async () => {
    const b = await blocked();
    expect(await runStanceCommand(["allow", b.blockId], terminal(world!).io)).toBe(0);
    const t = terminal(world!);
    expect(await runStanceCommand(["exceptions"], t.io)).toBe(0);
    const id = (await world!.allowances())[0]!.id as string;
    expect(t.out.join("")).toContain(id);
    expect(t.out.join("")).toContain("CLI");
    expect(await runStanceCommand(["exceptions", "revoke", id], terminal(world!).io)).toBe(0);
    expect((await world!.allowances())[0]!.state).toBe("revoked");
  });
});

describe("the real pager runner", () => {
  it("honours $PAGER (via sh), feeds it the whole preview on stdin, and reports its exit code", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-sx-pager-"));
    try {
      const out = path.join(dir, "paged.txt");
      expect(await defaultPager("line one\nline two\n", { ...process.env, PAGER: `cat > "${out}"` })).toBe(0);
      expect(fs.readFileSync(out, "utf8")).toBe("line one\nline two\n");
      expect(await defaultPager("x", { ...process.env, PAGER: "exit 4" })).toBe(4);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the shipped CLI binary", () => {
  const cli = path.resolve("dist/cli/init.js");
  it("refuses a non-interactive `stance allow` (piped stdin), exits non-zero, grants nothing", () => {
    if (!fs.existsSync(cli)) throw new Error("Run pnpm build before this test (it runs the shipped CLI).");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-sx-bin-"));
    try {
      const r = spawnSync(process.execPath, [cli, "stance", "allow", "blk_x"], {
        cwd: dir, input: "reason\nallow\n", encoding: "utf8", timeout: 20_000,
        env: { ...process.env, DEEPPAIRING_PROJECT_ROOT: dir, DEEPPAIRING_NO_OPEN: "1", BROWSER: "none", CLAUDECODE: "", CI: "" },
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("interactive terminal");
      expect(fs.existsSync(path.join(dir, ".deeppairing", "daemon.json"))).toBe(false); // it never started a daemon
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
