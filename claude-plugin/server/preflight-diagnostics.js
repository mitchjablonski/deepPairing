import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// src/hooks/hook-state.ts
import fs from "node:fs";
import path from "node:path";
var LOCK_STALE_MS = 5e3;
var LOCK_SPIN_MS = 2;
var LOCK_MAX_WAIT_MS = 500;
function errnoCode(err) {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = err.code;
    if (typeof code === "string") return code;
  }
  return void 0;
}
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
  }
}
function acquireHookStateLock(statePath, _now = Date.now()) {
  const lock = `${statePath}.lock`;
  const deadline = process.hrtime.bigint() + BigInt(LOCK_MAX_WAIT_MS) * 1000000n;
  let brokeStale = false;
  for (; ; ) {
    try {
      fs.closeSync(fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY));
      return lock;
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") return null;
      try {
        if (!brokeStale && Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          brokeStale = true;
          fs.unlinkSync(lock);
          continue;
        }
      } catch (staleErr) {
        if (errnoCode(staleErr) !== "ENOENT") return null;
      }
      if (process.hrtime.bigint() >= deadline) return null;
      sleepSync(LOCK_SPIN_MS);
    }
  }
}
function releaseHookStateLock(lock) {
  if (!lock) return;
  try {
    fs.unlinkSync(lock);
  } catch {
  }
}
function readHookState(statePath) {
  let raw;
  try {
    raw = fs.readFileSync(statePath, "utf-8");
  } catch {
    return { version: 1 };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
  }
  try {
    const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(`${statePath}.corrupt-${stamp}`, raw);
  } catch {
  }
  return { version: 1 };
}
function writeHookStateAtomic(statePath, state) {
  const tmp = `${statePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 10)}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, statePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
    }
    throw err;
  }
}
function mutateHookState(statePath, mutate, opts = {}) {
  try {
    if (opts.createDir === false) {
      if (!fs.statSync(path.dirname(statePath)).isDirectory()) return;
    } else {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
    }
    const lock = acquireHookStateLock(statePath);
    try {
      const state = readHookState(statePath);
      state.version = 1;
      mutate(state);
      writeHookStateAtomic(statePath, state);
    } finally {
      releaseHookStateLock(lock);
    }
  } catch {
  }
}
function hookStatePath(projectRoot) {
  return path.join(projectRoot, ".deeppairing", "hooks-state.json");
}

// src/hooks/preflight-diagnostics.ts
var PREFLIGHT_FAILURE_CLASSES = [
  "input_malformed",
  "ledger_unreadable",
  "ledger_corrupt",
  // #557 — a ledger entry the matcher can't fully read: its concept ignored or
  // coerced, or (if the matcher still throws) the entry skipped; the rest enforce.
  "ledger_entry_invalid",
  "matcher_import_failed",
  "evaluator_threw",
  "session_store_unreadable"
];
var PREFLIGHT_FAILURE_SOURCES = [
  "stdin",
  "preferences",
  "team",
  "sessions",
  "core",
  "rules",
  "matcher",
  "backstop",
  "state",
  "skeleton",
  "hook"
];
var PREFLIGHT_FAILURES_FIELD = "preflightFailures";
var PREFLIGHT_FAILURE_COUNT_CAP = 1e6;
var DETAIL_MAX = 64;
var PREFLIGHT_FAILURE_INDICES_CAP = 8;
function boundedIndices(v) {
  if (!Array.isArray(v)) return void 0;
  const out = v.filter((i) => Number.isInteger(i) && i >= 0 && i < 1e6).slice(0, PREFLIGHT_FAILURE_INDICES_CAP);
  return out.length > 0 ? out : void 0;
}
var CLASS_SET = new Set(PREFLIGHT_FAILURE_CLASSES);
var SOURCE_SET = new Set(PREFLIGHT_FAILURE_SOURCES);
var CODE_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
function failureCode(err) {
  if (typeof err === "object" && err !== null) {
    const code = err.code;
    if (typeof code === "string" && CODE_RE.test(code)) return code;
    const name = err.name;
    if (typeof name === "string" && CODE_RE.test(name)) return name;
  }
  return "Error";
}
function hasErrno(err) {
  const code = typeof err === "object" && err !== null ? err.code : void 0;
  return typeof code === "string" && /^E[A-Z0-9]+$/.test(code);
}
function noteFailure(kind, source, err) {
  switch (kind) {
    case "ledger":
    case "store": {
      const code = failureCode(err);
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      const unreadable = hasErrno(err);
      if (kind === "store") return { cls: "session_store_unreadable", source, tag: unreadable ? failureCode(err) : "corrupt" };
      return { cls: unreadable ? "ledger_unreadable" : "ledger_corrupt", source, tag: code };
    }
    case "schema":
      return { cls: "ledger_corrupt", source, tag: "schema" };
    case "import":
      return { cls: "matcher_import_failed", source, tag: failureCode(err) };
    case "evaluate":
      return { cls: "evaluator_threw", source, tag: failureCode(err) };
    case "input":
      return { cls: "input_malformed", source, tag: err === void 0 ? "shape" : failureCode(err) };
  }
}
function pushFailure(sink, note) {
  try {
    if (sink && note) sink.push(note);
  } catch {
  }
}
function sanitizeDetail(note) {
  const source = SOURCE_SET.has(note.source) ? note.source : "hook";
  const tag = typeof note.tag === "string" && CODE_RE.test(note.tag) ? note.tag : "Error";
  return `${source}:${tag}`.slice(0, DETAIL_MAX);
}
function validIso(v) {
  return typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));
}
function readPreflightFailures(state) {
  const out = {};
  const field = state && typeof state === "object" ? state[PREFLIGHT_FAILURES_FIELD] : void 0;
  if (!field || typeof field !== "object" || Array.isArray(field)) return out;
  for (const cls of PREFLIGHT_FAILURE_CLASSES) {
    const e = field[cls];
    if (!e || typeof e !== "object") continue;
    const count = typeof e.count === "number" && Number.isFinite(e.count) ? Math.max(0, Math.min(Math.floor(e.count), PREFLIGHT_FAILURE_COUNT_CAP)) : 0;
    if (count === 0 || !validIso(e.firstAt) || !validIso(e.lastAt)) continue;
    const detail = typeof e.detail === "string" && /^[a-z]+:[A-Za-z0-9_]{1,40}$/.test(e.detail) ? e.detail : "hook:Error";
    const indices = boundedIndices(e.indices);
    out[cls] = { count, firstAt: e.firstAt, lastAt: e.lastAt, detail, ...indices ? { indices } : {} };
  }
  return out;
}
function applyPreflightFailures(state, notes, now) {
  const current = readPreflightFailures(state);
  const iso = new Date(now).toISOString();
  const seen = /* @__PURE__ */ new Map();
  for (const note of notes) {
    if (note && CLASS_SET.has(note.cls)) seen.set(note.cls, note);
  }
  for (const [cls, note] of seen) {
    const prev = current[cls];
    const indices = boundedIndices(note.indices);
    current[cls] = {
      count: Math.min((prev?.count ?? 0) + 1, PREFLIGHT_FAILURE_COUNT_CAP),
      firstAt: prev?.firstAt ?? iso,
      lastAt: iso,
      detail: sanitizeDetail(note),
      ...indices ? { indices } : {}
    };
  }
  state[PREFLIGHT_FAILURES_FIELD] = current;
}
function recordPreflightFailures(projectRoot, notes, now = Date.now()) {
  try {
    const real = notes.filter((n) => !!n);
    if (real.length === 0 || typeof projectRoot !== "string" || !projectRoot) return;
    mutateHookState(hookStatePath(projectRoot), (state) => applyPreflightFailures(state, real, now), { createDir: false });
  } catch {
  }
}
export {
  PREFLIGHT_FAILURES_FIELD,
  PREFLIGHT_FAILURE_CLASSES,
  PREFLIGHT_FAILURE_COUNT_CAP,
  PREFLIGHT_FAILURE_INDICES_CAP,
  PREFLIGHT_FAILURE_SOURCES,
  applyPreflightFailures,
  failureCode,
  noteFailure,
  pushFailure,
  readPreflightFailures,
  recordPreflightFailures
};
