/**
 * SPIKE — v2 SDK round-trip test for server-v2.ts.
 *
 * Uses @modelcontextprotocol/client@2.0.0-beta.2's Client + the v2
 * InMemoryTransport. The v2 client's default connect mode is 'legacy'
 * (initialize handshake), which is what Claude Code speaks today; a second
 * suite probes 'auto' (server/discover → 2026-07-28 stateless) to see what
 * the modern era does to this server.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMcpServerV2 } from "../server-v2.js";
import { FileStore } from "../../store/file-store.js";
import { setGlobalStoreForTests } from "../../store/global-store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;
let store: FileStore;
let client: Client;
let broadcasts: any[];

async function setup(opts?: { modern?: boolean }) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-mcp-v2-test-"));
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
  store = new FileStore(tmpDir, "test_session");
  broadcasts = [];

  const { server } = createMcpServerV2(store, (e) => broadcasts.push(e), 4000);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  if (opts?.modern) {
    // V2 finding: a low-level Server connected via server.connect(transport)
    // NEVER serves the 2026-07-28 era — server/discover goes unanswered and
    // mode:'auto' clients silently fall back to legacy. Only a serving entry
    // (serveStdio / createMcpHandler) marks the connection modern-capable.
    serveStdio(() => server, { transport: serverTransport });
  } else {
    await server.connect(serverTransport);
  }
  // V2 gotcha: versionNegotiation is a CLIENT CONSTRUCTOR option, not a
  // connect() option. Passing { mode: 'auto' } to connect() typechecks
  // (RequestOptions is open enough) and is silently ignored.
  client = new Client(
    { name: "test-client", version: "1.0" },
    opts?.modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : undefined,
  );
  await client.connect(clientTransport);
}

afterEach(() => {
  store?.forceFlush();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  setGlobalStoreForTests(null);
});

describe("v2 SDK port — legacy-era connection (what Claude Code speaks today)", () => {
  beforeEach(async () => {
    await setup();
  });

  it("lists all 13 tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "answer_question",
      "check_feedback",
      "export_session",
      "log_reasoning",
      "post_pr_review",
      "present_code_change",
      "present_findings",
      "present_options",
      "present_plan",
      "present_spec",
      "recall",
      "revise_artifact",
      "update_plan_progress",
    ]);
    const cf = tools.find((t) => t.name === "check_feedback");
    expect(cf?.outputSchema).toBeDefined();
  });

  it("round-trips present_findings (artifact stored + broadcast)", async () => {
    const result = await client.callTool({
      name: "present_findings",
      arguments: {
        title: "Spike research",
        summary: "v2 SDK spike",
        findings: [
          { category: "arch", title: "F1", detail: "detail", evidence: "e", significance: "low" },
        ],
      },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as any[])
      .filter((b) => b?.type === "text")
      .map((b) => b.text)
      .join("");
    expect(text).toContain("art_");
    const artifacts = store.getArtifacts();
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].type).toBe("research");
    expect(broadcasts.some((b) => b?.type === "artifact_created")).toBe(true);
  });

  it("round-trips check_feedback on an empty session (structuredContent survives)", async () => {
    const result = await client.callTool({ name: "check_feedback", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect((result as any).structuredContent).toMatchObject({ status: "proceed" });
  });

  it("input validation errors round-trip with isError + _meta", async () => {
    const result = await client.callTool({
      name: "present_findings",
      arguments: { summary: "missing findings array" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as any[]).map((b) => b.text).join("");
    expect(text).toContain("INPUT_VALIDATION_FAILED");
    // v1 carried a structured error code in result._meta — does v2 preserve it?
    expect((result as any)._meta?.code).toBe("INPUT_VALIDATION_FAILED");
  });

  it("serves resources (onboarding + session/current) and prompts (recall)", async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain("deeppairing://onboarding");
    expect(uris).toContain("deeppairing://session/current");

    const read = await client.readResource({ uri: "deeppairing://session/current" });
    expect(read.contents[0].mimeType).toBe("application/json");

    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["recall", "seed"]);
    const got = await client.getPrompt({ name: "recall", arguments: { query: "caching" } });
    expect((got.messages[0].content as any).text).toContain("recall");
  });

  it("emits notifications/resources/list_changed after present_findings", async () => {
    let sawListChanged = false;
    client.fallbackNotificationHandler = async (n: any) => {
      if (n.method === "notifications/resources/list_changed") sawListChanged = true;
    };
    await client.callTool({
      name: "present_findings",
      arguments: {
        summary: "s",
        findings: [{ category: "arch", detail: "d", significance: "low" }],
      },
    });
    // Notification delivery over the in-memory pair is synchronous-ish; give
    // the microtask queue a tick.
    await new Promise((r) => setTimeout(r, 10));
    expect(sawListChanged).toBe(true);
  });
});

describe("v2 SDK port — modern-era connection (mode: 'auto' → server/discover)", () => {
  it("connects and round-trips a tool on the 2026-07-28 stateless era", async () => {
    await setup({ modern: true });
    // Assert we ACTUALLY negotiated the modern era, not a silent legacy
    // fallback (mode 'auto' falls back to initialize when discover fails).
    expect(client.getDiscoverResult()).toBeDefined();
    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    const { tools } = await client.listTools();
    expect(tools.length).toBe(13);
    const result = await client.callTool({ name: "check_feedback", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect((result as any).structuredContent).toMatchObject({ status: "proceed" });
  });

  it("elicitInput on a modern-era request throws (tryElicit falls back to 'review')", async () => {
    // Opt into terminal elicitation so present_findings actually calls
    // server.elicitInput. On a 2026-era request the SDK throws a typed error
    // steering to inputRequired(...); tool-helpers.tryElicit catches ANY
    // throw and returns null (fall back to companion-UI polling), so the
    // tool call itself must still succeed.
    process.env.DEEPPAIRING_TERMINAL_APPROVE = "1";
    try {
      await setup({ modern: true });
      const result = await client.callTool({
        name: "present_findings",
        arguments: {
          summary: "elicit probe",
          findings: [{ category: "arch", detail: "d", significance: "low" }],
        },
      });
      expect(result.isError).toBeFalsy();
      expect(store.getArtifacts().some((a) => a.type === "research")).toBe(true);
    } finally {
      delete process.env.DEEPPAIRING_TERMINAL_APPROVE;
    }
  });
});
