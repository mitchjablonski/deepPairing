import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// src/hooks/stop-hook.ts
import fs2 from "node:fs";
import path2 from "node:path";

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

// src/hooks/hook-state.ts
import fs from "node:fs";
import path from "node:path";
var FIRE_LOG_CAP = 50;
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
function hookErrorMessage(err) {
  if (typeof err === "object" && err !== null && "message" in err) {
    const message = err.message;
    if (typeof message === "string") return message;
  }
  return String(err);
}
function resolveHookProjectRoot(eventCwd) {
  return process.env.CLAUDE_PROJECT_DIR || process.env.DEEPPAIRING_PROJECT_ROOT || (typeof eventCwd === "string" && eventCwd ? eventCwd : "") || process.cwd();
}
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
  }
}
function acquireHookStateLock(statePath, now = Date.now()) {
  const lock = `${statePath}.lock`;
  const deadline = now + LOCK_MAX_WAIT_MS;
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
      if (Date.now() >= deadline) return null;
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
function appendHookFire(statePath, fire, mutate) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const lock = acquireHookStateLock(statePath);
    try {
      const state = readHookState(statePath);
      state.version = 1;
      const fires = Array.isArray(state.fires) ? state.fires : [];
      fires.push(fire);
      state.fires = fires.slice(-FIRE_LOG_CAP);
      mutate?.(state);
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

// src/hooks/stop-hook.ts
var HOOK_NAME = "stop";
var MAX_AGE_MS = 30 * 60 * 1e3;
var BLOCKING_TYPES = ["research", "spec", "plan", "decision", "code_change", "changeset"];
function runStopHook(now = Date.now()) {
  const projectRoot = resolveHookProjectRoot();
  function exit(code, reason) {
    appendHookFire(hookStatePath(projectRoot), {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      hook: HOOK_NAME,
      exitCode: code,
      reason
    });
    process.exit(code);
  }
  try {
    const sessionsDir = path2.join(projectRoot, ".deeppairing", "sessions");
    if (!fs2.existsSync(sessionsDir)) exit(0, "no sessions dir");
    let owesDebriefSession = null;
    for (const id of fs2.readdirSync(sessionsDir)) {
      const af = path2.join(sessionsDir, id, "artifacts.json");
      if (!fs2.existsSync(af)) continue;
      let arr;
      try {
        arr = JSON.parse(fs2.readFileSync(af, "utf-8"));
      } catch {
        continue;
      }
      if (!Array.isArray(arr)) continue;
      const artifacts = arr;
      const blocking = artifacts.some((x) => {
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
        const owes = sessionOwesDebrief(artifacts, (x) => {
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
    exit(0, "error: " + hookErrorMessage(err));
  }
}

// src/cli/stop-hook-entry.ts
runStopHook();
