/** Optional test-only observer, installed only in stale-lock contract cases. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface LockObservation {
  statePath: string;
  childLockEvidencePath?: string;
}

/** Prepend a boundary fake, then observe it without changing its results. */
export function prepareHookLockObserver(observation: LockObservation, prelude = ""): string {
  const prefix = path.join(path.dirname(observation.statePath), `lock-observer-${randomUUID()}`);
  const evidence = `${prefix}.json`;
  const preload = `${prefix}.mjs`;
  observation.childLockEvidencePath = evidence;
  fs.writeFileSync(preload, `${prelude}\n
import __dpFs from 'node:fs';
const __dpLock = ${JSON.stringify(`${observation.statePath}.lock`)};
const __dpEvidence = ${JSON.stringify(evidence)};
const __dpStat = __dpFs.statSync.bind(__dpFs);
const __dpWrite = __dpFs.writeFileSync.bind(__dpFs);
const __dpCode = e => typeof e?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(e.code) ? e.code : 'UNKNOWN';
const __dpSample = () => {
  const wallMs = Date.now();
  try { const mtimeMs = __dpStat(__dpLock).mtimeMs; return { wallMs, mtimeMs, ageMs: wallMs - mtimeMs }; }
  catch (e) { return { wallMs, issue: __dpCode(e) }; }
};
const __dpData = { entry: __dpSample(), calls: {} };
for (const call of ['openSync', 'statSync', 'unlinkSync']) {
  const real = __dpFs[call];
  __dpFs[call] = function(p, ...args) {
    if (String(p) !== __dpLock) return Reflect.apply(real, this, [p, ...args]);
    const row = __dpData.calls[call] ??= { count: 0 };
    row.count++;
    row.wallMs = Date.now();
    try {
      const result = Reflect.apply(real, this, [p, ...args]);
      row.outcome = 'ok'; delete row.issue;
      if (call === 'statSync') { row.mtimeMs = result.mtimeMs; row.ageMs = row.wallMs - result.mtimeMs; }
      return result;
    } catch (e) { row.outcome = 'error'; row.issue = __dpCode(e); throw e; }
  };
}
const __dpSave = () => { try { __dpWrite(__dpEvidence, JSON.stringify(__dpData)); } catch {} };
__dpSave();
process.once('exit', () => { __dpData.exit = __dpSample(); __dpSave(); });
`);
  return preload;
}

function metadata(value: unknown): Record<string, number | string> {
  const result: Record<string, number | string> = {};
  if (typeof value !== "object" || value === null) return result;
  const row = value as Record<string, unknown>;
  for (const key of ["wallMs", "mtimeMs", "ageMs", "count"] as const) {
    if (typeof row[key] === "number" && Number.isFinite(row[key])) result[key] = row[key];
  }
  if (row.outcome === "ok" || row.outcome === "error") result.outcome = row.outcome;
  if (typeof row.issue === "string" && /^[A-Z0-9_]{1,32}$/.test(row.issue)) result.issue = row.issue;
  return result;
}

/** Whitelist bounded metadata; never return arbitrary child-file contents. */
export function hookLockEvidence(observation: LockObservation) {
  if (!observation.childLockEvidencePath) return undefined;
  try {
    if (fs.statSync(observation.childLockEvidencePath).size > 8192) return { issue: "oversize" };
    const parsed: unknown = JSON.parse(fs.readFileSync(observation.childLockEvidencePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return { issue: "invalid" };
    const data = parsed as Record<string, unknown>;
    const calls: Record<string, Record<string, number | string>> = {};
    if (typeof data.calls === "object" && data.calls !== null) {
      const rows = data.calls as Record<string, unknown>;
      for (const call of ["openSync", "statSync", "unlinkSync"]) {
        if (rows[call] !== undefined) calls[call] = metadata(rows[call]);
      }
    }
    return { entry: metadata(data.entry), ...(data.exit === undefined ? { partial: true } : { exit: metadata(data.exit) }), calls };
  } catch {
    return { issue: "unreadable" };
  }
}
