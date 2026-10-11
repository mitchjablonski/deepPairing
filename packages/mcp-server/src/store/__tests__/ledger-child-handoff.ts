/** Test-only subprocess ownership/barriers for the #488/#500 ledger cases. */
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import { performance } from "node:perf_hooks";

const OUTPUT_LIMIT = 2048;
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

export function observeLedgerChild(child: ChildProcess) {
  const started = performance.now();
  const wallStart = Date.now();
  const stdout = { text: "", omitted: 0 };
  const stderr = { text: "", omitted: 0 };
  const append = (stream: typeof stdout, chunk: string | Buffer) => {
    const text = String(chunk);
    const room = OUTPUT_LIMIT - stream.text.length;
    stream.text += text.slice(0, room);
    stream.omitted += Math.max(0, text.length - room);
  };
  child.stdout?.on("data", (chunk: Buffer) => append(stdout, chunk));
  child.stderr?.on("data", (chunk: Buffer) => append(stderr, chunk));
  let error: string | undefined;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let closed = false;
  child.on("error", (value: NodeJS.ErrnoException) => {
    error = `${value.code ?? value.name}: ${value.message}`.slice(0, 512);
  });
  child.on("exit", (code, signal) => { exit = { code, signal }; });
  child.on("close", () => { closed = true; });
  const diagnostic = () => JSON.stringify({
    pid: child.pid, elapsedMs: Math.round(performance.now() - started),
    wallStart, wallEnd: Date.now(), exit, closed, error,
    stdout: stdout.text, stdoutOmitted: stdout.omitted,
    stderr: stderr.text, stderrOmitted: stderr.omitted,
  });
  const wait = async (predicate: () => boolean, budgetMs: number, label: string, rejectExit = true) => {
    const deadline = performance.now() + budgetMs;
    for (;;) {
      if (rejectExit && (exit || closed || error)) throw new Error(`${label}: child stopped; ${diagnostic()}`);
      if (predicate()) return;
      if (performance.now() >= deadline) throw new Error(`${label}: deadline ${budgetMs}ms; ${diagnostic()}`);
      await pause();
    }
  };
  return {
    child, diagnostic, wait,
    get stdout() { return stdout.text; },
    get result() { return exit; },
    async ownedQueue(lockPath: string, budgetMs = 30_000): Promise<string> {
      let nonce = "";
      await wait(() => {
        try {
          const owner: unknown = JSON.parse(fs.readFileSync(lockPath, "utf8"));
          if (typeof owner !== "object" || owner === null) return false;
          const row = owner as Record<string, unknown>;
          if (row.pid !== child.pid || typeof row.nonce !== "string" || !row.nonce) return false;
          nonce = row.nonce;
          return true;
        } catch (value) {
          if (value instanceof SyntaxError || (value as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw value;
        }
      }, budgetMs, "child-owned queue handoff");
      return nonce;
    },
    async collect(budgetMs = 5_000): Promise<void> {
      try {
        await wait(() => closed, budgetMs, "child close", false);
      } catch {
        child.kill("SIGTERM");
        try { await wait(() => closed, 2_000, "child SIGTERM close", false); }
        catch {
          child.kill("SIGKILL");
          await wait(() => closed, 2_000, "child SIGKILL close", false);
        }
        throw new Error(`child required termination; ${diagnostic()}`);
      }
    },
  };
}

/** Never lose the assertion error when release or bounded collection fails. */
export async function finishLedgerChild(observed: ReturnType<typeof observeLedgerChild>, release: () => void, primary?: unknown): Promise<void> {
  const errors: unknown[] = [];
  try { release(); } catch (error) { errors.push(error); }
  try { await observed.collect(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(primary === undefined ? errors : [primary, ...errors], "ledger child cleanup failed");
}
