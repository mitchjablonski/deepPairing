import { afterEach, describe, expect, it } from "vitest";
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
  daemonLogPath,
  daemonLogTail,
  diagnosticPendingBytesForTests,
  spawnDiagnosticProcess,
  withSetupDiagnostics,
} from "../../e2e/daemon-harness.js";
import {
  attachDiagnosticFile,
  BoundedDiagnosticTail,
  readConfinedFileTail,
  redactDiagnostic,
} from "../../e2e/diagnostics.js";

function fakeProcess() {
  return { stdout: new PassThrough(), stderr: new PassThrough() } as unknown as ChildProcess;
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const diagnosticDirs: string[] = [];
afterEach(() => {
  for (const dir of diagnosticDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A throwaway fixture project root whose `.deeppairing/` exists but holds no log yet. */
function fixtureProjectRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dp-diagnostic-root-"));
  diagnosticDirs.push(root);
  fs.mkdirSync(path.join(root, ".deeppairing"));
  return root;
}

function diagnosticInfo(attach: (name: string, value: { path: string }) => Promise<void>): TestInfo {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-diagnostic-file-"));
  diagnosticDirs.push(dir);
  return { status: "failed", expectedStatus: "passed", outputPath: (name: string) => path.join(dir, name), attach } as unknown as TestInfo;
}

async function capturedBody(proc: ChildProcess): Promise<Buffer> {
  let body: Buffer | undefined;
  const info = diagnosticInfo(async (_name, value) => { body = fs.readFileSync(value.path); });
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
      "ws://user:ws-secret@localhost:3901/ws?token=ws-query-secret",
      "wss://user:wss-secret@example.test/socket?token=wss-query-secret",
      '{"token":"token-secret","clientSecret":"client-secret","refreshToken":"refresh-secret","sessionToken":"session-secret","secret":"generic-secret"}',
      "/api/ws?token=relative-ws-secret",
      "x-deeppairing-token: app-header-secret",
    ].join("\n"));

    for (const secret of [
      "double-secret", "single-secret", "bare-secret", "basic-secret",
      "custom-secret", "url-secret", "query-secret", "fragment-secret",
      "two word secret", "single quoted secret", "quote-secret", "suffix-secret",
      "spaced-auth-secret", "trailing-secret", "single-auth-secret",
      "cookie-secret", "set-cookie-secret", "x-header-secret", "snake-secret",
      "json-cookie-secret", "json-csrf-secret", "object-set-cookie-secret",
      "array-cookie-secret", "array-csrf-secret",
      "ws-secret", "ws-query-secret", "wss-secret", "wss-query-secret",
      "token-secret", "client-secret", "refresh-secret", "session-secret",
      "generic-secret", "relative-ws-secret", "app-header-secret",
    ]) expect(output).not.toContain(secret);
    expect(output).toContain('Authorization: "Bearer [REDACTED]"');
    expect(output).toContain("Authorization='[REDACTED]'");
    expect(output).toContain('{"Cookie":"[REDACTED]"}');
    expect(output).toContain("{'Set-Cookie':'[REDACTED]'}");
    expect(output).toContain('{"Set-Cookie":["[REDACTED]"]}');
    expect(output).toContain("https://example.test/path");
    expect(output).toContain("ws://localhost:3901/ws");
    expect(output).toContain("wss://example.test/socket");
    expect(output).toContain("/api/ws");
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
    const info = diagnosticInfo(async (_name, value) => { bodies.push(fs.readFileSync(value.path, "utf8")); });

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
    const info = diagnosticInfo(async (_name, value) => { bodies.push(fs.readFileSync(value.path, "utf8")); });

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
    const info = diagnosticInfo(async () => { throw new Error("attachment backend failed"); });

    await expect(withSetupDiagnostics(proc, info, async () => { throw primary; })).rejects.toBe(primary);
    expect(fs.readFileSync(info.outputPath("daemon-diagnostics.txt"), "utf8")).not.toContain("child-setup-secret");
  });

  it("does not replace a test failure when the diagnostic file cannot be written", async () => {
    const info = diagnosticInfo(async () => { throw new Error("must not attach a missing file"); });
    const blocker = info.outputPath("not-a-directory");
    fs.writeFileSync(blocker, "fixture");
    info.outputPath = (name: string) => path.join(blocker, name);
    await expect(attachDiagnosticFile(info, "browser-diagnostics", Buffer.from("safe line\n"))).resolves.toBeUndefined();
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
      const files = fs.readdirSync(outputDir, { recursive: true })
        .map(String)
        .map((entry) => path.join(outputDir, entry))
        .filter((entry) => fs.statSync(entry).isFile());
      const attachments = files.map((entry) => fs.readFileSync(entry, "utf8")).join("\n");
      expect(files.some((entry) => entry.endsWith("daemon-diagnostics.txt"))).toBe(true);
      expect(attachments).toContain("deliberate child crash");
      expect(attachments).toContain("Set-Cookie: [REDACTED]");
      expect(`${report}\n${attachments}`).not.toContain("playwright-fixture-secret");
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("retains a real daemon.log when Playwright aborts a timed-out beforeAll hook", () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-hook-timeout-diagnostic-"));
    try {
      const cli = path.join(packageRoot, "node_modules", "@playwright", "test", "cli.js");
      const config = path.join(packageRoot, "e2e", "fixtures", "hook-timeout-diagnostics.config.ts");
      const run = spawnSync(process.execPath, [cli, "test", "--config", config], {
        cwd: packageRoot,
        env: { ...process.env, DP_HOOK_TIMEOUT_DIAGNOSTIC_OUTPUT: outputDir },
        encoding: "utf8",
        timeout: 20_000,
      });

      const report = `${run.stdout}\n${run.stderr}`;
      expect(run.status, report).toBe(1);
      expect(report).toContain('"beforeAll" hook timeout of 1500ms exceeded.');
      expect(report).toContain("daemon-log-diagnostics (text/plain)");
      const files = fs.readdirSync(outputDir, { recursive: true })
        .map(String)
        .map((entry) => path.join(outputDir, entry))
        .filter((entry) => fs.statSync(entry).isFile());
      const log = files.find((entry) => entry.endsWith("daemon-log-diagnostics.txt"));
      expect(log).toBeDefined();
      const body = fs.readFileSync(log!, "utf8");
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(64 * 1024 + 256);
      expect(body).toContain("[daemon] Daemon starting");
      expect(body).toContain("[daemon] Daemon running on http://localhost:");
      expect(body).not.toMatch(/[a-f0-9]{64}/i);
      expect(files.some((entry) => entry.endsWith("trace.zip"))).toBe(false);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  }, 30_000);

  describe("real daemon.log tail", () => {
    const notWindows = process.platform !== "win32";

    it("notes a missing log, and a rotated predecessor, without throwing", async () => {
      const root = fixtureProjectRoot();
      expect((await daemonLogTail(root)).toString()).toBe("[daemon.log] missing\n");
      fs.writeFileSync(`${daemonLogPath(root)}.1`, "Authorization: Bearer rotated-secret\n");
      const body = (await daemonLogTail(root)).toString();
      expect(body).toContain("[daemon.log] rotated: daemon.log.1 present (not read)");
      expect(body).toContain("[daemon.log] missing");
      expect(body).not.toContain("rotated-secret");
    });

    it("redacts credentials in a regular log and withholds an unterminated last line", async () => {
      const root = fixtureProjectRoot();
      fs.writeFileSync(daemonLogPath(root), [
        "[daemon] Daemon starting (PID 1)",
        "[daemon] Authorization: Bearer file-secret",
        '{"Cookie":"sid=unterminated-secret',
      ].join("\n"));
      const body = (await daemonLogTail(root)).toString();
      expect(body).toContain("[daemon] Daemon starting (PID 1)");
      expect(body).toContain("Authorization: Bearer [REDACTED]");
      expect(body).toContain("[daemon.log] [incomplete line withheld]");
      expect(body).not.toContain("file-secret");
      expect(body).not.toContain("unterminated-secret");
    });

    it("reads only the bounded tail of an oversized log and drops the partial first line", async () => {
      const root = fixtureProjectRoot();
      const early = `x-api-key: early-secret ${"e".repeat(200)}\n`.repeat(400);
      const late = Array.from({ length: 200 }, (_, i) => `[daemon] late line ${i}`).join("\n") + "\n";
      fs.writeFileSync(daemonLogPath(root), early + late);
      const size = fs.statSync(daemonLogPath(root)).size;

      const result = await readConfinedFileTail(root, [".deeppairing", "daemon.log"], 64 * 1024);
      expect(result.kind).toBe("tail");
      if (result.kind !== "tail") throw new Error("expected a tail");
      expect(result.bytes.length).toBe(64 * 1024);
      expect(result.skipped).toBe(size - 64 * 1024);

      const body = (await daemonLogTail(root)).toString();
      expect(body).toContain(`[daemon.log] tail: last ${64 * 1024} of ${size} bytes`);
      expect(body).toContain("[daemon] late line 0\n");
      expect(body).toContain("[daemon] late line 199\n");
      expect(body).not.toContain("early-secret");
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(64 * 1024 + 256);
      // Every content line is whole: the first line in the window is either complete or dropped.
      expect(body.split("\n").filter((line) => line.startsWith("e"))).toEqual([]);
    });

    it.skipIf(!notWindows)("refuses to follow a symlink named daemon.log", async () => {
      const root = fixtureProjectRoot();
      const target = path.join(root, "elsewhere.log");
      fs.writeFileSync(target, "password=\"symlink-target-secret\"\n");
      fs.symlinkSync(target, daemonLogPath(root));
      const body = (await daemonLogTail(root)).toString();
      expect(body).toBe("[daemon.log] skipped: not a regular file (symlink)\n");
    });

    it.skipIf(!notWindows)("skips a FIFO named daemon.log without blocking", async () => {
      const root = fixtureProjectRoot();
      const made = spawnSync("mkfifo", [daemonLogPath(root)]);
      if (made.status !== 0) return; // mkfifo unavailable on this host
      const started = Date.now();
      const body = (await daemonLogTail(root)).toString();
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(body).toBe("[daemon.log] skipped: not a regular file (fifo)\n");
    });

    it.skipIf(!notWindows)("refuses a symlinked .deeppairing parent pointing outside the fixture root", async () => {
      const root = fixtureProjectRoot();
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dp-diagnostic-outside-"));
      diagnosticDirs.push(outside);
      fs.writeFileSync(path.join(outside, "daemon.log"), "SYNTHETIC_OUTSIDE_REGISTERED_FIXTURE password=\"parent-link-secret\"\n");
      fs.rmdirSync(path.join(root, ".deeppairing"));
      fs.symlinkSync(outside, path.join(root, ".deeppairing"));
      fs.writeFileSync(`${daemonLogPath(root)}.1`, "rotated through the link\n");

      const body = (await daemonLogTail(root)).toString();
      expect(body).toBe("[daemon.log] skipped: path escapes the fixture root (symlinked component)\n");
      expect(body).not.toContain("SYNTHETIC_OUTSIDE_REGISTERED_FIXTURE");
      expect(body).not.toContain("parent-link-secret");
    });

    it.skipIf(!notWindows)("refuses a hard-linked daemon.log", async () => {
      const root = fixtureProjectRoot();
      const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dp-diagnostic-hardlink-")), "outside.log");
      diagnosticDirs.push(path.dirname(outside));
      fs.writeFileSync(outside, "HARDLINK_ESCAPE_CANARY secret=outside-secret\n");
      fs.linkSync(outside, daemonLogPath(root));

      const body = (await daemonLogTail(root)).toString();
      expect(body).toBe("[daemon.log] skipped: not a regular file (hardlink)\n");
      expect(body).not.toContain("HARDLINK_ESCAPE_CANARY");
      expect(body).not.toContain("outside-secret");
    });

    it.skipIf(!notWindows)("does not probe a rotated log through a symlinked parent", async () => {
      const root = fixtureProjectRoot();
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dp-diagnostic-rotation-"));
      diagnosticDirs.push(outside);
      fs.rmdirSync(path.join(root, ".deeppairing"));
      fs.symlinkSync(outside, path.join(root, ".deeppairing"));
      fs.writeFileSync(path.join(outside, "daemon.log.1"), "outside rotation\n");

      expect((await daemonLogTail(root)).toString()).toBe("[daemon.log] missing\n");
    });

    it.skipIf(!notWindows)("still reads a fixture whose ROOT is reached through a symlink (macOS tmp)", async () => {
      const root = fixtureProjectRoot();
      fs.writeFileSync(daemonLogPath(root), "[daemon] via symlinked root\n");
      const rootLink = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dp-diagnostic-link-")), "root");
      diagnosticDirs.push(path.dirname(rootLink));
      fs.symlinkSync(root, rootLink);
      expect((await daemonLogTail(rootLink)).toString()).toBe("[daemon] via symlinked root\n");
    });

    it("skips a directory named daemon.log", async () => {
      const root = fixtureProjectRoot();
      fs.mkdirSync(daemonLogPath(root));
      expect((await daemonLogTail(root)).toString())
        .toBe("[daemon.log] skipped: not a regular file (directory)\n");
    });

    it.skipIf(!notWindows || process.getuid?.() === 0)("notes an unreadable log instead of failing", async () => {
      const root = fixtureProjectRoot();
      fs.writeFileSync(daemonLogPath(root), "apiKey=\"unreadable-secret\"\n", { mode: 0o000 });
      const body = (await daemonLogTail(root)).toString();
      expect(body).toBe("[daemon.log] unreadable (EACCES)\n");
      expect(body).not.toContain("unreadable-secret");
    });

    it("attaches the log tail beside the retained stdout/stderr tail", async () => {
      const root = fixtureProjectRoot();
      fs.writeFileSync(daemonLogPath(root), "[daemon] Daemon running on http://localhost:1\n");
      const proc = fakeProcess();
      captureDaemonOutput(proc, { projectRoot: root });
      proc.stderr!.emit("data", Buffer.from("stderr still retained\n"));
      const bodies: Record<string, string> = {};
      const info = diagnosticInfo(async (name, value) => { bodies[name] = fs.readFileSync(value.path, "utf8"); });

      await attachDaemonOutput(proc, info);
      expect(Object.keys(bodies)).toEqual(["daemon-diagnostics", "daemon-log-diagnostics"]);
      expect(bodies["daemon-diagnostics"]).toBe("[stderr] stderr still retained\n");
      expect(bodies["daemon-log-diagnostics"]).toBe("[daemon] Daemon running on http://localhost:1/\n");
    });

    it("derives the log source only from the spawned daemon's own project root", async () => {
      const root = fixtureProjectRoot();
      fs.writeFileSync(daemonLogPath(root), "[daemon] from the spawn env\n");
      const proc = spawnDiagnosticProcess(process.execPath, ["-e", "process.exit(0)"], {
        env: { ...process.env, DEEPPAIRING_PROJECT_ROOT: root },
      });
      await once(proc, "close");
      const names: string[] = [];
      const info = diagnosticInfo(async (name) => { names.push(name); });
      await attachDaemonOutput(proc, info);
      expect(names).toEqual(["daemon-log-diagnostics"]);

      const plain = spawnDiagnosticProcess(process.execPath, ["-e", "process.exit(0)"]);
      await once(plain, "close");
      names.length = 0;
      await attachDaemonOutput(plain, info);
      expect(names).toEqual([]);
    });

    it("preserves the primary setup error when the log is missing and attaching fails", async () => {
      const root = fixtureProjectRoot();
      const proc = fakeProcess();
      captureDaemonOutput(proc, { projectRoot: root });
      const primary = new Error("primary startup failure");
      const info = diagnosticInfo(async () => { throw new Error("attachment backend failed"); });
      await expect(withSetupDiagnostics(proc, info, async () => { throw primary; })).rejects.toBe(primary);
      expect(fs.readFileSync(info.outputPath("daemon-log-diagnostics.txt"), "utf8")).toBe("[daemon.log] missing\n");
    });
  });

  it("recovery setup exposes its spawned child before readiness and tears that child down on setup failure", () => {
    const source = fs.readFileSync(path.resolve(packageRoot, "e2e/recovery.e2e.ts"), "utf8");
    expect(source).toContain("bootingProc = proc;");
    expect(source).toContain("daemon?.proc ?? bootingProc");
    expect(source).toContain("current ? portOf(current.baseURL) : undefined");
    expect(source).not.toContain("}, projectRoot);");
  });

  it("uploads only failure evidence even when a retry makes CI green", () => {
    const workflow = fs.readFileSync(path.resolve(packageRoot, "../../.github/workflows/ci.yml"), "utf8");
    const upload = workflow.split("- name: Upload Playwright failure diagnostics")[1]?.split("\n  hook-smoke:")[0] ?? "";
    expect(upload).toContain("if: always()");
    expect(upload).toContain("if-no-files-found: ignore");
    expect(upload).toContain("retention-days: 7");
    const paths = upload.match(/packages\/mcp-server\/test-results\/[^\r\n]+/g);
    expect(paths).toEqual([
      "packages/mcp-server/test-results/**/test-failed-*.png",
      "packages/mcp-server/test-results/**/error-context.md",
      "packages/mcp-server/test-results/**/*diagnostics*.txt",
    ]);
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
