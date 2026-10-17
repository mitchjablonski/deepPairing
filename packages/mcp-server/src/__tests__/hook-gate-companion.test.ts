/**
 * #544 — the companion shows WHY the PreToolUse gate is asking.
 *
 * Claude Code's native ask dialog doesn't render the hook's reason (upstream
 * anthropics/claude-code#102892), so the human answering it can't see which
 * stance matched. The hook now writes a structured gate record onto the
 * hooks-state fire it already appends, and the daemon's hooks-state watcher
 * turns that into a durable gate-log entry plus a live `preflight_blocked`
 * (lane "hook") to every open tab.
 *
 * Fakes, not mocks: the REAL hook process (both the init-generated copy and
 * the shipped plugin bundle), a REAL daemon composition listening on an
 * ephemeral (non-canonical) port with its real fs watcher, and a REAL
 * WebSocket client.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import WebSocket from "ws";
import { createDaemon, type Daemon } from "../daemon/create-daemon.js";
import { projectHashOf } from "../project-root.js";
import { canonicalProjectDir } from "../git-worktree.js";
import { ensurePreflightHook } from "../cli/setup-tasks.js";
import { withGlobalStore, type GlobalStoreFixture } from "./global-store-fixture.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const PLUGIN_HOOK = path.join(repoRoot, "claude-plugin/server/preflight.mjs");
/** The companion must show the ask before the human can answer the prompt. */
const DELIVERY_BOUND_MS = 1000;
/** The hook makes no network call; with the daemon down it must still finish well inside this. */
const HOOK_BOUND_MS = 3000;

const STANCE = { description: "global mutable state", reason: "Keep configuration explicit" };

interface HookRun { stdout: string; stderr: string; status: number | null; spawnedAt: number; exitedAt: number }

function runHook(script: string, root: string, input: string, mode?: string): Promise<HookRun> {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: root, DEEPPAIRING_GUARDRAIL_BACKSTOP: "", FORCE_COLOR: "0", NO_COLOR: "1" };
  delete env.DEEPPAIRING_PREFLIGHT_MODE;
  delete env.DEEPPAIRING_PROJECT_ROOT;
  if (mode) env.DEEPPAIRING_PREFLIGHT_MODE = mode;
  return new Promise((resolve, reject) => {
    const spawnedAt = performance.now();
    const child = spawn(process.execPath, [script], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("hook timed out")); }, 10_000);
    child.on("error", reject);
    child.on("close", (status) => { clearTimeout(timer); resolve({ stdout, stderr, status, spawnedAt, exitedAt: performance.now() }); });
    child.stdin.end(input);
  });
}

function makeProject(prefix: string, dir?: string): { root: string; initHook: string } {
  // Outside the checkout: a fixture inside a linked worktree would resolve to
  // the real project's ledger (#532).
  const root = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  expect(path.resolve(canonicalProjectDir(root).projectRoot)).toBe(path.resolve(root));
  fs.mkdirSync(path.join(root, ".deeppairing/sessions/s1"), { recursive: true });
  fs.writeFileSync(path.join(root, ".deeppairing/sessions/s1/artifacts.json"), "[]");
  fs.writeFileSync(path.join(root, ".deeppairing/preferences.json"), JSON.stringify({ rejectedApproaches: [STANCE] }));
  expect(ensurePreflightHook(root).ok).toBe(true);
  return { root, initHook: path.join(root, ".deeppairing/hooks/preflight.mjs") };
}

function writePayload(root: string, file = "src/config.ts", content = "export const config = {}; // global mutable state") {
  return JSON.stringify({ tool_name: "Write", tool_input: { file_path: path.join(root, file), content } });
}

const roots: string[] = [];
let project: { root: string; initHook: string };
let daemon: Daemon;
let server: ReturnType<typeof serve>;
let port = 0;
let ws: WebSocket;
const received: Array<{ at: number; data: Record<string, unknown> }> = [];

let fx: GlobalStoreFixture;

beforeAll(async () => {
  // Never the real ~/.deeppairing ledger: the fixture's dir is the project.
  fx = withGlobalStore("dp-hook-gate-");
  project = makeProject("dp-hook-gate-", fx.dir);
  daemon = createDaemon({
    projectRoot: project.root,
    authToken: "hook-gate-token",
    log: () => {},
    exitProcess: () => {},
    releaseListenSocket: () => {},
    env: { DEEPPAIRING_NO_OPEN: "1", BROWSER: "none" },
  });
  server = serve({ fetch: daemon.app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => {
    const s = server as unknown as { address(): AddressInfo | null; once(ev: string, cb: () => void): void };
    if (s.address()) return resolve();
    s.once("listening", () => resolve());
  });
  port = (server as unknown as { address(): AddressInfo }).address().port;
  daemon.attachUpgradeHandler(server as unknown as Parameters<Daemon["attachUpgradeHandler"]>[0]);
  daemon.startHooksWatcher();
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws?projectHash=${projectHashOf(project.root)}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("error", reject);
    ws.on("message", (raw) => {
      const data = JSON.parse(String(raw)) as Record<string, unknown>;
      received.push({ at: performance.now(), data });
      if (data.type === "connected") resolve();
    });
  });
}, 30_000);

afterAll(() => {
  // The bounds are asserted in each test; set DP_544_LATENCY_FILE to keep the numbers.
  const rounded = Object.fromEntries(Object.entries(latencies).map(([k, v]) => [k, Math.round(v * 10) / 10]));
  if (process.env.DP_544_LATENCY_FILE) fs.appendFileSync(process.env.DP_544_LATENCY_FILE, JSON.stringify(rounded) + "\n");
  try { ws?.close(); } catch { /* closed */ }
  daemon?.dispose();
  try { server?.close(); } catch { /* closed */ }
  fx?.dispose();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function waitForHookBlock(after: number, targetPath: string): Promise<{ at: number; data: Record<string, unknown> }> {
  const deadline = performance.now() + 5000;
  for (;;) {
    const hit = received.find((m) => m.at >= after && m.data.type === "preflight_blocked" && m.data.lane === "hook" && m.data.targetPath === targetPath);
    if (hit) return hit;
    if (performance.now() > deadline) throw new Error(`no hook preflight_blocked for ${targetPath}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function gateLog(): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`http://127.0.0.1:${port}/api/preflight-blocks`, { headers: { Authorization: "Bearer hook-gate-token", "X-Project-Hash": projectHashOf(project.root) } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { blocks: Array<Record<string, unknown>> }).blocks;
}

const latencies: Record<string, number> = {};

describe.each([
  ["init", () => project.initHook],
  ["plugin", () => PLUGIN_HOOK],
] as const)("#544 %s hook → companion", (copy, script) => {
  it("an ask reaches the companion live, with stance, reason, tool and target, and the decision is unchanged", async () => {
    expect(port < 3847 || port > 3974).toBe(true); // never the canonical window
    const file = `src/${copy}-config.ts`;
    const run = await runHook(script(), project.root, writePayload(project.root, file));
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout);
    // Decision semantics unchanged: ask stays ask, reason + systemMessage stay.
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("REJECTED_APPROACH_BLOCKED");
    expect(out.systemMessage).toBe(out.hookSpecificOutput.permissionDecisionReason);
    expect(out.continue).toBeUndefined();

    const hit = await waitForHookBlock(run.spawnedAt, file);
    // Signed: negative means the tab had it before the hook even exited (the
    // fire is written before the decision is printed).
    const afterExit = hit.at - run.exitedAt;
    latencies[`${copy} ask: hook exit → WS`] = afterExit;
    latencies[`${copy} ask: hook spawn → WS`] = hit.at - run.spawnedAt;
    expect(afterExit).toBeLessThan(DELIVERY_BOUND_MS);
    expect(hit.data).toMatchObject({
      lane: "hook", decision: "ask", toolName: "Write", targetPath: file, source: "session", eligible: false,
      match: { concept: STANCE.description, reason: STANCE.reason },
    });
    expect(typeof hit.data.blockId).toBe("string");

    const entry = (await gateLog()).find((b) => b.id === hit.data.blockId);
    expect(entry).toMatchObject({
      lane: "hook", decision: "ask", toolName: "Write", targetPath: file, concept: STANCE.description, reason: STANCE.reason,
    });
    expect(Number.isFinite(Date.parse(String(entry!.at)))).toBe(true);
  });

  it("a strict-stop deny is recorded as a deny, never an ask", async () => {
    const file = `src/${copy}-strict.ts`;
    const run = await runHook(script(), project.root, writePayload(project.root, file), "strict-stop");
    expect(JSON.parse(run.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    const hit = await waitForHookBlock(run.spawnedAt, file);
    expect(hit.data).toMatchObject({ decision: "deny", match: { concept: STANCE.description } });
    expect((await gateLog()).find((b) => b.id === hit.data.blockId)).toMatchObject({ decision: "deny", ineligibleReason: "hook_deny" });
  });

  it("the deeppairing-state guardrail class reaches the companion as a guarded file", async () => {
    const file = copy === "init" ? ".claude/settings.json" : ".deeppairing/team.json";
    const run = await runHook(script(), project.root, writePayload(project.root, file, "{}"));
    const out = JSON.parse(run.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(out.systemMessage).toBe(out.hookSpecificOutput.permissionDecisionReason);
    const hit = await waitForHookBlock(run.spawnedAt, file);
    latencies[`${copy} guardrail: hook exit → WS`] = hit.at - run.exitedAt;
    expect(hit.at - run.exitedAt).toBeLessThan(DELIVERY_BOUND_MS);
    expect(hit.data).toMatchObject({ decision: "ask", guardrail: "deeppairing-state", toolName: "Write", match: { concept: "deepPairing's own state" } });
    expect(String((hit.data.match as Record<string, unknown>).reason)).toContain("your stances");
  });
});

describe("#544 daemon down", () => {
  it.each(["init", "plugin"] as const)("%s: the hook's output is byte-identical and bounded, and the fire still carries its gate record", async (copy) => {
    // A second project with NO daemon watching it.
    const down = makeProject("dp-hook-gate-down-");
    roots.push(down.root);
    const script = copy === "init" ? down.initHook : PLUGIN_HOOK;
    const downRun = await runHook(script, down.root, writePayload(down.root));
    expect(downRun.status, downRun.stderr).toBe(0);
    expect(downRun.stderr).toBe("");
    expect(downRun.exitedAt - downRun.spawnedAt).toBeLessThan(HOOK_BOUND_MS);
    latencies[`${copy} daemon down: hook wall time`] = downRun.exitedAt - downRun.spawnedAt;

    // Same edit against the live-daemon project: identical decision output
    // (the paths differ only in the project root they name).
    const upRun = await runHook(copy === "init" ? project.initHook : PLUGIN_HOOK, project.root, writePayload(project.root));
    expect(downRun.stdout.split(down.root).join("<root>")).toBe(upRun.stdout.split(project.root).join("<root>"));
    expect(JSON.parse(downRun.stdout).hookSpecificOutput.permissionDecision).toBe("ask");

    const fire = JSON.parse(fs.readFileSync(path.join(down.root, ".deeppairing/hooks-state.json"), "utf8")).fires.at(-1);
    expect(fire).toMatchObject({ hook: "preflight", kind: "ask", gate: { decision: "ask", tool: "Write", target: "src/config.ts", concept: STANCE.description, reason: STANCE.reason } });
    expect(fire.id).toMatch(/^hf_/);
  });

});

/** A second, independent daemon on its own project (and ephemeral port). */
async function bootDaemon(root: string, deps: Partial<Parameters<typeof createDaemon>[0]> = {}) {
  const d = createDaemon({
    projectRoot: root,
    authToken: "hook-gate-token",
    log: () => {},
    exitProcess: () => {},
    releaseListenSocket: () => {},
    env: { DEEPPAIRING_NO_OPEN: "1", BROWSER: "none" },
    ...deps,
  });
  const srv = serve({ fetch: d.app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => {
    const s = srv as unknown as { address(): AddressInfo | null; once(ev: string, cb: () => void): void };
    if (s.address()) return resolve();
    s.once("listening", () => resolve());
  });
  const p = (srv as unknown as { address(): AddressInfo }).address().port;
  expect(p < 3847 || p > 3974).toBe(true);
  d.attachUpgradeHandler(srv as unknown as Parameters<Daemon["attachUpgradeHandler"]>[0]);
  d.startHooksWatcher();
  const sockets: WebSocket[] = [];
  async function connect(sessionId?: string) {
    const msgs: Array<{ at: number; data: Record<string, unknown> }> = [];
    const q = `projectHash=${projectHashOf(root)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`;
    const sock = new WebSocket(`ws://127.0.0.1:${p}/ws?${q}`);
    sockets.push(sock);
    await new Promise<void>((resolve, reject) => {
      sock.once("error", reject);
      sock.on("message", (raw) => {
        const data = JSON.parse(String(raw)) as Record<string, unknown>;
        msgs.push({ at: performance.now(), data });
        if (data.type === "connected") resolve();
      });
    });
    return msgs;
  }
  function close() {
    for (const s of sockets) { try { s.close(); } catch { /* closed */ } }
    d.dispose();
    try { srv.close(); } catch { /* closed */ }
  }
  return { daemon: d, connect, close };
}

async function waitIn(msgs: Array<{ at: number; data: Record<string, unknown> }>, pred: (d: Record<string, unknown>) => boolean, ms = 5000) {
  const deadline = performance.now() + ms;
  for (;;) {
    const hit = msgs.find((m) => pred(m.data));
    if (hit) return hit;
    if (performance.now() > deadline) return undefined;
    await new Promise((r) => setTimeout(r, 5));
  }
}

function sessionPayload(root: string, file: string, sessionId: string) {
  return JSON.stringify({ ...JSON.parse(writePayload(root, file)), session_id: sessionId });
}

describe("#544 review LOWs", () => {
  it("a watcher that never delivers (or errors) still surfaces the toast through the stat poll", async () => {
    const proj = makeProject("dp-hook-gate-poll-");
    roots.push(proj.root);
    // Fake watcher: a real EventEmitter that never reports a change — the
    // WSL /mnt/c class. It then errors, so guardWatcher closes it outright.
    const { EventEmitter } = await import("node:events");
    let fake: (InstanceType<typeof EventEmitter> & { close(): void }) | undefined;
    const world = await bootDaemon(proj.root, {
      watch: () => {
        fake = Object.assign(new EventEmitter(), { close() {} });
        return fake;
      },
    });
    try {
      fake!.emit("error", Object.assign(new Error("inotify unavailable"), { code: "ENOSYS" }));
      const msgs = await world.connect();
      const run = await runHook(PLUGIN_HOOK, proj.root, writePayload(proj.root, "src/polled.ts"));
      expect(JSON.parse(run.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
      const hit = await waitIn(msgs, (d) => d.type === "preflight_blocked" && d.targetPath === "src/polled.ts", 3000);
      expect(hit, "the poll must deliver what the watcher missed").toBeDefined();
      latencies["poll fallback: hook exit → WS"] = hit!.at - run.exitedAt;
      expect(hit!.at - run.exitedAt).toBeLessThan(1500);
      // Exactly once, even as the poll keeps ticking.
      await new Promise((r) => setTimeout(r, 1700));
      expect(msgs.filter((m) => m.data.type === "preflight_blocked" && m.data.targetPath === "src/polled.ts")).toHaveLength(1);
    } finally {
      world.close();
    }
  });

  it("routes a hook ask to the matching session's tabs only, and to every tab without a session id", async () => {
    const proj = makeProject("dp-hook-gate-sessions-");
    roots.push(proj.root);
    const world = await bootDaemon(proj.root);
    try {
      const sidA = "session_proj_abcd1234_claude-aaa";
      const sidB = "session_proj_abcd1234_claude-bbb";
      world.daemon.createSession(sidA);
      world.daemon.createSession(sidB);
      const tabA = await world.connect(sidA);
      const tabB = await world.connect(sidB);
      const isAsk = (file: string) => (d: Record<string, unknown>) => d.type === "preflight_blocked" && d.targetPath === file;

      // Two concurrent hooks, one per Claude session.
      await Promise.all([
        runHook(PLUGIN_HOOK, proj.root, sessionPayload(proj.root, "src/a.ts", "claude-aaa")),
        runHook(proj.initHook, proj.root, sessionPayload(proj.root, "src/b.ts", "claude-bbb")),
      ]);
      const a = await waitIn(tabA, isAsk("src/a.ts"));
      const b = await waitIn(tabB, isAsk("src/b.ts"));
      expect(a?.data.sessionId).toBe(sidA);
      expect(b?.data.sessionId).toBe(sidB);
      await new Promise((r) => setTimeout(r, 300));
      expect(tabA.some((m) => isAsk("src/b.ts")(m.data))).toBe(false);
      expect(tabB.some((m) => isAsk("src/a.ts")(m.data))).toBe(false);

      const blocks = JSON.parse(fs.readFileSync(path.join(proj.root, ".deeppairing/preflight-blocks.json"), "utf8")).blocks as Array<Record<string, unknown>>;
      expect(blocks.find((x) => x.targetPath === "src/a.ts")?.sessionId).toBe(sidA);
      expect(blocks.find((x) => x.targetPath === "src/b.ts")?.sessionId).toBe(sidB);

      // No session id (or no matching session): every tab sees it.
      await runHook(PLUGIN_HOOK, proj.root, writePayload(proj.root, "src/c.ts"));
      expect(await waitIn(tabA, isAsk("src/c.ts"))).toBeDefined();
      expect(await waitIn(tabB, isAsk("src/c.ts"))).toBeDefined();
    } finally {
      world.close();
    }
  });
});
