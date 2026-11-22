import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// src/hooks/stop-hook.ts
import fs6 from "node:fs";
import path7 from "node:path";

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

// src/session-id.ts
import crypto from "node:crypto";
import path from "node:path";
function deriveSessionId(projectRoot, claudeSessionIdRaw) {
  const projectName = path.basename(projectRoot);
  const safeProjectName = projectName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32);
  const projectHash = crypto.createHash("sha256").update(projectRoot).digest("hex").slice(0, 8);
  const base = `session_${safeProjectName}_${projectHash}`;
  const sanitized = (claudeSessionIdRaw ?? "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64);
  if (sanitized.length === 0) {
    return { sessionId: base, mode: "fallback" };
  }
  return { sessionId: `${base}_${sanitized}`, mode: "split", claudeSessionId: sanitized };
}

// src/hooks/hook-state.ts
import fs2 from "node:fs";
import path3 from "node:path";

// src/git-worktree.ts
import fs from "node:fs";
import path2 from "node:path";
function samePath(a, b) {
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return path2.resolve(a) === path2.resolve(b);
  }
}
function isGitDir(dir) {
  try {
    return fs.statSync(path2.join(dir, "HEAD")).isFile() && fs.statSync(path2.join(dir, "objects")).isDirectory() && fs.statSync(path2.join(dir, "refs")).isDirectory();
  } catch {
    return false;
  }
}
function readGitdirPointer(top, dotGitFile) {
  const raw = fs.readFileSync(dotGitFile, "utf8");
  const m = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(raw);
  return m ? path2.resolve(top, m[1]) : null;
}
function inspectDotGitFile(top, dotGitFile) {
  try {
    const gitdir = readGitdirPointer(top, dotGitFile);
    if (!gitdir) return { worktree: null, rejected: `${dotGitFile} has no "gitdir:" line` };
    let common;
    try {
      common = fs.readFileSync(path2.join(gitdir, "commondir"), "utf8").trim();
    } catch {
      return { worktree: null };
    }
    if (!common) return { worktree: null, rejected: `${gitdir}/commondir is empty` };
    const commonDir = path2.resolve(gitdir, common);
    if (path2.basename(commonDir) !== ".git") return { worktree: null };
    if (!isGitDir(commonDir)) return { worktree: null, rejected: `${commonDir} is not a git directory` };
    try {
      const config = fs.readFileSync(path2.join(commonDir, "config"), "utf8");
      if (/^[ \t]*bare[ \t]*=[ \t]*true[ \t]*$/im.test(config)) return { worktree: null };
    } catch {
      return { worktree: null, rejected: `${commonDir} has no config` };
    }
    let back;
    try {
      back = fs.readFileSync(path2.join(gitdir, "gitdir"), "utf8").trim();
    } catch {
      return { worktree: null, rejected: `${gitdir} has no gitdir back-reference` };
    }
    if (!back || !samePath(path2.resolve(gitdir, back), dotGitFile)) {
      return { worktree: null, rejected: `${gitdir}/gitdir does not point back at ${dotGitFile}` };
    }
    if (!samePath(path2.dirname(gitdir), path2.join(commonDir, "worktrees"))) {
      return { worktree: null, rejected: `${gitdir} is not under ${commonDir}/worktrees` };
    }
    const mainTop = path2.dirname(commonDir);
    const mainDotGit = path2.join(mainTop, ".git");
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
    let cur = path2.resolve(p);
    for (let i = 0; i < 256; i++) {
      const dotGit = path2.join(cur, ".git");
      let st;
      try {
        st = fs.statSync(dotGit);
      } catch {
        st = void 0;
      }
      if (st) return st.isFile() ? inspectDotGitFile(cur, dotGit) : { worktree: null };
      const parent = path2.dirname(cur);
      if (parent === cur) return { worktree: null };
      cur = parent;
    }
    return { worktree: null };
  } catch {
    return { worktree: null };
  }
}
function mapInto(abs, worktree) {
  const rel = path2.relative(worktree.worktreeTop, abs);
  return { path: rel ? path2.join(worktree.mainTop, rel) : worktree.mainTop, worktree };
}
function canonicalProjectDir(dir) {
  const abs = path2.resolve(dir);
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
  mutateHookState(statePath, (state) => {
    const fires = Array.isArray(state.fires) ? state.fires : [];
    fires.push(fire);
    state.fires = fires.slice(-FIRE_LOG_CAP);
    mutate?.(state);
  });
}
function mutateHookState(statePath, mutate, opts = {}) {
  try {
    if (opts.createDir === false) {
      if (!fs2.statSync(path3.dirname(statePath)).isDirectory()) return;
    } else {
      fs2.mkdirSync(path3.dirname(statePath), { recursive: true });
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
  return path3.join(projectRoot, ".deeppairing", "hooks-state.json");
}

// src/mcp/skeleton-drift.ts
import { createHash } from "node:crypto";

// src/skeleton-scope.ts
import fs3 from "node:fs";
import path4 from "node:path";
var SKEL_TODO = "SKEL_TODO";
var SKELETON_SCOPE_DIR = "skeleton-scopes";
var SKELETON_SCOPE_MAX_AGE_MS = 8 * 60 * 60 * 1e3;
function parseReshape(raw) {
  if (!raw || typeof raw !== "object") return void 0;
  const r = raw;
  if (typeof r.fromId !== "string" || !r.fromId) return void 0;
  const strs = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.length > 0) : [];
  return { fromId: r.fromId, files: strs(r.files), restoreApproved: r.restoreApproved === true, restoreSkelIds: strs(r.restoreSkelIds) };
}
var COMMENT = String.raw`(?:\/\/|#|--|;|\/\*|<!--|\{\/\*)`;
var ID = String.raw`([A-Za-z0-9][\w.-]*)`;
var OPEN_RE = new RegExp(String.raw`^\s*${COMMENT}\s*SKEL\[${ID}\]`);
var CLOSE_RE = new RegExp(String.raw`^\s*${COMMENT}\s*\/SKEL\[${ID}\](?:\s*(?:\*\/\}?|-->))?\s*$`);
function openMarker(line) {
  const m = OPEN_RE.exec(line);
  if (!m) return null;
  let title = line.slice(m[0].length).trim();
  if (title.endsWith("*/}")) title = title.slice(0, -3).trimEnd();
  else if (title.endsWith("*/") || title.endsWith("-->")) title = title.slice(0, title.endsWith("-->") ? -3 : -2).trimEnd();
  if (/[\r\n\u2028\u2029]/.test(title)) return null;
  return [m[1], title];
}
function scanSkeletonText(text, file) {
  const lines = text.split("\n");
  const fences = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const close = CLOSE_RE.exec(line);
    if (close) {
      if (!open) throw new Error(`${file}:${lineNo}: /SKEL[${close[1]}] closes nothing`);
      if (open.id !== close[1]) throw new Error(`${file}:${lineNo}: /SKEL[${close[1]}] closes SKEL[${open.id}] (opened line ${open.openLine})`);
      const body = lines.slice(open.openLine, lineNo - 1).join("\n");
      fences.push({ ...open, file, closeLine: lineNo, status: body.includes(SKEL_TODO) ? "todo" : "filled" });
      open = null;
      continue;
    }
    const m = openMarker(line);
    if (m) {
      if (open) throw new Error(`${file}:${lineNo}: SKEL[${m[0]}] opened inside SKEL[${open.id}] \u2014 fences don't nest`);
      open = { id: m[0], title: m[1], openLine: lineNo };
    }
  }
  if (open) throw new Error(`${file}:${open.openLine}: SKEL[${open.id}] is never closed`);
  return fences;
}
function skeletonScopeDir(projectRoot) {
  return path4.join(projectRoot, ".deeppairing", SKELETON_SCOPE_DIR);
}
function scopeFileName(artifactId) {
  return /^[A-Za-z0-9_-]{1,80}$/.test(artifactId) ? `${artifactId}.json` : null;
}
function parseScope(raw, now) {
  if (!raw || typeof raw !== "object") return null;
  const r = raw;
  const ids = Array.isArray(r.activeSkelIds) ? r.activeSkelIds.filter((x) => typeof x === "string" && x.length > 0) : [];
  const reshape = parseReshape(r.reshape);
  if (ids.length === 0 && !reshape || typeof r.artifactId !== "string") return null;
  const at = Date.parse(String(r.updatedAt));
  if (!Number.isFinite(at) || now - at > SKELETON_SCOPE_MAX_AGE_MS) return null;
  return {
    artifactId: r.artifactId,
    activeSkelIds: ids,
    updatedAt: String(r.updatedAt),
    ...typeof r.planTitle === "string" ? { planTitle: r.planTitle } : {},
    ...typeof r.sessionId === "string" && r.sessionId ? { sessionId: r.sessionId } : {},
    ...typeof r.workspaceRoot === "string" && r.workspaceRoot ? { workspaceRoot: r.workspaceRoot } : {},
    ...reshape ? { reshape } : {}
  };
}
function readSkeletonScopeFile(projectRoot, artifactId, now = Date.now()) {
  const name = scopeFileName(artifactId);
  if (!name) return null;
  try {
    return parseScope(JSON.parse(fs3.readFileSync(path4.join(skeletonScopeDir(projectRoot), name), "utf-8")), now);
  } catch {
    return null;
  }
}

// src/mcp/skeleton-drift.ts
var SKELETON_VISUAL_PREFIX = "skelcode:";
var isSkeletonApprovedVisualId = (id) => typeof id === "string" && id.startsWith(SKELETON_VISUAL_PREFIX);
var CLOSED_FOR_PROGRESS = /* @__PURE__ */ new Set(["superseded", "rejected", "retracted", "obsolete"]);
function isLivePlanVersion(art, artifacts) {
  if (art.type !== "plan" || CLOSED_FOR_PROGRESS.has(art.status)) return false;
  return !artifacts.some((a) => !!a && typeof a === "object" && a.parentId === art.id);
}
var MAX_LINES_LISTED = 5;
var MAX_APPROX_MORE = 20;
var MAX_LCS_CELLS = 4e6;
var normalizeSkeletonText = (text) => text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/\n$/, "");
var key = (line) => line.trimEnd();
function exteriorWithGaps(lines, fences, keep) {
  const out = [];
  let n = 1;
  for (const f of fences) {
    for (; n < f.openLine; n++) out.push({ text: key(lines[n - 1]), line: n });
    if (keep(f)) {
      out.push({ text: key(lines[f.openLine - 1]), line: f.openLine });
      out.push({ text: key(lines[f.closeLine - 1]), line: f.closeLine });
    } else {
      out.push(null);
    }
    n = f.closeLine + 1;
  }
  for (; n <= lines.length; n++) out.push({ text: key(lines[n - 1]), line: n });
  return out;
}
function skeletonExteriorDigest(text, file) {
  const norm = normalizeSkeletonText(text);
  const fences = scanSkeletonText(norm, file);
  const ext = exteriorWithGaps(norm.split("\n"), fences, () => true);
  return {
    sha256: createHash("sha256").update(ext.map((l) => l.text).join("\n")).digest("hex"),
    lines: ext.length,
    fenceIds: [...new Set(fences.map((f) => f.id))]
  };
}
function chunkMisfit(chunks, live) {
  const matchesAt = (chunk, at) => {
    let k = 0;
    while (k < chunk.length && at + k < live.length && live[at + k].text === chunk[k].text) k++;
    return k;
  };
  const lineAt = (i) => live[Math.min(Math.max(i, 0), live.length - 1)]?.line ?? 1;
  const last = chunks.length - 1;
  const top = chunks[0];
  const topLen = matchesAt(top, 0);
  if (topLen < top.length) return [lineAt(topLen)];
  if (last === 0) return live.length > top.length ? [lineAt(top.length)] : [];
  const bottom = chunks[last];
  const bottomStart = live.length - bottom.length;
  let pos = top.length;
  if (bottomStart < pos) return [lineAt(live.length - 1)];
  for (let k = bottom.length - 1; k >= 0; k--) {
    if (live[bottomStart + k].text !== bottom[k].text) return [lineAt(bottomStart + k)];
  }
  for (let c = 1; c < last; c++) {
    const chunk = chunks[c];
    if (chunk.length === 0) continue;
    let found = -1;
    let best = { at: pos, len: -1 };
    for (let at = pos; at + chunk.length <= bottomStart; at++) {
      const len = matchesAt(chunk, at);
      if (len === chunk.length) {
        found = at;
        break;
      }
      if (len > best.len) best = { at, len };
    }
    if (found < 0) return [lineAt(best.len > 0 ? best.at + best.len : pos)];
    pos = found + chunk.length;
  }
  return [];
}
function changedLines(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre].text === b[pre].text) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf].text === b[b.length - 1 - suf].text) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const exact = (lines) => ({ lines, approximate: false });
  if (am.length === 0 && bm.length === 0) return exact([]);
  const removalAt = (bi) => b[bi]?.line ?? b[b.length - 1]?.line ?? 1;
  if (bm.length === 0) return exact([removalAt(pre)]);
  if (am.length === 0) return exact(bm.map((l) => l.line));
  const out = /* @__PURE__ */ new Set();
  if (am.length * bm.length > MAX_LCS_CELLS) {
    for (let i2 = 0; i2 < bm.length; i2++) if (am[i2]?.text !== bm[i2].text) out.add(bm[i2].line);
    if (out.size === 0) out.add(removalAt(pre + bm.length));
    return { lines: [...out].sort((x, y) => x - y), approximate: true };
  }
  const n = am.length;
  const m = bm.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i2 = n - 1; i2 >= 0; i2--) {
    for (let j2 = m - 1; j2 >= 0; j2--) {
      dp[i2][j2] = am[i2].text === bm[j2].text ? dp[i2 + 1][j2 + 1] + 1 : Math.max(dp[i2 + 1][j2], dp[i2][j2 + 1]);
    }
  }
  let i = 0;
  let j = 0;
  let runInserted = false;
  let runRemoved = false;
  const closeRun = () => {
    if (runRemoved && !runInserted) out.add(removalAt(pre + j));
    runInserted = runRemoved = false;
  };
  while (i < n || j < m) {
    if (i < n && j < m && am[i].text === bm[j].text) {
      closeRun();
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      out.add(bm[j].line);
      runInserted = true;
      j++;
    } else {
      runRemoved = true;
      i++;
    }
  }
  closeRun();
  return exact([...out].sort((x, y) => x - y));
}
function compareCode(file, code, liveText) {
  const aNorm = normalizeSkeletonText(code);
  const aLines = aNorm.split("\n");
  let aFences;
  try {
    aFences = scanSkeletonText(aNorm, file);
  } catch {
    return "unparsable-approved";
  }
  const bNorm = normalizeSkeletonText(liveText);
  let bFences;
  try {
    bFences = scanSkeletonText(bNorm, file);
  } catch (err) {
    const why = err instanceof Error ? err.message.replace(`${file}:`, "line ") : String(err);
    return { file, lines: [], more: 0, note: `SKEL markers no longer parse (${why})` };
  }
  const bLines = bNorm.split("\n");
  const liveIds = new Set(bFences.map((f) => f.id));
  const stripped = aFences.filter((f) => !liveIds.has(f.id));
  const liveExt = exteriorWithGaps(bLines, bFences, () => true);
  if (stripped.length === 0) {
    const approvedExt = exteriorWithGaps(aLines, aFences, () => true);
    const { lines, approximate } = changedLines(approvedExt, liveExt);
    if (lines.length === 0) return null;
    const more = Math.max(0, lines.length - MAX_LINES_LISTED);
    return { file, lines: lines.slice(0, MAX_LINES_LISTED), more: approximate ? Math.min(more, MAX_APPROX_MORE) : more, ...approximate ? { approximate } : {} };
  }
  const withGaps = exteriorWithGaps(aLines, aFences, (f) => liveIds.has(f.id));
  const chunks = [[]];
  for (const l of withGaps) {
    if (l === null) chunks.push([]);
    else chunks[chunks.length - 1].push(l);
  }
  const misfit = chunkMisfit(chunks, liveExt);
  if (misfit.length === 0) return null;
  const which = stripped.length === aFences.length ? "markers stripped" : `markers of ${stripped.map((f) => `SKEL[${f.id}]`).join(", ")} stripped`;
  return { file, lines: misfit, more: 0, note: `${which}; the approved structure no longer matches near line ${misfit[0]}` };
}
function approvedSkeletonFiles(approvedVisuals) {
  const out = [];
  for (const v of approvedVisuals ?? []) {
    if (!v || v.kind !== "annotated_code" || !isSkeletonApprovedVisualId(v.id) || !v.skeleton) continue;
    const file = typeof v.filePath === "string" && v.filePath ? v.filePath : v.id.slice(SKELETON_VISUAL_PREFIX.length);
    const digest = v.skeleton.exterior;
    const fenceIds = digest?.fenceIds ?? v.skeleton.fences.map((f) => f.id);
    if (v.skeleton.withheld || typeof v.code !== "string") out.push({ file, ...digest ? { digest } : {}, fenceIds, codeless: "withheld from the approved snapshot" });
    else if (v.skeleton.truncated) out.push({ file, ...digest ? { digest } : {}, fenceIds, codeless: "the approved snapshot is truncated" });
    else out.push({ file, code: v.code, ...digest ? { digest } : {} });
    for (const o of v.skeleton.omitted ?? []) {
      if (out.some((f) => f.file === o.path)) continue;
      out.push(o.exterior ? { file: o.path, digest: o.exterior, ...o.exterior.fenceIds ? { fenceIds: o.exterior.fenceIds } : {}, codeless: "past the snapshot cap" } : { file: o.path, codeless: "past the snapshot cap and its digest budget" });
    }
  }
  return out;
}
function skeletonExteriorDrift(approvedVisuals, live) {
  const result = { changed: [], deleted: [], notChecked: [] };
  for (const a of approvedSkeletonFiles(approvedVisuals)) {
    const { file } = a;
    if (a.code === void 0 && !a.digest) {
      result.notChecked.push({ file, reason: a.codeless ?? "no approved record" });
      continue;
    }
    const now = live[file];
    if (!now) {
      result.notChecked.push({ file, reason: "not read" });
      continue;
    }
    if ("missing" in now) {
      result.deleted.push(file);
      continue;
    }
    if ("unchecked" in now) {
      result.notChecked.push({ file, reason: now.unchecked });
      continue;
    }
    if (a.code !== void 0) {
      const c = compareCode(file, a.code, now.text);
      if (c === "unparsable-approved") result.notChecked.push({ file, reason: "the approved snapshot's markers don't parse" });
      else if (c) result.changed.push(c);
      continue;
    }
    let liveDigest = null;
    try {
      liveDigest = skeletonExteriorDigest(now.text, file);
    } catch {
      result.changed.push({ file, lines: [], more: 0, note: "SKEL markers no longer parse" });
      continue;
    }
    const liveIds = new Set(liveDigest.fenceIds ?? []);
    if (liveIds.size === 0) {
      result.notChecked.push({ file, reason: `markers stripped; ${a.codeless}, so only a digest was kept` });
      continue;
    }
    if (a.fenceIds && a.fenceIds.length > 0 && (a.fenceIds.some((id) => !liveIds.has(id)) || liveIds.size !== new Set(a.fenceIds).size)) {
      result.changed.push({ file, lines: [], more: 0, note: `fence set differs from approval \u2014 ${a.codeless}, so no line numbers` });
      continue;
    }
    if (liveDigest.sha256 !== a.digest.sha256) {
      result.changed.push({ file, lines: [], more: 0, note: `changed \u2014 ${a.codeless}, so no line numbers` });
    }
  }
  return result;
}
function exteriorDriftParts(drift) {
  const renamedTo = new Map((drift.renamed ?? []).map((r) => [r.from, r.to]));
  const parts = [
    ...drift.changed.map((c) => {
      if (c.lines.length === 0) return `${c.file} (${c.note ?? "changed"})`;
      if (c.note) return `${c.file} (${c.note})`;
      const plural = c.lines.length + c.more === 1 ? "" : "s";
      const more = c.more > 0 ? ` (+${c.more}${c.approximate && c.more >= MAX_APPROX_MORE ? "+" : ""} more)` : "";
      return `${c.file} line${plural} ${c.lines.join(", ")}${more}${c.approximate ? " (approximate: file too large for an exact diff)" : ""}`;
    }),
    ...drift.deleted.map((f) => renamedTo.has(f) ? `${f} (deleted; its fences are now in ${renamedTo.get(f)} \u2014 renamed?)` : `${f} (deleted)`)
  ];
  return parts;
}
function isSkeletonDriftBaseline(art, artifacts) {
  if (!art || typeof art !== "object" || art.type !== "plan") return false;
  artifacts = artifacts.filter((a) => !!a && typeof a === "object");
  if (art.status === "approved") return isLivePlanVersion(art, artifacts);
  if (art.status !== "superseded") return false;
  const history = (Array.isArray(art.statusHistory) ? art.statusHistory : []).map((h) => h && typeof h === "object" ? h.status : void 0);
  const beforeSupersede = history.slice(0, history.lastIndexOf("superseded")).filter((s) => s !== "superseded").at(-1);
  if (beforeSupersede !== "approved") return false;
  const descendants = [];
  const queue = [art.id];
  while (queue.length > 0) {
    const id = queue.shift();
    for (const a of artifacts) {
      if (a.parentId === id && !descendants.includes(a)) {
        descendants.push(a);
        queue.push(a.id);
      }
    }
  }
  return descendants.length > 0 && descendants.every((d) => d.status === "rejected" || d.status === "retracted");
}

// src/mcp/skeleton-read.ts
import fs5 from "node:fs";
import path6 from "node:path";

// src/guardrail-rules.ts
var GUARDRAIL_RULES = [
  {
    category: "migrations",
    rationale: "Migrations are hard to reverse \u2014 escalate to supervised for changes here.",
    note: "hard to reverse",
    dirs: ["migrations", "db/migrate", "prisma/migrations", "supabase/migrations", "alembic/versions"],
    filePatterns: []
  },
  {
    category: "workflows",
    rationale: "CI workflows affect every future deploy \u2014 escalate for changes here.",
    note: "it affects every future deploy",
    dirs: [".github/workflows", ".circleci"],
    filePatterns: [/(^|\/)\.gitlab-ci\.ya?ml$/, /(^|\/)Jenkinsfile$/]
  },
  {
    category: "infrastructure",
    rationale: "Infrastructure changes affect production surfaces \u2014 escalate here.",
    note: "it affects production surfaces",
    dirs: ["infrastructure", "terraform", "k8s", "kubernetes", "helm"],
    filePatterns: [
      /(^|\/)Dockerfile([.-][^/]*)?$/,
      /(^|\/)(docker-)?compose[^/]*\.ya?ml$/,
      /(^|\/)[^/]*\.tfvars(\.json)?$/
    ]
  },
  {
    category: "secrets",
    rationale: "Secret files must never leak into the session or a commit \u2014 escalate here.",
    note: "secrets must never leak into a commit",
    dirs: [],
    filePatterns: [
      /(^|\/)\.env(\.[^/]+)?$/,
      /(^|\/)config\/secrets[^/]*$/,
      /(^|\/)config\/credentials[^/]*$/,
      /(^|\/)config\/master\.key$/
    ],
    // Checked-in templates are not secrets. Applies to the whole class (so
    // `config/secrets.example` is exempt too, not just `.env.example`) — the
    // pre-Q1 asymmetry, where the carve-out lived inside the dotenv predicate
    // alone, was an accident of how the predicates were written.
    fileExclude: /\.(example|sample|template|dist)$/i
  }
];
var GUARDRAIL_EXCLUDED_SEGMENTS = /(^|\/)(node_modules|bower_components|vendor|third_party|\.venv|venv|site-packages|dist|build|out|target|coverage|\.next|\.nuxt|\.output|\.turbo|__pycache__|fixtures|__fixtures__|testdata|test-data|__snapshots__|__mocks__|examples|example)(\/)/;
function matchesGuardrailDir(rel, d) {
  return rel === d || rel.startsWith(d + "/") || rel.endsWith("/" + d) || rel.includes("/" + d + "/");
}
function matchesGuardrailFile(rule, rel) {
  if (!rule.filePatterns.some((re) => re.test(rel))) return false;
  return !(rule.fileExclude && rule.fileExclude.test(rel));
}
function ruleForRelPath(rel) {
  if (GUARDRAIL_EXCLUDED_SEGMENTS.test(rel)) return null;
  for (const rule of GUARDRAIL_RULES) {
    if (rule.dirs.some((d) => matchesGuardrailDir(rel, d)) || matchesGuardrailFile(rule, rel)) return rule;
  }
  return null;
}

// src/project-root.ts
import path5 from "node:path";
import fs4 from "node:fs";
var DEFAULT_BASE_PORT = 3847;
var DEFAULT_PORT_SPAN = 128;
function resolvePortWindow(env = process.env, warn = (msg) => {
  try {
    process.stderr.write(`${msg}
`);
  } catch {
  }
}) {
  const readInt = (name, fallback, min, max) => {
    const raw = env[name];
    if (raw === void 0 || raw.trim() === "") return fallback;
    const n = Number(raw.trim());
    if (!Number.isInteger(n) || n < min || n > max) {
      warn(`[deepPairing] ignoring ${name}="${raw}" \u2014 expected an integer in ${min}..${max}; using default ${fallback}.`);
      return fallback;
    }
    return n;
  };
  const base = readInt("DEEPPAIRING_PORT_BASE", DEFAULT_BASE_PORT, 1024, 65e3);
  let span = readInt("DEEPPAIRING_PORT_SPAN", DEFAULT_PORT_SPAN, 1, 4096);
  if (base + span - 1 > 65535) {
    const clamped = 65535 - base + 1;
    warn(`[deepPairing] DEEPPAIRING_PORT_BASE=${base} + DEEPPAIRING_PORT_SPAN=${span} runs past port 65535 \u2014 clamping span to ${clamped}.`);
    span = clamped;
  }
  return { base, span };
}
var portWindow = resolvePortWindow();
var BASE_PORT = portWindow.base;
var PORT_SPAN = portWindow.span;
function canonical(root, source) {
  const { projectRoot, worktree, rejected } = canonicalProjectDir(root);
  if (!worktree) return rejected ? { projectRoot: root, source, worktreeRejected: rejected } : { projectRoot: root, source };
  return { projectRoot, source, worktree: { ...worktree, workspaceRoot: root } };
}
function resolveProjectRoot(opts = {}) {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? (() => process.cwd());
  const candidates = [
    { value: env.CLAUDE_PROJECT_DIR, source: "CLAUDE_PROJECT_DIR" },
    { value: env.DEEPPAIRING_PROJECT_ROOT, source: "DEEPPAIRING_PROJECT_ROOT" }
  ];
  for (const c of candidates) {
    const v = c.value?.trim();
    if (!v) continue;
    if (!path5.isAbsolute(v)) continue;
    try {
      if (!fs4.statSync(v).isDirectory()) continue;
    } catch {
      continue;
    }
    if (c.source === "DEEPPAIRING_PROJECT_ROOT") return { projectRoot: path5.resolve(v), source: c.source };
    return canonical(path5.resolve(v), c.source);
  }
  return canonical(path5.resolve(cwd()), "cwd");
}

// src/mcp/skeleton-read.ts
var SKELETON_SNAPSHOT_LIMITS = {
  maxFiles: 12,
  maxFileBytes: 48 * 1024,
  maxTotalBytes: 192 * 1024,
  maxReadBytes: 1e6
};
var MAX_RENAME_FILE_BYTES = 256 * 1024;
var MAX_RENAME_TOTAL_BYTES = 2 * 1024 * 1024;
var MAX_RENAME_ENTRIES = 200;
function within(dir, abs) {
  const rel = path6.relative(dir, abs);
  return rel === "" || !rel.startsWith("..") && !path6.isAbsolute(rel);
}
function normalizeSkeletonPath(root, raw) {
  if (typeof raw !== "string" || !raw.trim() || raw.includes("\0")) return null;
  const spelled = raw.trim().replace(/\\/g, "/");
  const abs = path6.resolve(root, spelled);
  if (!within(root, abs) || abs === path6.resolve(root)) return null;
  return path6.relative(root, abs).split(path6.sep).join("/");
}
function isDeniedSegment(segment) {
  const s = segment.toLowerCase();
  return s.startsWith(".env") || s === ".git" || s === ".ssh" || s === ".deeppairing" || s === ".npmrc" || s === ".netrc" || s === ".pypirc" || s.startsWith("id_rsa") || s.startsWith("id_ed25519") || s.startsWith("credentials") || s.endsWith(".pem") || s.endsWith(".key") || s.endsWith(".p12");
}
function isDeniedPath(rel) {
  const segs = rel.split(/[\\/]+/).filter(Boolean);
  if (segs.some(isDeniedSegment)) return true;
  return ruleForRelPath(rel.toLowerCase())?.category === "secrets";
}
var O_NOFOLLOW = fs5.constants.O_NOFOLLOW ?? 0;
function readConfined(root, rel, limits) {
  if (isDeniedPath(rel)) return { ok: false, reason: "a protected path \u2014 never snapshotted" };
  let realRoot;
  let realAbs;
  try {
    realRoot = fs5.realpathSync(root);
  } catch {
    return { ok: false, reason: "the project root is unreadable" };
  }
  try {
    realAbs = fs5.realpathSync(path6.resolve(root, rel));
  } catch {
    return { ok: false, reason: "not on disk" };
  }
  if (!within(realRoot, realAbs)) return { ok: false, reason: "it resolves outside the project (symlink)" };
  if (isDeniedPath(path6.relative(realRoot, realAbs))) return { ok: false, reason: "a protected path \u2014 never snapshotted" };
  let fd;
  try {
    fd = fs5.openSync(realAbs, fs5.constants.O_RDONLY | O_NOFOLLOW);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  try {
    const st = fs5.fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: "not a regular file" };
    try {
      const named = fs5.statSync(realAbs);
      if (named.dev !== st.dev || named.ino !== st.ino) return { ok: false, reason: "it changed while being read" };
    } catch {
      return { ok: false, reason: "it changed while being read" };
    }
    if (st.size > limits.maxReadBytes) return { ok: false, reason: `too large to snapshot (${st.size} bytes)` };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs5.readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    const data = buf.subarray(0, off);
    if (data.subarray(0, 8192).includes(0)) return { ok: false, reason: "binary \u2014 not shown" };
    return { ok: true, text: data.toString("utf-8") };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    try {
      fs5.closeSync(fd);
    } catch {
    }
  }
}
function checkSkeletonExteriorDrift(content, opts = {}) {
  const empty = { changed: [], deleted: [], notChecked: [] };
  try {
    const visuals = (Array.isArray(content?.visuals) ? content.visuals : []).filter((v) => v && typeof v === "object" && v.kind === "annotated_code" && isSkeletonApprovedVisualId(v.id) && v.skeleton);
    if (visuals.length === 0) return empty;
    const root = path6.resolve(opts.root ?? (() => {
      const r = resolveProjectRoot();
      return r.worktree?.workspaceRoot ?? r.projectRoot;
    })());
    const limits = opts.limits ?? SKELETON_SNAPSHOT_LIMITS;
    const live = {};
    const approved = approvedSkeletonFiles(visuals);
    for (const a of approved) {
      if (a.code === void 0 && !a.digest) continue;
      const rel = normalizeSkeletonPath(root, a.file);
      if (!rel) {
        live[a.file] = { unchecked: "outside the project" };
        continue;
      }
      const read = readConfined(root, rel, limits);
      live[a.file] = read.ok ? { text: read.text } : read.reason === "not on disk" ? { missing: true } : { unchecked: read.reason };
    }
    const drift = skeletonExteriorDrift(visuals, live);
    if (drift.deleted.length > 0) {
      const known = new Set(approved.map((a) => a.file));
      const renamed = [];
      let budget = MAX_RENAME_TOTAL_BYTES;
      for (const from of drift.deleted) {
        const fences0 = visuals.find((v) => (v.filePath ?? v.id.slice(SKELETON_VISUAL_PREFIX.length)) === from)?.skeleton?.fences ?? [];
        if (fences0.length === 0) continue;
        const want = new Map(fences0.map((f) => [f.id, f.title]));
        const dir = path6.posix.dirname(from);
        let names;
        try {
          names = fs5.readdirSync(path6.resolve(root, dir)).slice(0, MAX_RENAME_ENTRIES);
        } catch {
          continue;
        }
        for (const name of names) {
          if (budget <= 0) break;
          const rel = dir === "." ? name : `${dir}/${name}`;
          if (known.has(rel)) continue;
          let size;
          try {
            const st = fs5.statSync(path6.resolve(root, rel));
            if (!st.isFile()) continue;
            size = st.size;
          } catch {
            continue;
          }
          if (size > MAX_RENAME_FILE_BYTES || size > budget) continue;
          budget -= size;
          const read = readConfined(root, rel, limits);
          if (!read.ok || !read.text.includes("SKEL[")) continue;
          let fences;
          try {
            fences = scanSkeletonText(read.text, rel);
          } catch {
            continue;
          }
          const ids = new Set(fences.map((f) => f.id));
          const sameIds = ids.size === want.size && [...want.keys()].every((id) => ids.has(id));
          const sameTitles = fences.every((f) => {
            const t = want.get(f.id);
            return t === void 0 || t === f.title;
          });
          if (sameIds && sameTitles) {
            renamed.push({ from, to: rel });
            break;
          }
        }
      }
      if (renamed.length > 0) drift.renamed = renamed;
    }
    return drift;
  } catch {
    return empty;
  }
}

// src/hooks/stop-hook.ts
var HOOK_NAME = "stop";
var MAX_AGE_MS = 30 * 60 * 1e3;
var BLOCKING_TYPES = ["research", "spec", "plan", "decision", "code_change", "changeset", "page"];
var DRIFT_NUDGED_KEY = "skeletonDriftNudged";
var DRIFT_NUDGED_CAP = 50;
var MAX_NUDGE_PLANS = 3;
var MAX_NUDGE_FILES = 3;
var MAX_NUDGE_WHAT_CHARS = 280;
var DRIFT_MAX_AGE_MS = SKELETON_SCOPE_MAX_AGE_MS;
var isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
function approvedAtOf(a) {
  const history = Array.isArray(a.statusHistory) ? a.statusHistory : [];
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (isObj(h) && h.status === "approved" && typeof h.at === "string") return h.at;
  }
  return "";
}
function driftNudgeKey(a) {
  return `${a.id}@v${typeof a.version === "number" ? a.version : 0}@${approvedAtOf(a)}`;
}
function driftBaselines(raw, now) {
  const artifacts = raw.filter(isObj);
  return artifacts.filter((a) => {
    if (typeof a.id !== "string" || a.type !== "plan" || typeof a.status !== "string") return false;
    const visuals = isObj(a.content) && Array.isArray(a.content.visuals) ? a.content.visuals : [];
    if (!visuals.some((v) => isObj(v) && isSkeletonApprovedVisualId(v.id))) return false;
    const stamps = [approvedAtOf(a), typeof a.updatedAt === "string" ? a.updatedAt : ""].map((t) => t ? new Date(t).getTime() : NaN).filter((t) => Number.isFinite(t));
    if (stamps.length === 0 || now - Math.max(...stamps) > DRIFT_MAX_AGE_MS) return false;
    return isSkeletonDriftBaseline(a, artifacts);
  });
}
function peekNudged(statePath) {
  try {
    const parsed = JSON.parse(fs6.readFileSync(statePath, "utf-8"));
    const list = isObj(parsed) ? parsed[DRIFT_NUDGED_KEY] : void 0;
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
var oneLine = (t) => String(t ?? "").replace(/[\r\n\u2028\u2029]+/g, " ").slice(0, 60);
function runStopHook(stdin2 = "", now = Date.now()) {
  const projectRoot = resolveHookProjectRoot();
  function exit(code, reason, mutate) {
    appendHookFire(hookStatePath(projectRoot), {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      hook: HOOK_NAME,
      exitCode: code,
      reason
    }, mutate);
    process.exit(code);
  }
  try {
    let event;
    try {
      event = JSON.parse(stdin2 || "{}");
    } catch {
      exit(0, "skip: invalid stop input");
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      exit(0, "skip: invalid stop input");
    }
    let scopedSessionId;
    if (Object.prototype.hasOwnProperty.call(event, "session_id")) {
      const raw = event.session_id;
      if (typeof raw !== "string" || raw.length < 1 || raw.length > 64 || /[^a-zA-Z0-9-]/.test(raw)) {
        exit(0, "skip: invalid stop session identity");
      }
      scopedSessionId = deriveSessionId(projectRoot, raw).sessionId;
    }
    const sessionsDir = path7.join(projectRoot, ".deeppairing", "sessions");
    if (!fs6.existsSync(sessionsDir)) exit(0, "no sessions dir");
    let owesDebriefSession = null;
    const driftCandidates = [];
    for (const id of scopedSessionId === void 0 ? fs6.readdirSync(sessionsDir) : [scopedSessionId]) {
      const af = path7.join(sessionsDir, id, "artifacts.json");
      if (!fs6.existsSync(af)) continue;
      let arr;
      try {
        arr = JSON.parse(fs6.readFileSync(af, "utf-8"));
      } catch {
        continue;
      }
      if (!Array.isArray(arr)) continue;
      const artifacts = arr;
      try {
        driftCandidates.push(...driftBaselines(arr, now));
      } catch {
      }
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
    try {
      const statePath = hookStatePath(projectRoot);
      const nudged = peekNudged(statePath);
      const fired = [];
      const seenKeys = /* @__PURE__ */ new Set();
      for (const plan of driftCandidates) {
        const key2 = driftNudgeKey(plan);
        if (nudged.includes(key2) || seenKeys.has(key2)) continue;
        seenKeys.add(key2);
        const scope = readSkeletonScopeFile(projectRoot, String(plan.id));
        const root = scope?.workspaceRoot || resolveHookRoots().workspaceRoot;
        const parts = exteriorDriftParts(checkSkeletonExteriorDrift(plan.content, { root }));
        if (parts.length > 0) fired.push({ key: key2, title: oneLine(plan.title), parts });
      }
      if (fired.length > 0) {
        const filesOf = (parts) => parts.slice(0, MAX_NUDGE_FILES).join("; ") + (parts.length > MAX_NUDGE_FILES ? `; +${parts.length - MAX_NUDGE_FILES} more files` : "");
        let what = fired.length === 1 ? filesOf(fired[0].parts) : fired.slice(0, MAX_NUDGE_PLANS).map((f) => `"${f.title || "untitled plan"}": ${filesOf(f.parts)}`).join(" | ") + (fired.length > MAX_NUDGE_PLANS ? ` | +${fired.length - MAX_NUDGE_PLANS} more plans` : "");
        if (what.length > MAX_NUDGE_WHAT_CHARS) what = `${what.slice(0, MAX_NUDGE_WHAT_CHARS - 1)}\u2026`;
        process.stderr.write(
          `deepPairing: skeleton exterior drift since approval: ${what} \u2014 changes outside the fences are skeleton changes; propose them and revise_artifact the plan
`
        );
        exit(0, "skeleton drift " + fired.map((f) => f.key).join(", "), (state) => {
          const list = Array.isArray(state[DRIFT_NUDGED_KEY]) ? state[DRIFT_NUDGED_KEY] : [];
          for (const f of fired) if (!list.includes(f.key)) list.push(f.key);
          state[DRIFT_NUDGED_KEY] = list.slice(-DRIFT_NUDGED_CAP);
        });
      }
    } catch {
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
var stdin = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  runStopHook(stdin);
});
