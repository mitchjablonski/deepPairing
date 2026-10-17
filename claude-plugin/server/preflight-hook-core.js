import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// src/cli/preflight-hook-core.ts
import fs4 from "node:fs";
import path4 from "node:path";

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

// src/debrief-gate.ts
var PRE_WORK_CEREMONY_TYPES = ["research", "decision", "spec", "plan"];
var CEREMONY_DEAD_STATUSES = ["superseded", "retracted", "obsolete", "rejected"];
function sessionHasLivePreWorkCeremony(artifacts, isRecent = () => true) {
  return artifacts.some(
    (a) => PRE_WORK_CEREMONY_TYPES.includes(a?.type ?? "") && !CEREMONY_DEAD_STATUSES.includes(a?.status ?? "") && isRecent(a)
  );
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
function isLinkedWorktreeGitFile(abs) {
  try {
    if (!fs.lstatSync(abs).isFile()) return false;
    const gitdir = readGitdirPointer(path.dirname(abs), abs);
    return !!gitdir && fs.statSync(path.join(gitdir, "commondir")).isFile();
  } catch {
    return false;
  }
}
function findLinkedWorktree(p) {
  return inspect(p).worktree;
}
function canonicalizeWorktreePath(p) {
  const abs = path.resolve(p);
  const worktree = findLinkedWorktree(abs);
  if (!worktree) return { path: abs, worktree: null };
  return mapInto(abs, worktree);
}
function mapInto(abs, worktree) {
  const rel = path.relative(worktree.worktreeTop, abs);
  return { path: rel ? path.join(worktree.mainTop, rel) : worktree.mainTop, worktree };
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

// src/guardrail-rules.ts
import fs3 from "node:fs";
import os from "node:os";
import path3 from "node:path";
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
      const abs = path3.resolve(projectRoot, raw);
      let rel = path3.relative(projectRoot, abs).replace(/\\/g, "/");
      if (!rel || rel === ".." || rel.startsWith("../") || path3.isAbsolute(rel)) {
        const mapped = canonicalizeWorktreePath(abs);
        if (!mapped.worktree) continue;
        rel = path3.relative(projectRoot, mapped.path).replace(/\\/g, "/");
        if (!rel || rel === ".." || rel.startsWith("../") || path3.isAbsolute(rel)) continue;
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
      return realpathish(path3.resolve(path3.dirname(abs), target), hops + 1);
    } catch {
    }
  }
  const rest = [];
  let cur = abs;
  for (let i = 0; i < 64; i++) {
    const parent = path3.dirname(cur);
    if (parent === cur) return null;
    rest.unshift(path3.basename(cur));
    cur = parent;
    try {
      return path3.join(fs3.realpathSync.native(cur), ...rest);
    } catch {
    }
  }
  return null;
}
function physicalResolve(base, spelling) {
  try {
    const absolute = path3.isAbsolute(spelling);
    const root = absolute ? path3.parse(spelling).root : "";
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
        cur = path3.dirname(cur);
        continue;
      }
      cur = path3.join(cur, seg);
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
    if (/^~\//.test(cleaned)) spellings.push(path3.join(os.homedir(), cleaned.slice(2)));
    const ordered = [];
    for (const c of spellings) {
      const physical = physicalResolve(projectRoot, c);
      if (physical) ordered.push(physical);
    }
    for (const c of spellings) {
      const abs = path3.resolve(projectRoot, c);
      ordered.push(abs);
      const real = realpathish(abs);
      if (real) ordered.push(real);
    }
    ordered.push(...candidates);
    for (const c of ordered) {
      const m = STATE_PATTERN.exec(canonicalForm(c));
      if (!m) {
        if (path3.isAbsolute(c) && canonicalForm(c).split("/").pop() === ".git" && isLinkedWorktreeGitFile(c)) {
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
  const abs = path3.isAbsolute(candidate) ? candidate : path3.resolve(projectRoot, candidate);
  for (const root of roots) {
    const rel = path3.relative(root, abs).replace(/\\/g, "/");
    if (rel && rel !== ".." && !rel.startsWith("../") && !path3.isAbsolute(rel)) return rel;
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

// src/cli/preflight-hook-core.ts
function readRejectedApproaches(projectRoot) {
  const p = path4.join(projectRoot, ".deeppairing", "preferences.json");
  try {
    if (!fs4.existsSync(p)) return [];
    const raw = JSON.parse(fs4.readFileSync(p, "utf-8"));
    const list = raw?.rejectedApproaches;
    if (!Array.isArray(list)) return [];
    return list.map(
      (e) => typeof e === "string" ? { description: e } : {
        description: String(e?.description ?? ""),
        reason: e?.reason,
        rejectedAt: e?.rejectedAt,
        sourceArtifactId: e?.sourceArtifactId,
        concept: e?.concept
      }
    ).filter((r) => r.description);
  } catch {
    return [];
  }
}
function readTeamPreferences(projectRoot) {
  const p = path4.join(projectRoot, ".deeppairing", "team.json");
  try {
    if (!fs4.existsSync(p)) return [];
    const stripped = fs4.readFileSync(p, "utf-8").split("\n").map((l) => /^\s*\/\//.test(l) ? "" : l).join("\n");
    const raw = JSON.parse(stripped);
    if (!raw || raw.version !== 1 || !Array.isArray(raw.preferences)) return [];
    const KINDS = /* @__PURE__ */ new Set(["require", "prefer", "avoid"]);
    const valid = raw.preferences.every(
      (x) => x && typeof x.id === "string" && typeof x.concept === "string" && x.concept.length > 0 && typeof x.rationale === "string" && KINDS.has(x.kind)
    );
    return valid ? raw.preferences : [];
  } catch {
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
function readSessionCeremony(projectRoot, now = Date.now()) {
  const sessionsDir = path4.join(projectRoot, ".deeppairing", "sessions");
  let ids;
  try {
    if (!fs4.existsSync(sessionsDir)) return { reachable: false, hasLiveCeremony: false };
    ids = fs4.readdirSync(sessionsDir);
  } catch {
    return { reachable: false, hasLiveCeremony: false };
  }
  const isRecent = (a) => withinWindow(Date.parse(a?.createdAt ?? ""), now, CEREMONY_MAX_AGE_MS);
  let storesSeen = 0;
  let storesParsed = 0;
  for (const id of ids) {
    if (id.startsWith("demo_")) continue;
    let arr;
    try {
      const af = path4.join(sessionsDir, id, "artifacts.json");
      if (!fs4.existsSync(af)) continue;
      storesSeen++;
      arr = JSON.parse(fs4.readFileSync(af, "utf-8"));
      if (!Array.isArray(arr)) continue;
    } catch {
      continue;
    }
    storesParsed++;
    try {
      if (sessionHasLivePreWorkCeremony(arr, isRecent)) {
        return { reachable: true, hasLiveCeremony: true };
      }
    } catch {
      continue;
    }
  }
  if (storesSeen > 0 && storesParsed === 0) return { reachable: false, hasLiveCeremony: false };
  return { reachable: true, hasLiveCeremony: false };
}
function guardrailAskSuppressed(projectRoot, category, matchedPath, now = Date.now()) {
  try {
    const sp = path4.join(projectRoot, ".deeppairing", "hooks-state.json");
    const state = JSON.parse(fs4.readFileSync(sp, "utf-8"));
    const entry = state?.guardrailAsks?.[category];
    const at = PER_PATH_DEDUP_CLASSES.has(category) ? entry && typeof entry === "object" ? entry[matchedPath] : void 0 : entry;
    if (typeof at !== "string") return false;
    return withinWindow(Date.parse(at), now, GUARDRAIL_ASK_TTL_MS - 1);
  } catch {
    return false;
  }
}
function stampGuardrailAsk(state, match, now) {
  const asks = state.guardrailAsks && typeof state.guardrailAsks === "object" ? state.guardrailAsks : {};
  const iso = new Date(now).toISOString();
  if (PER_PATH_DEDUP_CLASSES.has(match.category)) {
    const prev = asks[match.category];
    const byPath = {};
    if (prev && typeof prev === "object") {
      for (const [p, at] of Object.entries(prev)) {
        const t = typeof at === "string" ? Date.parse(at) : NaN;
        if (withinWindow(t, now, GUARDRAIL_ASK_TTL_MS - 1)) byPath[p] = at;
      }
    }
    byPath[match.path] = iso;
    asks[match.category] = byPath;
  } else {
    asks[match.category] = iso;
  }
  state.guardrailAsks = asks;
}
function recordHookFire(projectRoot, decision, now = Date.now(), mode = "ask") {
  appendHookFire(
    hookStatePath(projectRoot),
    {
      at: new Date(now).toISOString(),
      hook: "preflight",
      kind: mode === "strict-stop" ? "deny" : "ask",
      ...mode === "strict-stop" ? { mode } : {},
      reason: decision.guardrail ? `guardrail:${decision.guardrail.category}` : decision.source || "blocked"
    },
    (state) => {
      if (mode === "ask" && decision.guardrail && decision.guardrail.category !== DEEPPAIRING_STATE_CATEGORY) {
        stampGuardrailAsk(state, decision.guardrail, now);
      }
    }
  );
}
function guardrailReason(match) {
  return `Allow this edit to ${match.path}? It's a guardrail path (${match.category} \u2014 ${match.note}), and no findings, options, spec, or plan is live in this project's recent sessions. Decline to have it presented for review first \u2014 presenting findings, options, a spec, or a plan is what makes this prompt stop.
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
    if (args.mode !== "strict-stop" && guardrailAskSuppressed(projectRoot, match.category, match.path, now)) return null;
    const ceremony = readSessionCeremony(projectRoot, now);
    if (!ceremony.reachable) return null;
    if (ceremony.hasLiveCeremony) return null;
    const reason = args.mode === "strict-stop" ? `Edit to ${strictExcerpt(match.path, 200)} stopped before execution (strict-stop mode). It's a guardrail path (${match.category} \u2014 ${strictExcerpt(match.note, 160)}), and no findings, options, spec, or plan is live in this project's recent sessions. Cancel or revise the proposal, or present the required pre-work for review before continuing. [GUARDRAIL_ESCALATION]` : guardrailReason(match);
    return { fire: true, reason, source: "guardrail", guardrail: match };
  } catch {
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
  } catch {
    return null;
  }
}
function evaluatePreflightHook(args) {
  const { toolName, toolInput, projectRoot } = args;
  const state = evaluateDeeppairingState({ toolInput, projectRoot, mode: args.mode });
  if (toolName === "NotebookEdit") return state ?? { fire: false };
  const { strings, paths } = buildProposals(toolName, toolInput);
  if (strings.length === 0) return state ?? { fire: false };
  const result = runPreflight({
    toolName,
    proposalStrings: strings,
    proposalPaths: paths,
    rejectedApproaches: readRejectedApproaches(projectRoot),
    teamPreferences: readTeamPreferences(projectRoot)
  });
  if (result.blocked) {
    const reason = args.mode === "strict-stop" ? strictRejectionReason(result.block) : toHookReason(result.block.message);
    return state ? { ...state, reason: `${reason}

${state.reason}`, source: result.block.source } : { fire: true, reason, source: result.block.source };
  }
  if (state) return state;
  return evaluateGuardrailBackstop({ toolInput, projectRoot, now: args.now, env: args.env, mode: args.mode }) ?? { fire: false };
}
export {
  CEREMONY_MAX_AGE_MS,
  CLOCK_SKEW_TOLERANCE_MS,
  DEEPPAIRING_STATE_CATEGORY,
  GUARDRAIL_ASK_TTL_MS,
  GUARDRAIL_BACKSTOP_ENV,
  GUARDRAIL_RULES,
  PER_PATH_DEDUP_CLASSES,
  PREFLIGHT_MODE_WARNING,
  acquireHookStateLock,
  buildProposals,
  deeppairingStateReason,
  evaluateDeeppairingState,
  evaluateGuardrailBackstop,
  evaluatePreflightHook,
  guardrailAskSuppressed,
  guardrailBackstopDisabled,
  guardrailReason,
  matchDeeppairingStatePath,
  matchGuardrailPath,
  preflightHookOutput,
  readHookState,
  readRejectedApproaches,
  readSessionCeremony,
  readTeamPreferences,
  recordHookFire,
  releaseHookStateLock,
  resolvePreflightMode,
  sanitizeStrictReason,
  stripArtifactClause,
  toHookReason,
  toolInputTargetsDeeppairingState,
  toolInputTargetsGuardrail,
  withinWindow,
  writeHookStateAtomic
};
