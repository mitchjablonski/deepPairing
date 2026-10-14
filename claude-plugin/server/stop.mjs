import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// src/hooks/stop-hook.ts
import fs3 from "node:fs";
import path3 from "node:path";

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
import fs2 from "node:fs";
import path2 from "node:path";

// src/git-worktree.ts
import fs from "node:fs";
import path from "node:path";
function samePath(a, b) {
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}
function isGitDir(dir) {
  try {
    return fs.statSync(path.join(dir, "HEAD")).isFile() && fs.statSync(path.join(dir, "objects")).isDirectory() && fs.statSync(path.join(dir, "refs")).isDirectory();
  } catch {
    return false;
  }
}
function readGitdirPointer(top, dotGitFile) {
  const raw = fs.readFileSync(dotGitFile, "utf8");
  const m = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(raw);
  return m ? path.resolve(top, m[1]) : null;
}
function inspectDotGitFile(top, dotGitFile) {
  try {
    const gitdir = readGitdirPointer(top, dotGitFile);
    if (!gitdir) return { worktree: null, rejected: `${dotGitFile} has no "gitdir:" line` };
    let common;
    try {
      common = fs.readFileSync(path.join(gitdir, "commondir"), "utf8").trim();
    } catch {
      return { worktree: null };
    }
    if (!common) return { worktree: null, rejected: `${gitdir}/commondir is empty` };
    const commonDir = path.resolve(gitdir, common);
    if (path.basename(commonDir) !== ".git") return { worktree: null };
    if (!isGitDir(commonDir)) return { worktree: null, rejected: `${commonDir} is not a git directory` };
    try {
      const config = fs.readFileSync(path.join(commonDir, "config"), "utf8");
      if (/^[ \t]*bare[ \t]*=[ \t]*true[ \t]*$/im.test(config)) return { worktree: null };
    } catch {
      return { worktree: null, rejected: `${commonDir} has no config` };
    }
    let back;
    try {
      back = fs.readFileSync(path.join(gitdir, "gitdir"), "utf8").trim();
    } catch {
      return { worktree: null, rejected: `${gitdir} has no gitdir back-reference` };
    }
    if (!back || !samePath(path.resolve(gitdir, back), dotGitFile)) {
      return { worktree: null, rejected: `${gitdir}/gitdir does not point back at ${dotGitFile}` };
    }
    if (!samePath(path.dirname(gitdir), path.join(commonDir, "worktrees"))) {
      return { worktree: null, rejected: `${gitdir} is not under ${commonDir}/worktrees` };
    }
    const mainTop = path.dirname(commonDir);
    const mainDotGit = path.join(mainTop, ".git");
    if (!fs.statSync(mainDotGit).isDirectory() || !samePath(mainDotGit, commonDir)) {
      return { worktree: null, rejected: `${mainDotGit} is not the common dir ${commonDir}` };
    }
    if (samePath(mainTop, top)) return { worktree: null };
    return { worktree: { worktreeTop: top, mainTop } };
  } catch (err) {
    return { worktree: null, rejected: `${dotGitFile} unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
}
function inspect(p) {
  try {
    let cur = path.resolve(p);
    for (let i = 0; i < 256; i++) {
      const dotGit = path.join(cur, ".git");
      let st;
      try {
        st = fs.statSync(dotGit);
      } catch {
        st = void 0;
      }
      if (st) return st.isFile() ? inspectDotGitFile(cur, dotGit) : { worktree: null };
      const parent = path.dirname(cur);
      if (parent === cur) return { worktree: null };
      cur = parent;
    }
    return { worktree: null };
  } catch {
    return { worktree: null };
  }
}
function mapInto(abs, worktree) {
  const rel = path.relative(worktree.worktreeTop, abs);
  return { path: rel ? path.join(worktree.mainTop, rel) : worktree.mainTop, worktree };
}
function canonicalProjectDir(dir) {
  const abs = path.resolve(dir);
  const found = inspect(abs);
  if (!found.worktree) return found.rejected ? { projectRoot: abs, worktree: null, rejected: found.rejected } : { projectRoot: abs, worktree: null };
  const mapped = mapInto(abs, found.worktree);
  let projectRoot = mapped.path;
  try {
    if (!fs.statSync(projectRoot).isDirectory()) projectRoot = mapped.worktree.mainTop;
  } catch {
    projectRoot = mapped.worktree.mainTop;
  }
  return { projectRoot, worktree: mapped.worktree };
}
function resolveHookRoots(eventCwd, env = process.env, cwd = () => process.cwd()) {
  const claude = env.CLAUDE_PROJECT_DIR;
  const explicit = env.DEEPPAIRING_PROJECT_ROOT;
  if (!claude && explicit) return { projectRoot: explicit, workspaceRoot: explicit, worktree: null };
  const raw = claude || (typeof eventCwd === "string" && eventCwd ? eventCwd : "") || cwd();
  try {
    const { projectRoot, worktree, rejected } = canonicalProjectDir(raw);
    if (worktree) return { projectRoot, workspaceRoot: raw, worktree };
    return rejected ? { projectRoot: raw, workspaceRoot: raw, worktree: null, rejected } : { projectRoot: raw, workspaceRoot: raw, worktree: null };
  } catch {
    return { projectRoot: raw, workspaceRoot: raw, worktree: null };
  }
}

// src/hooks/hook-state.ts
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
  return resolveHookRoots(eventCwd).projectRoot;
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
      fs2.closeSync(fs2.openSync(lock, fs2.constants.O_CREAT | fs2.constants.O_EXCL | fs2.constants.O_WRONLY));
      return lock;
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") return null;
      try {
        if (!brokeStale && Date.now() - fs2.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          brokeStale = true;
          fs2.unlinkSync(lock);
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
    fs2.unlinkSync(lock);
  } catch {
  }
}
function readHookState(statePath) {
  let raw;
  try {
    raw = fs2.readFileSync(statePath, "utf-8");
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
    fs2.writeFileSync(`${statePath}.corrupt-${stamp}`, raw);
  } catch {
  }
  return { version: 1 };
}
function writeHookStateAtomic(statePath, state) {
  const tmp = `${statePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 10)}`;
  try {
    fs2.writeFileSync(tmp, JSON.stringify(state));
    fs2.renameSync(tmp, statePath);
  } catch (err) {
    try {
      fs2.unlinkSync(tmp);
    } catch {
    }
    throw err;
  }
}
function appendHookFire(statePath, fire, mutate) {
  try {
    fs2.mkdirSync(path2.dirname(statePath), { recursive: true });
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
  return path2.join(projectRoot, ".deeppairing", "hooks-state.json");
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
    const sessionsDir = path3.join(projectRoot, ".deeppairing", "sessions");
    if (!fs3.existsSync(sessionsDir)) exit(0, "no sessions dir");
    let owesDebriefSession = null;
    for (const id of fs3.readdirSync(sessionsDir)) {
      const af = path3.join(sessionsDir, id, "artifacts.json");
      if (!fs3.existsSync(af)) continue;
      let arr;
      try {
        arr = JSON.parse(fs3.readFileSync(af, "utf-8"));
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
