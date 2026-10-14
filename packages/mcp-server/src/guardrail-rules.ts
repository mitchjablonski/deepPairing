import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalizeWorktreePath } from "./git-worktree.js";

// #532 — re-exported so the init-generated hook (which imports THIS leaf by
// URL) resolves the project root through the same worktree canonicalisation.
export { resolveHookRoots } from "./git-worktree.js";

/**
 * Q1 (round-12) — THE ONE GUARDRAIL RULE TABLE.
 *
 * Round-12's HIGH: the guardrail path set lived in THREE places — this table
 * (as `GUARDRAIL_RULES` inside cli/preflight-hook-core.ts), a byte-identical
 * copy as `GUARDRAIL_SENSORS` in store/project-signals.ts, and a hand-written
 * "loose superset" regex (`GUARDRAIL_PATH_PREFILTER`) that setup-tasks.ts
 * interpolated into the init-generated hook. The INVERSION the review named:
 * the two frank copy-paste tables were still perfectly in sync; the one place
 * that claimed derivation ("by construction", per its own header) is the one
 * that DRIFTED — its trailing group `(\/|\.|$)` rejected `-`/`_` continuations
 * and `\.tfvars$` was end-anchored, so `Dockerfile-prod`,
 * `docker-compose-prod.yml`, `compose-prod.yml`, `config/secrets_prod.yml`,
 * `config/credentials-dev.yml` and `prod.tfvars.json` all failed the prefilter
 * while these rules guard them. Because the hook's early exit was
 * `!ledgersPresent() && !looksLikeGuardrailPath()`, every LEDGER-FREE project
 * (i.e. every fresh one) silently skipped the backstop on exactly those paths.
 *
 * The fix is a DELETION, not a 13th parity test: the prefilter is GONE and the
 * hook entries call the authoritative matcher below in the early exit. That is
 * only affordable because this module is a LEAF — `node:path` and nothing else,
 * no @deeppairing/shared, no zod, no store — so it is cheap for the CLI cold
 * start, cheap as a dynamic import from the init-generated `.mjs`, and safe to
 * inline into the esbuild plugin bundle. Everything else imports it:
 *
 *   - cli/preflight-hook-core.ts  → re-exports GUARDRAIL_RULES / matchGuardrailPath
 *   - cli/preflight-hook-entry.ts → the plugin-bundled hook's early exit
 *   - cli/setup-tasks.ts          → stamps this module's URL into the generated hook
 *   - store/project-signals.ts    → senseProjectGuardrails (the 🛡 hint section)
 *
 * There is no longer a mirror to keep honest, so the parity test's job shrank
 * to what it should always have been: quantifying over THIS table
 * programmatically rather than over a hand-picked fixture list.
 *
 * Node builtins only. Keep it that way — cli/preflight-hook-core.ts's
 * dependency-light contract now depends on this file's.
 */

export interface GuardrailRule {
  category: string;
  /** Rationale rendered by the 🛡 first-call-hint section (full sentence). */
  rationale: string;
  /** Short lowercase clause for the human-facing ask ("hard to reverse"). */
  note: string;
  /**
   * Directory names, matched at ANY path-segment boundary of the
   * project-relative path (see `matchesGuardrailDir`).
   */
  dirs: string[];
  /**
   * File patterns over the project-relative posix path, each anchored with
   * `(^|\/)` so it matches at any depth. MACHINE-READABLE on purpose: these
   * used to be opaque `(rel: string) => boolean` predicates, which is precisely
   * why the prefilter had to be hand-written (and therefore drifted).
   */
  filePatterns: RegExp[];
  /**
   * Optional carve-out applied AFTER filePatterns — the checked-in-template
   * exemption (`.env.example`, `.env.sample`, …).
   */
  fileExclude?: RegExp;
}

/**
 * Q1 item 7 — THE MONOREPO DECISION: match at ANY path-segment boundary.
 *
 * Pre-Q1 both the matcher and the prefilter were ROOT-RELATIVE-ONLY
 * (`rel === d || rel.startsWith(d + "/")`), so in a monorepo — which
 * deepPairing itself is, and which the target audience overwhelmingly is —
 * `packages/api/migrations/002_drop_users.sql` never fired. A backstop whose
 * whole job is the irreversible edit cannot be blind to the layout its own
 * repo uses. Both dir rules and file rules now match at any depth.
 *
 * Any-depth matching is paired with GUARDRAIL_EXCLUDED_SEGMENTS below — without
 * it the widened set swallows node_modules, fixtures and build output (H1).
 *
 * The near-miss silence list is UNAFFECTED and pinned: `src/migrations.js`,
 * `docs/migrations.md`, `src/k8s-helpers.ts`, `docs/terraform-notes.md`,
 * `compose.ts` are FILES NAMED LIKE guardrail dirs, not files INSIDE them —
 * the trailing `(\/|$)` is what separates the two, and it always did.
 *
 * The cost is a wider divergence from senseProjectGuardrails, which stays
 * root-relative because it enumerates classes with no edit in hand (walking a
 * whole monorepo on every FileStore construction is not worth it). That
 * divergence runs in the SAFE direction — everything the 🛡 section renders is
 * still something the hook would ask about — and is pinned in both directions
 * by guardrail-backstop-parity.test.ts.
 */
export const GUARDRAIL_RULES: GuardrailRule[] = [
  {
    category: "migrations",
    rationale: "Migrations are hard to reverse — escalate to supervised for changes here.",
    note: "hard to reverse",
    dirs: ["migrations", "db/migrate", "prisma/migrations", "supabase/migrations", "alembic/versions"],
    filePatterns: [],
  },
  {
    category: "workflows",
    rationale: "CI workflows affect every future deploy — escalate for changes here.",
    note: "it affects every future deploy",
    dirs: [".github/workflows", ".circleci"],
    filePatterns: [/(^|\/)\.gitlab-ci\.ya?ml$/, /(^|\/)Jenkinsfile$/],
  },
  {
    category: "infrastructure",
    rationale: "Infrastructure changes affect production surfaces — escalate here.",
    note: "it affects production surfaces",
    dirs: ["infrastructure", "terraform", "k8s", "kubernetes", "helm"],
    filePatterns: [
      /(^|\/)Dockerfile([.-][^/]*)?$/,
      /(^|\/)(docker-)?compose[^/]*\.ya?ml$/,
      /(^|\/)[^/]*\.tfvars(\.json)?$/,
    ],
  },
  {
    category: "secrets",
    rationale: "Secret files must never leak into the session or a commit — escalate here.",
    note: "secrets must never leak into a commit",
    dirs: [],
    filePatterns: [
      /(^|\/)\.env(\.[^/]+)?$/,
      /(^|\/)config\/secrets[^/]*$/,
      /(^|\/)config\/credentials[^/]*$/,
      /(^|\/)config\/master\.key$/,
    ],
    // Checked-in templates are not secrets. Applies to the whole class (so
    // `config/secrets.example` is exempt too, not just `.env.example`) — the
    // pre-Q1 asymmetry, where the carve-out lived inside the dotenv predicate
    // alone, was an accident of how the predicates were written.
    fileExclude: /\.(example|sample|template|dist)$/i,
  },
];

/**
 * H1 (round-12 adversarial review) — THE EXCLUSION LIST, and why any-depth
 * matching needs one.
 *
 * Extending the rules to any path-segment boundary (item 7, the monorepo fix)
 * bought the guarded set a large amount of code nobody edits deliberately:
 * vendored dependencies, test fixtures, build output, docs examples. Executed
 * against the shipped marketplace hook, `node_modules/somepkg/migrations/x.js`
 * and `test/fixtures/migrations/seed.sql` both ASKED; a realistic "add a
 * migration-runner package with tests" session of 20 writes produced 9 asks, 8
 * of them spurious — and the per-FILE dedup grain for migrations/secrets makes
 * it WORSE, because every fixture asks separately rather than once for the
 * class. This repository's own `node_modules` contains 20 newly-firing paths.
 *
 * Round-12's dogfood measured ZERO spurious asks and called the backstop
 * something the user "would not turn off". Spurious asks are the failure mode
 * that kills a gate like this, so the exclusion is checked BEFORE any rule.
 *
 * The trade-off, stated rather than hidden: a REAL migration that lives under
 * `examples/` or `fixtures/` goes unguarded. That is the same policy the
 * near-miss silence list already takes — the backstop is a protocol backstop,
 * not a security boundary, and a false ask costs more than a missed one here.
 *
 * A segment only excludes when something follows it (the trailing `\/`), so a
 * FILE named `dist` or `vendor` is untouched.
 */
export const GUARDRAIL_EXCLUDED_SEGMENTS =
  /(^|\/)(node_modules|bower_components|vendor|third_party|\.venv|venv|site-packages|dist|build|out|target|coverage|\.next|\.nuxt|\.output|\.turbo|__pycache__|fixtures|__fixtures__|testdata|test-data|__snapshots__|__mocks__|examples|example)(\/)/;

/** `rel` is, or is inside, directory `d` — at ANY segment boundary. */
export function matchesGuardrailDir(rel: string, d: string): boolean {
  return rel === d || rel.startsWith(d + "/") || rel.endsWith("/" + d) || rel.includes("/" + d + "/");
}

/** `rel` matches one of the rule's file patterns and is not a checked-in template. */
export function matchesGuardrailFile(rule: GuardrailRule, rel: string): boolean {
  if (!rule.filePatterns.some((re) => re.test(rel))) return false;
  return !(rule.fileExclude && rule.fileExclude.test(rel));
}

/** The rule a project-relative posix path falls under, or null. */
export function ruleForRelPath(rel: string): GuardrailRule | null {
  // H1 — vendored / generated / fixture / example trees are out of scope
  // entirely. Checked first: it is the reason any-depth matching is safe.
  if (GUARDRAIL_EXCLUDED_SEGMENTS.test(rel)) return null;
  for (const rule of GUARDRAIL_RULES) {
    if (rule.dirs.some((d) => matchesGuardrailDir(rel, d)) || matchesGuardrailFile(rule, rel)) return rule;
  }
  return null;
}

export interface GuardrailMatch {
  category: string;
  /** The project-relative path that matched (what the human sees named). */
  path: string;
  /** Full-sentence rationale (the 🛡 wording). */
  rationale: string;
  /** Short clause for the ask. */
  note: string;
}

/**
 * Authoritative match: is this edit's target under a guardrail rule of THIS
 * project? A path outside the project root never matches.
 *
 * Deliberately NOT gated on fs.existsSync of the rule's root.
 * senseProjectGuardrails needs existsSync because it enumerates classes with no
 * edit in hand; here the EDITED PATH ITSELF is the evidence. The two sets
 * therefore differ in exactly two documented cases — creating the FIRST file in
 * a guardrail location (a project's first migration, its first CI workflow),
 * and a NESTED guardrail location in a monorepo — both of which are guardrail
 * work by definition and included on purpose. Both divergences are pinned by
 * the parity test.
 *
 * FAIL OPEN on any fault: a null return means "no ask".
 */
export function matchGuardrailPath(projectRoot: string, paths: string[]): GuardrailMatch | null {
  try {
    for (const raw of paths) {
      if (typeof raw !== "string" || !raw) continue;
      const abs = path.resolve(projectRoot, raw);
      let rel = path.relative(projectRoot, abs).replace(/\\/g, "/");
      if (!rel || rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) {
        // #532 — outside the root, but maybe inside a git linked worktree of
        // it: the root is canonicalised to the main checkout, and an absolute
        // edit in `<worktree>/migrations/…` must still be the guardrail path
        // it is. Map it to the same repo-relative path in the main checkout.
        const mapped = canonicalizeWorktreePath(abs);
        if (!mapped.worktree) continue; // outside the project
        rel = path.relative(projectRoot, mapped.path).replace(/\\/g, "/");
        if (!rel || rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) continue;
      }
      const rule = ruleForRelPath(rel);
      if (rule) return { category: rule.category, path: rel, rationale: rule.rationale, note: rule.note };
    }
    return null;
  } catch {
    return null; // FAIL OPEN
  }
}

/**
 * The hook entries' early-exit predicate: could this tool_input's target be a
 * guardrail path?
 *
 * This IS the authoritative matcher — there is no separate prefilter any more
 * (see the header). Windows separators are normalized by matchGuardrailPath's
 * own `path.relative` + replace, so the same call works on both platforms.
 */
export function toolInputTargetsGuardrail(projectRoot: string, toolInput: unknown): boolean {
  try {
    const input = toolInput as { file_path?: unknown; filePath?: unknown } | null;
    const fp = input?.file_path ?? input?.filePath;
    if (typeof fp !== "string" || !fp) return false;
    return matchGuardrailPath(projectRoot, [fp]) !== null;
  } catch {
    return false;
  }
}

// ===========================================================================
// #470 slice 4 — THE `deeppairing-state` GUARDRAIL CLASS (design
// stance-exceptions.md §"Direct file edits", §10 row 7).
// ===========================================================================
//
// deepPairing's own state files. An agent Edit/Write/MultiEdit/NotebookEdit to
// one of them ALWAYS asks: no ceremony skip, no dedup window, and the
// DEEPPAIRING_GUARDRAIL_BACKSTOP opt-out does not switch it off (that opt-out
// is for the protocol backstop; this class protects the stances themselves).
//
//   - `.deeppairing/preferences.json` — your stance rows. Deleting or
//     rewriting one is an unprompted, silent Retire.
//   - `.deeppairing/team.json` — the committed team rules.
//   - `.deeppairing/hooks/<file>` — the init-installed hook scripts
//     (preflight.mjs, stance-allow-ask.sh, stop.mjs, checkpoint.mjs). Editing
//     one can switch these very prompts off; the #503 review flagged
//     stance-allow-ask.sh as the same residual. The whole directory is guarded,
//     not just that one script: preflight.mjs is the script that asks here.
//
// It is a PATH check, so it has to survive trivial path variants. Every
// candidate spelling of the target is normalised and tested:
//   - relative or absolute, with `.`/`..`, resolved against the project root;
//   - Windows separators, a `\\?\` prefix, trailing dots/spaces on a segment
//     and an NTFS stream suffix (`preferences.json::$DATA`), all of which name
//     the same file on Windows;
//   - case, folded on EVERY platform (a case-insensitive volume — macOS,
//     Windows, WSL's /mnt/c — would otherwise let `.DeepPairing/Team.JSON`
//     through; on a case-sensitive one the extra ask is harmless);
//   - symlinks, via realpath of the target, or of its deepest existing
//     ancestor for a file that doesn't exist yet.
// The match is at ANY depth of the resolved absolute path, inside or outside
// the project, so another project's or a symlinked-in copy asks too.
//
// Residuals, stated: hard links, Windows 8.3 short names (`DEEPPA~1`), and any
// write that isn't an Edit/Write/MultiEdit/NotebookEdit tool call — Bash
// writes (`echo >`, `sed -i`, `cp`, `mv`, `tee`) are outside this check by
// design (the narrow Bash matcher only looks at `stance allow`).

export const DEEPPAIRING_STATE_CATEGORY = "deeppairing-state";

// #505 review (Sol P2) — `hooks/` guards every DESCENDANT, not just direct
// children (`.deeppairing/hooks/lib/permission.mjs`). (Claude P3) — Claude
// Code's own settings files carry the hook rows, so editing one can remove
// these prompts: `.claude/settings.json` and `.claude/settings.local.json`
// (project or user scope) always ask too.
const STATE_PATTERN = /(^|\/)(?:\.deeppairing\/(preferences\.json|team\.json|hooks\/.+)|\.claude\/(settings(?:\.local)?\.json))$/;

export interface StateMatch {
  category: typeof DEEPPAIRING_STATE_CATEGORY;
  /** What the human sees named: project-relative when inside it, else absolute. */
  path: string;
  kind: "preferences" | "team" | "hooks" | "claude-settings";
}

/** One spelling → the comparable form: `/` separators, no Windows trailing
 *  dots/spaces or stream suffix on any segment, lower case. */
function canonicalForm(p: string): string {
  return p
    .replace(/\\/g, "/")
    .split("/")
    .map((seg) => (seg === "." || seg === ".." ? seg : seg.replace(/:.*$/, "").replace(/[. ]+$/, "")))
    .join("/")
    .toLowerCase();
}

/** Realpath of `abs`, or of its deepest existing ancestor plus the rest. A
 *  dangling symlink (its target doesn't exist yet) is followed by hand. */
function realpathish(abs: string, hops = 0): string | null {
  try {
    return fs.realpathSync.native(abs);
  } catch {
    /* not there yet, or a dangling link — walk up */
  }
  if (hops < 8) {
    try {
      const target = fs.readlinkSync(abs);
      return realpathish(path.resolve(path.dirname(abs), target), hops + 1);
    } catch {
      /* not a link */
    }
  }
  const rest: string[] = [];
  let cur = abs;
  for (let i = 0; i < 64; i++) {
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    rest.unshift(path.basename(cur));
    cur = parent;
    try {
      return path.join(fs.realpathSync.native(cur), ...rest);
    } catch {
      /* keep walking */
    }
  }
  return null;
}

/**
 * #505 review (Sol P2) — resolve the way the FILESYSTEM does, not lexically.
 * `alias/../preferences.json` with `alias` → `.deeppairing/hooks` opens
 * `.deeppairing/preferences.json`: the kernel follows `alias` first and only
 * then takes its parent. `path.resolve` collapses `alias/..` to nothing and
 * lands somewhere else. So walk segment by segment from the base, realpath-ing
 * every prefix that exists before applying the next `..`. A missing entry is
 * kept as written and the walk goes on (stricter than the kernel, which would
 * fail a `..` past a missing directory: an extra ask, never a missed one).
 */
function physicalResolve(base: string, spelling: string): string | null {
  try {
    const absolute = path.isAbsolute(spelling);
    // Never path.resolve the spelling itself: that would collapse `..` lexically.
    const root = absolute ? path.parse(spelling).root : "";
    let cur = absolute ? root : base;
    try { cur = fs.realpathSync.native(cur); } catch { /* keep as written */ }
    const segs = (absolute ? spelling.slice(root.length) : spelling).split(/[\\/]+/);
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      if (seg === "" || seg === ".") continue;
      if (seg === "..") { cur = path.dirname(cur); continue; }
      cur = path.join(cur, seg);
      // Every prefix is re-checked (no latch): after `missing/..` the walk is
      // back on real directories, and a link met later must still be followed.
      try {
        cur = fs.realpathSync.native(cur);
      } catch {
        // A dangling link is followed by hand; a missing entry stays as written.
        try {
          if (fs.lstatSync(cur).isSymbolicLink()) {
            const followed = realpathish(cur);
            if (followed) cur = followed;
          }
        } catch { /* missing */ }
      }
    }
    return cur;
  } catch {
    return null;
  }
}

/** Is `raw` (an agent-supplied tool path) one of deepPairing's state files?
 *  Never throws; anything it cannot read is "no match". */
export function matchDeeppairingStatePath(projectRoot: string, raw: unknown): StateMatch | null {
  try {
    if (typeof raw !== "string" || !raw) return null;
    // `\\?\C:\x` and `//?/C:/x` are the same file as `C:\x`.
    const unprefixed = raw.replace(/^(\\\\|\/\/)[?.](\\|\/)/, "");
    const slashed = unprefixed.replace(/\\/g, "/");
    // A segment-level clean BEFORE resolving, so `.deeppairing./x` or
    // `.deeppairing /x` collapses like Windows does and `..` still resolves.
    const cleaned = slashed
      .split("/")
      .map((seg) => (seg === "." || seg === ".." || /^[A-Za-z]:$/.test(seg) ? seg : seg.replace(/:.*$/, "").replace(/[. ]+$/, "") || seg))
      .join("/");
    const candidates = new Set<string>([slashed, cleaned]);
    const spellings = [slashed, cleaned];
    // `~/…` is a home-relative spelling some tools expand.
    if (/^~\//.test(cleaned)) spellings.push(path.join(os.homedir(), cleaned.slice(2)));
    // Filesystem-semantics resolutions come FIRST: they name the file the
    // write would really open, so they are also what the human is shown.
    const ordered: string[] = [];
    for (const c of spellings) {
      const physical = physicalResolve(projectRoot, c);
      if (physical) ordered.push(physical);
    }
    for (const c of spellings) {
      const abs = path.resolve(projectRoot, c);
      ordered.push(abs);
      const real = realpathish(abs);
      if (real) ordered.push(real);
    }
    ordered.push(...candidates);
    for (const c of ordered) {
      const m = STATE_PATTERN.exec(canonicalForm(c));
      if (!m) continue;
      const file = m[2] ?? "";
      const kind: StateMatch["kind"] = m[3] ? "claude-settings" : file.startsWith("hooks/") ? "hooks" : file === "team.json" ? "team" : "preferences";
      return { category: DEEPPAIRING_STATE_CATEGORY, path: displayPath(projectRoot, c), kind };
    }
    return null;
  } catch {
    return null;
  }
}

/** Project-relative (against the root as written or its realpath) when the
 *  path is inside the project, else absolute; always with `/`. */
function displayPath(projectRoot: string, candidate: string): string {
  const roots = [projectRoot];
  try { roots.push(fs.realpathSync.native(projectRoot)); } catch { /* as written */ }
  const abs = path.isAbsolute(candidate) ? candidate : path.resolve(projectRoot, candidate);
  for (const root of roots) {
    const rel = path.relative(root, abs).replace(/\\/g, "/");
    if (rel && rel !== ".." && !rel.startsWith("../") && !path.isAbsolute(rel)) return rel;
  }
  return abs.replace(/\\/g, "/");
}

/** The target path of an Edit/Write/MultiEdit (`file_path`) or NotebookEdit
 *  (`notebook_path`) tool_input. */
export function toolInputTargetPath(toolInput: unknown): unknown {
  const input = toolInput as { file_path?: unknown; filePath?: unknown; notebook_path?: unknown } | null;
  return input?.file_path ?? input?.filePath ?? input?.notebook_path;
}

export function toolInputTargetsDeeppairingState(projectRoot: string, toolInput: unknown): boolean {
  try {
    return matchDeeppairingStatePath(projectRoot, toolInputTargetPath(toolInput)) !== null;
  } catch {
    return false;
  }
}
