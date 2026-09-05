import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { TestInfo } from "@playwright/test";
import {
  attachDaemonOutput,
  captureDaemonOutput,
  diagnosticPendingBytesForTests,
} from "../../e2e/daemon-harness.js";
import { BoundedDiagnosticTail, redactDiagnostic } from "../../e2e/diagnostics.js";

function fakeProcess() {
  return { stdout: new PassThrough(), stderr: new PassThrough() } as unknown as ChildProcess;
}

async function capturedBody(proc: ChildProcess): Promise<Buffer> {
  let body: Buffer | undefined;
  const info = {
    status: "failed",
    expectedStatus: "passed",
    attach: async (_name: string, value: { body: Buffer }) => { body = value.body; },
  } as unknown as TestInfo;
  await attachDaemonOutput(proc, info);
  if (!body) throw new Error("diagnostic attachment missing");
  return body;
}

describe("E2E daemon diagnostics", () => {
  it("scrubs common credential forms and credentials embedded in URLs", () => {
    const output = redactDiagnostic([
      'password="double-secret"',
      "apiKey='single-secret'",
      "accessToken=bare-secret",
      "Authorization: Basic basic-secret",
      "Authorization=Custom custom-secret",
      "https://user:url-secret@example.test/path?token=query-secret#fragment-secret",
    ].join("\n"));

    for (const secret of [
      "double-secret", "single-secret", "bare-secret", "basic-secret",
      "custom-secret", "url-secret", "query-secret", "fragment-secret",
    ]) expect(output).not.toContain(secret);
    expect(output).toContain("https://example.test/path");
  });

  it("preserves the prior tail when an oversized browser event is discarded", () => {
    const tail = new BoundedDiagnosticTail(64);
    tail.record("useful prior line");
    tail.record("x".repeat(65));

    expect(tail.body().toString()).toBe("useful prior line\n");
  });

  it("reassembles stream fragments before redacting credentials", async () => {
    const proc = fakeProcess();
    captureDaemonOutput(proc);
    proc.stderr!.emit("data", Buffer.from("Authorization: Bea"));
    proc.stderr!.emit("data", Buffer.from("rer secret-token\n{\"authTo"));
    proc.stderr!.emit("data", Buffer.from("ken\":\"second-secret\"}\n"));

    const output = (await capturedBody(proc)).toString();
    expect(output).toContain("Bearer [REDACTED]");
    expect(output).toContain('"authToken":"[REDACTED]"');
    expect(output).not.toContain("secret-token");
    expect(output).not.toContain("second-secret");
  });

  it("drops an oversized raw line and retains the following safe UTF-8 line", async () => {
    const proc = fakeProcess();
    captureDaemonOutput(proc);
    proc.stdout!.emit("data", Buffer.from(`Authorization: Bearer ${"s".repeat(80_000)}\n`));
    proc.stdout!.emit("data", Buffer.from(`kept 🙂 line\n`));

    const body = await capturedBody(proc);
    expect(body.length).toBeLessThanOrEqual(64 * 1024);
    expect(body.toString()).not.toContain("Bearer");
    expect(body.toString()).toContain("kept 🙂 line");
    expect(body.toString()).not.toContain("s".repeat(100));
    expect(body.toString()).not.toContain("�");
  });

  it("bounds an unterminated line and discards through its eventual newline", async () => {
    const proc = fakeProcess();
    captureDaemonOutput(proc);
    proc.stderr!.emit("data", Buffer.from(`Authorization: Bearer ${"split-secret".repeat(4_000)}`));
    proc.stderr!.emit("data", Buffer.from("split-secret".repeat(4_000)));
    expect(diagnosticPendingBytesForTests(proc)).toBeLessThanOrEqual(64 * 1024);
    proc.stderr!.emit("data", Buffer.from("credential-suffix\nsafe after oversized line\n"));

    const output = (await capturedBody(proc)).toString();
    expect(output).toContain("safe after oversized line");
    expect(output).not.toContain("credential-suffix");
    expect(output).not.toContain("split-secret");
  });
});
