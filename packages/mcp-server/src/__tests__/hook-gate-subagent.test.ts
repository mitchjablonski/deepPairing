/**
 * #553 — a worker SUBAGENT's gate ask or strict-stop deny reaches the human.
 *
 * Claude Code runs PreToolUse hooks inside a subagent's tool calls too. The
 * hook input then carries the PARENT's `session_id` plus `agent_id` /
 * `agent_type`. Before this, a strict-stop deny stopped the worker and nobody
 * else heard about it (#548): the lead isn't told, and the companion record
 * (#552) didn't say a subagent made the call.
 *
 * Now both hook copies put the agent identity on the gate record, and the
 * daemon routes it exactly like a main-agent firing (#552): to the parent
 * session's tabs and the all-sessions view only, never to another session.
 *
 * Fakes, not mocks: the REAL hook processes (init-generated + shipped plugin
 * bundle), a REAL daemon on an ephemeral non-canonical port with its real
 * watcher, and REAL WebSocket clients.
 */
import { afterAll, describe, expect, it } from "vitest";
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
import { hookAgentFields } from "../cli/preflight-hook-core.js";
import { hookGateEntryFromFire } from "../store/preflight-block-log.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const PLUGIN_HOOK = path.join(repoRoot, "claude-plugin/server/preflight.mjs");
const STANCE = { description: "global mutable state", reason: "Keep configuration explicit" };
const TOKEN = "hook-gate-subagent-token";
/** Raw tool content must never reach a record, a frame or a response. */
const CONTENT_CANARY = "FAKE-CANARY-553-content";
const SID_A = "session_proj_abcd1234_claude-aaa";
const SID_B = "session_proj_abcd1234_claude-bbb";
const AGENT = { agent_id: "agent-FAKE553a", agent_type: "general-purpose" };

const roots: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function runHook(script: string, root: string, input: string, mode?: string): Promise<{ stdout: string; stderr: string; status: number | null }> {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: root, DEEPPAIRING_GUARDRAIL_BACKSTOP: "", FORCE_COLOR: "0", NO_COLOR: "1" };
  delete env.DEEPPAIRING_PREFLIGHT_MODE;
  delete env.DEEPPAIRING_PROJECT_ROOT;
  if (mode) env.DEEPPAIRING_PREFLIGHT_MODE = mode;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("hook timed out")); }, 10_000);
    child.on("error", reject);
    child.on("close", (status) => { clearTimeout(timer); resolve({ stdout, stderr, status }); });
    child.stdin.end(input);
  });
}

function makeProject(prefix: string): { root: string; initHook: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  expect(path.resolve(canonicalProjectDir(root).projectRoot)).toBe(path.resolve(root));
  fs.mkdirSync(path.join(root, ".deeppairing/sessions/s1"), { recursive: true });
  fs.writeFileSync(path.join(root, ".deeppairing/sessions/s1/artifacts.json"), "[]");
  fs.writeFileSync(path.join(root, ".deeppairing/preferences.json"), JSON.stringify({ rejectedApproaches: [STANCE] }));
  expect(ensurePreflightHook(root).ok).toBe(true);
  return { root, initHook: path.join(root, ".deeppairing/hooks/preflight.mjs") };
}

/** A Write the way Claude Code sends it from inside a worker subagent. */
function payload(root: string, file: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    tool_name: "Write",
    tool_input: { file_path: path.join(root, file), content: `export const config = {}; // global mutable state ${CONTENT_CANARY}` },
    ...extra,
  });
}

async function bootDaemon(root: string) {
  const d = createDaemon({
    projectRoot: root,
    authToken: TOKEN,
    log: () => {},
    exitProcess: () => {},
    releaseListenSocket: () => {},
    env: { DEEPPAIRING_NO_OPEN: "1", BROWSER: "none" },
  });
  const srv = serve({ fetch: d.app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => {
    const s = srv as unknown as { address(): AddressInfo | null; once(ev: string, cb: () => void): void };
    if (s.address()) return resolve();
    s.once("listening", () => resolve());
  });
  const port = (srv as unknown as { address(): AddressInfo }).address().port;
  expect(port < 3847 || port > 3974).toBe(true); // never the canonical window
  d.attachUpgradeHandler(srv as unknown as Parameters<Daemon["attachUpgradeHandler"]>[0]);
  d.startHooksWatcher();
  const sockets: WebSocket[] = [];
  async function connect(sessionId?: string) {
    const msgs: Array<Record<string, unknown>> = [];
    const q = `projectHash=${projectHashOf(root)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`;
    const sock = new WebSocket(`ws://127.0.0.1:${port}/ws?${q}`);
    sockets.push(sock);
    await new Promise<void>((resolve, reject) => {
      sock.once("error", reject);
      sock.on("message", (raw) => {
        const data = JSON.parse(String(raw)) as Record<string, unknown>;
        msgs.push(data);
        if (data.type === "connected") resolve();
      });
    });
    return msgs;
  }
  async function api(route: string, sessionId?: string): Promise<string> {
    const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}`, "X-Project-Hash": projectHashOf(root) };
    if (sessionId) headers["X-Session-Id"] = sessionId;
    const res = await fetch(`http://127.0.0.1:${port}${route}`, { headers });
    expect(res.status).toBe(200);
    return res.text();
  }
  function close() {
    for (const s of sockets) { try { s.close(); } catch { /* closed */ } }
    d.dispose();
    try { srv.close(); } catch { /* closed */ }
  }
  return { daemon: d, connect, api, close };
}

async function waitFor<T>(fn: () => T | undefined, ms = 5000): Promise<T | undefined> {
  const deadline = performance.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (performance.now() > deadline) return undefined;
    await new Promise((r) => setTimeout(r, 10));
  }
}

const readBlocks = (root: string) =>
  JSON.parse(fs.readFileSync(path.join(root, ".deeppairing/preflight-blocks.json"), "utf8")).blocks as Array<Record<string, unknown>>;

describe.each([
  ["init", (p: { initHook: string }) => p.initHook],
  ["plugin", () => PLUGIN_HOOK],
] as const)("#553 %s hook: a worker subagent's firing", (_copy, scriptOf) => {
  it.each([
    ["ask", undefined],
    ["deny", "strict-stop"],
  ] as const)("%s: attributed to the parent session, labelled with its agent type, and never reaches another session", async (decision, mode) => {
    const proj = makeProject(`dp-hook-subagent-${decision}-`);
    const world = await bootDaemon(proj.root);
    try {
      world.daemon.createSession(SID_A);
      world.daemon.createSession(SID_B);
      // ONLY session B's companion is open while A's worker is stopped.
      const tabB = await world.connect(SID_B);
      const file = `src/worker-${decision}.ts`;

      const run = await runHook(scriptOf(proj), proj.root, payload(proj.root, file, { session_id: "claude-aaa", ...AGENT }), mode);
      expect(run.status, run.stderr).toBe(0);
      const out = JSON.parse(run.stdout);
      expect(out.hookSpecificOutput.permissionDecision).toBe(decision);
      // The agent fields change only the record, never the hook's decision output.
      const lead = await runHook(scriptOf(proj), proj.root, payload(proj.root, file, { session_id: "claude-aaa" }), mode);
      expect(run.stdout).toBe(lead.stdout);

      // The fire record: bounded identity + stance/target only, no raw content.
      const state = fs.readFileSync(path.join(proj.root, ".deeppairing/hooks-state.json"), "utf8");
      expect(state).not.toContain(CONTENT_CANARY);
      const fire = (JSON.parse(state).fires as Array<Record<string, any>>).find((f) => f.gate?.agentId === AGENT.agent_id);
      expect(fire?.gate).toMatchObject({ decision, session: "claude-aaa", agentType: AGENT.agent_type, target: file, concept: STANCE.description });

      // The durable gate log: attributed to A's deepPairing session.
      const entry = await waitFor(() => {
        try { return readBlocks(proj.root).find((b) => b.targetPath === file && b.agentId === AGENT.agent_id); } catch { return undefined; }
      });
      expect(entry).toMatchObject({ lane: "hook", decision, sessionId: SID_A, agentId: AGENT.agent_id, agentType: AGENT.agent_type, concept: STANCE.description });
      expect(fs.readFileSync(path.join(proj.root, ".deeppairing/preflight-blocks.json"), "utf8")).not.toContain(CONTENT_CANARY);

      // Isolation: let every frame land, then inspect ALL of B's frames and
      // every response B's tab can fetch.
      await new Promise((r) => setTimeout(r, 400));
      const secrets = [file, AGENT.agent_id, AGENT.agent_type, CONTENT_CANARY];
      const leaked = (text: string) => secrets.filter((s) => text.includes(s));
      expect(tabB.filter((m) => m.type === "preflight_blocked")).toEqual([]);
      expect(leaked(JSON.stringify(tabB))).toEqual([]);
      // The stance itself is project-wide (B's \`connected\` snapshot carries the
      // ledger); no frame AFTER it may repeat the firing's reason.
      expect(tabB.filter((m) => m.type !== "connected" && JSON.stringify(m).includes(STANCE.reason))).toEqual([]);
      for (const route of ["/api/preflight-blocks", "/api/hook-state"]) {
        expect(leaked(await world.api(route, SID_B)), `${route} as session B`).toEqual([]);
      }

      // The parent session's own view and the all-sessions view do get it.
      const asA = JSON.parse(await world.api("/api/preflight-blocks", SID_A)).blocks as Array<Record<string, unknown>>;
      expect(asA.find((b) => b.id === entry!.id)).toMatchObject({ agentType: AGENT.agent_type, sessionId: SID_A });
      const asAll = JSON.parse(await world.api("/api/preflight-blocks")).blocks as Array<Record<string, unknown>>;
      expect(asAll.some((b) => b.id === entry!.id)).toBe(true);

      // Live: once A's tab is open, the next worker firing reaches it, labelled,
      // and B still sees nothing.
      const tabA = await world.connect(SID_A);
      const file2 = `src/worker-${decision}-2.ts`;
      await runHook(scriptOf(proj), proj.root, payload(proj.root, file2, { session_id: "claude-aaa", ...AGENT }), mode);
      const live = await waitFor(() => tabA.find((m) => m.type === "preflight_blocked" && m.targetPath === file2));
      expect(live).toMatchObject({ lane: "hook", decision, sessionId: SID_A, agentId: AGENT.agent_id, agentType: AGENT.agent_type, match: { concept: STANCE.description } });
      expect(JSON.stringify(live)).not.toContain(CONTENT_CANARY);
      await new Promise((r) => setTimeout(r, 300));
      expect(leaked(JSON.stringify(tabB)).concat(JSON.stringify(tabB).includes(file2) ? [file2] : [])).toEqual([]);
    } finally {
      world.close();
    }
  });
});

describe("#553 legacy records and bounds", () => {
  it("a fire written by an older hook (no agent fields) still surfaces, with no agent keys anywhere", async () => {
    const proj = makeProject("dp-hook-subagent-legacy-");
    const world = await bootDaemon(proj.root);
    try {
      const all = await world.connect();
      // Exactly the #552 record shape: no agentId/agentType.
      const sp = path.join(proj.root, ".deeppairing/hooks-state.json");
      const prior = fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, "utf8")) : {};
      const fire = {
        at: new Date().toISOString(), hook: "preflight", kind: "deny", mode: "strict-stop", reason: "session", id: "hf_legacy553",
        gate: { decision: "deny", source: "session", concept: STANCE.description, reason: STANCE.reason, tool: "Write", target: "src/legacy.ts" },
      };
      fs.writeFileSync(sp, JSON.stringify({ ...prior, fires: [...(prior.fires ?? []), fire] }));
      const hit = await waitFor(() => all.find((m) => m.type === "preflight_blocked" && m.targetPath === "src/legacy.ts"));
      expect(hit).toMatchObject({ lane: "hook", decision: "deny" });
      expect("agentId" in hit!).toBe(false);
      expect("agentType" in hit!).toBe(false);
      const entry = readBlocks(proj.root).find((b) => b.id === "blk_hf_legacy553");
      expect(entry).toBeDefined();
      expect(Object.keys(entry!).filter((k) => k.startsWith("agent"))).toEqual([]);
    } finally {
      world.close();
    }
  });

  it("agent fields are sanitized at the hook and validated at the daemon", () => {
    expect(hookAgentFields(undefined)).toEqual({});
    expect(hookAgentFields({})).toEqual({});
    expect(hookAgentFields({ agent_id: 42, agent_type: { x: 1 } })).toEqual({});
    const f = hookAgentFields({ agent_id: "agent/../\u0000x-1", agent_type: `Ex\u0007plore${"y".repeat(200)}` });
    expect(f.agentId).toBe("agentx-1");
    expect(f.agentType!.length).toBeLessThanOrEqual(80);
    expect(f.agentType).not.toMatch(/[\u0000-\u001f]/);

    const base = { id: "hf_x", at: new Date().toISOString(), hook: "preflight", gate: { decision: "ask", source: "session", concept: "c" } };
    // A hand-edited file with a bad id charset doesn't carry it through.
    expect(hookGateEntryFromFire({ ...base, gate: { ...base.gate, agentId: "bad id;rm", agentType: "Explore" } })).toMatchObject({ agentType: "Explore" });
    expect(hookGateEntryFromFire({ ...base, gate: { ...base.gate, agentId: "bad id;rm" } })!.agentId).toBeUndefined();
    expect(hookGateEntryFromFire({ ...base, gate: { ...base.gate, agentId: "agent-1" } })!.agentId).toBe("agent-1");
  });
});
