/**
 * D2 — shared harness for the server.test.ts split. One in-memory
 * MCP client↔server pair + FileStore on a mkdtemp dir per test (fakes not
 * mocks), exactly the setup the 3,000-line monolith used.
 *
 * Pattern note: setupServerTest() must be CALLED by each test file (not run
 * at import time) — with isolate:false the module is cached across files in
 * a worker, so import-time hook registration would only ever bind to the
 * first file that loaded it. And register any local-copy beforeEach AFTER
 * calling setupServerTest(): same-level hooks run in registration order, so
 * a copy-hook registered first would read stale/undefined ctx values.
 */
import { beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../server.js";
import { FileStore } from "../../store/file-store.js";
import { setGlobalStoreForTests } from "../../store/global-store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ServerTestCtx {
  tmpDir: string;
  store: FileStore;
  client: Client;
  broadcasts: any[];
}

export function setupServerTest(): ServerTestCtx {
  const ctx = { broadcasts: [] } as unknown as ServerTestCtx;

  beforeEach(async () => {
    ctx.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-mcp-test-"));
    // Redirect the global philosophy ledger to tmpDir so tests don't leak.
    setGlobalStoreForTests(path.join(ctx.tmpDir, "philosophy.json"));
    ctx.store = new FileStore(ctx.tmpDir, "test_session");
    ctx.broadcasts.length = 0;

    const { server } = createMcpServer(ctx.store, (e) => ctx.broadcasts.push(e), 4000);

    // Connect client ↔ server via in-memory transport
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    ctx.client = new Client({ name: "test-client", version: "1.0" });
    await ctx.client.connect(clientTransport);
  });

  afterEach(() => {
    // Force flush to prevent pending timer writes after dir is deleted
    ctx.store.forceFlush();
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
    setGlobalStoreForTests(null);
  });

  return ctx;
}

export function makeCallTool(ctx: ServerTestCtx) {
  return async function callTool(name: string, args: Record<string, any> = {}) {
    const result = await ctx.client.callTool({ name, arguments: args });
    // II12 — firstCallHint moved from "spliced into content[0].text" to "a
    // separate content[1+] text block" so strict JSON-parsing clients see a
    // clean tool reply in content[0]. Tests assert on the combined visible
    // text the agent sees; concatenate every text content block so the
    // existing assertions (which match against the joined string) still
    // exercise the same surface.
    const blocks = (result.content as any[]) ?? [];
    const text = blocks
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
    // IV10 — surface _meta so tests can assert on the new structured
    // error-code contract without breaking the existing { text, isError }
    // call-site shape. B3 — surface structuredContent for the check_feedback
    // outputSchema contract.
    return {
      text,
      isError: result.isError,
      _meta: (result as any)._meta,
      structuredContent: (result as any).structuredContent,
    };
  };
}
