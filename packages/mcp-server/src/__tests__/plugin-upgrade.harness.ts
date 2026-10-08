/** Real released/candidate runtimes only; no workspace store/schema imports. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const BASELINE_COMMIT = "d9efe325454f96473ec84a4537e38661ffdd9aac";
const runtimeFiles = ["server.mjs", "server/package.json", "server/standalone.js", "server/daemon.js", "server/web/index.html", ".claude-plugin/plugin.json", "LICENSE"];
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Hash-check before executing, using only Node builtins (including on Windows). */
export function expandReleasedRuntime(fixture: string, destination: string): void {
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture, "manifest.json"), "utf8"));
  if (manifest.version !== "0.1.57" || manifest.commit !== BASELINE_COMMIT) throw new Error("unrecognized upgrade baseline provenance");
  const compressed = fs.readFileSync(path.join(fixture, "runtime.json.gz"));
  if (compressed.length !== manifest.archive.bytes || sha256(compressed) !== manifest.archive.sha256) throw new Error("upgrade baseline archive hash mismatch");
  const files = JSON.parse(gunzipSync(compressed, { maxOutputLength: 4 * 1024 * 1024 }).toString("utf8")) as Record<string, string>;
  if (JSON.stringify(Object.keys(files).sort()) !== JSON.stringify([...runtimeFiles].sort())) throw new Error("upgrade baseline runtime file set changed");
  for (const file of runtimeFiles) {
    const bytes = Buffer.from(files[file], "utf8");
    const expected = manifest.files[file];
    const gitBlob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256 || gitBlob !== expected.gitBlob) throw new Error(`upgrade baseline file hash mismatch: ${file}`);
    const target = path.join(destination, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  const plugin = JSON.parse(fs.readFileSync(path.join(destination, ".claude-plugin/plugin.json"), "utf8"));
  if (plugin.version !== "0.1.57") throw new Error("released plugin version mismatch");
}

interface DaemonInfo { pid: number; port: number; projectRoot: string; authToken?: string; projectHash?: string }
interface SessionListing { sessions: Array<{ sessionId: string }> }

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 40));
async function until(check: () => boolean, description: string, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await pause();
  }
}

export class UpgradeProject {
  readonly tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dp-plugin-upgrade-"));
  readonly project = path.join(this.tmp, "project");
  readonly home = path.join(this.tmp, "home");
  private daemon: ChildProcess | null = null;
  private info: DaemonInfo | null = null;
  private clients: Client[] = [];
  private stderr = "";
  private env: Record<string, string>;

  constructor() {
    fs.mkdirSync(this.project); fs.mkdirSync(this.home);
    this.env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    // Both os.homedir forms and config/cache roots must stay in this sandbox.
    Object.assign(this.env, {
      HOME: this.home, USERPROFILE: this.home, XDG_CONFIG_HOME: path.join(this.home, ".config"), XDG_CACHE_HOME: path.join(this.home, ".cache"),
      CLAUDE_PROJECT_DIR: this.project, DEEPPAIRING_PROJECT_ROOT: this.project,
      DEEPPAIRING_NO_OPEN: "1", DEEPPAIRING_OPEN_BROWSER: "0", BROWSER: "none",
      DEEPPAIRING_PORT_BASE: "33000", DEEPPAIRING_PORT_SPAN: "128",
    });
    for (const key of ["VITEST", "NODE_ENV", "CLAUDE_CODE_SESSION_ID", "NODE_OPTIONS", "DEEPPAIRING_GLOBAL_DIR"]) delete this.env[key];
  }

  async start(plugin: string): Promise<void> {
    if (this.daemon) throw new Error("previous runtime must stop before upgrade");
    this.stderr = "";
    // Own the actual ChildProcess: never signal a PID discovered from user data.
    this.daemon = spawn(process.execPath, [path.join(plugin, "server/daemon.js")], { cwd: this.project, env: this.env, stdio: ["ignore", "ignore", "pipe"] });
    this.daemon.stderr!.on("data", (chunk) => { this.stderr += String(chunk); });
    const sidecar = path.join(this.project, ".deeppairing/daemon.json");
    await until(() => {
      if (this.daemon!.exitCode !== null || this.daemon!.signalCode !== null) throw new Error(`runtime exited during startup: ${this.stderr}`);
      try {
        const info = JSON.parse(fs.readFileSync(sidecar, "utf8")) as DaemonInfo;
        if (info.pid !== this.daemon!.pid || path.resolve(info.projectRoot) !== this.project) return false;
        if (info.port < 33000 || info.port >= 33128) throw new Error("runtime escaped isolated port boundary");
        this.info = info;
        return true;
      } catch (error) {
        if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    }, "owned runtime startup");
    // The companion shell is the supported credential/bootstrap interface in
    // both versions, including candidates that split daemon.json from secrets.
    const shell = await fetch(`http://127.0.0.1:${this.info!.port}/`, { signal: AbortSignal.timeout(10_000) });
    if (!shell.ok) throw new Error(`runtime shell: HTTP ${shell.status}`);
    const html = await shell.text();
    const token = html.match(/window\.__deepPairingToken\s*=\s*("[^"]+")/);
    const hash = html.match(/window\.__dpProjectHash\s*=\s*("[^"]+")/);
    if (!token || !hash) throw new Error("runtime companion bootstrap missing token/project hash");
    this.info!.authToken = JSON.parse(token[1]) as string;
    this.info!.projectHash = JSON.parse(hash[1]) as string;
    const expectedVersion = JSON.parse(fs.readFileSync(path.join(plugin, ".claude-plugin/plugin.json"), "utf8")).version as string;
    const running = await this.http<{ version: string }>("/api/daemon-info");
    if (running.version !== expectedVersion) throw new Error(`runtime version mismatch: expected ${expectedVersion}, got ${running.version}`);
  }

  async connect(plugin: string, claudeSession: string): Promise<{ client: Client; sessionId: string }> {
    const client = new Client({ name: "released-upgrade-test", version: "1" });
    this.clients.push(client);
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(plugin, "server.mjs")], cwd: this.project, env: { ...this.env, CLAUDE_CODE_SESSION_ID: claudeSession }, stderr: "pipe" });
    transport.stderr?.on("data", (chunk) => { this.stderr += String(chunk); });
    await client.connect(transport, { timeout: 15_000 });
    // /api/sessions is persisted history, which may be empty before a newly
    // registered session writes its first artifact. The companion's live list
    // exposes the wrapper registration without relying on a flush delay.
    const listing = await this.http<SessionListing>("/api/active-sessions");
    const matching = listing.sessions.filter((session) => session.sessionId.endsWith(`_${claudeSession}`));
    if (matching.length !== 1) throw new Error(`expected one persisted session for ${claudeSession}: ${JSON.stringify(listing)}`);
    return { client, sessionId: matching[0].sessionId };
  }

  async tool(client: Client, name: string, args: Record<string, unknown>): Promise<void> {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 15_000 });
    if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result)}`);
  }

  async http<T>(route: string, sessionId?: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    if (!this.info) throw new Error("runtime not ready");
    const res = await fetch(`http://127.0.0.1:${this.info.port}${route}`, {
      method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(10_000),
      headers: { "Content-Type": "application/json", "X-Project-Hash": this.info.projectHash!, Authorization: `Bearer ${this.info.authToken}`, ...(sessionId ? { "X-Session-Id": sessionId } : {}), ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${route}: HTTP ${res.status}: ${text}`);
    return JSON.parse(text) as T;
  }

  async stop(): Promise<void> {
    const clients = this.clients.splice(0);
    await Promise.all(clients.map((client) => client.close()));
    if (!this.daemon) return;
    const daemon = this.daemon;
    try {
      // Cooperative doctor shutdown force-flushes and exits zero on Windows as
      // well as Unix (Windows kill(SIGTERM) bypasses Node's signal handlers).
      if (daemon.exitCode === null && daemon.signalCode === null) {
        if (this.info) await this.http("/api/evict", undefined, {}, { "X-DeepPairing-Confirm-Pid": String(daemon.pid) });
        else daemon.kill("SIGTERM");
      }
      await until(() => daemon.exitCode !== null || daemon.signalCode !== null, "runtime clean exit");
    } catch (error) {
      daemon.kill("SIGKILL");
      await until(() => daemon.exitCode !== null || daemon.signalCode !== null, "owned runtime forced cleanup", 5_000);
      this.daemon = null; this.info = null;
      throw error;
    }
    this.daemon = null; this.info = null;
    if (daemon.exitCode !== 0) throw new Error(`runtime did not stop cleanly (${daemon.exitCode}, ${daemon.signalCode}): ${this.stderr}`);
    if (fs.existsSync(path.join(this.project, ".deeppairing/daemon.json"))) throw new Error("runtime left a stale daemon sidecar");
  }

  async dispose(): Promise<void> {
    try { await this.stop(); }
    finally { fs.rmSync(this.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }
}
