import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// src/cli/preflight-hook-entry.ts
import fs2 from "node:fs";
import path2 from "node:path";

// src/cli/preflight-hook-core.ts
import fs from "node:fs";
import path from "node:path";

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
function meaningfulTokens(s) {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !SHORT_STOPWORDS.has(t)).map(stemToken);
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
  return meaningfulTokens(storedConcept).length >= 2;
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
function runPreflight(input2) {
  const { toolName, proposalStrings, proposalPaths = [], proposalConcepts = [], rejectedApproaches, teamPreferences, globalAdvisoryConcepts = [] } = input2;
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

Do NOT retry with this approach. Revise your proposal to exclude it, or \u2014 if you believe conditions have changed \u2014 present_findings first to make the case for reconsidering, then wait for the human's response via check_feedback. The artifact was NOT created.`;
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
              via: match.via
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

// src/cli/guardrail-prefilter.ts
var GUARDRAIL_PATH_PREFILTER = /(^|\/)(\.github\/workflows|\.circleci|\.gitlab-ci|Jenkinsfile|migrations|db\/migrate|prisma\/migrations|supabase\/migrations|alembic\/versions|Dockerfile|docker-compose|compose|infrastructure|terraform|k8s|kubernetes|helm|\.env|config\/secrets|config\/credentials|config\/master\.key)(\/|\.|$)|\.tfvars$/;
function looksLikeGuardrailPath(toolInput) {
  try {
    const input2 = toolInput;
    const fp = input2?.file_path ?? input2?.filePath;
    if (typeof fp !== "string" || !fp) return false;
    return GUARDRAIL_PATH_PREFILTER.test(fp.replace(/\\/g, "/"));
  } catch {
    return false;
  }
}

// src/cli/preflight-hook-core.ts
function readRejectedApproaches(projectRoot) {
  const p = path.join(projectRoot, ".deeppairing", "preferences.json");
  try {
    if (!fs.existsSync(p)) return [];
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
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
  const p = path.join(projectRoot, ".deeppairing", "team.json");
  try {
    if (!fs.existsSync(p)) return [];
    const stripped = fs.readFileSync(p, "utf-8").split("\n").map((l) => /^\s*\/\//.test(l) ? "" : l).join("\n");
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
var PER_PATH_DEDUP_CLASSES = /* @__PURE__ */ new Set(["migrations", "secrets"]);
function isRealDotenv(name) {
  if (!/^\.env(\.[^/]+)?$/.test(name)) return false;
  return !/\.(example|sample|template|dist)$/i.test(name);
}
var GUARDRAIL_RULES = [
  {
    category: "migrations",
    rationale: "Migrations are hard to reverse \u2014 escalate to supervised for changes here.",
    note: "hard to reverse",
    dirs: ["migrations", "db/migrate", "prisma/migrations", "supabase/migrations", "alembic/versions"],
    file: () => false
  },
  {
    category: "workflows",
    rationale: "CI workflows affect every future deploy \u2014 escalate for changes here.",
    note: "it affects every future deploy",
    dirs: [".github/workflows", ".circleci"],
    file: (rel) => rel === ".gitlab-ci.yml" || rel === ".gitlab-ci.yaml" || rel === "Jenkinsfile"
  },
  {
    category: "infrastructure",
    rationale: "Infrastructure changes affect production surfaces \u2014 escalate here.",
    note: "it affects production surfaces",
    dirs: ["infrastructure", "terraform", "k8s", "kubernetes", "helm"],
    file: (rel) => /^Dockerfile([.-][^/]*)?$/.test(rel) || /^(docker-)?compose[^/]*\.ya?ml$/.test(rel) || /^[^/]*\.tfvars(\.json)?$/.test(rel)
  },
  {
    category: "secrets",
    rationale: "Secret files must never leak into the session or a commit \u2014 escalate here.",
    note: "secrets must never leak into a commit",
    dirs: [],
    file: (rel) => isRealDotenv(rel) || /^config\/secrets[^/]*$/.test(rel) || /^config\/credentials[^/]*$/.test(rel) || rel === "config/master.key"
  }
];
function matchGuardrailPath(projectRoot, paths) {
  try {
    for (const raw of paths) {
      if (typeof raw !== "string" || !raw) continue;
      const abs = path.resolve(projectRoot, raw);
      const rel = path.relative(projectRoot, abs).replace(/\\/g, "/");
      if (!rel || rel === ".." || rel.startsWith("../")) continue;
      for (const rule of GUARDRAIL_RULES) {
        const hit = rule.dirs.some((d) => rel === d || rel.startsWith(d + "/")) || rule.file(rel);
        if (hit) return { category: rule.category, path: rel, rationale: rule.rationale, note: rule.note };
      }
    }
    return null;
  } catch {
    return null;
  }
}
function readSessionCeremony(projectRoot, now = Date.now()) {
  const sessionsDir = path.join(projectRoot, ".deeppairing", "sessions");
  let ids;
  try {
    if (!fs.existsSync(sessionsDir)) return { reachable: false, hasLiveCeremony: false };
    ids = fs.readdirSync(sessionsDir);
  } catch {
    return { reachable: false, hasLiveCeremony: false };
  }
  const isRecent = (a) => {
    const t = Date.parse(a?.createdAt ?? "");
    return Number.isFinite(t) ? now - t <= CEREMONY_MAX_AGE_MS : false;
  };
  for (const id of ids) {
    try {
      const af = path.join(sessionsDir, id, "artifacts.json");
      if (!fs.existsSync(af)) continue;
      const arr = JSON.parse(fs.readFileSync(af, "utf-8"));
      if (!Array.isArray(arr)) continue;
      if (sessionHasLivePreWorkCeremony(arr, isRecent)) return { reachable: true, hasLiveCeremony: true };
    } catch {
      continue;
    }
  }
  return { reachable: true, hasLiveCeremony: false };
}
function guardrailAskSuppressed(projectRoot, category, matchedPath, now = Date.now()) {
  try {
    const sp = path.join(projectRoot, ".deeppairing", "hooks-state.json");
    const state = JSON.parse(fs.readFileSync(sp, "utf-8"));
    const entry = state?.guardrailAsks?.[category];
    const at = PER_PATH_DEDUP_CLASSES.has(category) ? entry && typeof entry === "object" ? entry[matchedPath] : void 0 : entry;
    if (typeof at !== "string") return false;
    const t = Date.parse(at);
    if (!Number.isFinite(t)) return false;
    return now - t < GUARDRAIL_ASK_TTL_MS;
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
        if (Number.isFinite(t) && now - t < GUARDRAIL_ASK_TTL_MS) byPath[p] = at;
      }
    }
    byPath[match.path] = iso;
    asks[match.category] = byPath;
  } else {
    asks[match.category] = iso;
  }
  state.guardrailAsks = asks;
}
var FIRE_LOG_CAP = 50;
function recordHookFire(projectRoot, decision, now = Date.now()) {
  try {
    const sp = path.join(projectRoot, ".deeppairing", "hooks-state.json");
    let state = { version: 1 };
    try {
      const parsed = JSON.parse(fs.readFileSync(sp, "utf-8"));
      if (parsed && typeof parsed === "object") state = parsed;
    } catch {
    }
    state.version = 1;
    const fires = Array.isArray(state.fires) ? state.fires : [];
    fires.push({
      at: new Date(now).toISOString(),
      hook: "preflight",
      reason: decision.guardrail ? `guardrail:${decision.guardrail.category}` : decision.source || "blocked"
    });
    state.fires = fires.slice(-FIRE_LOG_CAP);
    if (decision.guardrail) stampGuardrailAsk(state, decision.guardrail, now);
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, JSON.stringify(state));
  } catch {
  }
}
function guardrailReason(match) {
  return `GUARDRAIL_ESCALATION \u2014 Allow this edit to ${match.path}? It's a guardrail path (${match.category} \u2014 ${match.note}), and no findings, options, spec, or plan is live in this project's recent sessions. Decline to have your pair present it for review first. (Agent: this is ESCALATED work \u2014 on a decline, present findings/options/a spec or plan before landing it.)`;
}
function evaluateGuardrailBackstop(args) {
  const { projectRoot } = args;
  const now = args.now ?? Date.now();
  try {
    if (guardrailBackstopDisabled(args.env ?? process.env)) return null;
    const input2 = args.toolInput;
    const fp = input2?.file_path ?? input2?.filePath;
    if (typeof fp !== "string" || !fp) return null;
    const match = matchGuardrailPath(projectRoot, [fp]);
    if (!match) return null;
    if (guardrailAskSuppressed(projectRoot, match.category, match.path, now)) return null;
    const ceremony = readSessionCeremony(projectRoot, now);
    if (!ceremony.reachable) return null;
    if (ceremony.hasLiveCeremony) return null;
    return { fire: true, reason: guardrailReason(match), source: "guardrail", guardrail: match };
  } catch {
    return null;
  }
}
function evaluatePreflightHook(args) {
  const { toolName, toolInput, projectRoot } = args;
  const { strings, paths } = buildProposals(toolName, toolInput);
  if (strings.length === 0) return { fire: false };
  const result = runPreflight({
    toolName,
    proposalStrings: strings,
    proposalPaths: paths,
    rejectedApproaches: readRejectedApproaches(projectRoot),
    teamPreferences: readTeamPreferences(projectRoot)
  });
  if (result.blocked) {
    return { fire: true, reason: toHookReason(result.block.message), source: result.block.source };
  }
  return evaluateGuardrailBackstop({ toolInput, projectRoot, now: args.now, env: args.env }) ?? { fire: false };
}

// src/cli/preflight-hook-entry.ts
function ledgersPresent(root) {
  try {
    const prefs = JSON.parse(fs2.readFileSync(path2.join(root, ".deeppairing", "preferences.json"), "utf-8"));
    if (Array.isArray(prefs?.rejectedApproaches) && prefs.rejectedApproaches.length > 0) return true;
  } catch {
  }
  try {
    if (fs2.existsSync(path2.join(root, ".deeppairing", "team.json"))) return true;
  } catch {
  }
  return false;
}
var input = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (d) => {
  input += d;
});
process.stdin.on("end", () => {
  try {
    const ev = JSON.parse(input || "{}");
    const toolName = ev.tool_name || "";
    const toolInput = ev.tool_input || ev.input || {};
    const projectRoot = process.env.CLAUDE_PROJECT_DIR || ev.cwd || process.cwd();
    if (toolName !== "Edit" && toolName !== "Write" && toolName !== "MultiEdit") {
      process.exit(0);
    }
    if (!ledgersPresent(projectRoot) && !looksLikeGuardrailPath(toolInput)) {
      process.exit(0);
    }
    const decision = evaluatePreflightHook({ toolName, toolInput, projectRoot });
    if (decision && decision.fire) {
      recordHookFire(projectRoot, decision);
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "ask",
            permissionDecisionReason: decision.reason || "This change matches a previously-rejected approach."
          }
        })
      );
    }
    process.exit(0);
  } catch (err) {
    try {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write("[deepPairing] preflight hook error: " + msg + "\n");
    } catch {
    }
    process.exit(0);
  }
});
