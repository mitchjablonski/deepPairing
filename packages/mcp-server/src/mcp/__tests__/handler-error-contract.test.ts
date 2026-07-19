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
    // #147 — a dead socket is genuinely transient: retry can succeed.
    expect(res._meta?.retryable).toBe(true);
  });
});

/**
 * #147 — retryability split. Pre-fix formatHandlerError stamped
 * `retryable: true` on EVERY TOOL_EXECUTION_FAILED, so a deterministic
 * handler bug (TypeError) told the agent to loop-retry input that can never
 * work. These pin the per-error mapping:
 *   tagged 5xx / 408 / 429 / network → retryable true
 *   tagged other 4xx                 → retryable false
 *   untagged TypeError/RangeError    → retryable false (and still no stack)
 * plus the projectRoot-relativization of fs-error messages.
 */
describe("#147 — TOOL_EXECUTION_FAILED retryability split", () => {
  const tagged = (message: string, status: number, code?: string) =>
    Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

  it("a daemon-tagged 503 is retryable (transient daemon trouble)", () => {
    const res = formatHandlerError("present_findings", tagged("[deepPairing] request failed (503)", 503));
    expect(res._meta?.code).toBe(TOOL_ERROR_CODES.TOOL_EXECUTION_FAILED);
    expect(res._meta?.retryable).toBe(true);
    // Transient phrasing steers the agent to retry.
    expect(res.content[0]!.text).toMatch(/transient/i);
  });

  it("a daemon-tagged 400 is NOT retryable (the request is wrong; identical input can't help)", () => {
    const res = formatHandlerError("present_findings", tagged("[deepPairing] validation failed", 400, "validation_error"));
    expect(res._meta?.code).toBe(TOOL_ERROR_CODES.TOOL_EXECUTION_FAILED);
    expect(res._meta?.retryable).toBe(false);
    // The text must NOT tell the agent this is transient.
    const text = res.content[0]!.text;
    expect(text).not.toMatch(/usually transient/i);
    expect(text).toMatch(/retrying the identical input will fail the same way/i);
  });

  it("daemon-tagged 408 and 429 stay retryable (timeout / rate limit ARE transient 4xx)", () => {
    expect(formatHandlerError("recall", tagged("request timeout", 408))._meta?.retryable).toBe(true);
    expect(formatHandlerError("recall", tagged("rate limited", 429))._meta?.retryable).toBe(true);
  });

  it("an untagged TypeError is NOT retryable and still leaks no stack", () => {
    // A classic deterministic handler bug — same input, same throw, forever.
    let err: unknown;
    try {
      (undefined as unknown as { title: string }).title.toString();
    } catch (thrown) {
      err = thrown; // a REAL TypeError with a real stack
    }
    const res = formatHandlerError("present_spec", err);
    expect(res._meta?.code).toBe(TOOL_ERROR_CODES.TOOL_EXECUTION_FAILED);
    expect(res._meta?.retryable).toBe(false);
    const text = res.content[0]!.text;
    expect(text).not.toContain("at "); // no stack frames leaked
    expect(text).not.toContain(".ts:");
  });

  it("relativizes the absolute project root out of fs-error messages", () => {
    const projectRoot = "/home/someone/dev/secret-client-project";
    const err = new Error(
      `ENOENT: no such file or directory, open '${projectRoot}/.deeppairing/sessions/s1/artifacts.json'`,
    );
    const res = formatHandlerError("present_plan", err, projectRoot);
    const text = res.content[0]!.text;
    expect(text).not.toContain(projectRoot);
    // The useful, project-relative tail survives.
    expect(text).toContain(".deeppairing/sessions/s1/artifacts.json");
  });

  it("relativizes a bare project-root mention to '.'", () => {
    const projectRoot = "/home/someone/dev/secret-client-project";
    const err = new Error(`EACCES: permission denied, scandir '${projectRoot}'`);
    const res = formatHandlerError("present_plan", err, projectRoot);
    const text = res.content[0]!.text;
    expect(text).not.toContain(projectRoot);
    expect(text).toContain("scandir '.'");
  });

  it("does NOT mangle a prefix-SIBLING path (review repro: /proj vs /proj-archive)", () => {
    // Review-caught: a bare split(projectRoot).join('.') with no boundary
    // check rendered '/home/u/proj-archive/x' as '.-archive/x'. The bare
    // replacement must only fire at a path boundary; the sibling path (root +
    // non-separator suffix) survives verbatim while the true child relativizes.
    const projectRoot = "/home/u/proj";
    const err = new Error(
      `EPERM: cannot link '/home/u/proj-archive/x' to '${projectRoot}/src/a.ts'`,
    );
    const res = formatHandlerError("present_plan", err, projectRoot);
    const text = res.content[0]!.text;
    expect(text).toContain("/home/u/proj-archive/x"); // sibling untouched
    expect(text).not.toContain(".-archive");          // the mangled form
    expect(text).toContain("'src/a.ts'");             // the child relativized
    expect(text).not.toContain(`${projectRoot}/src`); // and the root gone
  });

  it("a deterministic TypeError merely MENTIONING 'socket' is NOT retryable (no loose classifier terms)", () => {
    // Review-caught: bare `socket|network` regex terms classified
    // `TypeError: Cannot read properties of undefined (reading 'socket')` —
    // a deterministic handler bug — as a transient network error.
    let err: unknown;
    try {
      (undefined as unknown as { socket: object }).socket.toString();
    } catch (thrown) {
      err = thrown; // real TypeError: "... (reading 'socket')"
    }
    const res = formatHandlerError("present_findings", err);
    expect(res._meta?.code).toBe(TOOL_ERROR_CODES.TOOL_EXECUTION_FAILED);
    expect(res._meta?.retryable).toBe(false);
    // While the REAL network shapes stay retryable: undici's fetch wrapper…
    expect(formatHandlerError("recall", new TypeError("fetch failed"))._meta?.retryable).toBe(true);
    // …and DaemonClient's untagged dead-daemon rethrow (client.ts request()).
    expect(
      formatHandlerError(
        "recall",
        new Error("daemon connection lost (likely after host sleep). Reconnect failed — run `node packages/mcp-server/dist/cli/init.js doctor` to diagnose, or restart Claude Code."),
      )._meta?.retryable,
    ).toBe(true);
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
