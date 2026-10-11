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
import { defaultPager, PAGER_UNAVAILABLE, renderSnapshot, runStanceCommand, safeText, unifiedDiff, type StanceIo } from "../stance-allow.js";

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

async function blocked(args = ARGS): Promise<{ blockId: string; sessionId: string; call: () => Promise<{ isError?: boolean }> }> {
  world = new StanceWorld("dp-sx-cli-");
  world.daemon.writeDaemonInfo(FAKE_PORT); // the CLI discovers the daemon like any client
  const w = await world.wrapper();
  holdStance(world.store(w.sessionId), STANCE);
  expect((await w.call("present_code_change", args)).isError).toBe(true);
  return { blockId: (await world.newestBlock()).id, sessionId: w.sessionId, call: () => w.call("present_code_change", args) };
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

describe("#503 review (Sol) — truthful results, safe previews, a portable path", () => {
  it("a lost grant response after the daemon recorded it says 'couldn't confirm', never 'nothing was allowed'", async () => {
    const b = await blocked();
    world!.drop = (url, init) => url.includes("/exception") && init?.method === "POST";
    const t = terminal(world!);
    expect(await runStanceCommand(["allow", b.blockId], t.io)).toBe(1);
    expect(t.err.join("")).toContain("Couldn't confirm whether the grant went through");
    expect(t.err.join("")).not.toContain("Nothing was allowed");
    expect(await world!.allowances()).toEqual([expect.objectContaining({ state: "allowed", grantedVia: "cli" })]);
  });

  it("an idempotent repeat on a REVOKED allowance reports it truthfully and re-arms nothing", async () => {
    const b = await blocked();
    expect(await runStanceCommand(["allow", b.blockId], terminal(world!).io)).toBe(0);
    const id = (await world!.allowances())[0]!.id as string;
    expect((await world!.revoke(id)).status).toBe(200);
    const t = terminal(world!);
    expect(await runStanceCommand(["allow", b.blockId], t.io)).toBe(1);
    expect(t.err.join("")).toContain(`(${id}) is now revoked. Nothing new was allowed.`);
    expect(t.out.join("")).not.toContain("Claude can now retry");
    expect((await world!.allowances())[0]!.state).toBe("revoked");
  });

  it("agent-supplied control bytes can't drive your terminal: the preview and the list show them escaped", async () => {
    world = new StanceWorld("dp-sx-cli-");
    world.daemon.writeDaemonInfo(FAKE_PORT);
    const w = await world.wrapper();
    holdStance(world.store(w.sessionId), STANCE);
    await w.call("present_code_change", { ...ARGS, after: "ok\x1b[2J\x1b[Hhidden\rover\x07" });
    const t = terminal(world, { answers: ["reason with \x1b[31mred", "allow"] });
    expect(await runStanceCommand(["allow", (await world.newestBlock()).id], t.io)).toBe(0);
    expect(t.paged[0]).not.toMatch(/[\x07\x1b\r]/);
    expect(t.paged[0]).toContain("ok⟨ESC⟩[2J⟨ESC⟩[Hhidden⟨CR⟩over⟨BEL⟩");
    const list = terminal(world);
    await runStanceCommand(["exceptions"], list.io);
    expect(list.out.join("")).not.toMatch(/\x1b/);
  });

  it("no $PAGER and no `less` (e.g. Windows): the runner reports it, and the CLI shows the whole preview and asks you to confirm reading it", async () => {
    expect(await defaultPager("x", { PATH: "" })).toBe(PAGER_UNAVAILABLE);
    const b = await blocked();
    const t = terminal(world!, { page: async () => PAGER_UNAVAILABLE, answers: ["", "the removal is the point", "allow"] });
    expect(await runStanceCommand(["allow", b.blockId], t.io)).toBe(0);
    expect(t.out.join("")).toContain("--- a/src/config.ts");
    expect(t.events[0]).toMatch(/^prompt:That's the whole proposal/);
    const eof = terminal(world!, { page: async () => PAGER_UNAVAILABLE, answers: [] });
    expect(await runStanceCommand(["allow", b.blockId], eof.io)).toBe(1); // confirmation never given
  });
});

describe("#503 review round 2 (Sol) — every displayed field is safe; a success we can't read is unconfirmed", () => {
  const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
  const BAD = "x\x1b[8mhidden\rover\x07\x9b2J";

  it.each([
    ["decision title", { kind: "create", type: "decision", title: BAD, content: { options: [] } }],
    ["decision context", { kind: "create", type: "decision", title: "t", content: { context: BAD, options: [] } }],
    ["option title", { kind: "create", type: "decision", title: "t", content: { options: [{ title: BAD }] } }],
    ["option description", { kind: "create", type: "decision", title: "t", content: { options: [{ title: "o", description: BAD }] } }],
    ["option pros", { kind: "create", type: "decision", title: "t", content: { options: [{ title: "o", pros: ["fine", BAD] }] } }],
    ["option cons", { kind: "create", type: "decision", title: "t", content: { options: [{ title: "o", cons: [BAD] }] } }],
    ["code file path", { kind: "create", type: "code_change", title: "t", content: { filePath: BAD, before: "a", after: "b" } }],
    ["code before", { kind: "create", type: "code_change", title: "t", content: { filePath: "a.ts", before: BAD, after: "b" } }],
    ["code after", { kind: "create", type: "code_change", title: "t", content: { filePath: "a.ts", before: "a", after: BAD } }],
    ["code reasoning", { kind: "create", type: "code_change", title: "t", content: { filePath: "a.ts", before: "a", after: "b", reasoning: BAD } }],
    ["generic title", { kind: "revise", type: "research", title: BAD, content: {} }],
    ["generic nested string", { kind: "revise", type: "research", title: "t", content: { findings: [{ detail: BAD }] } }],
    ["generic key", { kind: "revise", type: "research", title: "t", content: { [BAD]: "v" } }],
  ] as const)("%s reaches the preview escaped", (_field, snapshot) => {
    for (const env of [{ NO_COLOR: "1" }, {}] as NodeJS.ProcessEnv[]) {
      const out = renderSnapshot(snapshot as never, env).replace(/\x1b\[\d+m/g, ""); // the renderer's own colours only
      expect(out).not.toMatch(CONTROLS);
      expect(out).toContain("⟨ESC⟩[8mhidden⟨CR⟩over⟨BEL⟩⟨U+009B⟩2J");
    }
  });

  it("a real present_options block with controls in pros/cons pages clean (NO_COLOR)", async () => {
    world = new StanceWorld("dp-sx-cli-");
    world.daemon.writeDaemonInfo(FAKE_PORT);
    const w = await world.wrapper();
    holdStance(world.store(w.sessionId), STANCE);
    const options = [
      { id: "a", title: "Inject", description: "d", pros: [`fast${BAD}`], cons: [BAD], effort: "low", risk: "low", recommendation: true },
      { id: "b", title: "Keep", description: "d", pros: ["x"], cons: ["y"], effort: "low", risk: "low", recommendation: false },
    ];
    await w.call("present_options", { context: "Remove global mutable state?", title: "Owner", options });
    const t = terminal(world);
    expect(await runStanceCommand(["allow", (await world.newestBlock()).id], t.io)).toBe(0);
    expect(t.paged[0]).not.toMatch(CONTROLS);
    expect(t.paged[0]).toContain("Pros: fastx⟨ESC⟩[8mhidden⟨CR⟩over⟨BEL⟩");
  });

  it.each([
    ["an unreadable 201 body", () => new Response("<<not json>>", { status: 201 })],
    ["a 201 with the wrong shape", () => new Response(JSON.stringify({ allowance: { id: 7 } }), { status: 201, headers: { "Content-Type": "application/json" } })],
    ["a 201 with no allowance", () => new Response(JSON.stringify({ ok: true }), { status: 201, headers: { "Content-Type": "application/json" } })],
  ])("%s after the daemon really granted: 'couldn't confirm', never 'refused' or 'nothing was allowed'", async (_label, replacement) => {
    const b = await blocked();
    const t = terminal(world!, {
      fetch: async (input, init) => {
        const res = await globalThis.fetch(input, init); // the real route commits
        return init?.method === "POST" && String(input).includes("/exception") ? replacement() : res;
      },
    });
    expect(await runStanceCommand(["allow", b.blockId], t.io)).toBe(1);
    const err = t.err.join("");
    expect(err).toContain("Couldn't confirm whether the grant went through");
    expect(err).not.toMatch(/refused|Nothing was allowed/);
    expect(await world!.allowances()).toEqual([expect.objectContaining({ state: "allowed", grantedVia: "cli" })]);
  });
});

describe("#503 review round 3 (Sol P2) — the preview never hides a real difference", () => {
  const strip = (s: string) => s.replace(/\x1b\[\d+m/g, "");
  const code = (before: string, after: string) =>
    strip(renderSnapshot({ kind: "create", type: "code_change", title: "t", content: { filePath: "a.ts", before, after } } as never, { NO_COLOR: "1" }));

  it("a real CR before and a typed ^M after: a hunk, never '(no changes)'", () => {
    const out = code("const s = 'x\rY';", "const s = 'x^MY';");
    expect(out).not.toContain("(no changes)");
    expect(out).toContain("-const s = 'x⟨CR⟩Y';");
    expect(out).toContain("+const s = 'x^MY';");
  });

  it.each([
    ["\r", "^M"], ["\r", "\\r"], ["\r", "⟨CR⟩"], ["\x1b", "^["], ["\x1b", "⟨ESC⟩"], ["\u202e", "⟨U+202E⟩"],
    ["\x9b", "\\x9b"], ["\x7f", "^?"], ["⟨", "⟨⟨⟩"], ["\u200b", ""], ["\ud800", "\ufffd"],
  ])("raw %j vs literal %j differ in the diff", (a, b) => {
    const out = code(`v = '${a}'`, `v = '${b}'`);
    expect(out).not.toContain("(no changes)");
    expect(out.split("\n").filter((l) => /^[+-]v/.test(l))).toHaveLength(2);
  });

  it("only truly equal texts say '(no changes)'", () => {
    expect(code("same\r\nline", "same\r\nline")).toContain("(no changes)");
  });

  it("property: distinct raw strings never render the same (exhaustive to length 3, then 20k seeded over a hostile alphabet)", () => {
    const alphabet = ["a", "^", "M", "[", "\\", "x", "0", "d", "U", "+", "2", "E", "⟨", "⟩", "C", "R", "\r", "\x1b", "\x07", "\x9b", "\x7f", "\u202e", "\u2066", "\u200b", "\u200d", "\ufeff", "\u2028", "\t", "\ud800", "\udc00", "\u{e0041}", " ", "\u3164", "\u2800", "\u034f", "\u00a0", "\u115f", "\ufe0f", "\u{e0100}"];
    let seed = 470;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const seen = new Map<string, string>();
    const check = (raw: string) => {
      const shown = safeText(raw);
      const prior = seen.get(shown);
      if (prior !== undefined) expect(prior, JSON.stringify([prior, raw, shown])).toBe(raw);
      seen.set(shown, raw);
    };
    // Exhaustive over every string of length <= 3 (the short collisions), then random longer ones.
    for (const a of alphabet) { check(a); for (const b of alphabet) { check(a + b); for (const c of alphabet) check(a + b + c); } }
    for (let i = 0; i < 20_000; i++) {
      let raw = "";
      const len = 1 + rnd(6);
      for (let k = 0; k < len; k++) raw += alphabet[rnd(alphabet.length)];
      const shown = safeText(raw);
      const prior = seen.get(shown);
      if (prior !== undefined) expect(prior, JSON.stringify([prior, raw, shown])).toBe(raw);
      seen.set(shown, raw);
    }
  });

  it("LOW: bidi overrides, isolates, zero-width and BOM characters are marked visibly (Trojan source)", () => {
    const trojan = "if (isAdmin) {\u202e } \u2066// check\u2069 \u200b\u200c\u200d\u2060\ufeff\u061c\u00ad";
    const shown = safeText(trojan);
    expect(shown).toBe("if (isAdmin) {⟨U+202E⟩ } ⟨U+2066⟩// check⟨U+2069⟩ ⟨U+200B⟩⟨U+200C⟩⟨U+200D⟩⟨U+2060⟩⟨U+FEFF⟩⟨U+061C⟩⟨U+00AD⟩");
    expect(shown).not.toMatch(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/);
    const out = code("ok", `ok${trojan}`);
    expect(out).toContain("⟨U+202E⟩");
    expect(out).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/);
  });

  it("ordinary code stays readable: tabs, newlines, backslashes, carets and non-ASCII letters pass through", () => {
    expect(safeText("\tconst re = /\\d+\\^/; // naïve 日本 ⟩")).toBe("\tconst re = /\\d+\\^/; // naïve 日本 ⟩");
  });
});

describe("#506 — visible whitespace and invisible-character fidelity", () => {
  const diff = (before: string, after: string) => unifiedDiff("a.ts", before, after, { NO_COLOR: "1" });

  it.each([
    ["x", "x ", "-x", "+x⟨SPACE⟩"],
    ["\tx", "  x", "-⟨TAB⟩x", "+⟨SPACE⟩⟨SPACE⟩x"],
    ["a b", "ab", "-a⟨SPACE⟩b", "+ab"],
    [" ", "\t", "-⟨SPACE⟩", "+⟨TAB⟩"],
  ])("whitespace-only raw %j -> %j stays distinct", (before, after, removed, added) => {
    const shown = diff(before, after);
    expect(shown).toContain(removed);
    expect(shown).toContain(added);
    expect(shown).toContain("Whitespace on marked change lines");
    expect(shown).not.toContain("(no changes)");
  });

  it("mixed hunks mark whitespace-only counterparts, not ordinary edits or unchanged context", () => {
    const shown = diff("same context\na b\nold value", "same context\nab\nnew value");
    expect(shown).toContain(" same context");
    expect(shown).toContain("-a⟨SPACE⟩b");
    expect(shown).toContain("+ab");
    expect(shown).toContain("-old value");
    expect(shown).toContain("+new value");
    expect(shown).not.toContain("same⟨SPACE⟩context");
  });

  it.each([["x", "x\n", "absent", "present"], ["x\n", "x", "present", "absent"]])(
    "final newline raw %j -> %j gets honest endpoint metadata", (before, after, oldState, newState) => {
      const shown = diff(before, after);
      expect(shown).toContain(`Final newline (LF): before ${oldState}; after ${newState}.`);
      expect(shown).not.toContain("(no changes)");
      expect(shown).toContain("Changed empty lines contain no characters");
    },
  );

  it("an extra EOF blank line is a real added empty line, not a fictional LF change", () => {
    const shown = diff("x\n", "x\n\n");
    expect(shown).toContain("@@ -1,2 +1,3 @@");
    expect(shown.split("\n").filter((l) => l === "+")).toHaveLength(1);
    expect(shown).not.toContain("Final newline (LF)");
    expect(diff("x \t\n", "x \t\n")).toContain("(no changes)");
    expect(diff("x \t\n", "x \t\n")).not.toContain("Whitespace on marked");
  });

  it.each([0x3164, 0x2800, 0x034f, 0x115f, 0x1160, 0xffa0, 0x17b4, 0x17b5,
    0x00a0, 0x1680, 0x2007, 0x202f, 0x205f, 0x3000, 0xfe0f, 0xe0100])(
    "invisible U+%s has an explicit distinct token in every preview", (cp) => {
      const ch = String.fromCodePoint(cp);
      const token = `⟨U+${cp.toString(16).toUpperCase().padStart(4, "0")}⟩`;
      expect(safeText(ch)).toBe(token);
      expect(safeText(token)).not.toBe(token);
      expect(diff("x", `x${ch}`)).toContain(`+x${token}`);
      expect(renderSnapshot({ kind: "create", type: "decision", title: ch,
        content: { context: ch, options: [] } } as never, { NO_COLOR: "1" })).toContain(token);
    },
  );

  it("ordinary emoji/non-Latin text stays readable; variation selectors deliberately become visible tokens", () => {
    expect(safeText("😀 日本 café e\u0301")).toBe("😀 日本 café e\u0301");
    expect(safeText("✈\ufe0f")).toBe("✈⟨U+FE0F⟩");
  });

  it("whitespace-mode encoding stays injective, including literal marker tokens", () => {
    const alphabet = ["", " ", "\t", "⟨", "⟩", "SPACE", "TAB", "⟨SPACE⟩", "⟨TAB⟩", "\u3164", "\u034f", "\u2800", "\r", "\n", "😀"];
    const seen = new Map<string, string>();
    for (const a of alphabet) for (const b of alphabet) for (const c of alphabet) {
      const raw = a + b + c;
      const shown = safeText(raw, true);
      const prior = seen.get(shown);
      if (prior !== undefined) expect(prior).toBe(raw);
      seen.set(shown, raw);
    }
    expect(safeText(" \t", true)).toBe("⟨SPACE⟩⟨TAB⟩");
    expect(safeText("⟨SPACE⟩⟨TAB⟩", true)).toBe("⟨⟨⟩SPACE⟩⟨⟨⟩TAB⟩");
    expect(diff("⟨SPACE⟩", " ")).toContain("-⟨⟨⟩SPACE⟩");
  });

  it("the real daemon-routed CLI pages whitespace and invisible markers before explicit reason/allow; raw retry still matches", async () => {
    const b = await blocked({ ...ARGS, before: "let config = {};", after: "let config = {}; \u3164\u2800\u034f" });
    const t = terminal(world!);
    expect(await runStanceCommand(["allow", b.blockId], t.io)).toBe(0);
    expect(t.paged[0]).toContain("⟨U+3164⟩⟨U+2800⟩⟨U+034F⟩");
    expect(t.events[0]).toBe("page");
    expect((await b.call()).isError).toBeFalsy();
    expect((await world!.allowances())[0]?.state).toBe("used");
  });

  it("the real daemon-routed whitespace-only preview marks changed lines and aborting confirmation grants nothing", async () => {
    const b = await blocked({ ...ARGS, before: "let config = {};", after: "let config = {}; " });
    const t = terminal(world!, { answers: ["reviewed whitespace", "no"] });
    expect(await runStanceCommand(["allow", b.blockId], t.io)).toBe(1);
    expect(t.paged[0]).toContain("+let⟨SPACE⟩config⟨SPACE⟩=⟨SPACE⟩{};⟨SPACE⟩");
    expect(await world!.allowances()).toHaveLength(0);
  });
});
