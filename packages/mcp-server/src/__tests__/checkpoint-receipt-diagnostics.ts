/** Test-only, bounded receipt evidence. Never export receipt bodies or IDs. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function prepareCheckpointReceiptObserver(statePath: string) {
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
const data = { entryWallMs: wall(), dateCalls: 0, wallSamples: [], claims: [] };
// Observe returned native values; no clock injection, constructor change or policy.
Date.now = function(...args) {
  const value = Reflect.apply(nativeNow, this, args);
  data.dateCalls++;
  if (data.wallSamples.length < 8) data.wallSamples.push({wallMs:value,elapsedMs:elapsed()});
  return value;
};
const stat = fs.statSync.bind(fs), read = fs.readFileSync.bind(fs), write = fs.writeFileSync.bind(fs);
const code = e => typeof e?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(e.code) ? e.code : 'UNKNOWN';
const summarize = source => {
  const readWallMs = wall();
  let exists = null;
  try {
    const size = stat(source).size; exists = true;
    if (size > 8192) return {exists,readWallMs,issue:'OVERSIZE'};
    const r = JSON.parse(read(source,'utf8'));
    if (!r || typeof r !== 'object' || Array.isArray(r)) return {exists:true,readWallMs,issue:'INVALID'};
    const at = typeof r.at === 'string' ? Date.parse(r.at) : NaN;
    const expiry = r.expiresAt === undefined ? at + 60000 : typeof r.expiresAt === 'string' ? Date.parse(r.expiresAt) : NaN;
    const atValid = Number.isFinite(at), expiryValid = Number.isFinite(expiry);
    return {exists:true,readWallMs,atMs:atValid?at:null,expiresAtMs:expiryValid?expiry:null,
      atValid,expiryValid,expiryAfterAt:atValid&&expiryValid&&expiry>=at,
      futureAtRead:atValid&&at>readWallMs,expiredAtRead:expiryValid&&expiry<readWallMs,
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
  for (const key of ["entryWallMs", "exitWallMs", "elapsedMs", "dateCalls", "wallMs", "readWallMs", "atMs", "expiresAtMs"]) {
    if (typeof row[key] === "number" && Number.isFinite(row[key])) result[key] = row[key];
    else if ((key === "atMs" || key === "expiresAtMs") && row[key] === null) result[key] = null;
  }
  for (const key of ["exists", "atValid", "expiryValid", "expiryAfterAt", "futureAtRead", "expiredAtRead", "versionMatches", "sessionMatches", "fileMatches", "artifactIdPresent"]) {
    if (typeof row[key] === "boolean") result[key] = row[key];
    else if (key === "exists" && row[key] === null) result[key] = null;
  }
  for (const key of ["issue", "renameIssue"]) {
    if (typeof row[key] === "string" && /^[A-Z0-9_]{1,32}$/.test(row[key])) result[key] = row[key];
  }
  if (row.renameOutcome === "ok" || row.renameOutcome === "error") result.renameOutcome = row.renameOutcome;
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

/** Read-time flags are observations, not the hook's authoritative `now` argument. */
export function checkpointReceiptDiagnostic(base: string, evidencePath: string): string {
  return JSON.stringify({ ...JSON.parse(base), checkpointReceipt: checkpointReceiptEvidence(evidencePath) });
}
