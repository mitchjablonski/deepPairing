/** Test-only, bounded receipt evidence. Never export receipt bodies or IDs. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface CheckpointFixtureClock {
  /** Explicit owned-receipt epoch; never supplied by production. */
  epochMs?: number;
  /** Declared input-clock epoch for deterministic controls, not native telemetry. */
  inputEpochMs?: number;
  /** Test-only backward input control, separate from observed native OS time. */
  inputWallStepMs?: number;
}

export function prepareCheckpointReceiptObserver(statePath: string, clock: CheckpointFixtureClock = {}) {
  if (clock.epochMs !== undefined && !Number.isFinite(clock.epochMs)) throw new Error("Invalid fixture epoch");
  if (clock.inputEpochMs !== undefined && !Number.isFinite(clock.inputEpochMs)) throw new Error("Invalid input epoch");
  if (clock.inputWallStepMs !== undefined && !Number.isFinite(clock.inputWallStepMs)) throw new Error("Invalid fixture input step");
  const prefix = path.join(path.dirname(statePath), `receipt-observer-${randomUUID()}`);
  const evidencePath = `${prefix}.json`;
  const preloadPath = `${prefix}.mjs`;
  const sessions = path.join(path.dirname(statePath), "sessions") + path.sep;
  fs.writeFileSync(preloadPath, `
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const nativeNow = Date.now;
const wall = () => Reflect.apply(nativeNow, Date, []);
const mono = process.hrtime.bigint();
const elapsed = () => Number(process.hrtime.bigint() - mono) / 1e6;
const epoch = ${JSON.stringify(clock.epochMs ?? null)};
const inputEpoch = ${JSON.stringify(clock.inputEpochMs ?? null)};
const inputStep = ${JSON.stringify(clock.inputWallStepMs ?? 0)};
const mode = epoch !== null ? 'fixture-monotonic' : inputStep || inputEpoch !== null ? 'controlled-input' : 'native';
const data = { mode, entryWallMs: wall(), dateCalls: 0, wallSamples: [], claims: [] };
const inputWall = native => (inputEpoch === null ? native : inputEpoch + Math.floor(elapsed())) + (data.dateCalls >= 1 ? inputStep : 0);
const effective = native => epoch === null ? inputWall(native) : epoch + Math.floor(elapsed());
// Default mode delegates native Date.now. Only explicitly declared owned fixture
// children get an effective clock; Date constructor and production stay untouched.
Date.now = function(...args) {
  const native = Reflect.apply(nativeNow, this, args);
  const value = effective(native), input = inputWall(native);
  data.dateCalls++;
  if (data.wallSamples.length < 8) data.wallSamples.push({wallMs:native,inputWallMs:input,effectiveMs:value,elapsedMs:elapsed()});
  return value;
};
// Only the declared backward-input regression primes a before-step sample.
if (inputStep) Date.now();
const stat = fs.statSync.bind(fs), read = fs.readFileSync.bind(fs), write = fs.writeFileSync.bind(fs);
const code = e => typeof e?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(e.code) ? e.code : 'UNKNOWN';
const summarize = source => {
  const readWallMs = wall();
  const readEffectiveMs = effective(readWallMs);
  let exists = null;
  try {
    const size = stat(source).size; exists = true;
    if (size > 8192) return {exists,readWallMs,issue:'OVERSIZE'};
    const r = JSON.parse(read(source,'utf8'));
    if (!r || typeof r !== 'object' || Array.isArray(r)) return {exists:true,readWallMs,issue:'INVALID'};
    const at = typeof r.at === 'string' ? Date.parse(r.at) : NaN;
    const expiry = r.expiresAt === undefined ? at + 60000 : typeof r.expiresAt === 'string' ? Date.parse(r.expiresAt) : NaN;
    const atValid = Number.isFinite(at), expiryValid = Number.isFinite(expiry);
    return {exists:true,readWallMs,readEffectiveMs,atMs:atValid?at:null,expiresAtMs:expiryValid?expiry:null,
      atValid,expiryValid,expiryAfterAt:atValid&&expiryValid&&expiry>=at,
      futureAtRead:atValid&&at>readWallMs,expiredAtRead:expiryValid&&expiry<readWallMs,
      futureAtEffectiveRead:atValid&&at>readEffectiveMs,expiredAtEffectiveRead:expiryValid&&expiry<readEffectiveMs,
      versionMatches:r.version===1,sessionMatches:r.sessionId===path.basename(path.dirname(path.dirname(source))),
      fileMatches:typeof r.filePath==='string'&&path.isAbsolute(r.filePath)&&
        crypto.createHash('sha256').update(r.filePath).digest('hex')+'.json'===path.basename(source),
      artifactIdPresent:typeof r.artifactId==='string'&&r.artifactId.length>0};
  } catch (e) { return {exists:code(e)==='ENOENT'?false:exists,readWallMs,issue:e instanceof SyntaxError?'INVALID':code(e)}; }
};
const rename = fs.renameSync;
fs.renameSync = function(source,destination,...args) {
  const from = String(source), to = String(destination);
  const observed = from.startsWith(${JSON.stringify(sessions)}) &&
    /[\\/]code-checkpoints[\\/][a-f0-9]{64}\\.json$/.test(from) && to.startsWith(from+'.claim.');
  if (!observed || data.claims.length >= 4) return Reflect.apply(rename,this,[source,destination,...args]);
  const row = summarize(from); data.claims.push(row);
  try { const result = Reflect.apply(rename,this,[source,destination,...args]); row.renameOutcome='ok'; return result; }
  catch(e) { row.renameOutcome='error'; row.renameIssue=code(e); throw e; }
};
const save = () => {try {write(${JSON.stringify(evidencePath)},JSON.stringify(data));} catch {}};
save();
process.once('exit',()=>{data.exitWallMs=wall();data.elapsedMs=elapsed();save();});
`);
  return { preloadPath, evidencePath };
}

function pick(value: unknown) {
  const result: Record<string, number | boolean | string | null> = {};
  if (typeof value !== "object" || value === null) return result;
  const row = value as Record<string, unknown>;
  for (const key of ["entryWallMs", "exitWallMs", "elapsedMs", "dateCalls", "wallMs", "inputWallMs", "effectiveMs", "readWallMs", "readEffectiveMs", "atMs", "expiresAtMs"]) {
    if (typeof row[key] === "number" && Number.isFinite(row[key])) result[key] = row[key];
    else if ((key === "atMs" || key === "expiresAtMs") && row[key] === null) result[key] = null;
  }
  for (const key of ["exists", "atValid", "expiryValid", "expiryAfterAt", "futureAtRead", "expiredAtRead", "futureAtEffectiveRead", "expiredAtEffectiveRead", "versionMatches", "sessionMatches", "fileMatches", "artifactIdPresent"]) {
    if (typeof row[key] === "boolean") result[key] = row[key];
    else if (key === "exists" && row[key] === null) result[key] = null;
  }
  for (const key of ["issue", "renameIssue"]) {
    if (typeof row[key] === "string" && /^[A-Z0-9_]{1,32}$/.test(row[key])) result[key] = row[key];
  }
  if (row.renameOutcome === "ok" || row.renameOutcome === "error") result.renameOutcome = row.renameOutcome;
  if (row.mode === "native" || row.mode === "controlled-input" || row.mode === "fixture-monotonic") result.mode = row.mode;
  return result;
}

export function checkpointReceiptEvidence(evidencePath: string) {
  try {
    if (fs.statSync(evidencePath).size > 8192) return { issue: "oversize" };
    const data: unknown = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
    if (typeof data !== "object" || data === null) return { issue: "invalid" };
    const row = data as Record<string, unknown>;
    return { ...pick(row), ...(row.exitWallMs === undefined ? { partial: true } : {}),
      wallSamples: Array.isArray(row.wallSamples) ? row.wallSamples.slice(0, 8).map(pick) : [],
      claims: Array.isArray(row.claims) ? row.claims.slice(0, 4).map(pick) : [] };
  } catch { return { issue: "unreadable" }; }
}

/** Both read-time clock flags are observations, not the hook's exact `now` argument. */
export function checkpointReceiptDiagnostic(base: string, evidencePath: string): string {
  return JSON.stringify({ ...JSON.parse(base), checkpointReceipt: checkpointReceiptEvidence(evidencePath) });
}
