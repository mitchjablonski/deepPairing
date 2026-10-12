/**
 * #470 — invariant A1, pinned structurally (design §3 "Structural absence"):
 * only the daemon's in-memory registry creates an allowance, and only the
 * public, bearer-gated human route reaches its grant(). This enumerates every
 * other surface the agent can touch and fails if any of them grows a door.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../mcp/server.js";
import { FileStore } from "../store/file-store.js";
import { DaemonClient } from "../daemon/client.js";
import { createDaemon } from "../daemon/create-daemon.js";
import { withGlobalStore, type GlobalStoreFixture } from "./global-store-fixture.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, "..");
const GRANTISH = /grant|allow(?!ed)|stance[_-]?exception/i;

let fx: GlobalStoreFixture | undefined;
afterEach(() => { fx?.dispose(); fx = undefined; });

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("#470 A1 — the authority surface", () => {
  it("no MCP tool (name or input schema) can grant", async () => {
    fx = withGlobalStore("dp-sx-auth-");
    const store = fx.track(new FileStore(fx.dir, "auth_session"));
    const { server } = createMcpServer(store, () => {}, 4000);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "auth", version: "1" });
    await client.connect(ct);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(10);
    for (const tool of tools) {
      expect(tool.name).not.toMatch(GRANTISH);
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(/exceptionIds|allowance|stance_exception/i);
    }
    await client.close();
  });

  it("no IStore, FileStore or DaemonClient method grants", () => {
    const methods = (proto: object) => Object.getOwnPropertyNames(proto).filter((n) => n !== "constructor");
    for (const name of [...methods(DaemonClient.prototype), ...methods(FileStore.prototype)]) {
      expect(name, name).not.toMatch(/grant|allow/i);
    }
    const iface = fs.readFileSync(path.join(srcDir, "store", "store-interface.ts"), "utf8");
    const declared = [...iface.matchAll(/^\s{2}(\w+)\??\(/gm)].map((m) => m[1]!);
    expect(declared.length).toBeGreaterThan(20);
    for (const name of declared) expect(name, name).not.toMatch(/grant|allow/i);
  });

  it("no /api/internal/* route grants; the ONE grant route is the public human route", () => {
    fx = withGlobalStore("dp-sx-auth-");
    const daemon = createDaemon({ projectRoot: fx.dir, authToken: "t", log: () => {}, exitProcess: () => {}, releaseListenSocket: () => {}, env: {} });
    try {
      const routes = daemon.app.routes.filter((r) => r.method !== "ALL");
      const internal = routes.filter((r) => r.path.startsWith("/api/internal/"));
      expect(internal.length).toBeGreaterThan(20);
      for (const r of internal) {
        expect(`${r.method} ${r.path}`).not.toMatch(/exception$|grant|allow/i);
        if (r.path.includes("stance-exceptions")) expect(r.method).toBe("GET"); // inspect is read-only
      }
      const grants = routes.filter((r) => r.method !== "GET" && /\/exception$/.test(r.path));
      expect(grants.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /api/preflight-blocks/:blockId/exception"]);
    } finally {
      daemon.dispose();
    }
  });

  it("registry.grant() is called from exactly one place: the public route registration", () => {
    const callers = sourceFiles(srcDir).filter((f) => /\.grant\(/.test(fs.readFileSync(f, "utf8")));
    expect(callers.map((f) => path.relative(srcDir, f))).toEqual([path.join("daemon", "stance-exceptions.ts")]);
    const src = fs.readFileSync(path.join(srcDir, "daemon", "stance-exceptions.ts"), "utf8");
    const routeFn = src.slice(src.indexOf("export function registerStanceExceptionRoutes"));
    expect(routeFn).toContain("registry.grant(");
    expect(src.slice(0, src.indexOf("export function registerStanceExceptionRoutes")).match(/\.grant\(/g) ?? []).toEqual([]);
  });

  it("no CLI subcommand grants (slice 1 ships none; the interactive `stance allow` is slice 3)", () => {
    for (const file of sourceFiles(path.join(srcDir, "cli"))) {
      expect(fs.readFileSync(file, "utf8"), file).not.toMatch(/stance[\s"'`]+allow|preflight-blocks\/[^"'`]*\/exception/);
    }
  });
});
