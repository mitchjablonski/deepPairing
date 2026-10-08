/**
 * The SHIPPED plugin bundle must boot with plain `node` — no workspace, no
 * dist, no node_modules — and answer an MCP handshake.
 *
 * Why this exists: from v0.1.43 to v0.1.56, `claude-plugin/server/standalone.js`
 * crashed at module load ("TypeError: Class2 is not a constructor", Node 20,
 * 22 and 24; Linux and Windows). A dynamic `import("./lifecycle.js")` made
 * esbuild wrap zod in lazy initialisers, and the MCP SDK's top-level
 * `z.custom(...)` ran before zod was initialised. Every check stayed green
 * because nothing ever loaded the bundle: in a monorepo checkout the launcher
 * (server.mjs) prefers `packages/mcp-server/dist/standalone.js`, and only a
 * marketplace install — which has no dist — runs the bundle.
 *
 * This copies ONLY `claude-plugin/` into a temp dir (exactly what a
 * marketplace install has), launches `server.mjs` with plain node, completes
 * `initialize` + `tools/list` over stdio, and stops the daemon it spawned.
 * The daemon binds the test port window and never opens a browser.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginSrc = path.resolve(here, "../../../../claude-plugin");
const bundle = path.join(pluginSrc, "server", "standalone.js");

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) { try { cleanups.pop()!(); } catch { /* best effort */ } } });

describe.runIf(fs.existsSync(bundle))("shipped plugin bundle boots with plain node", () => {
  it("answers initialize and tools/list from a copy of claude-plugin/ alone", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dp-plugin-boot-"));
    cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    const plugin = path.join(tmp, "plugin");
    fs.cpSync(pluginSrc, plugin, { recursive: true });
    const project = path.join(tmp, "project");
    fs.mkdirSync(project);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: tmp, USERPROFILE: tmp, CLAUDE_PROJECT_DIR: project,
      DEEPPAIRING_NO_OPEN: "1", DEEPPAIRING_OPEN_BROWSER: "0", BROWSER: "none",
      // A window of its own, clear of the canonical 3847-3974 range and of the
      // per-worker vitest windows (~20000-32000 are per-run jittered; 26000+
      // collisions just fall back to the next slot).
      DEEPPAIRING_PORT_BASE: "26000",
    };
    delete env.VITEST; delete env.NODE_ENV; delete env.CLAUDE_CODE_SESSION_ID;
    const mcp: ChildProcess = spawn(process.execPath, [path.join(plugin, "server.mjs")], { cwd: project, env, stdio: ["pipe", "pipe", "pipe"] });
    cleanups.push(() => {
      mcp.kill("SIGKILL");
      try {
        const info = JSON.parse(fs.readFileSync(path.join(project, ".deeppairing", "daemon.json"), "utf8"));
        process.kill(info.pid, "SIGTERM");
      } catch { /* no daemon */ }
    });

    let stderr = "";
    mcp.stderr!.on("data", (d) => { stderr += d; });
    // Fail FAST when the server dies (the #437 crash exited at load): reject
    // every pending request with the exit code and stderr tail instead of
    // waiting out the per-request timeout.
    let exited: string | null = null;
    const failAll = () => { for (const fail of failers.values()) fail(new Error(exited!)); };
    mcp.once("exit", (code, signal) => {
      // Let the last stderr chunk land before reporting.
      setTimeout(() => {
        exited = `plugin server exited (${signal ? `signal ${signal}` : `code ${code}`}) before answering; stderr:\n${stderr.slice(-2000)}`;
        failAll();
      }, 50);
    });
    let buf = "";
    const waiters = new Map<number, (m: any) => void>();
    const failers = new Map<number, (e: Error) => void>();
    mcp.stdout!.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        waiters.get(msg.id)?.(msg);
      }
    });
    let id = 0;
    const rpc = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
      const my = ++id;
      if (exited) return reject(new Error(exited));
      const timer = setTimeout(() => reject(new Error(`${method} timed out; stderr:\n${stderr.slice(-2000)}`)), 45_000);
      const done = () => { clearTimeout(timer); waiters.delete(my); failers.delete(my); };
      waiters.set(my, (m) => { done(); resolve(m); });
      failers.set(my, (e) => { done(); reject(e); });
      mcp.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: my, method, params }) + "\n");
    });

    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bundle-boot-test", version: "0" } });
    expect(stderr).not.toMatch(/failed to start server|is not a constructor/);
    expect(init.result?.serverInfo?.name).toBeTruthy();
    mcp.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const tools = await rpc("tools/list", {});
    const names = (tools.result?.tools ?? []).map((t: { name: string }) => t.name);
    expect(names).toContain("present_findings");
    expect(names).toContain("check_feedback");

    // The daemon the bundle spawned (daemon.js, also bundled) is really up:
    // its companion answers HTTP 200 on the port it recorded.
    const info = JSON.parse(fs.readFileSync(path.join(project, ".deeppairing", "daemon.json"), "utf8"));
    expect(info.port).toBeGreaterThanOrEqual(26000);
    const res = await fetch(`http://127.0.0.1:${info.port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/<html/i);
  }, 90_000);
});

/**
 * Cheap static guard for the #437 class. esbuild emits `__esm(` lazy-init
 * wrappers only when a module is reached through a dynamic `import()` (or a
 * require of ESM). In 6f82ce2c (#317) `lifecycle.ts` — imported dynamically by
 * client.ts and create-daemon.ts — gained an `@deeppairing/shared` import, so
 * esbuild wrapped shared AND zod in `__esm` initialisers; the MCP SDK's
 * top-level `z.custom(...)` then ran before zod was initialised and every
 * marketplace install crashed at load from v0.1.43 to v0.1.56 (105 wrappers
 * in that bundle; 0 after the fix). Keep every shipped bundle free of them:
 * don't dynamically import a module that (transitively) pulls in
 * `@deeppairing/shared` or zod — import it statically.
 */
describe("shipped bundles contain no esbuild lazy-init wrappers (__esm)", () => {
  const serverDir = path.join(pluginSrc, "server");
  const bundles = fs.existsSync(serverDir)
    ? [
      path.join(pluginSrc, "server.mjs"),
      ...fs.readdirSync(serverDir).filter((f) => /\.(m?js)$/.test(f)).map((f) => path.join(serverDir, f)),
    ]
    : [];
  const generatedHooks = path.resolve(here, "../cli/hook-scripts.generated.ts");

  it.runIf(bundles.length > 0)("claude-plugin/server.mjs and claude-plugin/server/*.{js,mjs}", () => {
    const offenders = bundles.filter((file) => fs.readFileSync(file, "utf8").includes("__esm("));
    expect(offenders.map((file) => path.relative(pluginSrc, file))).toEqual([]);
    // Sanity: the set really covers the MCP server, the daemon and the hooks.
    expect(bundles.map((file) => path.basename(file))).toEqual(
      expect.arrayContaining(["standalone.js", "daemon.js", "preflight.mjs", "stop.mjs"]),
    );
  });

  it("the generated hook scripts init writes into projects", () => {
    expect(fs.readFileSync(generatedHooks, "utf8")).not.toContain("__esm(");
  });
});
