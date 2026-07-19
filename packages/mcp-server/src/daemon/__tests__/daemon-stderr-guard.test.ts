/**
 * #168 (review finding 2) — a daemon whose parent (the wrapper) has DESTROYED
 * its read end of the daemon's stderr pipe must not DIE on the next stderr
 * write. The wrapper does exactly that once it adopts the daemon
 * (lifecycle.ts spawnDaemon release()), and the daemon still writes stderr
 * post-boot (safeHeartbeatTick's "loud but non-fatal" line, the token-sidecar
 * SECURITY refusal). Without a `process.stderr.on("error", …)` listener, Node
 * re-raises the EPIPE as an uncaughtException, and the daemon's
 * uncaughtException handler (index.ts) turns that into exit(1) — so the wrapper
 * kills the very daemon it just adopted.
 *
 * This drives the exact parent/child shape empirically: a child that installs
 * the same handler wiring as the daemon entry, whose parent closes the stderr
 * read end, then writes stderr. WITH the guard it survives (exit 0); WITHOUT it
 * the EPIPE is fatal via uncaughtException (exit 1) — which also proves the
 * finding was real.
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";

/** Mirrors the daemon-entry wiring: uncaughtException → exit(1), plus the
 *  #168 stderr guard when `guard` is set. Then, once the parent has closed our
 *  stderr read end, write stderr and report survival via exit code. */
function childScript(guard: boolean): string {
  return `
    process.on("uncaughtException", () => process.exit(1));
    ${guard ? 'process.stderr.on("error", () => {});' : "/* no stderr guard */"}
    // Tell the parent we're up so it can destroy its stderr read end.
    process.stdout.write("ready\\n");
    setTimeout(() => {
      // Parent has closed the pipe's read end by now → this write EPIPEs.
      try { process.stderr.write("x".repeat(1 << 20)); } catch { /* sync throw path */ }
      // If we're still alive a moment later, the EPIPE was non-fatal.
      setTimeout(() => process.exit(0), 150);
    }, 300);
  `;
}

/** Spawn the child, close our stderr read end after it signals ready, resolve
 *  with its exit code. */
function runChild(guard: boolean): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", childScript(guard)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (b: Buffer) => {
      if (b.toString().includes("ready")) {
        // The wrapper's release(): destroy our read end of the daemon's stderr.
        child.stderr.destroy();
      }
    });
    child.stderr.on("error", () => { /* our read-end teardown — ignore */ });
    child.on("exit", (code) => resolve(code));
  });
}

describe("#168 daemon stderr guard — a destroyed stderr reader is never fatal", () => {
  it("WITHOUT the guard: an EPIPE stderr write is fatal (uncaughtException → exit 1) — confirms the finding", async () => {
    expect(await runChild(false)).toBe(1);
  }, 15_000);

  it("WITH the guard (as the daemon entry installs): the daemon survives the EPIPE (exit 0)", async () => {
    expect(await runChild(true)).toBe(0);
  }, 15_000);
});
