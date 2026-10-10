/** Test-only evidence for #500; no retries, deadline changes or hook policy. */
import fs from "node:fs";
import type { ChildProcess } from "node:child_process";

const OUTPUT_LIMIT = 1024;

function bounded(value: unknown, limit = OUTPUT_LIMIT): string {
  const text = typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : "";
  return text.length <= limit ? text : `${text.slice(0, limit)}…[${text.length - limit} chars omitted]`;
}

function errorSummary(error: unknown): Record<string, string> | null {
  if (typeof error !== "object" || error === null) return null;
  const fields: Record<string, string> = {};
  for (const key of ["name", "code", "message"] as const) {
    if (key in error) {
      const value: unknown = (error as Record<string, unknown>)[key];
      if (typeof value === "string") fields[key] = bounded(value, key === "message" ? 256 : 64);
    }
  }
  return fields;
}

/** Only counts/reason/lock age, never the raw state or hook input. */
function stateSummary(statePath: string) {
  let fireCount: number | null = null;
  let lastReason = "";
  let stateIssue: string | null = null;
  try {
    if (fs.statSync(statePath).size > 64 * 1024) {
      stateIssue = "oversize";
    } else {
      const state: unknown = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (typeof state === "object" && state !== null && "fires" in state && Array.isArray(state.fires)) {
        fireCount = state.fires.length;
        const last: unknown = state.fires.at(-1);
        if (typeof last === "object" && last !== null && "reason" in last) lastReason = bounded(last.reason, 240);
      } else stateIssue = "invalid-fires";
    }
  } catch (error) {
    const summary = errorSummary(error);
    stateIssue = summary?.code ?? summary?.name ?? "unreadable";
  }
  let lock: { present: boolean; ageMs?: number; issue?: string };
  try {
    lock = { present: true, ageMs: Math.max(0, Math.round(Date.now() - fs.statSync(`${statePath}.lock`).mtimeMs)) };
  } catch (error) {
    const summary = errorSummary(error);
    lock = { present: false, ...(summary?.code === "ENOENT" ? {} : { issue: summary?.code ?? "unreadable" }) };
  }
  return { fireCount, lastReason, stateIssue, lock };
}

export interface HookSpawnObservation {
  lane: string;
  deadlineMs: number;
  startedAt: number;
  statePath: string;
  beforeFireCount: number | null;
}

export function beginHookSpawn(lane: string, deadlineMs: number, statePath: string): HookSpawnObservation {
  const beforeFireCount = stateSummary(statePath).fireCount;
  return { lane, deadlineMs, statePath, beforeFireCount, startedAt: performance.now() };
}

interface HookExit {
  status: number | null;
  signal: string | null;
  error?: unknown;
  stdout?: unknown;
  stderr?: unknown;
}

export function hookSpawnDiagnostic(observation: HookSpawnObservation, result: HookExit): string {
  const state = stateSummary(observation.statePath);
  return JSON.stringify({
    lane: bounded(observation.lane, 120),
    elapsedMs: Math.round(performance.now() - observation.startedAt),
    deadlineMs: observation.deadlineMs,
    exitCode: result.status,
    signal: result.signal,
    error: errorSummary(result.error),
    // Stream captures include their omission-count suffix; preserve it rather
    // than reporting the suffix itself as truncated output.
    stdout: bounded(result.stdout, OUTPUT_LIMIT + 64),
    stderr: bounded(result.stderr, OUTPUT_LIMIT + 64),
    beforeFireCount: observation.beforeFireCount,
    fireDelta: state.fireCount === null ? null : state.fireCount - (observation.beforeFireCount ?? 0),
    state,
  });
}

/** Capture close (including its signal), errors and bounded piped output. */
export function observeHookChild(child: ChildProcess, observation: HookSpawnObservation) {
  return new Promise<{ status: number | null; signal: NodeJS.Signals | null; error: unknown; stdout: string; stderr: string; diagnostic: string }>((resolve) => {
    const stdout = { text: "", omitted: 0 };
    const stderr = { text: "", omitted: 0 };
    const append = (output: typeof stdout, chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const remaining = OUTPUT_LIMIT - output.text.length;
      output.text += text.slice(0, remaining);
      output.omitted += Math.max(0, text.length - remaining);
    };
    const render = (output: typeof stdout) => output.text + (output.omitted ? `…[${output.omitted} chars omitted]` : "");
    let error: unknown;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string | Buffer) => append(stdout, chunk));
    child.stderr?.on("data", (chunk: string | Buffer) => append(stderr, chunk));
    child.on("error", (value: Error) => { error = value; });
    child.on("close", (status, signal) => {
      const result = { status, signal, error, stdout: render(stdout), stderr: render(stderr) };
      resolve({ ...result, diagnostic: hookSpawnDiagnostic(observation, result) });
    });
  });
}
