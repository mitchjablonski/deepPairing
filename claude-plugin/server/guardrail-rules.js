import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// src/guardrail-rules.ts
import fs2 from "node:fs";
import os from "node:os";
import path2 from "node:path";

// src/git-worktree.ts
import fs from "node:fs";
import path from "node:path";
function sameDir(a, b) {
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}
function parseLinkedWorktree(top, dotGitFile) {
  try {
    const raw = fs.readFileSync(dotGitFile, "utf8");
    const m = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(raw);
    if (!m) return null;
    const gitdir = path.resolve(top, m[1]);
    let common;
    try {
      common = fs.readFileSync(path.join(gitdir, "commondir"), "utf8").trim();
    } catch {
      return null;
    }
    if (!common) return null;
    const commonDir = path.resolve(gitdir, common);
    if (path.basename(commonDir) !== ".git") return null;
    try {
      const config = fs.readFileSync(path.join(commonDir, "config"), "utf8");
      if (/^[ \t]*bare[ \t]*=[ \t]*true[ \t]*$/im.test(config)) return null;
    } catch {
      return null;
    }
    const mainTop = path.dirname(commonDir);
    const mainDotGit = path.join(mainTop, ".git");
    if (!fs.statSync(mainDotGit).isDirectory() || !sameDir(mainDotGit, commonDir)) return null;
    if (sameDir(mainTop, top)) return null;
    return { worktreeTop: top, mainTop };
  } catch {
    return null;
  }
}
function findLinkedWorktree(p) {
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
      if (st) return st.isFile() ? parseLinkedWorktree(cur, dotGit) : null;
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
    return null;
  } catch {
    return null;
  }
}
function canonicalizeWorktreePath(p) {
  const abs = path.resolve(p);
  const worktree = findLinkedWorktree(abs);
  if (!worktree) return { path: abs, worktree: null };
  const rel = path.relative(worktree.worktreeTop, abs);
  return { path: rel ? path.join(worktree.mainTop, rel) : worktree.mainTop, worktree };
}
function canonicalProjectDir(dir) {
  const abs = path.resolve(dir);
  const mapped = canonicalizeWorktreePath(abs);
  if (!mapped.worktree) return { projectRoot: abs, worktree: null };
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
    const { projectRoot, worktree } = canonicalProjectDir(raw);
    return worktree ? { projectRoot, workspaceRoot: raw, worktree } : { projectRoot: raw, workspaceRoot: raw, worktree: null };
  } catch {
    return { projectRoot: raw, workspaceRoot: raw, worktree: null };
  }
}

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
function matchGuardrailPath(projectRoot, paths) {
  try {
    for (const raw of paths) {
      if (typeof raw !== "string" || !raw) continue;
      const abs = path2.resolve(projectRoot, raw);
      let rel = path2.relative(projectRoot, abs).replace(/\\/g, "/");
      if (!rel || rel === ".." || rel.startsWith("../") || path2.isAbsolute(rel)) {
        const mapped = canonicalizeWorktreePath(abs);
        if (!mapped.worktree) continue;
        rel = path2.relative(projectRoot, mapped.path).replace(/\\/g, "/");
        if (!rel || rel === ".." || rel.startsWith("../") || path2.isAbsolute(rel)) continue;
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
    return fs2.realpathSync.native(abs);
  } catch {
  }
  if (hops < 8) {
    try {
      const target = fs2.readlinkSync(abs);
      return realpathish(path2.resolve(path2.dirname(abs), target), hops + 1);
    } catch {
    }
  }
  const rest = [];
  let cur = abs;
  for (let i = 0; i < 64; i++) {
    const parent = path2.dirname(cur);
    if (parent === cur) return null;
    rest.unshift(path2.basename(cur));
    cur = parent;
    try {
      return path2.join(fs2.realpathSync.native(cur), ...rest);
    } catch {
    }
  }
  return null;
}
function physicalResolve(base, spelling) {
  try {
    const absolute = path2.isAbsolute(spelling);
    const root = absolute ? path2.parse(spelling).root : "";
    let cur = absolute ? root : base;
    try {
      cur = fs2.realpathSync.native(cur);
    } catch {
    }
    const segs = (absolute ? spelling.slice(root.length) : spelling).split(/[\\/]+/);
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        cur = path2.dirname(cur);
        continue;
      }
      cur = path2.join(cur, seg);
      try {
        cur = fs2.realpathSync.native(cur);
      } catch {
        try {
          if (fs2.lstatSync(cur).isSymbolicLink()) {
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
    if (/^~\//.test(cleaned)) spellings.push(path2.join(os.homedir(), cleaned.slice(2)));
    const ordered = [];
    for (const c of spellings) {
      const physical = physicalResolve(projectRoot, c);
      if (physical) ordered.push(physical);
    }
    for (const c of spellings) {
      const abs = path2.resolve(projectRoot, c);
      ordered.push(abs);
      const real = realpathish(abs);
      if (real) ordered.push(real);
    }
    ordered.push(...candidates);
    for (const c of ordered) {
      const m = STATE_PATTERN.exec(canonicalForm(c));
      if (!m) continue;
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
    roots.push(fs2.realpathSync.native(projectRoot));
  } catch {
  }
  const abs = path2.isAbsolute(candidate) ? candidate : path2.resolve(projectRoot, candidate);
  for (const root of roots) {
    const rel = path2.relative(root, abs).replace(/\\/g, "/");
    if (rel && rel !== ".." && !rel.startsWith("../") && !path2.isAbsolute(rel)) return rel;
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
export {
  DEEPPAIRING_STATE_CATEGORY,
  GUARDRAIL_EXCLUDED_SEGMENTS,
  GUARDRAIL_RULES,
  matchDeeppairingStatePath,
  matchGuardrailPath,
  matchesGuardrailDir,
  matchesGuardrailFile,
  resolveHookRoots,
  ruleForRelPath,
  toolInputTargetPath,
  toolInputTargetsDeeppairingState,
  toolInputTargetsGuardrail
};
