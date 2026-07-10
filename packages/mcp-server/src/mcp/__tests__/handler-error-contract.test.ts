import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../server.js";
import { FileStore } from "../../store/file-store.js";
import { setGlobalStoreForTests } from "../../store/global-store.js";
import { formatHandlerError } from "../validate-tool-input.js";
import { TOOL_ERROR_CODES } from "../../error-codes.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * H1-6 — the CallToolRequestSchema dispatch wrapped the tool switch in a bare
 * IIFE with no try/catch, so a handler throw (classically a 413/body-cap from
 * DaemonClient.request on an oversized-but-Zod-valid artifact) reached the SDK
 * as a raw JSON-RPC protocol error instead of the clean isError tool contract.
 * These tests pin the mapping and the wrapping.
 */

/** Real fake: a genuine FileStore whose createArtifact throws exactly like the
 *  daemon rejecting an oversized body (413 / body_too_large), so present_*
 *  hits the throw AFTER passing Zod validation. */
class Body413Store extends FileStore {
  createArtifact(): never {
    const e = new Error("[deepPairing] Request body exceeds 65536-byte cap.") as Error & {
      code?: string;
      status?: number;
    };
    e.code = "body_too_large";
    e.status = 413;
    throw e;
  }
}

describe("H1-6 — formatHandlerError mapping", () => {
  it("maps a 413/body_too_large throw to PAYLOAD_TOO_LARGE (retryable) with actionable text", () => {
    const err = Object.assign(new Error("[deepPairing] Request body exceeds 65536-byte cap."), {
      code: "body_too_large",
      status: 413,
    });
    const res = formatHandlerError("present_findings", err);
    expect(res.isError).toBe(true);
    expect(res._meta?.code).toBe(TOOL_ERROR_CODES.PAYLOAD_TOO_LARGE);
    expect(res._meta?.retryable).toBe(true);
    const text = res.content[0]!.text;
    expect(text).toContain("too large");
    expect(text).toMatch(/split|trim|shorten|summarize/i);
    // Sanitized: our internal "[deepPairing] " prefix is stripped.
    expect(text).not.toContain("[deepPairing]");
  });

  it("maps a generic throw to TOOL_EXECUTION_FAILED without leaking a stack", () => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:3999");
    // Give it a stack to prove we never surface it.
    const res = formatHandlerError("present_plan", err);
    expect(res.isError).toBe(true);
    expect(res._meta?.code).toBe(TOOL_ERROR_CODES.TOOL_EXECUTION_FAILED);
    const text = res.content[0]!.text;
    expect(text).toContain("ECONNREFUSED");
    expect(text).not.toContain("at "); // no stack frames leaked
    expect(text).not.toContain(".ts:");
  });
});

describe("H1-6 — the dispatch wrapper returns isError, not a protocol error", () => {
  let tmpDir: string;
  let client: Client;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-h16-"));
    setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
    const store = new Body413Store(tmpDir, "test_session");
    const { server } = createMcpServer(store, () => {}, 4000);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0" });
    await client.connect(clientTransport);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    setGlobalStoreForTests(null);
  });

  it("an oversized-but-valid present_findings returns a clean isError result with _meta.code (call does NOT reject)", async () => {
    // Zod-valid input — validation passes, then createArtifact throws the 413.
    const result = await client.callTool({
      name: "present_findings",
      arguments: {
        title: "Audit",
        summary: "Two issues in auth.ts",
        findings: [
          {
            category: "security",
            title: "Weak password hash",
            detail: "bcrypt rounds=4 is too low",
            evidence: "auth.ts L23 uses bcrypt.hash(pw, 4)",
            significance: "high",
            recommendation: "raise to 12+",
          },
        ],
      },
    });
    // The whole point: the call RESOLVED with an isError result rather than
    // rejecting with a raw JSON-RPC protocol error.
    expect(result.isError).toBe(true);
    expect((result as { _meta?: { code?: string } })._meta?.code).toBe(TOOL_ERROR_CODES.PAYLOAD_TOO_LARGE);
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain("too large");
    expect(text).not.toContain("[deepPairing]");
  });
});
