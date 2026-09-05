import { describe, expect, it } from "vitest";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestInfo } from "@playwright/test";
import {
  attachDaemonOutput,
  captureDaemonOutput,
  diagnosticPendingBytesForTests,
  spawnDiagnosticProcess,
  withSetupDiagnostics,
} from "../../e2e/daemon-harness.js";
import { BoundedDiagnosticTail, redactDiagnostic } from "../../e2e/diagnostics.js";

function fakeProcess() {
  return { stdout: new PassThrough(), stderr: new PassThrough() } as unknown as ChildProcess;
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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
      'password="two word secret"',
      "accessToken='single quoted secret'",
      'apiKey="escaped \\\"quote-secret\\\" suffix-secret"',
      'Authorization: "Bearer spaced-auth-secret trailing-secret"',
      "Authorization='Custom single-auth-secret trailing-secret'",
      "Cookie: session=cookie-secret; theme=dark",
      "Set-Cookie: session=set-cookie-secret; HttpOnly; Secure",
      '{"Cookie":"sid=json-cookie-secret; csrf=json-csrf-secret"}',
      "{'Set-Cookie':'sid=object-set-cookie-secret; HttpOnly'}",
      '{"Set-Cookie":["sid=array-cookie-secret; HttpOnly","csrf=array-csrf-secret"]}',
      "x-api-key: x-header-secret",
      "api_key=snake-secret",
      "https://user:url-secret@example.test/path?token=query-secret#fragment-secret",
    ].join("\n"));

    for (const secret of [
      "double-secret", "single-secret", "bare-secret", "basic-secret",
      "custom-secret", "url-secret", "query-secret", "fragment-secret",
      "two word secret", "single quoted secret", "quote-secret", "suffix-secret",
      "spaced-auth-secret", "trailing-secret", "single-auth-secret",
      "cookie-secret", "set-cookie-secret", "x-header-secret", "snake-secret",
      "json-cookie-secret", "json-csrf-secret", "object-set-cookie-secret",
      "array-cookie-secret", "array-csrf-secret",
    ]) expect(output).not.toContain(secret);
    expect(output).toContain('Authorization: "Bearer [REDACTED]"');
    expect(output).toContain("Authorization='[REDACTED]'");
    expect(output).toContain('{"Cookie":"[REDACTED]"}');
    expect(output).toContain("{'Set-Cookie':'[REDACTED]'}");
    expect(output).toContain('{"Set-Cookie":["[REDACTED]"]}');
    expect(output).toContain("https://example.test/path");
  });

  it("captures and redacts output from a real crashing child process", async () => {
    const proc = spawnDiagnosticProcess(process.execPath, [
      "-e",
      "console.error('Set-Cookie: sid=child-secret; HttpOnly'); console.log('startup failed deliberately'); process.exit(23)",
    ]);
    await once(proc, "close");

    const output = (await capturedBody(proc)).toString();
    expect(proc.exitCode).toBe(23);
    expect(output).toContain("startup failed deliberately");
    expect(output).toContain("Set-Cookie: [REDACTED]");
    expect(output).not.toContain("child-secret");
  });

  it("keeps split credentials redacted across repeated live attachments", async () => {
    const proc = fakeProcess();
    captureDaemonOutput(proc);
    const bodies: string[] = [];
    const info = {
      status: "failed",
      expectedStatus: "passed",
      attach: async (_name: string, value: { body: Buffer }) => { bodies.push(value.body.toString()); },
    } as unknown as TestInfo;

    proc.stderr!.emit("data", Buffer.from("Authorization: Bearer prefix-"));
    await attachDaemonOutput(proc, info);
    proc.stderr!.emit("data", Buffer.from("suffix-secret\n"));
    await attachDaemonOutput(proc, info);

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain("[incomplete line withheld]");
    expect(bodies[1]).toContain("Bearer [REDACTED]");
    expect(bodies.join("\n")).not.toContain("prefix-");
    expect(bodies.join("\n")).not.toContain("suffix-secret");
  });

  it("withholds incomplete quoted credentials until the whole line can be redacted", async () => {
    const proc = fakeProcess();
    captureDaemonOutput(proc);
    const bodies: string[] = [];
    const info = {
      status: "failed",
      expectedStatus: "passed",
      attach: async (_name: string, value: { body: Buffer }) => { bodies.push(value.body.toString()); },
    } as unknown as TestInfo;

    proc.stderr!.emit("data", Buffer.from('{"Cookie":"sid=partial-cookie-secret'));
    await attachDaemonOutput(proc, info);
    expect(bodies).toEqual(["[stderr] [incomplete line withheld]\n"]);
    proc.stderr!.emit("data", Buffer.from('; csrf=eventual-secret"}\n'));
    await attachDaemonOutput(proc, info);

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain("[incomplete line withheld]");
    expect(bodies[1]).toContain('{"Cookie":"[REDACTED]"}');
    expect(bodies.join("\n")).not.toContain("partial-cookie-secret");
    expect(bodies.join("\n")).not.toContain("eventual-secret");
  });

  it("withholds unterminated credentials when the stream ends", async () => {
    const proc = fakeProcess();
    captureDaemonOutput(proc);
    proc.stderr!.emit("data", Buffer.from("safe complete line\n"));
    proc.stderr!.emit("data", Buffer.from('{"password":"prefix \\" escaped-end-secret'));
    proc.stderr!.emit("end");

    const output = (await capturedBody(proc)).toString();
    expect(output).toContain("safe complete line");
    expect(output).toContain("[incomplete line withheld]");
    expect(output).not.toContain("escaped-end-secret");
  });

  it("withholds an unterminated Set-Cookie array when the stream ends", async () => {
    const proc = fakeProcess();
    captureDaemonOutput(proc);
    proc.stderr!.emit("data", Buffer.from('{"Set-Cookie":["sid=end-array-secret'));
    proc.stderr!.emit("end");

    const output = (await capturedBody(proc)).toString();
    expect(output).toContain("[incomplete line withheld]");
    expect(output).not.toContain("end-array-secret");
  });

  it("preserves the primary setup error when diagnostic attachment fails", async () => {
    const proc = spawnDiagnosticProcess(process.execPath, [
      "-e",
      "console.error('x-api-key: child-setup-secret'); process.exit(17)",
    ]);
    await once(proc, "close");
    const primary = new Error("primary startup failure");
    const info = {
      status: "failed",
      expectedStatus: "passed",
      attach: async () => { throw new Error("attachment backend failed"); },
    } as unknown as TestInfo;

    await expect(withSetupDiagnostics(proc, info, async () => { throw primary; })).rejects.toBe(primary);
  });

  it("attaches a real crashing child's redacted tail when Playwright beforeAll fails", () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-setup-diagnostic-"));
    try {
      const cli = path.join(packageRoot, "node_modules", "@playwright", "test", "cli.js");
      const config = path.join(packageRoot, "e2e", "fixtures", "playwright.config.ts");
      const run = spawnSync(process.execPath, [cli, "test", "--config", config], {
        cwd: packageRoot,
        env: { ...process.env, DP_SETUP_DIAGNOSTIC_OUTPUT: outputDir },
        encoding: "utf8",
        timeout: 20_000,
      });

      const report = `${run.stdout}\n${run.stderr}`;
      expect(run.status, report).toBe(1);
      expect(report).toContain("deliberate beforeAll seed failure");
      expect(report).toContain("attachment #1: daemon-diagnostics");
      expect(report).toContain("deliberate child crash");
      expect(report).toContain("Set-Cookie: [REDACTED]");
      const files = fs.readdirSync(outputDir, { recursive: true })
        .map(String)
        .map((entry) => path.join(outputDir, entry))
        .filter((entry) => fs.statSync(entry).isFile());
      const attachments = files.map((entry) => fs.readFileSync(entry, "utf8")).join("\n");
      expect(`${report}\n${attachments}`).not.toContain("playwright-fixture-secret");
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
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
