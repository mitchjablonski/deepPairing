import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// src/cli/preflight-hook-core.ts
import fs5 from "node:fs";
import path6 from "node:path";

// src/mcp/preflight-validator.ts
function normalizeConceptKey(name) {
  return String(name).trim().toLowerCase().replace(/\s+/g, " ");
}
var SHORT_STOPWORDS = /* @__PURE__ */ new Set([
  "the",
  "and",
  "for",
  "but",
  "not",
  "use",
  "with",
  "from",
  "into",
  "onto",
  "that",
  "this",
  "than",
  "then",
  "via",
  "per",
  "our",
  "your",
  "its"
]);
function stemToken(raw) {
  const t = raw.toLowerCase();
  if (t.length <= 4) return t;
  if (t.endsWith("ing") && t.length >= 6) return t.slice(0, -3);
  if (t.endsWith("ed") && t.length >= 5) return t.slice(0, -2);
  if (t.endsWith("s") && !t.endsWith("ss") && t.length >= 5) return t.slice(0, -1);
  return t;
}
var CONCEPT_ALIAS_GROUPS = [
  // delete ≡ remove (stems: delete/delet, remove/remov)
  ["delete", "delet", "remove", "remov"],
  // directory ≡ folder (stems: directory/directorie, folder). "dir" left out
  // (too noisy as a bare token).
  ["directory", "directorie", "folder"],
  // cache ≡ memoize — caching IS memoization (stems: cache/cach, memoize/memoiz,
  // memoization).
  ["cache", "cach", "memoize", "memoiz", "memoization"],
  // env ≡ environment.
  ["env", "environment"],
  // AUTHENTICATION side — kept STRICTLY distinct from authorization below. Bare
  // "auth" intentionally excluded (ambiguous).
  ["authn", "authentication", "authenticate", "authenticat", "login", "signin"],
  // AUTHORIZATION side — never shares a representative with authentication.
  ["authz", "authorization", "authorize", "authoriz"]
  // (A billing/pricing group was deliberately NOT added — see the FALSE-POSITIVE
  // DISCIPLINE note above: its candidate members were not mutually substitutable.)
];
var CONCEPT_ALIASES = Object.freeze(
  Object.fromEntries(
    CONCEPT_ALIAS_GROUPS.flatMap((group) => {
      const rep = group[0];
      return group.map((member) => [member, rep]);
    })
  )
);
function aliasCanonical(token) {
  return CONCEPT_ALIASES[token] ?? token;
}
function meaningfulTokens(s) {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !SHORT_STOPWORDS.has(t)).map(stemToken).map(aliasCanonical);
}
function tokenCoverage(concept, proposal) {
  const tokens = meaningfulTokens(concept);
  if (tokens.length === 0) return 0;
  const pset = new Set(meaningfulTokens(proposal));
  const hits = tokens.filter((t) => pset.has(t)).length;
  return hits / tokens.length;
}
var NEAR_MISS_THRESHOLD = 0.5;
var CONSIDERED_CAP = 20;
function conceptMatchesProposal(concept, proposal) {
  const tokens = meaningfulTokens(concept);
  if (tokens.length === 0) return false;
  const pset = new Set(meaningfulTokens(proposal));
  return tokens.every((t) => pset.has(t));
}
function containmentBlockAllowed(storedConcept) {
  return new Set(meaningfulTokens(storedConcept)).size >= 2;
}
function findConceptToConceptMatch(proposalConcepts, storedConcepts) {
  for (const stored of storedConcepts) {
    if (!stored?.trim()) continue;
    const storedKey = normalizeConceptKey(stored);
    for (const pc of proposalConcepts) {
      if (!pc?.trim()) continue;
      if (normalizeConceptKey(pc) === storedKey) return { proposalConcept: pc, storedConcept: stored };
      if (containmentBlockAllowed(stored) && conceptMatchesProposal(stored, pc)) {
        return { proposalConcept: pc, storedConcept: stored };
      }
    }
  }
  return null;
}
function isCrossProjectAdvisoryHit(storedConcept, proposalStrings, proposalConcepts) {
  if (!storedConcept?.trim()) return false;
  const key = normalizeConceptKey(storedConcept);
  if (proposalConcepts.some((pc) => pc?.trim() && normalizeConceptKey(pc) === key)) return true;
  if (containmentBlockAllowed(storedConcept)) {
    const texts = [...proposalStrings, ...proposalConcepts];
    if (texts.some((t) => conceptMatchesProposal(storedConcept, t))) return true;
  }
  return false;
}
function matchesGlob(pathStr, glob) {
  const escape = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (glob[i] === "*") {
      re += "[^/]*";
    } else {
      re += escape(glob[i]);
    }
  }
  return new RegExp(`^${re}$`).test(pathStr);
}
function findTeamPreferenceViolation(proposalStrings, prefs, proposalPaths = []) {
  for (const pref of prefs) {
    if (pref.kind === "prefer") continue;
    if (pref.scope?.paths?.length) {
      if (proposalPaths.length === 0) continue;
      const hit = proposalPaths.some((p) => pref.scope.paths.some((g) => matchesGlob(p, g)));
      if (!hit) continue;
    }
    if (pref.kind === "avoid") {
      if (!containmentBlockAllowed(pref.concept)) continue;
      for (const proposal of proposalStrings) {
        if (!proposal.trim()) continue;
        if (conceptMatchesProposal(pref.concept, proposal)) {
          return { proposal, pref, via: "avoid" };
        }
      }
    }
    if (pref.kind === "require") {
      const forIdx = pref.concept.toLowerCase().indexOf(" for ");
      if (forIdx === -1) continue;
      const required = pref.concept.slice(0, forIdx).trim();
      const domain = pref.concept.slice(forIdx + 5).trim();
      if (!required || !domain) continue;
      for (const proposal of proposalStrings) {
        if (!proposal.trim()) continue;
        const mentionsDomain = conceptMatchesProposal(domain, proposal);
        if (!mentionsDomain) continue;
        const hasRequired = conceptMatchesProposal(required, proposal);
        if (!hasRequired) {
          return { proposal, pref, via: "require" };
        }
      }
    }
  }
  return null;
}
function containsAsPhrase(haystack, needle) {
  const n = needle.trim();
  if (n.length < 3) return false;
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${esc}(?:[^a-z0-9]|$)`).test(haystack);
}
function findRejectedApproachMatch(proposalStrings, rejected) {
  const clean = (s) => s.trim().toLowerCase();
  for (const rej of rejected) {
    const rejNormalized = clean(rej.description);
    if (!rejNormalized) continue;
    const specificNoun = rejNormalized.includes(":") ? rejNormalized.split(":").slice(1).join(":").trim() : rejNormalized;
    for (const proposal of proposalStrings) {
      const p = clean(proposal);
      if (!p) continue;
      if (containsAsPhrase(p, rejNormalized)) {
        return { proposal, rejected: rej, via: "surface" };
      }
      if (containsAsPhrase(specificNoun, p)) {
        return { proposal, rejected: rej, via: "surface" };
      }
      if (containsAsPhrase(p, specificNoun)) {
        return { proposal, rejected: rej, via: "surface" };
      }
      if (rej.concept && containmentBlockAllowed(rej.concept) && conceptMatchesProposal(rej.concept, proposal)) {
        return { proposal, rejected: rej, via: "concept" };
      }
    }
  }
  return null;
}
function runPreflight(input) {
  const { toolName, proposalStrings, proposalPaths = [], proposalConcepts = [], rejectedApproaches, teamPreferences, globalAdvisoryConcepts = [] } = input;
  const coverageTexts = proposalConcepts.length ? [...proposalStrings, ...proposalConcepts] : proposalStrings;
  const considered = [];
  for (const rej of rejectedApproaches) {
    if (considered.length >= CONSIDERED_CAP) break;
    considered.push({
      source: "session",
      concept: rej.concept ?? rej.description,
      reason: rej.reason
    });
  }
  for (const pref of teamPreferences) {
    if (considered.length >= CONSIDERED_CAP) break;
    if (pref.kind === "prefer") continue;
    if (pref.scope?.paths?.length) {
      const hit = proposalPaths.some(
        (p) => pref.scope.paths.some((g) => matchesGlob(p, g))
      );
      if (!hit) continue;
    }
    considered.push({
      source: "team",
      concept: pref.concept,
      reason: pref.rationale
    });
  }
  const nearMisses = [];
  for (const rej of rejectedApproaches) {
    const conceptText = rej.concept ?? rej.description;
    const cov = Math.max(
      ...coverageTexts.map((p) => tokenCoverage(conceptText, p)),
      0
    );
    if (cov >= NEAR_MISS_THRESHOLD && cov < 1) {
      nearMisses.push({
        source: "session",
        concept: conceptText,
        reason: rej.reason,
        why: `Partial token overlap (${Math.round(cov * 100)}%) with a past rejection.`
      });
    }
  }
  for (const pref of teamPreferences) {
    if (pref.kind === "prefer") continue;
    if (pref.scope?.paths?.length) {
      const hit = proposalPaths.some(
        (p) => pref.scope.paths.some((g) => matchesGlob(p, g))
      );
      if (!hit) continue;
    }
    const cov = Math.max(
      ...coverageTexts.map((p) => tokenCoverage(pref.concept, p)),
      0
    );
    if (cov >= NEAR_MISS_THRESHOLD && cov < 1) {
      nearMisses.push({
        source: "team",
        concept: pref.concept,
        reason: pref.rationale,
        why: `Partial token overlap (${Math.round(cov * 100)}%) with a team policy.`
      });
    }
  }
  for (const g of globalAdvisoryConcepts) {
    if (!g.concept?.trim()) continue;
    if (isCrossProjectAdvisoryHit(g.concept, proposalStrings, proposalConcepts)) {
      nearMisses.push({
        source: "global",
        concept: g.concept,
        reason: g.reason,
        project: g.project,
        why: g.project ? `You avoided this in "${g.project}" \u2014 still want it here? (cross-project, advisory)` : `You avoided this in another project \u2014 still want it here? (cross-project, advisory)`
      });
    }
  }
  if (rejectedApproaches.length > 0) {
    let match = findRejectedApproachMatch(proposalStrings, rejectedApproaches);
    if (!match && proposalConcepts.length > 0) {
      for (const rej of rejectedApproaches) {
        if (!rej.concept) continue;
        const cc = findConceptToConceptMatch(proposalConcepts, [rej.concept]);
        if (cc) {
          match = { proposal: cc.proposalConcept, rejected: rej, via: "concept" };
          break;
        }
      }
    }
    if (match) {
      const reasonLine = match.rejected.reason ? `
Prior rejection reason: "${match.rejected.reason}"` : "";
      const conceptLine = match.via === "concept" && match.rejected.concept ? `
Matched on underlying concept: "${match.rejected.concept}". A paraphrased proposal still counts \u2014 the user has rejected this kind of approach.` : "";
      const message = `REJECTED_APPROACH_BLOCKED: ${toolName} refused \u2014 your proposal contains "${match.proposal}" which the user previously rejected ("${match.rejected.description}").${reasonLine}${conceptLine}

Do NOT retry with this approach. Propose an alternative. If this is a false positive or conditions have changed, ask the human to allow this proposal once or retire the stance from the companion UI's gate log before retrying. Mentioning the rejected concept in present_findings is checked by this same gate. The artifact was NOT created.`;
      return {
        blocked: true,
        block: {
          source: "session",
          message,
          broadcastEvent: {
            type: "preflight_blocked",
            toolName,
            source: "session",
            match: {
              proposal: match.proposal,
              description: match.rejected.description,
              reason: match.rejected.reason,
              concept: match.rejected.concept,
              via: match.via,
              // #470 — with description + concept, the exact stance row an
              // allowance binds to.
              rejectedAt: match.rejected.rejectedAt
            }
          }
        },
        trace: {
          decision: "blocked",
          consideredCount: considered.length,
          consideredConcepts: considered,
          nearMisses,
          block: {
            source: "session",
            concept: match.rejected.concept ?? match.rejected.description,
            reason: match.rejected.reason,
            via: match.via
          }
        }
      };
    }
  }
  if (teamPreferences.length > 0) {
    let teamMatch = findTeamPreferenceViolation(proposalStrings, teamPreferences, proposalPaths);
    if (!teamMatch && proposalConcepts.length > 0) {
      for (const pref of teamPreferences) {
        if (pref.kind !== "avoid") continue;
        if (pref.scope?.paths?.length) {
          if (proposalPaths.length === 0) continue;
          const hit = proposalPaths.some((p) => pref.scope.paths.some((g) => matchesGlob(p, g)));
          if (!hit) continue;
        }
        const cc = findConceptToConceptMatch(proposalConcepts, [pref.concept]);
        if (cc) {
          teamMatch = { proposal: cc.proposalConcept, pref, via: "avoid" };
          break;
        }
      }
    }
    if (teamMatch) {
      const { pref, proposal, via } = teamMatch;
      const attribution = pref.addedBy ? ` (added by ${pref.addedBy})` : "";
      const scope = pref.scope?.paths?.length ? `
Scope: ${pref.scope.paths.join(", ")}` : "";
      const headline = via === "avoid" ? `your proposal touches "${proposal}" which conflicts with the team's "avoid: ${pref.concept}" policy` : `your proposal addresses "${proposal}" but is missing the team-required "${pref.concept}"`;
      const message = `REJECTED_APPROACH_BLOCKED: ${toolName} refused \u2014 ${headline}.
Team rationale: "${pref.rationale}"${attribution}.${scope}

` + (via === "avoid" ? `Do NOT propose this. Revise to use an alternative approach, or call present_findings to make a case for changing the team policy. The artifact was NOT created.` : `Revise your proposal to use the required approach, or call present_findings to surface why this case warrants an exception. The artifact was NOT created.`);
      return {
        blocked: true,
        block: {
          source: "team",
          message,
          broadcastEvent: {
            type: "preflight_blocked",
            toolName,
            source: "team",
            match: {
              proposal,
              description: pref.concept,
              reason: pref.rationale,
              concept: pref.concept,
              via,
              kind: pref.kind,
              addedBy: pref.addedBy,
              scope: pref.scope?.paths
            }
          }
        },
        trace: {
          decision: "blocked",
          consideredCount: considered.length,
          consideredConcepts: considered,
          nearMisses,
          block: {
            source: "team",
            concept: pref.concept,
            reason: pref.rationale,
            via
          }
        }
      };
    }
  }
  return {
    blocked: false,
    trace: {
      decision: "admitted",
      consideredCount: considered.length,
      consideredConcepts: considered,
      nearMisses
    }
  };
}
function coerceStanceConcept(concept) {
  if (concept === void 0 || concept === null || typeof concept === "string") return { concept, changed: false };
  if (typeof concept === "object" && !Array.isArray(concept)) {
    const name = concept.name;
    if (typeof name === "string" && name.trim()) return { concept: name, changed: true };
  }
  return { concept: void 0, changed: true };
}
function runPreflightGuarded(input, indexOf = (i) => i) {
  const coerced = [];
  const skipped = [];
  let entries = input.rejectedApproaches.map((entry, i) => {
    const c = coerceStanceConcept(entry.concept);
    if (!c.changed) return { entry, i };
    coerced.push(indexOf(i));
    return { entry: { ...entry, concept: c.concept ?? void 0 }, i };
  });
  const run = (list, team = input.teamPreferences) => runPreflight({ ...input, rejectedApproaches: list.map((e) => e.entry), teamPreferences: team });
  let result;
  try {
    result = run(entries);
  } catch (err) {
    const survivors = entries.filter((e) => {
      try {
        runPreflight({ toolName: input.toolName, proposalStrings: input.proposalStrings, proposalPaths: input.proposalPaths, proposalConcepts: input.proposalConcepts, rejectedApproaches: [e.entry], teamPreferences: [] });
        return true;
      } catch {
        skipped.push(indexOf(e.i));
        return false;
      }
    });
    if (survivors.length === entries.length) throw err;
    entries = survivors;
    result = run(entries);
  }
  return { result, coerced: coerced.sort((a, b) => a - b), skipped: skipped.sort((a, b) => a - b) };
}

// src/debrief-gate.ts
var PRE_WORK_CEREMONY_TYPES = ["research", "decision", "spec", "plan"];

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
function isLinkedWorktreeGitFile(abs) {
  try {
    if (!fs.lstatSync(abs).isFile()) return false;
    const gitdir = readGitdirPointer(path2.dirname(abs), abs);
    return !!gitdir && fs.statSync(path2.join(gitdir, "commondir")).isFile();
  } catch {
    return false;
  }
}
function findLinkedWorktree(p) {
  return inspect(p).worktree;
}
function canonicalizeWorktreePath(p) {
  const abs = path2.resolve(p);
  const worktree = findLinkedWorktree(abs);
  if (!worktree) return { path: abs, worktree: null };
  return mapInto(abs, worktree);
}
function mapInto(abs, worktree) {
  const rel = path2.relative(worktree.worktreeTop, abs);
  return { path: rel ? path2.join(worktree.mainTop, rel) : worktree.mainTop, worktree };
}

// src/hooks/hook-state.ts
import fs2 from "node:fs";
import path3 from "node:path";
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

// src/guardrail-rules.ts
import fs3 from "node:fs";
import os from "node:os";
import path4 from "node:path";
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
function matchGuardrailPath(projectRoot, paths) {
  try {
    for (const raw of paths) {
      if (typeof raw !== "string" || !raw) continue;
      const abs = path4.resolve(projectRoot, raw);
      let rel = path4.relative(projectRoot, abs).replace(/\\/g, "/");
      if (!rel || rel === ".." || rel.startsWith("../") || path4.isAbsolute(rel)) {
        const mapped = canonicalizeWorktreePath(abs);
        if (!mapped.worktree) continue;
        rel = path4.relative(projectRoot, mapped.path).replace(/\\/g, "/");
        if (!rel || rel === ".." || rel.startsWith("../") || path4.isAbsolute(rel)) continue;
      }
      const rule = ruleForRelPath(rel);
      if (rule) return { category: rule.category, path: rel, rationale: rule.rationale, note: rule.note };
    }
    return null;
  } catch {
    return null;
  }
}
function toolInputTargetsGuardrail(projectRoot, toolInput) {
  try {
    const input = toolInput;
    const fp = input?.file_path ?? input?.filePath;
    if (typeof fp !== "string" || !fp) return false;
    return matchGuardrailPath(projectRoot, [fp]) !== null;
  } catch {
    return false;
  }
}
var DEEPPAIRING_STATE_CATEGORY = "deeppairing-state";
var STATE_PATTERN = /(^|\/)(?:\.deeppairing\/(preferences\.json|team\.json|hooks\/.+)|\.claude\/(settings(?:\.local)?\.json))$/;
function canonicalForm(p) {
  return p.replace(/\\/g, "/").split("/").map((seg) => seg === "." || seg === ".." ? seg : seg.replace(/:.*$/, "").replace(/[. ]+$/, "")).join("/").toLowerCase();
}
function realpathish(abs, hops = 0) {
  try {
    return fs3.realpathSync.native(abs);
  } catch {
  }
  if (hops < 8) {
    try {
      const target = fs3.readlinkSync(abs);
      return realpathish(path4.resolve(path4.dirname(abs), target), hops + 1);
    } catch {
    }
  }
  const rest = [];
  let cur = abs;
  for (let i = 0; i < 64; i++) {
    const parent = path4.dirname(cur);
    if (parent === cur) return null;
    rest.unshift(path4.basename(cur));
    cur = parent;
    try {
      return path4.join(fs3.realpathSync.native(cur), ...rest);
    } catch {
    }
  }
  return null;
}
function physicalResolve(base, spelling) {
  try {
    const absolute = path4.isAbsolute(spelling);
    const root = absolute ? path4.parse(spelling).root : "";
    let cur = absolute ? root : base;
    try {
      cur = fs3.realpathSync.native(cur);
    } catch {
    }
    const segs = (absolute ? spelling.slice(root.length) : spelling).split(/[\\/]+/);
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        cur = path4.dirname(cur);
        continue;
      }
      cur = path4.join(cur, seg);
      try {
        cur = fs3.realpathSync.native(cur);
      } catch {
        try {
          if (fs3.lstatSync(cur).isSymbolicLink()) {
            const followed = realpathish(cur);
            if (followed) cur = followed;
          }
        } catch {
        }
      }
    }
    return cur;
  } catch {
    return null;
  }
}
function matchDeeppairingStatePath(projectRoot, raw) {
  try {
    if (typeof raw !== "string" || !raw) return null;
    const unprefixed = raw.replace(/^(\\\\|\/\/)[?.](\\|\/)/, "");
    const slashed = unprefixed.replace(/\\/g, "/");
    const cleaned = slashed.split("/").map((seg) => seg === "." || seg === ".." || /^[A-Za-z]:$/.test(seg) ? seg : seg.replace(/:.*$/, "").replace(/[. ]+$/, "") || seg).join("/");
    const candidates = /* @__PURE__ */ new Set([slashed, cleaned]);
    const spellings = [slashed, cleaned];
    if (/^~\//.test(cleaned)) spellings.push(path4.join(os.homedir(), cleaned.slice(2)));
    const ordered = [];
    for (const c of spellings) {
      const physical = physicalResolve(projectRoot, c);
      if (physical) ordered.push(physical);
    }
    for (const c of spellings) {
      const abs = path4.resolve(projectRoot, c);
      ordered.push(abs);
      const real = realpathish(abs);
      if (real) ordered.push(real);
    }
    ordered.push(...candidates);
    for (const c of ordered) {
      const m = STATE_PATTERN.exec(canonicalForm(c));
      if (!m) {
        if (path4.isAbsolute(c) && canonicalForm(c).split("/").pop() === ".git" && isLinkedWorktreeGitFile(c)) {
          return { category: DEEPPAIRING_STATE_CATEGORY, path: displayPath(projectRoot, c), kind: "worktree-link" };
        }
        continue;
      }
      const file = m[2] ?? "";
      const kind = m[3] ? "claude-settings" : file.startsWith("hooks/") ? "hooks" : file === "team.json" ? "team" : "preferences";
      return { category: DEEPPAIRING_STATE_CATEGORY, path: displayPath(projectRoot, c), kind };
    }
    return null;
  } catch {
    return null;
  }
}
function displayPath(projectRoot, candidate) {
  const roots = [projectRoot];
  try {
    roots.push(fs3.realpathSync.native(projectRoot));
  } catch {
  }
  const abs = path4.isAbsolute(candidate) ? candidate : path4.resolve(projectRoot, candidate);
  for (const root of roots) {
    const rel = path4.relative(root, abs).replace(/\\/g, "/");
    if (rel && rel !== ".." && !rel.startsWith("../") && !path4.isAbsolute(rel)) return rel;
  }
  return abs.replace(/\\/g, "/");
}
function toolInputTargetPath(toolInput) {
  const input = toolInput;
  return input?.file_path ?? input?.filePath ?? input?.notebook_path;
}
function toolInputTargetsDeeppairingState(projectRoot, toolInput) {
  try {
    return matchDeeppairingStatePath(projectRoot, toolInputTargetPath(toolInput)) !== null;
  } catch {
    return false;
  }
}

// src/skeleton-scope.ts
import fs4 from "node:fs";
import path5 from "node:path";
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
var OPEN_RE = new RegExp(String.raw`^\s*${COMMENT}\s*SKEL\[${ID}\]\s*(.*?)\s*(?:\*\/\}?|-->)?\s*$`);
var CLOSE_RE = new RegExp(String.raw`^\s*${COMMENT}\s*\/SKEL\[${ID}\]\s*(?:\*\/\}?|-->)?\s*$`);
function scanSkeletonText(text, file) {
  const lines = text.split("\n");
  const fences = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const close = CLOSE_RE.exec(line);
    if (close) {
      if (!open || open.id !== close[1]) throw new Error(`${file}:${lineNo}: /SKEL[${close[1]}] closes ${open ? `SKEL[${open.id}]` : "nothing"}`);
      const body = lines.slice(open.openLine, lineNo - 1).join("\n");
      fences.push({ ...open, file, closeLine: lineNo, status: body.includes(SKEL_TODO) ? "todo" : "filled" });
      open = null;
      continue;
    }
    const m = OPEN_RE.exec(line);
    if (m) {
      if (open) throw new Error(`${file}:${lineNo}: SKEL[${m[1]}] opened inside SKEL[${open.id}]`);
      open = { id: m[1], title: m[2] ?? "", openLine: lineNo };
    }
  }
  if (open) throw new Error(`${file}:${open.openLine}: SKEL[${open.id}] is never closed`);
  return fences;
}
function skeletonScopeDir(projectRoot) {
  return path5.join(projectRoot, ".deeppairing", SKELETON_SCOPE_DIR);
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
function readSkeletonScopes(projectRoot, now = Date.now()) {
  let names;
  try {
    names = fs4.readdirSync(skeletonScopeDir(projectRoot)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    try {
      const scope = parseScope(JSON.parse(fs4.readFileSync(path5.join(skeletonScopeDir(projectRoot), n), "utf-8")), now);
      if (scope) out.push(scope);
    } catch {
    }
  }
  return out;
}
function skeletonScopeActive(projectRoot, now = Date.now()) {
  return readSkeletonScopes(projectRoot, now).length > 0;
}
function planOnDisk(projectRoot, sessionId, artifactId) {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(sessionId)) return null;
  try {
    const arr = JSON.parse(fs4.readFileSync(path5.join(projectRoot, ".deeppairing", "sessions", sessionId, "artifacts.json"), "utf-8"));
    if (!Array.isArray(arr)) return null;
    const plan = arr.find((a) => !!a && typeof a === "object" && a.id === artifactId);
    if (plan?.type !== "plan" || typeof plan.status !== "string") return null;
    const steps = Array.isArray(plan.content?.steps) ? plan.content.steps : [];
    const inProgressSkelIds = steps.filter((st) => st && typeof st.skelId === "string" && st.skelId && st.status === "in_progress").map((st) => st.skelId);
    return { status: plan.status, inProgressSkelIds };
  } catch {
    return null;
  }
}
function resolveSkeletonScopes(projectRoot, scopes) {
  const fenced = [];
  const paused = [];
  for (const s of scopes) {
    if (!s.sessionId) continue;
    const plan = planOnDisk(projectRoot, s.sessionId, s.artifactId);
    if (!plan) continue;
    if (!s.reshape) {
      if (plan.status === "approved" && s.activeSkelIds.length > 0) fenced.push(s);
      continue;
    }
    if (plan.status === "draft" || plan.status === "revised") {
      paused.push(s);
    } else if (plan.status === "approved") {
      const ids = [.../* @__PURE__ */ new Set([...s.activeSkelIds, ...plan.inProgressSkelIds])];
      if (ids.length > 0) fenced.push({ ...s, activeSkelIds: ids });
    } else if ((plan.status === "rejected" || plan.status === "retracted") && s.reshape.restoreApproved) {
      const ids = restoredSkelIds(projectRoot, s.sessionId, s.artifactId, s.reshape);
      if (ids.length > 0) fenced.push({ ...s, activeSkelIds: ids });
    }
  }
  return { fenced, paused };
}
var RESTORABLE = /* @__PURE__ */ new Set(["superseded", "approved"]);
function restoredSkelIds(projectRoot, sessionId, reshapeId, reshape) {
  const arr = readSessionArtifacts(projectRoot, sessionId);
  if (!arr) return [];
  const idx = arr.findIndex((a) => a.id === reshape.fromId);
  if (idx === -1) return reshape.restoreSkelIds;
  const v1 = arr[idx];
  if (v1.type !== "plan" || typeof v1.status !== "string" || !RESTORABLE.has(v1.status)) return [];
  const mine = arr.findIndex((a) => a.id === reshapeId);
  if (arr.some((a, i) => a.parentId === reshape.fromId && a.id !== reshapeId && i > mine)) return [];
  return inProgressSkelIdsOf(v1.content);
}
function readSessionArtifacts(projectRoot, sessionId) {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(sessionId)) return null;
  try {
    const arr = JSON.parse(fs4.readFileSync(path5.join(projectRoot, ".deeppairing", "sessions", sessionId, "artifacts.json"), "utf-8"));
    return Array.isArray(arr) ? arr.filter((a) => !!a && typeof a === "object") : null;
  } catch {
    return null;
  }
}
function inProgressSkelIdsOf(content) {
  const steps = content?.steps;
  if (!Array.isArray(steps)) return [];
  return steps.filter((st) => !!st && typeof st.skelId === "string" && st.skelId.length > 0 && st.status === "in_progress").map((st) => st.skelId);
}
function evaluatePausedEdit(args) {
  if (args.toolName !== "Edit" && args.toolName !== "Write" && args.toolName !== "MultiEdit") return null;
  const input = args.toolInput ?? {};
  const fp = input.file_path ?? input.filePath;
  if (typeof fp !== "string" || !fp) return null;
  const abs = path5.resolve(args.projectRoot, fp);
  if (abs.split(path5.sep).includes(".deeppairing")) return null;
  const mine = args.paused.filter((s) => s.sessionId === args.sessionId && (!s.workspaceRoot || within(s.workspaceRoot, abs)));
  for (const s of mine) {
    const base = s.workspaceRoot ?? args.projectRoot;
    const rel = path5.relative(base, abs).split(path5.sep).join("/");
    const files = (s.reshape?.files ?? []).map((f) => path5.relative(base, path5.resolve(base, f)).split(path5.sep).join("/"));
    if (!files.includes(rel)) continue;
    const plan = s.planTitle ? ` ("${s.planTitle}")` : "";
    return {
      skelIds: [],
      target: rel,
      reason: args.strict ? `Edit to ${rel} stopped before execution (strict-stop mode). The skeleton${plan} was reshaped and the new version awaits your approval, so fills are paused. [SKELETON_PAUSED]` : `Allow this edit while the skeleton change awaits your approval? The skeleton${plan} was reshaped and the new version isn't approved yet, so fills are paused for its files (${rel}).
[SKELETON_PAUSED \u2014 agent: a reshaped skeleton plan awaits re-review. Don't fill or restructure its files until your pair approves the new version; poll check_feedback.]`
    };
  }
  return null;
}
function within(dir, abs) {
  const rel = path5.relative(dir, abs);
  return rel === "" || !rel.startsWith("..") && !path5.isAbsolute(rel);
}
function selectSkeletonScope(scopes, args) {
  const mine = scopes.filter(
    (s) => s.sessionId === args.sessionId && (!s.workspaceRoot || within(s.workspaceRoot, args.targetAbs))
  );
  if (mine.length === 0) return null;
  const titles = [...new Set(mine.map((s) => s.planTitle).filter((t) => !!t))];
  return {
    artifactId: mine.map((s) => s.artifactId).join(","),
    activeSkelIds: [...new Set(mine.flatMap((s) => s.activeSkelIds))],
    updatedAt: mine.map((s) => s.updatedAt).sort().at(-1),
    ...titles.length > 0 ? { planTitle: titles.join(", ") } : {}
  };
}
function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}
function spanOf(text, index, needle) {
  let start = lineOf(text, index);
  let end = start;
  for (let i = 0; i < needle.length; i++) if (needle.charCodeAt(i) === 10) end++;
  if (needle.startsWith("\n") && end > start) start++;
  if (needle.endsWith("\n") && end > start) end--;
  return [start, end];
}
function applyEdit(text, oldStr, newStr, all) {
  if (!oldStr) return null;
  const first = text.indexOf(oldStr);
  if (first === -1) return null;
  const spans = [];
  let out = "";
  let from = 0;
  let i = first;
  while (i !== -1) {
    spans.push(spanOf(text, i, oldStr));
    out += text.slice(from, i) + newStr;
    from = i + oldStr.length;
    if (!all) break;
    i = text.indexOf(oldStr, from);
  }
  return { text: out + text.slice(from), spans };
}
function preservesOutside(original, next, fences) {
  const lines = original.split("\n");
  const out = next.split("\n");
  const sorted = [...fences].sort((a, b) => a.openLine - b.openLine);
  const segments = [];
  let from = 0;
  for (const f of sorted) {
    segments.push(lines.slice(from, f.openLine));
    from = f.closeLine - 1;
  }
  segments.push(lines.slice(from));
  const matchesAt = (seg, at) => at >= 0 && at + seg.length <= out.length && seg.every((l, i) => out[at + i] === l);
  let pos = 0;
  for (let k = 0; k < segments.length; k++) {
    const seg = segments[k];
    if (k === 0) {
      if (!matchesAt(seg, 0)) return false;
      pos = seg.length;
    } else if (k === segments.length - 1) {
      if (out.length - seg.length < pos || !matchesAt(seg, out.length - seg.length)) return false;
    } else {
      let at = pos;
      while (at + seg.length <= out.length && !matchesAt(seg, at)) at++;
      if (!matchesAt(seg, at)) return false;
      pos = at + seg.length;
    }
  }
  return true;
}
var signature = (fences) => fences.map((f) => `${f.id}\0${f.title}`).join("");
var HASH_COMMENT_EXT = /\.(py|pyi|rb|sh|bash|zsh|ya?ml|toml|r|pl|ex|exs|nim|cr|coffee)$/i;
function bodyEscapesFence(body, markerLine, file) {
  const indentOf = (l) => (/^[ \t]*/.exec(l)?.[0] ?? "").replace(/\t/g, "    ").length;
  const markerIndent = indentOf(markerLine);
  const hash = HASH_COMMENT_EXT.test(file);
  let depth = 0;
  let quote = null;
  const lines = body.split("\n");
  for (const line of lines) {
    if (line.trim() && !quote && indentOf(line) < markerIndent) return "a line is indented outside the fence's block";
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "/" && line[i + 1] === "/" || hash && c === "#") break;
      else if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (--depth < 0) return "it closes the block the fence sits in";
      }
    }
    if (quote && quote !== "`") quote = null;
  }
  return depth === 0 ? null : "it leaves a bracket open past the fence";
}
function evaluateSkeletonEdit(args) {
  const { scope } = args;
  if (!scope || scope.activeSkelIds.length === 0) return null;
  if (args.toolName !== "Edit" && args.toolName !== "Write" && args.toolName !== "MultiEdit") return null;
  const input = args.toolInput ?? {};
  const fp = input.file_path ?? input.filePath;
  if (typeof fp !== "string" || !fp) return null;
  const abs = path5.resolve(args.projectRoot, fp);
  if (abs.split(path5.sep).includes(".deeppairing")) return null;
  const rel = path5.relative(args.projectRoot, abs);
  const shown = rel && !rel.startsWith("..") && !path5.isAbsolute(rel) ? rel.split(path5.sep).join("/") : abs;
  const ids = scope.activeSkelIds;
  const label = ids.length === 1 ? `step SKEL[${ids[0]}]` : `steps ${ids.map((i) => `SKEL[${i}]`).join(", ")}`;
  const plan = scope.planTitle ? ` ("${scope.planTitle}")` : "";
  const violation = (what) => ({
    skelIds: ids,
    target: shown,
    reason: args.strict ? `Edit to ${shown} stopped before execution (strict-stop mode). ${what}. The approved skeleton${plan} is being filled, and ${label} may only change code inside its fence. Propose the skeleton change to your pair and revise the plan, or set the step back to pending before an agreed structural edit. [SKELETON_SCOPE]` : `Allow this edit outside the skeleton? ${what}. The approved skeleton${plan} is being filled, and ${label} may only change code inside its fence. Allowing it changes the structure you approved.
[SKELETON_SCOPE \u2014 agent: this is a skeleton change. Don't route around the fence; stop and propose the change (what, where, why) to your pair. Once they agree, revise the plan (or set the step back to pending) before the structural edit.]`
  });
  const original = args.readFile(abs);
  if (original === null) return args.toolName === "Write" ? violation(`It creates a new file, ${shown}`) : null;
  let before;
  try {
    before = scanSkeletonText(original, shown);
  } catch {
    return violation(`${shown} has malformed SKEL markers`);
  }
  const active = before.filter((f) => ids.includes(f.id));
  if (active.length === 0) return violation(`${shown} has no ${label} fence`);
  let next;
  if (args.toolName === "Write") {
    next = String(input.content ?? "");
  } else {
    const edits = args.toolName === "MultiEdit" ? Array.isArray(input.edits) ? input.edits : [] : [input];
    next = original;
    for (const e of edits) {
      const oldStr = typeof e?.old_string === "string" ? e.old_string : "";
      const applied = applyEdit(next, oldStr, typeof e?.new_string === "string" ? e.new_string : "", e?.replace_all === true);
      if (!applied) return null;
      let current;
      try {
        current = scanSkeletonText(next, shown).filter((f) => ids.includes(f.id));
      } catch {
        return violation(`${shown} has malformed SKEL markers`);
      }
      for (const [start, end] of applied.spans) {
        if (!current.some((f) => start >= f.openLine && end <= f.closeLine)) {
          return violation(`It touches ${shown}:${start}${end > start ? `-${end}` : ""}`);
        }
      }
      next = applied.text;
    }
  }
  let after;
  try {
    after = scanSkeletonText(next, shown);
  } catch {
    return violation(`It leaves malformed SKEL markers in ${shown}`);
  }
  if (signature(after) !== signature(before)) return violation(`It adds, removes or retitles SKEL markers in ${shown}`);
  if (!preservesOutside(original, next, active)) return violation(`It changes ${shown} outside the fence`);
  const nextLines = next.split("\n");
  for (const f of after.filter((x) => ids.includes(x.id))) {
    const body = nextLines.slice(f.openLine, f.closeLine - 1).join("\n");
    const escape = bodyEscapesFence(body, nextLines[f.openLine - 1] ?? "", shown);
    if (escape) return violation(`In ${shown}:${f.openLine}-${f.closeLine}, ${escape}`);
  }
  return null;
}

// src/cli/preflight-hook-core.ts
function readRejectedApproaches(projectRoot, failures) {
  return readRejectedApproachEntries(projectRoot, failures).map((e) => e.entry);
}
function readRejectedApproachEntries(projectRoot, failures) {
  const p = path6.join(projectRoot, ".deeppairing", "preferences.json");
  try {
    if (!fs5.existsSync(p)) return [];
    const raw = JSON.parse(fs5.readFileSync(p, "utf-8"));
    const list = raw?.rejectedApproaches;
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || list !== void 0 && !Array.isArray(list)) {
      pushFailure(failures, noteFailure("schema", "preferences"));
    }
    if (!Array.isArray(list)) return [];
    return list.map((e, index) => ({
      index,
      entry: typeof e === "string" ? { description: e } : {
        description: String(e?.description ?? ""),
        reason: e?.reason,
        rejectedAt: e?.rejectedAt,
        sourceArtifactId: e?.sourceArtifactId,
        concept: e?.concept
      }
    })).filter((r) => r.entry.description);
  } catch (err) {
    pushFailure(failures, noteFailure("ledger", "preferences", err));
    return [];
  }
}
function readTeamPreferences(projectRoot, failures) {
  const p = path6.join(projectRoot, ".deeppairing", "team.json");
  try {
    if (!fs5.existsSync(p)) return [];
    const stripped = fs5.readFileSync(p, "utf-8").split("\n").map((l) => /^\s*\/\//.test(l) ? "" : l).join("\n");
    const raw = JSON.parse(stripped);
    if (!raw || raw.version !== 1 || !Array.isArray(raw.preferences)) {
      pushFailure(failures, noteFailure("schema", "team"));
      return [];
    }
    const KINDS = /* @__PURE__ */ new Set(["require", "prefer", "avoid"]);
    const valid = raw.preferences.every(
      (x) => x && typeof x.id === "string" && typeof x.concept === "string" && x.concept.length > 0 && typeof x.rationale === "string" && KINDS.has(x.kind)
    );
    if (!valid) pushFailure(failures, noteFailure("schema", "team"));
    return valid ? raw.preferences : [];
  } catch (err) {
    pushFailure(failures, noteFailure("ledger", "team", err));
    return [];
  }
}
function buildProposals(_toolName, toolInput) {
  const strings = [];
  const paths = [];
  const fp = toolInput?.file_path ?? toolInput?.filePath;
  if (typeof fp === "string" && fp) {
    strings.push(fp);
    paths.push(fp);
  }
  if (typeof toolInput?.content === "string") strings.push(toolInput.content);
  if (typeof toolInput?.new_string === "string") strings.push(toolInput.new_string);
  if (Array.isArray(toolInput?.edits)) {
    for (const e of toolInput.edits) {
      if (typeof e?.new_string === "string") strings.push(e.new_string);
    }
  }
  return { strings: strings.filter(Boolean), paths: paths.filter(Boolean) };
}
function resolvePreflightMode(value) {
  if (value === void 0 || value === "" || value === "ask") return { mode: "ask", invalid: false };
  return { mode: "strict-stop", invalid: value !== "strict-stop" };
}
var PREFLIGHT_MODE_WARNING = "Invalid DEEPPAIRING_PREFLIGHT_MODE; using strict-stop for this matching edit.";
function sanitizeStrictReason(reason) {
  const clean = reason.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > 1800 ? clean.slice(0, 1799).replace(/[\ud800-\udbff]$/, "") + "\u2026" : clean;
}
function strictExcerpt(value, limit) {
  const text = typeof value === "string" ? sanitizeStrictReason(value) : "";
  return text.length > limit ? text.slice(0, limit - 1).replace(/[\ud800-\udbff]$/, "") + "\u2026" : text;
}
function strictRejectionReason(block) {
  const match = block.broadcastEvent.match;
  const whose = block.source === "session" ? "Prior stance" : "Team rule";
  const recovery = block.source === "session" ? "If the personal stance is no longer intended, the human can explicitly retire it in the companion UI before a revised attempt." : "Any intended team-policy change requires an explicit authorized change to the committed team rule.";
  return `REJECTED_APPROACH_BLOCKED: This edit stopped before execution (strict-stop mode). ${whose}: "${strictExcerpt(match.description, 220)}". Rationale: "${strictExcerpt(match.reason, 260) || "No rationale recorded"}". ` + (match.concept ? `Matched concept: "${strictExcerpt(match.concept, 120)}". ` : "") + `Cancel or revise the proposal; do not retry the same edit. ${recovery}`;
}
function preflightHookOutput(decision, config) {
  const rawReason = (config.invalid ? PREFLIGHT_MODE_WARNING + "\n\n" : "") + (decision.reason || "This change matches a previously-rejected approach.");
  const reason = config.mode === "strict-stop" ? sanitizeStrictReason(rawReason) : rawReason;
  return {
    ...config.mode === "strict-stop" ? { continue: false, stopReason: reason } : {},
    systemMessage: reason,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: config.mode === "strict-stop" ? "deny" : "ask",
      permissionDecisionReason: reason
    }
  };
}
function stripArtifactClause(message) {
  return message.replace(/\s*The artifact was NOT created\.\s*$/, "").trimEnd();
}
function toHookReason(message) {
  return stripArtifactClause(message).replace(" refused \u2014 ", " paused for your review \u2014 ");
}
var GUARDRAIL_BACKSTOP_ENV = "DEEPPAIRING_GUARDRAIL_BACKSTOP";
function guardrailBackstopDisabled(env = process.env) {
  const v = (env[GUARDRAIL_BACKSTOP_ENV] ?? "").trim().toLowerCase();
  return v === "off" || v === "0" || v === "false";
}
var CEREMONY_MAX_AGE_MS = 8 * 60 * 60 * 1e3;
var GUARDRAIL_ASK_TTL_MS = 30 * 60 * 1e3;
var CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1e3;
function withinWindow(t, now, maxAgeMs) {
  if (!Number.isFinite(t)) return false;
  const age = now - t;
  return age <= maxAgeMs && age >= -CLOCK_SKEW_TOLERANCE_MS;
}
var PER_PATH_DEDUP_CLASSES = /* @__PURE__ */ new Set(["migrations", "secrets"]);
function usableSessionId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(value) ? value : void 0;
}
function guardrailScopeKey(category, identity) {
  const session = usableSessionId(identity.sessionId);
  if (!session) return void 0;
  const agent = identity.agentId;
  if (agent !== void 0 && (typeof agent !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(agent))) return void 0;
  return `scope:${session}:${agent ?? ""}:${category}`;
}
var SCOPELESS_FALLBACK_TYPES = /* @__PURE__ */ new Set(["spec", "plan"]);
function object(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function artifactCoverage(projectRoot, artifact) {
  if (!Object.hasOwn(artifact, "content")) return { declared: false, paths: null };
  const content = artifact.content;
  if (!object(content)) return { declared: true, paths: null };
  let declared = false;
  let invalid = false;
  const paths = [];
  const add = (raw) => {
    if (typeof raw !== "string" || !raw.trim() || /[\x00-\x1f\x7f*?\[\]{}]/.test(raw) || /[\\/]$/.test(raw)) {
      invalid = true;
      return;
    }
    const normalized = raw.replace(/\\/g, path6.sep);
    const match = matchGuardrailPath(projectRoot, [normalized]);
    if (match) {
      paths.push(match.path);
      return;
    }
    const abs = path6.resolve(projectRoot, normalized);
    const mapped = canonicalizeWorktreePath(abs);
    const rel = path6.relative(projectRoot, mapped.worktree ? mapped.path : abs);
    if (!rel || rel === ".." || rel.startsWith(`..${path6.sep}`) || path6.isAbsolute(rel)) invalid = true;
    else paths.push(rel.replace(/\\/g, "/"));
  };
  const files = (value, visual = false) => {
    declared = true;
    if (!Array.isArray(value) || value.length === 0) {
      invalid = true;
      return;
    }
    for (const entry of value) add(visual ? object(entry) ? entry.path : void 0 : typeof entry === "string" ? entry : object(entry) ? entry.filePath : void 0);
  };
  const malformed = () => {
    declared = true;
    invalid = true;
  };
  if (Array.isArray(content.visuals)) {
    for (const visual of content.visuals) if (object(visual) && visual.kind === "file_map") files(visual.files, true);
  } else if (Object.hasOwn(content, "visuals")) {
    malformed();
  }
  if (artifact.type === "plan" && Array.isArray(content.steps)) {
    for (const step of content.steps) {
      if (!object(step)) {
        malformed();
        continue;
      }
      if (Object.hasOwn(step, "files")) files(step.files);
      if (Array.isArray(step.branches)) {
        for (const branch of step.branches) {
          if (!object(branch)) malformed();
          else if (Object.hasOwn(branch, "files")) files(branch.files);
        }
      } else if (Object.hasOwn(step, "branches")) {
        malformed();
      }
    }
  } else if (artifact.type === "plan" && Object.hasOwn(content, "steps")) {
    malformed();
  }
  return { declared, paths: declared && !invalid && paths.length > 0 ? paths : null };
}
function readSessionCeremony(projectRoot, now = Date.now(), failures, scope = {}) {
  const sessionsDir = path6.join(projectRoot, ".deeppairing", "sessions");
  let ids;
  try {
    if (!fs5.existsSync(sessionsDir)) return { reachable: false, hasLiveCeremony: false };
    ids = fs5.readdirSync(sessionsDir);
  } catch (err) {
    pushFailure(failures, noteFailure("store", "sessions", err));
    return { reachable: false, hasLiveCeremony: false };
  }
  const isRecent = (a) => withinWindow(Date.parse(a?.createdAt ?? ""), now, CEREMONY_MAX_AGE_MS);
  let storesSeen = 0;
  let storesParsed = 0;
  const session = usableSessionId(scope.sessionId);
  const currentSession = session ? deriveSessionId(projectRoot, session).sessionId : void 0;
  let sameSessionDeclaration = false;
  let sameSessionFallback = false;
  for (const id of ids) {
    if (id.startsWith("demo_")) continue;
    let arr;
    try {
      const af = path6.join(sessionsDir, id, "artifacts.json");
      if (!fs5.existsSync(af)) continue;
      storesSeen++;
      arr = JSON.parse(fs5.readFileSync(af, "utf-8"));
      if (!Array.isArray(arr)) continue;
    } catch {
      continue;
    }
    storesParsed++;
    try {
      for (const artifact of arr) {
        if (!object(artifact) || artifact.status !== "approved" || !PRE_WORK_CEREMONY_TYPES.includes(artifact.type) || !isRecent({ createdAt: typeof artifact.createdAt === "string" ? artifact.createdAt : void 0 })) continue;
        const coverage = artifactCoverage(projectRoot, artifact);
        if (scope.targetPath && coverage.paths?.includes(scope.targetPath)) return { reachable: true, hasLiveCeremony: true };
        if (id !== currentSession) continue;
        if (coverage.declared) sameSessionDeclaration = true;
        else if (SCOPELESS_FALLBACK_TYPES.has(artifact.type)) sameSessionFallback = true;
      }
    } catch {
      continue;
    }
  }
  if (storesSeen > 0 && storesParsed === 0) {
    pushFailure(failures, { cls: "session_store_unreadable", source: "sessions", tag: "corrupt" });
    return { reachable: false, hasLiveCeremony: false };
  }
  return { reachable: true, hasLiveCeremony: sameSessionFallback && !sameSessionDeclaration };
}
function guardrailAskSuppressed(projectRoot, category, matchedPath, now = Date.now(), identity = {}) {
  const key = guardrailScopeKey(category, identity);
  if (!key) return false;
  try {
    const sp = path6.join(projectRoot, ".deeppairing", "hooks-state.json");
    const state = JSON.parse(fs5.readFileSync(sp, "utf-8"));
    const entry = state?.guardrailAsks?.[key];
    const at = PER_PATH_DEDUP_CLASSES.has(category) ? entry && typeof entry === "object" ? entry[matchedPath] : void 0 : entry;
    if (typeof at !== "string") return false;
    return withinWindow(Date.parse(at), now, GUARDRAIL_ASK_TTL_MS - 1);
  } catch {
    return false;
  }
}
function stampGuardrailAsk(state, match, now, identity) {
  const key = guardrailScopeKey(match.category, identity);
  if (!key) return;
  const asks = state.guardrailAsks && typeof state.guardrailAsks === "object" ? state.guardrailAsks : {};
  const iso = new Date(now).toISOString();
  if (PER_PATH_DEDUP_CLASSES.has(match.category)) {
    const prev = asks[key];
    const byPath = {};
    if (prev && typeof prev === "object") {
      for (const [p, at] of Object.entries(prev)) {
        const t = typeof at === "string" ? Date.parse(at) : NaN;
        if (withinWindow(t, now, GUARDRAIL_ASK_TTL_MS - 1)) byPath[p] = at;
      }
    }
    byPath[match.path] = iso;
    asks[key] = byPath;
  } else {
    asks[key] = iso;
  }
  state.guardrailAsks = asks;
}
function recordHookFire(projectRoot, decision, now = Date.now(), mode = "ask", claudeSessionId, agent) {
  const gate = hookGateRecord(decision, mode);
  const session = typeof claudeSessionId === "string" ? claudeSessionId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64) : "";
  if (gate && session) gate.session = session;
  if (gate) Object.assign(gate, hookAgentFields(agent));
  appendHookFire(
    hookStatePath(projectRoot),
    {
      at: new Date(now).toISOString(),
      hook: "preflight",
      kind: mode === "strict-stop" ? "deny" : "ask",
      ...mode === "strict-stop" ? { mode } : {},
      reason: decision.guardrail ? `guardrail:${decision.guardrail.category}` : decision.source || "blocked",
      ...gate ? { id: `hf_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`, gate } : {}
    },
    (state) => {
      if (mode === "ask" && decision.guardrail && decision.guardrail.category !== DEEPPAIRING_STATE_CATEGORY) {
        stampGuardrailAsk(state, decision.guardrail, now, { sessionId: claudeSessionId, agentId: agent?.agent_id });
      }
    }
  );
}
function guardrailReason(match) {
  return `Allow this edit to ${match.path}? It's a guardrail path (${match.category} \u2014 ${match.note}), and no findings, options, spec, or plan has recent approval covering this file. Decline to have it presented for review first \u2014 approved exact file coverage (or approved scopeless pre-work in this session) is what makes this prompt stop.
[GUARDRAIL_ESCALATION \u2014 agent: this is ESCALATED work. On a decline, present findings/options/a spec or plan before landing it.]`;
}
function evaluateGuardrailBackstop(args) {
  const { projectRoot } = args;
  const now = args.now ?? Date.now();
  try {
    if (guardrailBackstopDisabled(args.env ?? process.env)) return null;
    const input = args.toolInput;
    const fp = input?.file_path ?? input?.filePath;
    if (typeof fp !== "string" || !fp) return null;
    const match = matchGuardrailPath(projectRoot, [fp]);
    if (!match) return null;
    if (args.mode !== "strict-stop" && guardrailAskSuppressed(projectRoot, match.category, match.path, now, args)) return null;
    const ceremony = readSessionCeremony(projectRoot, now, args.failures, { sessionId: args.sessionId, agentId: args.agentId, targetPath: match.path });
    if (!ceremony.reachable) return null;
    if (ceremony.hasLiveCeremony) return null;
    const reason = args.mode === "strict-stop" ? `Edit to ${strictExcerpt(match.path, 200)} stopped before execution (strict-stop mode). It's a guardrail path (${match.category} \u2014 ${strictExcerpt(match.note, 160)}), and no findings, options, spec, or plan has recent approval covering this file. Cancel or revise the proposal, or present the required pre-work for review before continuing. [GUARDRAIL_ESCALATION]` : guardrailReason(match);
    return { fire: true, reason, source: "guardrail", guardrail: match };
  } catch (err) {
    pushFailure(args.failures, noteFailure("evaluate", "backstop", err));
    return null;
  }
}
function deeppairingStateReason(match, mode = "ask") {
  const what = match.kind === "preferences" ? "It's where your stances live: an edit here can quietly retire one." : match.kind === "team" ? "It holds your team's committed rules: an edit here changes them for everyone." : match.kind === "hooks" ? "It's one of the hook scripts that make these prompts: an edit here can switch a prompt off." : match.kind === "worktree-link" ? "It's this git worktree's link to its main checkout, which decides whose stances apply here: an edit can point the worktree at an empty ledger." : "It's a Claude Code settings file that registers deepPairing's hooks: an edit here can remove these prompts.";
  const whose = match.kind === "claude-settings" || match.kind === "worktree-link" ? "It guards deepPairing's prompts." : "It's deepPairing's own state.";
  if (mode === "strict-stop") {
    return `Edit to ${strictExcerpt(match.path, 200)} stopped before execution (strict-stop mode). ${whose} ${what} Cancel or revise the proposal. An authorized human must make any intended state, rule, hook, settings or worktree-link change themselves. [DEEPPAIRING_STATE]`;
  }
  return `Allow this edit to ${match.path}? ${whose} ${what} deepPairing always asks about this file, whatever else is going on.
[DEEPPAIRING_STATE \u2014 agent: don't edit deepPairing's state files to change a stance, rule or hook. On a decline, ask your pair to make the change themselves.]`;
}
function evaluateDeeppairingState(args) {
  try {
    const match = matchDeeppairingStatePath(args.projectRoot, toolInputTargetPath(args.toolInput));
    if (!match) return null;
    return {
      fire: true,
      reason: deeppairingStateReason(match, args.mode),
      source: "guardrail",
      guardrail: {
        category: DEEPPAIRING_STATE_CATEGORY,
        path: match.path,
        rationale: "deepPairing's own state: your stances, team rules, hook scripts and the settings that register them.",
        note: "deepPairing's own state"
      }
    };
  } catch (err) {
    pushFailure(args.failures, noteFailure("evaluate", "state", err));
    return null;
  }
}
function runPreflightSkippingBadEntries(args) {
  const { result, coerced, skipped } = runPreflightGuarded(
    {
      toolName: args.toolName,
      proposalStrings: args.proposalStrings,
      proposalPaths: args.proposalPaths,
      rejectedApproaches: args.entries.map((e) => e.entry),
      teamPreferences: args.teamPreferences
    },
    (i) => args.entries[i].index
  );
  const indices = [.../* @__PURE__ */ new Set([...coerced, ...skipped])].sort((a, b) => a - b);
  if (indices.length > 0) {
    pushFailure(args.failures, { cls: "ledger_entry_invalid", source: "preferences", tag: skipped.length > 0 ? "skipped" : "concept", indices });
  }
  return result;
}
function evaluatePreflightHook(args) {
  const decision = evaluateHookGates(args);
  if (!decision.fire) return decision;
  const target = decision.guardrail?.path ?? displayTarget(args.projectRoot, toolInputTargetPath(args.toolInput));
  return { ...decision, toolName: args.toolName, ...target ? { target } : {} };
}
function displayTarget(projectRoot, target) {
  if (typeof target !== "string" || !target) return void 0;
  try {
    if (!path6.isAbsolute(target)) return target;
    const rel = path6.relative(projectRoot, target);
    return rel && !rel.startsWith("..") && !path6.isAbsolute(rel) ? rel : target;
  } catch {
    return target;
  }
}
function evaluateHookGates(args) {
  const { toolName, toolInput, projectRoot, failures } = args;
  const state = evaluateDeeppairingState({ toolInput, projectRoot, mode: args.mode, failures });
  if (toolName === "NotebookEdit") return state ?? { fire: false };
  const { strings, paths } = buildProposals(toolName, toolInput);
  if (strings.length === 0) return state ?? evaluateSkeletonScope({ toolName, toolInput, projectRoot, now: args.now, mode: args.mode, failures, sessionId: args.sessionId, agentId: args.agentId }) ?? { fire: false };
  const result = runPreflightSkippingBadEntries({
    toolName,
    proposalStrings: strings,
    proposalPaths: paths,
    entries: readRejectedApproachEntries(projectRoot, failures),
    teamPreferences: readTeamPreferences(projectRoot, failures),
    failures
  });
  if (result.blocked) {
    const reason = args.mode === "strict-stop" ? strictRejectionReason(result.block) : toHookReason(result.block.message);
    const stance = stanceOf(result.block);
    return state ? { ...state, reason: `${reason}

${state.reason}`, source: result.block.source, ...stance ? { stance } : {} } : { fire: true, reason, source: result.block.source, ...stance ? { stance } : {} };
  }
  if (state) return state;
  const skeleton = evaluateSkeletonScope({ toolName, toolInput, projectRoot, now: args.now, mode: args.mode, failures, sessionId: args.sessionId, agentId: args.agentId });
  if (skeleton) {
    const backstop = evaluateGuardrailBackstop({ toolInput, projectRoot, now: args.now, env: args.env, mode: args.mode, failures, sessionId: args.sessionId, agentId: args.agentId });
    return backstop?.fire && backstop.reason ? { ...skeleton, reason: `${skeleton.reason}

${backstop.reason}` } : skeleton;
  }
  return evaluateGuardrailBackstop({ toolInput, projectRoot, now: args.now, env: args.env, mode: args.mode, failures, sessionId: args.sessionId, agentId: args.agentId }) ?? { fire: false };
}
function evaluateSkeletonScope(args) {
  try {
    const scopes = readSkeletonScopes(args.projectRoot, args.now);
    if (scopes.length === 0) return null;
    const target = toolInputTargetPath(args.toolInput);
    if (typeof target !== "string" || !target) return null;
    const sessionId = deriveSessionId(args.projectRoot, usableSessionId(args.sessionId)).sessionId;
    const { fenced, paused } = resolveSkeletonScopes(args.projectRoot, scopes);
    const hold = evaluatePausedEdit({
      toolName: args.toolName,
      toolInput: args.toolInput,
      paused,
      sessionId,
      projectRoot: args.projectRoot,
      strict: args.mode === "strict-stop"
    });
    if (hold) return { fire: true, reason: hold.reason, source: "skeleton", skeleton: { skelIds: [], paused: true } };
    const scope = selectSkeletonScope(fenced, { sessionId, targetAbs: path6.resolve(args.projectRoot, target) });
    const violation = evaluateSkeletonEdit({
      toolName: args.toolName,
      toolInput: args.toolInput,
      projectRoot: args.projectRoot,
      scope,
      strict: args.mode === "strict-stop",
      readFile: (abs) => {
        try {
          return fs5.readFileSync(abs, "utf-8");
        } catch {
          return null;
        }
      }
    });
    if (!violation) return null;
    return { fire: true, reason: violation.reason, source: "skeleton", skeleton: { skelIds: violation.skelIds } };
  } catch (err) {
    pushFailure(args.failures, noteFailure("evaluate", "skeleton", err));
    return null;
  }
}
function stanceOf(block) {
  const m = block.broadcastEvent.match;
  const str = (v) => typeof v === "string" && v ? v : void 0;
  const concept = str(m.concept) ?? str(m.description);
  if (!concept) return void 0;
  return {
    concept,
    ...str(m.description) ? { description: str(m.description) } : {},
    ...str(m.reason) ? { reason: str(m.reason) } : {},
    ...str(m.via) ? { via: str(m.via) } : {},
    ...str(m.addedBy) ? { addedBy: str(m.addedBy) } : {}
  };
}
function gateText(value, limit) {
  if (typeof value !== "string") return void 0;
  const text = sanitizeStrictReason(value);
  if (!text) return void 0;
  return text.length > limit ? text.slice(0, limit - 1).replace(/[\ud800-\udbff]$/, "") + "\u2026" : text;
}
function hookAgentFields(agent) {
  try {
    if (!agent || typeof agent !== "object") return {};
    const out = {};
    const id = typeof agent.agent_id === "string" ? agent.agent_id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) : "";
    const type = gateText(agent.agent_type, 80);
    if (id) out.agentId = id;
    if (type) out.agentType = type;
    return out;
  } catch {
    return {};
  }
}
function hookGateRecord(decision, mode = "ask") {
  try {
    if (!decision.fire) return void 0;
    const stance = decision.stance;
    const g = decision.guardrail ?? (decision.skeleton ? decision.skeleton.paused ? { category: "skeleton-paused", path: decision.target ?? "", note: "Skeleton change awaiting approval", rationale: "A reshaped skeleton awaits your re-review: fills are paused for its files." } : { category: "skeleton-scope", path: decision.target ?? "", note: `Skeleton fence ${decision.skeleton.skelIds.map((i) => `SKEL[${i}]`).join(", ")}`, rationale: "Filling an approved skeleton: edits stay inside the in-progress step's fence." } : void 0);
    const concept = gateText(stance?.concept ?? g?.note, 200);
    if (!concept) return void 0;
    const source = stance ? decision.source === "team" ? "team" : "session" : "guardrail";
    const out = { decision: mode === "strict-stop" ? "deny" : "ask", source, concept };
    const description = gateText(stance?.description, 200);
    const reason = gateText(stance ? stance.reason : g?.rationale, 500);
    const via = gateText(stance?.via, 20);
    const addedBy = gateText(stance?.addedBy, 80);
    const category = gateText(g?.category, 60);
    const tool = gateText(decision.toolName, 40);
    const target = gateText(decision.target, 400);
    if (description && description !== concept) out.description = description;
    if (reason) out.reason = reason;
    if (via) out.via = via;
    if (addedBy) out.addedBy = addedBy;
    if (category) out.guardrail = category;
    if (tool) out.tool = tool;
    if (target) out.target = target;
    return out;
  } catch {
    return void 0;
  }
}
export {
  CEREMONY_MAX_AGE_MS,
  CLOCK_SKEW_TOLERANCE_MS,
  DEEPPAIRING_STATE_CATEGORY,
  GUARDRAIL_ASK_TTL_MS,
  GUARDRAIL_BACKSTOP_ENV,
  GUARDRAIL_RULES,
  PER_PATH_DEDUP_CLASSES,
  PREFLIGHT_FAILURE_CLASSES,
  PREFLIGHT_MODE_WARNING,
  SCOPELESS_FALLBACK_TYPES,
  acquireHookStateLock,
  buildProposals,
  deeppairingStateReason,
  evaluateDeeppairingState,
  evaluateGuardrailBackstop,
  evaluatePreflightHook,
  evaluateSkeletonScope,
  guardrailAskSuppressed,
  guardrailBackstopDisabled,
  guardrailReason,
  hookAgentFields,
  hookGateRecord,
  matchDeeppairingStatePath,
  matchGuardrailPath,
  noteFailure,
  preflightHookOutput,
  pushFailure,
  readHookState,
  readPreflightFailures,
  readRejectedApproachEntries,
  readRejectedApproaches,
  readSessionCeremony,
  readTeamPreferences,
  recordHookFire,
  recordPreflightFailures,
  releaseHookStateLock,
  resolvePreflightMode,
  runPreflightSkippingBadEntries,
  sanitizeStrictReason,
  skeletonScopeActive,
  stripArtifactClause,
  toHookReason,
  toolInputTargetsDeeppairingState,
  toolInputTargetsGuardrail,
  withinWindow,
  writeHookStateAtomic
};
