/**
 * #426 — a daemon child that dies during startup must fail `ensureDaemon`
 * at once, not after the 40 s readiness ceiling.
 *
 * `spawnDaemon` starts the daemon detached + unref'd, and `waitForDaemon`
 * used to poll only the port/daemon.json, so an early death — a bind failure
 * (exit 2/3), a signal during module load, a missing entry — left the caller
 * (MCP startup, the DaemonClient recovery path, `deeppairing demo`) waiting
 * the full ceiling before any error. The spawned child's exit now ends the
 * wait immediately, with the exit code/signal and the daemon's stderr tail.
 *
 * Deterministic early death with the REAL daemon: give the child a one-port
 * window (DEEPPAIRING_PORT_SPAN=1) whose only port we already hold, so every
 * bind attempt hits EADDRINUSE and the daemon exits 2 ("No free port…") on
 * stderr. The port is the LAST slot of this worker's test window, never the
 * canonical 3847-3974 range.
 */
import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDaemon } from "../daemon/lifecycle.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const distDaemonEntry = path.resolve(__dir, "../../dist/daemon/index.js");

const restore: Array<() => void> = [];
afterEach(() => { while (restore.length) restore.pop()!(); });

function setEnv(key: string, value: string): void {
  const prev = process.env[key];
  process.env[key] = value;
  restore.push(() => { if (prev === undefined) delete process.env[key]; else process.env[key] = prev; });
}

describe("#426 — ensureDaemon surfaces an early daemon exit immediately", () => {
  it("rejects within ~1 s of the child's death with its exit code and stderr tail (not the 40 s ceiling)", async () => {
    const base = Number(process.env.DEEPPAIRING_PORT_BASE);
    const span = Number(process.env.DEEPPAIRING_PORT_SPAN ?? "128");
    expect(base).toBeGreaterThanOrEqual(20000); // the test window, never 3847-3974
    const squatPort = base + span - 1;
    const squatter = net.createServer();
    await new Promise<void>((resolve, reject) => {
      squatter.once("error", reject);
      squatter.listen(squatPort, "127.0.0.1", () => resolve());
    });
    restore.push(() => squatter.close());

    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-426-"));
    restore.push(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
    // Only the CHILD reads these (spawnDaemon passes process.env through);
    // this process resolved its own port window at module load.
    setEnv("DEEPPAIRING_PORT_BASE", String(squatPort));
    setEnv("DEEPPAIRING_PORT_SPAN", "1");
    setEnv("DEEPPAIRING_OPEN_BROWSER", "0");

    const started = Date.now();
    const err = await ensureDaemon(projectRoot).then(() => null, (e: unknown) => e as Error);
    const elapsed = Date.now() - started;

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/exited during startup \((exit code \d+|signal \w+)\)/);
    expect(err!.message).toMatch(/Daemon stderr:\n\S/);
    if (fs.existsSync(distDaemonEntry)) {
      // The real daemon's bind-failure exit, reported with its own words.
      expect(err!.message).toContain("exit code 2");
      expect(err!.message).toContain("No free port");
    }
    // Node cold start + the daemon's bind attempts, then an immediate report —
    // an order of magnitude under the 40 s readiness ceiling.
    expect(elapsed).toBeLessThan(10_000);
    expect(fs.existsSync(path.join(projectRoot, ".deeppairing", "daemon.json"))).toBe(false);
  }, 20_000);
});
