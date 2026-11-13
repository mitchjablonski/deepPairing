import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";
import { createMcpServer } from "../server.js";
import { buildFirstCallHint } from "../first-call-hint.js";
import { evaluatePreflightHook } from "../../cli/preflight-hook-core.js";

let fx: GlobalStoreFixture;
let store: FileStore;
const clients: Client[] = [];
beforeEach(() => {
  fx = withGlobalStore("dp-team-hint-624-");
  store = fx.track(new FileStore(fx.dir, "team_hint"));
});
afterEach(async () => { for (const client of clients.splice(0)) await client.close(); fx.dispose(); });
const file = () => path.join(fx.dir, ".deeppairing", "team.json");
const warning = "Team-rule load warning";
const rule = { id: "x", kind: "avoid", concept: "redis cache", rationale: "ops" };
const writeRules = (preferences: unknown[]) => fs.writeFileSync(file(), JSON.stringify({ version: 1, preferences }));
const snapshot = () => buildFirstCallHint(store, 4000, [], { projectRoot: fx.dir });
const cachedRules = "MCP plan/review tools still use this session's cached team rules until daemon restart";
const emptyCache = "MCP plan/review tools currently have no cached team rules";
const liveHook = "The Edit/Write hook reads team.json from disk on each call instead of using this MCP cache";
const hookDecision = (toolName: "Edit" | "Write") => evaluatePreflightHook({
  toolName, projectRoot: fx.dir,
  toolInput: { file_path: path.join(fx.dir, "cache.ts"), new_string: "redis cache", content: "redis cache" },
});

async function connect() {
  const { server } = createMcpServer(store, () => {}, 4000, { projectRoot: fx.dir });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "team-warning-test", version: "1" });
  clients.push(client);
  await client.connect(ct);
  return client;
}
function text(result: { content?: unknown }) {
  return (result.content as Array<{ type: string; text?: string }>).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
}
const recall = (client: Client) => client.callTool({ name: "recall", arguments: { mode: "project", query: "" } });

describe("#624 — existing first-call guidance carries the local load snapshot", () => {
  it("warns once on first success, survives a failed opener, and never includes file text or absolute path", async () => {
    const client = await connect();
    // Added after construction/connection: this must be a fresh local read,
    // not the FileStore's cached empty team preferences or a hook-state event.
    fs.writeFileSync(file(), "{ DO_NOT_ECHO_TEAM_CONTENT");
    const failed = await client.callTool({ name: "recall", arguments: { mode: "any" } });
    expect(failed.isError).toBe(true);
    expect(text(failed)).not.toContain(warning);
    const first = text(await recall(client));
    expect(first.match(/Team-rule load warning/g)).toHaveLength(1);
    expect(first).toContain("invalid JSON or schema");
    expect(first).toContain("Tell the human");
    expect(first).toContain("/deeppairing:doctor");
    expect(first).toContain("guidance snapshot, not continuous health monitoring");
    expect(first).not.toContain("DO_NOT_ECHO_TEAM_CONTENT");
    expect(first).not.toContain(fx.dir);
    expect(text(await recall(client))).not.toContain(warning);
  });

  it("does not warn for missing/valid-empty disk and cache", async () => {
    expect(text(await recall(await connect()))).not.toContain(warning);
    writeRules([]);
    expect(text(await recall(await connect()))).not.toContain(warning);
  });

  it("warns truthfully after repair within the same server: disk valid does not reload its empty cache", async () => {
    writeRules([{ ...rule, addedAt: "bad" }]);
    const client = await connect();
    expect(text(await recall(client))).toContain("invalid JSON or schema");
    writeRules([rule]);
    // Automatic guidance is once per server session, not a health monitor.
    expect(text(await recall(client))).not.toContain(warning);
    const onboarding = await client.readResource({ uri: "deeppairing://onboarding" });
    const current = JSON.stringify(onboarding.contents);
    expect(current).toContain("disk file differs");
    expect(current).toContain(emptyCache);
    expect(current).toContain(liveHook);
    expect(current).toContain("restart the deepPairing daemon");
    expect(store.getTeamPreferences()).toEqual([]);
    // A resumed/new wrapper over the same daemon cache must warn too, even
    // though its first local disk read is now valid.
    expect(text(await recall(await connect()))).toContain(emptyCache);
    // A genuinely fresh store, unlike a new wrapper over the same daemon
    // cache, loads the repaired file and clears the discrepancy.
    const fresh = fx.track(new FileStore(fx.dir, "fresh_after_restart"));
    expect(fresh.getTeamPreferences()).toEqual([rule]);
    expect(await buildFirstCallHint(fresh, 4000, [], { projectRoot: fx.dir })).not.toContain(warning);
  });

  it("a broken disk file does not imply the cached hard rules were ignored", async () => {
    writeRules([rule]);
    store = fx.track(new FileStore(fx.dir, "cached_rules"));
    fs.writeFileSync(file(), "{ INVALID_DISK_SENTINEL");
    const hint = text(await recall(await connect()));
    expect(hint).toContain("invalid JSON or schema");
    expect(hint).toContain(cachedRules);
    expect(hint).toContain(liveHook);
    expect(hint).toContain('"redis cache"');
    expect(hint).not.toContain("were ignored");
    expect(hint).not.toContain("INVALID_DISK_SENTINEL");
    expect(store.getTeamPreferences()).toEqual([rule]);
  });

  it("changed, empty or removed disk snapshots leave the cached rules in use and request restart", async () => {
    writeRules([rule]);
    store = fx.track(new FileStore(fx.dir, "cached_before_changes"));
    expect(await snapshot()).not.toContain(warning);
    writeRules([{ ...rule, rationale: "a changed agreement" }]);
    expect(await snapshot()).toContain("disk file differs");
    writeRules([]);
    expect(await snapshot()).toContain(cachedRules);
    fs.unlinkSync(file());
    const removed = await snapshot();
    expect(removed).toContain("disk file is missing");
    expect(removed).toContain(cachedRules);
    expect(store.getTeamPreferences()).toEqual([rule]);
  });

  it.each([
    { toolName: "Edit" as const, cached: true }, { toolName: "Write" as const, cached: true },
    { toolName: "Edit" as const, cached: false }, { toolName: "Write" as const, cached: false },
  ])("distinguishes MCP cache=$cached from live $toolName hook reads across break and repair", async ({ toolName, cached }) => {
    if (cached) writeRules([rule]);
    else fs.writeFileSync(file(), "{ BROKEN_BEFORE_CACHE_LOAD");
    store = fx.track(new FileStore(fx.dir, "before_disk_changes"));
    const cachedSnapshot = cached ? [rule] : [];
    const cacheClause = cached ? cachedRules : emptyCache;
    writeRules([rule]);
    expect(hookDecision(toolName)).toMatchObject({ fire: true, source: "team" });
    fs.writeFileSync(file(), "{ BROKEN_DISK");
    const broken = await snapshot();
    expect(broken).toContain(cacheClause);
    expect(broken).toContain(liveHook);
    // Real hook evaluation reads this same broken file, not FileStore's cache.
    expect(hookDecision(toolName).fire).toBe(false);
    expect(store.getTeamPreferences()).toEqual(cachedSnapshot);

    // Change the repaired rule so even the nonempty cache remains discrepant.
    writeRules([{ ...rule, rationale: "repaired agreement" }]);
    const repaired = await snapshot();
    expect(repaired).toContain(cacheClause);
    expect(repaired).toContain(liveHook);
    expect(repaired).toContain("broken or repaired disk files affect that gate without a daemon restart");
    expect(hookDecision(toolName)).toMatchObject({ fire: true, source: "team" });
    expect(store.getTeamPreferences()).toEqual(cachedSnapshot);
  });

  it("bounds read failures and reads only the explicitly bound project", async () => {
    fs.mkdirSync(file());
    const hint = await buildFirstCallHint(store, 4000, [], { projectRoot: fx.dir });
    expect(hint).toContain("file unavailable");
    expect(hint).not.toContain(fx.dir);
    expect(hint).not.toContain("EISDIR");
    const other = path.join(fx.dir, "other-project");
    fs.mkdirSync(other);
    expect(await buildFirstCallHint(store, 4000, [], { projectRoot: other })).not.toContain(warning);
  });

  it("pins the production standalone root-passing call and proves the real server ignores the process cwd", async () => {
    // Static wiring pin, NOT a standalone subprocess test. The real in-memory
    // MCP call below separately exercises server -> hint -> bound local disk.
    // Removing standalone's fourth argument must fail even if direct server
    // fixture calls still supply it. Do not import standalone: it launches I/O.
    const source = fs.readFileSync(new URL("../../standalone.ts", import.meta.url), "utf-8");
    expect(source).toMatch(/const\s*\{\s*projectRoot,[^}]*\}\s*=\s*resolveProjectRoot\(\)/);
    expect(source).toMatch(/createMcpServer\(client,\s*noop,\s*port,\s*\{\s*projectRoot\s*\}\)/);
    expect(path.resolve(fx.dir)).not.toBe(path.resolve(process.cwd()));
    fs.writeFileSync(file(), "{ BOUND_ROOT_SENTINEL");
    const hint = text(await recall(await connect()));
    expect(hint).toContain("invalid JSON or schema");
    expect(hint).not.toContain("BOUND_ROOT_SENTINEL");
    expect(hint).not.toContain(fx.dir);
  });
});
