import path from "node:path";

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
      const rel = path.relative(projectRoot, abs).replace(/\\/g, "/");
      if (!rel || rel === ".." || rel.startsWith("../")) continue; // outside the project
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
