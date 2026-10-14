import { test as base } from "@playwright/test";
import { test, expect } from "./test.js";
import { runAttentionSmoke, SMOKE_TAGS, SMOKE_TIMEOUT_MS, SMOKE_USE } from "./attention-ci-smoke.js";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

test.use(SMOKE_USE);
test.setTimeout(SMOKE_TIMEOUT_MS);
for (const theme of ["dark", "light"] as const) {
  test(`Next-up CI smoke ${theme}`, { tag: SMOKE_TAGS }, async ({ page }, info) => {
    await runAttentionSmoke(page, info, theme);
  });
}

// A real deliberately-failing browser subprocess proves the wrapper cannot
// swallow a failed assertion, and independently checks its resource barriers.
base("Next-up CI smoke failure control", { tag: ["@attention-smoke", "@failure-control"] }, async ({}) => {
  const owned = await fs.mkdtemp(path.join(os.tmpdir(), "dp-attention-ci-fault-"));
  let confirmed = false;
  try {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
    const child = spawnSync(process.execPath, [cli, "test", "--config", "e2e/fixtures/attention-ci-failure.config.ts"], {
      cwd: packageRoot, encoding: "utf8", timeout: 50_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, DP_ATTENTION_FAULT_OUTPUT: owned },
    });
    // Never echo child stdout/stderr: it may contain raw framework context.
    expect(child.error, "fault subprocess must complete within its bound").toBeUndefined();
    expect(child.status, "a genuine browser assertion failure must exit nonzero").toBe(1);
    const files = await fs.readdir(owned, { recursive: true });
    const diagnostics = files.filter((file) => file.endsWith("attention-smoke-diagnostics.txt"));
    expect(diagnostics).toHaveLength(1);
    const body = await fs.readFile(path.join(owned, diagnostics[0]!), "utf8");
    const evidence = JSON.parse(body) as { cleanup: string; failure: string; sandbox: { root: string; port: number } };
    expect(evidence.failure).toContain("Deliberately absent smoke control");
    expect(evidence.cleanup).toBe("removed");
    await expect(fs.stat(evidence.sandbox.root)).rejects.toMatchObject({ code: "ENOENT" });
    const refused = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port: evidence.sandbox.port });
      const done = (value: boolean) => { socket.destroy(); resolve(value); };
      socket.once("connect", () => done(false));
      socket.once("error", (error: NodeJS.ErrnoException) => done(error.code === "ECONNREFUSED"));
      socket.setTimeout(500, () => done(false));
    });
    expect(refused, "the fault daemon's actual port must be released").toBe(true);
    const allDiagnostics = await Promise.all(files.filter((file) => file.endsWith("diagnostics.txt")).map((file) => fs.readFile(path.join(owned, file), "utf8")));
    expect(allDiagnostics.join("\n")).not.toContain("synthetic-auth-sentinel");
    expect(allDiagnostics.join("\n")).toContain("[REDACTED]");
    expect(files.some((file) => /\.(zip|webm)$/.test(file))).toBe(false);
    confirmed = true;
    console.log("[attention-smoke] failure control: exit=1, sandbox removed, TCP refused, diagnostics redacted, trace/video absent");
  } finally {
    if (confirmed) {
      const canonical = await fs.realpath(owned);
      if (path.dirname(canonical) !== await fs.realpath(os.tmpdir()) || !path.basename(canonical).startsWith("dp-attention-ci-fault-")) throw new Error("Refusing fault output cleanup outside its owned sandbox");
      await fs.rm(canonical, { recursive: true, force: true });
    } else {
      // Do not delete evidence or an unconfirmed resource on a causal failure.
      console.warn(`[attention-smoke] fault output retained: ${path.basename(owned)}`);
    }
  }
});
