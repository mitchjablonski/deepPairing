/**
 * #470 — end-to-end harness for stance exceptions. Fakes, not mocks:
 *  - a REAL daemon composition (createDaemon) on a temp project dir;
 *  - a REAL DaemonClient per wrapper, reaching that daemon through a fetch
 *    shim (no sockets) that can drop a response AFTER the daemon committed —
 *    the lost-response fault §10 needs;
 *  - a REAL MCP server per wrapper (createMcpServer over DaemonClient),
 *    driven by an MCP client over the in-memory transport;
 *  - real FileStore, real locks, an injectable clock, and named fault points
 *    inside the daemon's operation (a throw there simulates a crash).
 *
 * Wrappers register WITHOUT expectedProjectRoot, so DaemonClient's recovery
 * path refuses to re-adopt (it would otherwise try to spawn a real daemon).
 * A "restart" disposes every store WITHOUT flushing (a SIGKILL's view: only
 * what was flushed survives) and composes a fresh daemon on the same dir.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDaemon, type Daemon } from "../create-daemon.js";
import type { StanceFaultPoint } from "../stance-exceptions.js";
import { DaemonClient } from "../client.js";
import { createMcpServer } from "../../mcp/server.js";
import { projectHashOf } from "../../project-root.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";
import type { PreflightBlockEntry } from "../../store/preflight-block-log.js";
import type { FileStore } from "../../store/file-store.js";

export const TOKEN = "sx-test-token";
/** Never bound: the shim routes by URL, nothing listens. */
export const FAKE_PORT = 1;

export type DropRule = (url: string, init: RequestInit | undefined) => boolean;

export interface Wrapper {
  client: DaemonClient;
  sessionId: string;
  call: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean; structuredContent?: Record<string, unknown> }>;
  close: () => Promise<void>;
}

export class StanceWorld {
  readonly fx: GlobalStoreFixture;
  readonly dir: string;
  daemon!: Daemon;
  now = Date.parse("2026-10-10T12:00:00.000Z");
  fault: ((point: StanceFaultPoint, operationId: string) => void) | null = null;
  /** Return true to let the daemon handle the request, then throw a network
   *  error at the client (the response is lost after the commit). */
  drop: DropRule | null = null;
  readonly events: Array<Record<string, unknown>> = [];
  /** Every request the wrappers sent, in order (url, method, raw body). */
  readonly requests: Array<{ url: string; method: string; body?: string }> = [];
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly realFetch = globalThis.fetch;
  private readonly wrappers: Wrapper[] = [];

  constructor(prefix = "dp-sx-") {
    this.fx = withGlobalStore(prefix);
    this.dir = this.fx.dir;
    this.boot();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      this.requests.push({ url, method: init?.method ?? "GET", ...(typeof init?.body === "string" ? { body: init.body } : {}) });
      const p = (async () => {
        const res = await this.daemon.app.request(url, init);
        if (this.drop?.(url, init)) {
          this.drop = null;
          throw new TypeError("fetch failed (dropped by the shim after the daemon handled it)");
        }
        return res;
      })();
      this.inflight.add(p);
      try { return await p; } finally { this.inflight.delete(p); }
    }) as typeof fetch;
  }

  boot(): void {
    this.daemon = createDaemon({
      projectRoot: this.dir,
      authToken: TOKEN,
      log: () => {},
      exitProcess: () => {},
      releaseListenSocket: () => {},
      env: { DEEPPAIRING_NO_OPEN: "1", BROWSER: "none" },
      stanceExceptionClock: () => this.now,
      stanceExceptionFault: (point, op) => this.fault?.(point, op),
    });
    // A recording tap on the registry's broadcast seam (it still forwards to
    // the real fan-out + block-log persistence).
    const deps = (this.daemon.stanceExceptions as unknown as { deps: { broadcast: (sid: string, e: Record<string, unknown>) => void } }).deps;
    const forward = deps.broadcast;
    deps.broadcast = (sid, e) => { this.events.push(e); forward(sid, e); };
  }

  /** Kill without flushing, then compose a fresh daemon on the same dir. */
  async restart(): Promise<void> {
    await this.settle();
    for (const w of this.wrappers.splice(0)) await w.close().catch(() => {});
    for (const store of this.daemon.sessions.values()) store.dispose();
    this.daemon.dispose();
    this.boot();
  }

  /** Wait for fire-and-forget wrapper calls (block records) to land. */
  async settle(): Promise<void> {
    for (let i = 0; i < 20 && this.inflight.size > 0; i++) await Promise.allSettled([...this.inflight]);
    await new Promise((r) => setTimeout(r, 0));
  }

  store(sessionId: string): FileStore {
    return this.daemon.sessions.get(sessionId)!;
  }

  async wrapper(sessionId = "sx_session", opts: { split?: boolean } = {}): Promise<Wrapper> {
    const client = new DaemonClient(FAKE_PORT, sessionId, this.dir, TOKEN);
    await client.register({ title: "sx", project: "sx", ...(opts.split !== undefined ? { splitMode: opts.split } : {}) });
    const { server } = createMcpServer(client, () => {}, FAKE_PORT);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const mcp = new Client({ name: "sx-test", version: "1.0" });
    await mcp.connect(ct);
    const w: Wrapper = {
      client,
      sessionId,
      call: async (name, args) => {
        const result = await mcp.callTool({ name, arguments: args });
        await this.settle();
        const text = ((result.content as Array<{ type: string; text?: string }>) ?? [])
          .filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
        return { text, isError: result.isError as boolean | undefined, structuredContent: result.structuredContent as Record<string, unknown> | undefined };
      },
      close: async () => { await mcp.close(); },
    };
    this.wrappers.push(w);
    return w;
  }

  /** The human's grant, through the public bearer-gated route. */
  grant(blockId: string, reason = "false positive, this removes it", opts: { via?: "cli"; headers?: Record<string, string>; body?: unknown } = {}) {
    return this.publicRequest(`/api/preflight-blocks/${blockId}/exception`, {
      method: "POST",
      headers: { ...(opts.via ? { "X-DeepPairing-Grant-Origin": opts.via } : {}), ...(opts.headers ?? {}) },
      body: JSON.stringify(opts.body ?? { reason }),
    });
  }

  revoke(id: string) {
    return this.publicRequest(`/api/stance-exceptions/${id}/revoke`, { method: "POST", body: "{}" });
  }

  publicRequest(path: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
    return this.daemon.app.request(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
        "X-Project-Hash": projectHashOf(this.dir),
        ...(init.headers ?? {}),
      },
    });
  }

  /** The internal operation route, as DaemonClient would call it. */
  operation(sessionId: string, operationId: string, body: Record<string, unknown>, registrationToken?: string) {
    return this.daemon.app.request(`/api/internal/sessions/${sessionId}/operations/${operationId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
        "X-Project-Hash": projectHashOf(this.dir),
        ...(registrationToken ? { "X-DeepPairing-Registration": registrationToken } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  async blocks(): Promise<PreflightBlockEntry[]> {
    const res = await this.publicRequest("/api/preflight-blocks");
    return ((await res.json()) as { blocks: PreflightBlockEntry[] }).blocks;
  }

  async newestBlock(): Promise<PreflightBlockEntry> {
    return (await this.blocks())[0]!;
  }

  async allowances(): Promise<Array<Record<string, unknown>>> {
    const res = await this.publicRequest("/api/stance-exceptions");
    return ((await res.json()) as { allowances: Array<Record<string, unknown>> }).allowances;
  }

  /** Grant on the newest block and return the allowance id. */
  async allowNewest(reason?: string, via?: "cli"): Promise<string> {
    const block = await this.newestBlock();
    const res = await this.grant(block.id, reason, via ? { via } : {});
    if (res.status !== 201 && res.status !== 200) throw new Error(`grant failed ${res.status}: ${await res.text()}`);
    return ((await res.json()) as { allowance: { id: string } }).allowance.id;
  }

  /** The newest claim a wrapper sent: its operation id and exact body. */
  lastClaim(): { operationId: string; body: Record<string, unknown> } {
    const req = [...this.requests].reverse().find((r) => r.method === "POST" && /\/operations\//.test(r.url) && r.body?.includes("\"admission\""));
    if (!req) throw new Error("no claim was sent");
    return { operationId: decodeURIComponent(req.url.split("/operations/")[1]!), body: JSON.parse(req.body!) };
  }

  /** Throw once at `point` (a simulated crash inside the daemon operation). */
  crashAt(point: StanceFaultPoint): void {
    this.fault = (p) => {
      if (p !== point) return;
      this.fault = null;
      throw new Error(`simulated crash at ${point}`);
    };
  }

  async dispose(): Promise<void> {
    await this.settle();
    for (const w of this.wrappers.splice(0)) await w.close().catch(() => {});
    globalThis.fetch = this.realFetch;
    this.daemon.dispose();
    this.fx.dispose();
  }
}

/** A stance the human holds, written the way the reject flow writes it. */
export function holdStance(store: FileStore, description = "global mutable state", reason = "hard to test"): void {
  store.recordRejectedApproach({ description, concept: description, reason });
}

export function registrationTokenOf(w: Wrapper): string {
  return (w.client as unknown as { registrationToken: string }).registrationToken;
}
