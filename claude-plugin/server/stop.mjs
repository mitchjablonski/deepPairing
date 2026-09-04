import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// src/cli/stop-hook-entry.ts
import fs from "node:fs";
import path from "node:path";

// src/debrief-gate.ts
var CODE_CLOSED_STATUSES = ["superseded", "retracted", "obsolete"];
var DEBRIEF_DEAD_STATUSES = ["superseded", "retracted", "obsolete", "rejected"];
var CEREMONY_TYPES = ["decision", "spec", "plan"];
function isExternalReview(a) {
  if (a?.type !== "changeset") return false;
  const content = a?.content;
  return !!content && typeof content === "object" && content.reviewIntent === "external";
}
function sessionOwesDebrief(artifacts, isRecent = () => true) {
  const hasLiveDebrief = artifacts.some(
    (a) => a?.type === "debrief" && !DEBRIEF_DEAD_STATUSES.includes(a?.status ?? "")
  );
  if (hasLiveDebrief) return false;
  const recentCode = artifacts.filter(
    (a) => (a?.type === "code_change" || a?.type === "changeset") && !isExternalReview(a) && !CODE_CLOSED_STATUSES.includes(a?.status ?? "") && isRecent(a)
  );
  if (recentCode.length === 0) return false;
  const changesets = recentCode.filter((a) => a?.type === "changeset").length;
  const codeChanges = recentCode.filter((a) => a?.type === "code_change").length;
  const hasCeremony = artifacts.some((a) => CEREMONY_TYPES.includes(a?.type ?? "")) || artifacts.some((a) => a?.type === "debrief");
  const trivial = changesets === 0 && codeChanges === 1 && !hasCeremony;
  return !trivial;
}

// src/cli/stop-hook-entry.ts
var HOOK_NAME = "stop";
var STATE_CAP = 50;
var MAX_AGE_MS = 30 * 60 * 1e3;
var BLOCKING_TYPES = ["research", "spec", "plan", "decision", "code_change", "changeset"];
function projectRoot() {
  return process.env.CLAUDE_PROJECT_DIR || process.env.DEEPPAIRING_PROJECT_ROOT || process.cwd();
}
function readState(statePath) {
  let raw;
  try {
    raw = fs.readFileSync(statePath, "utf-8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
  }
  try {
    fs.writeFileSync(`${statePath}.corrupt-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}`, raw);
  } catch {
  }
  return {};
}
function writeStateAtomic(statePath, state) {
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
function acquireLock(statePath) {
  const lock = `${statePath}.lock`;
  const deadline = Date.now() + 500;
  for (; ; ) {
    try {
      fs.closeSync(fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY));
      return lock;
    } catch (error) {
      if (error.code !== "EEXIST") return null;
      if (Date.now() >= deadline) return null;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 5e3) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch (error2) {
        if (error2.code !== "ENOENT") return null;
      }
      if (Date.now() >= deadline) return null;
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      } catch {
      }
    }
  }
}
function releaseLock(lock) {
  if (!lock) return;
  try {
    fs.unlinkSync(lock);
  } catch {
  }
}
function recordFire(exitCode, reason) {
  try {
    const statePath = path.join(projectRoot(), ".deeppairing", "hooks-state.json");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const lock = acquireLock(statePath);
    try {
      const state = readState(statePath);
      state.version = 1;
      const fires = Array.isArray(state.fires) ? state.fires : [];
      fires.push({ at: (/* @__PURE__ */ new Date()).toISOString(), hook: HOOK_NAME, exitCode, reason });
      state.fires = fires.slice(-STATE_CAP);
      writeStateAtomic(statePath, state);
    } finally {
      releaseLock(lock);
    }
  } catch {
  }
}
function exit(code, reason) {
  recordFire(code, reason);
  process.exit(code);
}
try {
  const sessionsDir = path.join(projectRoot(), ".deeppairing", "sessions");
  if (!fs.existsSync(sessionsDir)) exit(0, "no sessions dir");
  const now = Date.now();
  let owesDebriefSession = null;
  for (const id of fs.readdirSync(sessionsDir)) {
    const af = path.join(sessionsDir, id, "artifacts.json");
    if (!fs.existsSync(af)) continue;
    let arr;
    try {
      arr = JSON.parse(fs.readFileSync(af, "utf-8"));
    } catch {
      continue;
    }
    if (!Array.isArray(arr)) continue;
    const blocking = arr.some((x) => {
      if (x?.status !== "draft") return false;
      if (!x?.type || !BLOCKING_TYPES.includes(x.type)) return false;
      const t = x?.createdAt ? new Date(x.createdAt).getTime() : 0;
      if (t && now - t > MAX_AGE_MS) return false;
      return true;
    });
    if (blocking) {
      process.stderr.write("deepPairing: pending artifacts need review \u2014 call check_feedback\n");
      exit(0, "pending artifacts in " + id);
    }
    if (owesDebriefSession === null) {
      const owes = sessionOwesDebrief(arr, (x) => {
        const t = x?.createdAt ? new Date(x.createdAt).getTime() : 0;
        return !t || now - t <= MAX_AGE_MS;
      });
      if (owes) owesDebriefSession = id;
    }
  }
  if (owesDebriefSession !== null) {
    process.stderr.write(
      "deepPairing: code was presented but no present_debrief yet \u2014 end the run with one so your pair gets the walk-through\n"
    );
    exit(0, "owes debrief in " + owesDebriefSession);
  }
  exit(0, "pass: no blocking drafts");
} catch (err) {
  exit(0, "error: " + (err instanceof Error ? err.message : String(err)));
}
