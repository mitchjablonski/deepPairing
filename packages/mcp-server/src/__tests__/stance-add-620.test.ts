/**
 * #620 Phase 1 item 1 — `deeppairing stance add` and `/deeppairing:reject`
 * (the `record_stance` MCP tool). Fakes, not mocks: real FileStores on tmp
 * project dirs, the real in-memory MCP server, the REAL init-generated
 * PreToolUse hook process, and the real CLI runner with a recording io.
 *
 * Every catch below is a SYNTHETIC replay — a functional check that the
 * stance reaches the gate, not evidence of a natural re-proposal.
 *
 * The daemon-routed path (DaemonClient → /memory/rejected provenance, allow
 * once, daemon restart) is daemon/__tests__/stance-add-620.e2e.test.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../mcp/server.js";
import { FileStore } from "../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "./global-store-fixture.js";
import { ensurePreflightHook } from "../cli/setup-tasks.js";
import { canonicalProjectDir } from "../git-worktree.js";
import {
  parseStanceArguments,
  recordStance,
  validateStanceInput,
  formatRecordStanceOutcome,
  RECOVERY_PROBES,
  STANCE_CONCEPT_MAX,
  MAX_PROJECT_STANCES,
} from "../store/stance-add.js";
import { runStanceAddCommand, type StanceAddIo } from "../cli/stance-add.js";
import { evaluatePreflightHook } from "../cli/preflight-hook-core.js";
import { findRejectedApproachMatch } from "../mcp/preflight-validator.js";
import { getGlobalStore } from "../store/global-store.js";

const CONCEPT = "global mutable state for config";
const REASON = "keep configuration explicit and testable";

const fixtures: GlobalStoreFixture[] = [];
const plainDirs: string[] = [];
const plainStores: FileStore[] = [];
afterEach(() => {
  for (const s of plainStores.splice(0)) s.dispose();
  for (const f of fixtures.splice(0)) f.dispose();
  for (const d of plainDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A second project for scope checks: a plain tmp dir (one global-store
 *  fixture per test, so the two projects never fight over the singleton). */
function otherProject(prefix = "dp-620-other-"): { root: string; store: FileStore } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  plainDirs.push(root);
  const store = new FileStore(root, "s620_other");
  plainStores.push(store);
  return { root, store };
}

function project(prefix = "dp-620-"): { fx: GlobalStoreFixture; root: string; store: FileStore } {
  const fx = withGlobalStore(prefix);
  fixtures.push(fx);
  const store = fx.track(new FileStore(fx.dir, "s620"));
  return { fx, root: fx.dir, store };
}

function prefsOf(root: string): { rejectedApproaches?: Array<Record<string, unknown>> } {
  const p = path.join(root, ".deeppairing", "preferences.json");
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf-8")) : {};
}

async function mcpOver(store: FileStore) {
  const { server } = createMcpServer(store, () => {}, 4000);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t620", version: "1" });
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    const text = ((r.content as Array<{ type: string; text?: string }>) ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    return { text, isError: r.isError as boolean | undefined };
  };
  return { client, call };
}

describe("#620 input — parse + validation (concept hygiene)", () => {
  it("splits on the FIRST ` -- `; a reason may contain `--`; argv takes a standalone `--`", () => {
    expect(parseStanceArguments(`${CONCEPT} -- ${REASON}`)).toEqual({ what: CONCEPT, why: REASON });
    expect(parseStanceArguments("redis for caching -- costs -- and ops")).toEqual({ what: "redis for caching", why: "costs -- and ops" });
    expect(parseStanceArguments(["redis", "for", "caching", "--", "too", "costly"])).toEqual({ what: "redis for caching", why: "too costly" });
    expect(parseStanceArguments("built-in retries")).toEqual({ what: "built-in retries", why: "" });
  });

  it("a reason is required", () => {
    for (const why of ["", "   ", "\n\t"]) {
      const v = validateStanceInput({ what: CONCEPT, why });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.error).toMatch(/reason is required/);
    }
    const noSep = parseStanceArguments(CONCEPT);
    expect(validateStanceInput(noSep).ok).toBe(false);
  });

  it("invalid or empty input is refused with a reason, never coerced", () => {
    const bad: Array<[unknown, unknown, RegExp]> = [
      [undefined, REASON, /required, as text/],
      [42, REASON, /required, as text/],
      ["", REASON, /Say what to avoid/],
      ["ab", REASON, /too short/],
      ["x".repeat(STANCE_CONCEPT_MAX + 1), REASON, /short phrase/],
      [CONCEPT, "no", /too short/],
      [CONCEPT, "y".repeat(281), /280 or fewer/],
      ["the and for", REASON, /no word the gate can match/],
      [`global‮mutable state`, REASON, /invisible characters/],
      [CONCEPT, `because​hidden`, /invisible characters/],
      [`token xoxb-FAKECANARY-000000 usage`, REASON, /secret/],
      [CONCEPT, "leaks xoxb-FAKECANARY-000000", /secret/],
    ];
    for (const [what, why, re] of bad) {
      const v = validateStanceInput({ what, why });
      expect(v.ok, String(what)).toBe(false);
      if (!v.ok) expect(v.error).toMatch(re);
    }
  });

  it("#625 — the part after a colon needs a usable word too (the matcher phrase-matches it on its own)", () => {
    // The review's exact input: `/deeppairing:reject Data: the -- because`.
    const exact = validateStanceInput(parseStanceArguments("Data: the -- because"));
    expect(exact.ok).toBe(false);
    if (!exact.ok) expect(exact.error).toMatch(/part after the colon, "the"/);
    for (const what of ["Data: the", "Cache backend: a", "Logging: is it", "Deploy:", "Deploy:   ", "Config: for the via", "a: b: the"]) {
      const v = validateStanceInput({ what, why: REASON });
      expect(v.ok, what).toBe(false);
    }
    // Controls: a real post-colon noun passes, and so does a colon later in the phrase.
    for (const what of ["Cache backend: Redis", "Deploy: Railway", "Data: the warehouse"]) {
      expect(validateStanceInput({ what, why: REASON }).ok, what).toBe(true);
    }
  });

  it("#625 — the gate would really have jammed on \"Data: the\" (why the check exists)", () => {
    const hit = findRejectedApproachMatch(["Update the README"], [{ description: "Data: the", concept: "Data: the" }]);
    expect(hit?.via).toBe("surface");
  });

  it("tidies whitespace but keeps the human's words (no path stripping, no rewording)", () => {
    const v = validateStanceInput({ what: "  src/config.ts —  global\n mutable   state ", why: "  keep it\texplicit " });
    expect(v).toEqual({ ok: true, concept: "src/config.ts — global mutable state", reason: "keep it explicit" });
  });

  it("refuses a stance that would block deepPairing's own recovery paths", () => {
    for (const what of ["deeppairing doctor", "doctor", "stance allow", "Retire this stance", "preferences.json", "deeppairing"]) {
      const v = validateStanceInput({ what, why: REASON });
      expect(v.ok, what).toBe(false);
      if (!v.ok) expect(v.error).toMatch(/recovery path/);
    }
    // The control: an ordinary stance passes, and passes every probe.
    expect(validateStanceInput({ what: CONCEPT, why: REASON }).ok).toBe(true);
    expect(RECOVERY_PROBES.length).toBeGreaterThan(5);
  });
});

describe("#620 record_stance (the /deeppairing:reject door)", () => {
  it("add → a present_* re-proposal is refused with the reason quoted (synthetic replay)", async () => {
    const { root, store } = project();
    const { call } = await mcpOver(store);
    const added = await call("record_stance", { text: `${CONCEPT} -- ${REASON}`, requestedBy: "user" });
    expect(added.isError).toBeFalsy();
    expect(added.text).toContain(`Concept: "${CONCEPT}"`);
    expect(added.text).toContain(`Reason:  "${REASON}"`);
    expect(added.text).toMatch(/Scope: {3}This project only/);
    expect(added.text).toMatch(/word matching, not meaning/);
    expect(added.text).toMatch(/fail-open/);

    const blocked = await call("present_options", {
      context: `Should we keep ${CONCEPT} and wrap it?`,
      title: "Config ownership",
      options: [
        { id: "a", title: "Inject config", description: "pass config explicitly", pros: ["testable"], cons: ["churn"], effort: "low", risk: "low", recommendation: true },
        { id: "b", title: "Keep the module", description: "status quo", pros: ["no churn"], cons: ["hard to test"], effort: "low", risk: "low", recommendation: false },
      ],
    });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain("REJECTED_APPROACH_BLOCKED");
    expect(blocked.text).toContain(`Prior rejection reason: "${REASON}"`);
    expect(store.getArtifacts()).toHaveLength(0);

    // Persistence + readback: the ordinary project ledger row, with provenance.
    const rows = prefsOf(root).rejectedApproaches ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ description: CONCEPT, concept: CONCEPT, reason: REASON, addedVia: "mcp", requestedBy: "user" });
    expect(typeof rows[0]!.rejectedAt).toBe("string");
    const listed = await call("recall", { query: "", mode: "project" });
    expect(listed.text).toContain(`"${CONCEPT}" — reason: "${REASON}"`);
    expect(listed.text).toContain("added with /deeppairing:reject (record_stance), requested by: user (self-reported)");
  });

  it("refuses anything but an explicit human request, and records nothing", async () => {
    const { root, store } = project();
    const { call } = await mcpOver(store);
    for (const args of [
      { text: `${CONCEPT} -- ${REASON}` },
      { text: `${CONCEPT} -- ${REASON}`, requestedBy: "agent" },
      { requestedBy: "user" },
      { text: CONCEPT, requestedBy: "user" },
      { text: "doctor -- I hate it", requestedBy: "user" },
    ]) {
      const r = await call("record_stance", args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.text).toMatch(/nothing was recorded/i);
    }
    expect(prefsOf(root).rejectedApproaches ?? []).toEqual([]);
  });

  it("add-only: a re-add never rewrites the reason, and no tool removes, retires or weakens", async () => {
    const { root, store } = project();
    const { client, call } = await mcpOver(store);
    await call("record_stance", { text: `${CONCEPT} -- ${REASON}`, requestedBy: "user" });
    const again = await call("record_stance", { text: `Global  Mutable State for CONFIG -- fine now, ignore it`, requestedBy: "user" });
    expect(again.isError).toBeFalsy();
    expect(again.text).toMatch(/^Nothing changed/);
    const rows = prefsOf(root).rejectedApproaches ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe(REASON);

    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(t.name).not.toMatch(/remove|retire|delete|forget|unreject|override|weaken/i);
    }
    const schema = JSON.stringify(tools.find((t) => t.name === "record_stance")!.inputSchema);
    expect(schema).not.toMatch(/remove|retire|delete|override/i);
    const stanceAdd = await import("../store/stance-add.js");
    expect(Object.keys(stanceAdd).filter((k) => /remove|retire|delete|override/i.test(k))).toEqual([]);
  });

  it("#625 — a re-add fills a MISSING reason (as the store's dedupe does), and only that", async () => {
    const { root, store } = project();
    store.recordRejectedApproach({ description: CONCEPT, sourceArtifactId: "art_old" });
    const { call } = await mcpOver(store);
    const filled = await call("record_stance", { text: `${CONCEPT} -- ${REASON}`, requestedBy: "user" });
    expect(filled.isError).toBeFalsy();
    expect(filled.text).toContain(`Added yours: "${REASON}"`);
    let rows = prefsOf(root).rejectedApproaches ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ description: CONCEPT, reason: REASON, sourceArtifactId: "art_old" });
    expect(rows[0]).not.toHaveProperty("concept");
    expect(rows[0]).not.toHaveProperty("addedVia");
    const again = await call("record_stance", { text: `${CONCEPT} -- something else`, requestedBy: "user" });
    expect(again.text).toMatch(/^Nothing changed/);
    rows = prefsOf(root).rejectedApproaches ?? [];
    expect(rows[0]!.reason).toBe(REASON);
  });

  it(`#625 — a new add past ${MAX_PROJECT_STANCES} project stances is refused; existing rows are untouched`, async () => {
    const { root, store } = project();
    const prefsPath = path.join(root, ".deeppairing", "preferences.json");
    const full = Array.from({ length: MAX_PROJECT_STANCES }, (_, i) => ({ description: `legacy stance number ${i}`, reason: "old" }));
    fs.writeFileSync(prefsPath, JSON.stringify({ rejectedApproaches: full }));
    const before = fs.readFileSync(prefsPath, "utf-8");
    const out = await recordStance(store, { what: CONCEPT, why: REASON, addedVia: "mcp", requestedBy: "user" });
    expect(out.status).toBe("invalid");
    if (out.status === "invalid") expect(out.error).toContain(`already has ${MAX_PROJECT_STANCES} stances`);
    expect(fs.readFileSync(prefsPath, "utf-8")).toBe(before);
    // A re-add of an existing row is still answered (not a new row).
    expect((await recordStance(store, { what: "legacy stance number 3", why: REASON, addedVia: "mcp", requestedBy: "user" })).status).toBe("exists");
  });

  it("#625 — with publishing on, only a stance the CLI attributes to you reaches the cross-project ledger", async () => {
    const { store } = project();
    store.setGlobalLedgerPublish(true);
    const viaMcp = await recordStance(store, { what: "redis for caching", why: REASON, addedVia: "mcp", requestedBy: "user" });
    const viaCliUnknown = await recordStance(store, { what: "global singletons", why: REASON, addedVia: "cli", requestedBy: "unknown" });
    const viaCliUser = await recordStance(store, { what: "ORM lazy loading", why: REASON, addedVia: "cli", requestedBy: "user" });
    expect([viaMcp, viaCliUnknown, viaCliUser].map((o) => o.status)).toEqual(["recorded", "recorded", "recorded"]);
    const ledger = getGlobalStore().query({ limit: 100 }).map((e) => e.concept.toLowerCase());
    expect(ledger).toContain("orm lazy loading");
    expect(ledger).not.toContain("redis for caching");
    expect(ledger).not.toContain("global singletons");
    // All three still bind THIS project.
    expect(store.getSessionMemory().rejectedApproaches.map((r) => r.concept)).toEqual(["redis for caching", "global singletons", "ORM lazy loading"]);
    // And the readback says so.
    if (viaMcp.status === "recorded") expect(formatRecordStanceOutcome(viaMcp, "This project").text).toMatch(/not published to the cross-project ledger/);
    if (viaCliUser.status === "recorded") expect(formatRecordStanceOutcome(viaCliUser, "This project").text).toMatch(/only if this project publishes/);
  });

  it("provenance survives a later write to the same file (another rejection, a retire of a different row)", async () => {
    const { root, store } = project();
    await recordStance(store, { what: CONCEPT, why: REASON, addedVia: "mcp", requestedBy: "user" });
    store.recordRejectedApproach({ description: "Cache backend: Redis", reason: "ops cost" });
    store.overrideRejectedApproach({ description: "Cache backend: Redis" });
    const rows = prefsOf(root).rejectedApproaches ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ description: CONCEPT, addedVia: "mcp", requestedBy: "user" });
  });

  it("the existing human retire path still removes a terminal-added stance", async () => {
    const { root, store } = project();
    await recordStance(store, { what: CONCEPT, why: REASON, addedVia: "mcp", requestedBy: "user" });
    expect(store.overrideRejectedApproach({ concept: CONCEPT }).retired).toBe(1);
    expect(prefsOf(root).rejectedApproaches).toEqual([]);
  });
});

describe("#620 scope + persistence", () => {
  it("project-local: a stance in project A never applies in project B", async () => {
    const a = project("dp-620-a-");
    const b = otherProject("dp-620-b-");
    await recordStance(a.store, { what: CONCEPT, why: REASON, addedVia: "cli", requestedBy: "user" });
    expect((b.store.getSessionMemory()).rejectedApproaches).toEqual([]);
    const input = { file_path: path.join(b.root, "src/config.ts"), content: `export const x = 1; // ${CONCEPT}` };
    expect(evaluatePreflightHook({ toolName: "Write", toolInput: input, projectRoot: b.root }).fire).toBe(false);
    // Control: the same edit in A fires.
    const inA = { file_path: path.join(a.root, "src/config.ts"), content: input.content };
    expect(evaluatePreflightHook({ toolName: "Write", toolInput: inA, projectRoot: a.root }).fire).toBe(true);
  });

  it("survives the store being rebuilt (what a daemon restart does) with provenance intact", async () => {
    const { fx, root, store } = project();
    await recordStance(store, { what: CONCEPT, why: REASON, addedVia: "cli", requestedBy: "unknown" });
    store.dispose();
    const fresh = fx.track(new FileStore(root, "another_session"));
    const row = fresh.getSessionMemory().rejectedApproaches.find((r) => r.concept === CONCEPT);
    expect(row).toMatchObject({ reason: REASON, addedVia: "cli", requestedBy: "unknown" });
  });
});

describe("#620 the real PreToolUse hook", () => {
  function runHook(script: string, root: string, payload: unknown): Promise<{ stdout: string; status: number | null }> {
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: root, DEEPPAIRING_GUARDRAIL_BACKSTOP: "", FORCE_COLOR: "0", NO_COLOR: "1" };
    delete env.DEEPPAIRING_PREFLIGHT_MODE;
    delete env.DEEPPAIRING_PROJECT_ROOT;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script], { env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (d) => { stdout += d; });
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("hook timed out")); }, 10_000);
      child.on("error", reject);
      child.on("close", (status) => { clearTimeout(timer); resolve({ stdout, status }); });
      child.stdin.end(JSON.stringify(payload));
    });
  }

  it("add → a matching Edit asks, quoting the reason; another project's identical Edit does not (synthetic replay)", async () => {
    const a = project("dp-620-hook-a-");
    const b = otherProject("dp-620-hook-b-");
    for (const p of [a, b]) {
      expect(path.resolve(canonicalProjectDir(p.root).projectRoot)).toBe(path.resolve(p.root));
      expect(ensurePreflightHook(p.root).ok).toBe(true);
    }
    const added = await recordStance(a.store, { ...parseStanceArguments(`${CONCEPT} -- ${REASON}`), addedVia: "mcp", requestedBy: "user" });
    expect(added.status).toBe("recorded");
    const edit = (root: string) => ({
      tool_name: "Edit",
      tool_input: { file_path: path.join(root, "src/config.ts"), old_string: "const config = load();", new_string: `// keep ${CONCEPT}\nlet config = load();` },
    });
    const run = await runHook(path.join(a.root, ".deeppairing/hooks/preflight.mjs"), a.root, edit(a.root));
    expect(run.status).toBe(0);
    const out = JSON.parse(run.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("REJECTED_APPROACH_BLOCKED");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain(REASON);

    const other = await runHook(path.join(b.root, ".deeppairing/hooks/preflight.mjs"), b.root, edit(b.root));
    expect(other.status).toBe(0);
    expect(other.stdout.trim()).toBe("");
  }, 30_000);
});

describe("#620 `deeppairing stance add` (CLI runner, same code path)", () => {
  function io(root: string, over: Partial<StanceAddIo> = {}): StanceAddIo & { out: string[]; err: string[]; state: { opened: number; roots: string[] } } {
    const out: string[] = [];
    const err: string[] = [];
    const state = { opened: 0, roots: [] as string[] };
    const base: StanceAddIo = {
      projectRoot: root,
      env: {},
      stdinIsTTY: true,
      write: (t) => { out.push(t); },
      writeErr: (t) => { err.push(t); },
      openStore: async (r) => { state.opened++; state.roots.push(r); return new FileStore(r, "cli_seed"); },
      homeDir: path.join(os.tmpdir(), "dp-620-no-such-home"),
      ...over,
    };
    return { ...base, out, err, state };
  }

  it("records with cli provenance and prints what was saved; inside Claude Code it says `unknown`", async () => {
    const { root } = project();
    const tty = io(root);
    expect(await runStanceAddCommand([...CONCEPT.split(" "), "--", ...REASON.split(" ")], tty)).toBe(0);
    expect(tty.out.join("")).toContain(`Concept: "${CONCEPT}"`);
    expect(tty.out.join("")).toContain(`Project ${path.basename(root)} (${root}) only`);
    const inside = io(root, { env: { CLAUDECODE: "1" } });
    expect(await runStanceAddCommand(["redis for caching -- serverless, no persistent cache"], inside)).toBe(0);
    const rows = prefsOf(root).rejectedApproaches ?? [];
    expect(rows.map((r) => [r.concept, r.addedVia, r.requestedBy])).toEqual([
      [CONCEPT, "cli", "user"],
      ["redis for caching", "cli", "unknown"],
    ]);
  });

  it("missing reason / no args exit 1 and write nothing", async () => {
    const { root } = project();
    const noReason = io(root);
    expect(await runStanceAddCommand(CONCEPT.split(" "), noReason)).toBe(1);
    expect(noReason.err.join("")).toMatch(/Nothing was recorded\. A reason is required/);
    const empty = io(root);
    expect(await runStanceAddCommand([], empty)).toBe(1);
    expect(empty.state.opened).toBe(0);
    expect(prefsOf(root).rejectedApproaches ?? []).toEqual([]);
  });

  it("#625 — from a subdirectory it writes to the project's .deeppairing/, not the cwd's, and says which", async () => {
    const { root } = project();
    const sub = path.join(root, "packages", "api", "src");
    fs.mkdirSync(sub, { recursive: true });
    const run = io(sub);
    expect(await runStanceAddCommand([CONCEPT, "--", REASON], run)).toBe(0);
    expect(run.state.roots).toEqual([root]);
    expect(run.out.join("")).toContain(`(${root})`);
    expect(fs.existsSync(path.join(sub, ".deeppairing"))).toBe(false);
    expect((prefsOf(root).rejectedApproaches ?? []).map((r) => r.concept)).toEqual([CONCEPT]);
  });

  it("#625 — no project at or above the cwd (and never the home dir's ~/.deeppairing): refuse, print where it looked, write nothing", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dp-620-home-"));
    plainDirs.push(home);
    fs.mkdirSync(path.join(home, ".deeppairing", "sessions"), { recursive: true }); // looks like a project marker, but it's home
    fs.writeFileSync(path.join(home, ".deeppairing", "preferences.json"), "{}");
    const proj = path.join(home, "code", "fresh");
    fs.mkdirSync(proj, { recursive: true });
    const run = io(proj, { homeDir: home });
    expect(await runStanceAddCommand([CONCEPT, "--", REASON], run)).toBe(1);
    expect(run.state.opened).toBe(0);
    expect(run.err.join("")).toContain(`No deepPairing project at or above ${proj}`);
    expect(fs.readFileSync(path.join(home, ".deeppairing", "preferences.json"), "utf-8")).toBe("{}");
    expect(fs.existsSync(path.join(proj, ".deeppairing"))).toBe(false);
  });

  it("a failed write surfaces as a thrown error, not a silent success", async () => {
    const { root } = project();
    const failing = io(root, {
      openStore: async () => ({
        getSessionMemory: () => ({ rejectedApproaches: [], approvedPatterns: [] }),
        recordRejectedApproach: () => { throw Object.assign(new Error("Project preferences lock busy"), { code: "ELOCKED" }); },
      }),
    });
    await expect(runStanceAddCommand([CONCEPT, "--", REASON], failing)).rejects.toThrow(/lock busy/);
    expect(failing.out.join("")).not.toMatch(/Stance recorded/);
  });
});

