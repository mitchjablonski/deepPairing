/**
 * P1 (round-11) — THE GUARDRAIL BACKSTOP, unit level.
 *
 * Round-11's HIGH: SKILL.md and the first-call hint both claimed "the preflight
 * gate escalates guardrail-path edits itself regardless", while the preflight
 * hook had ZERO guardrail logic. This pins the mechanism that now backs the
 * claim, case by case:
 *
 *   (a) guardrail edit, NO pre-work ceremony  → ask, naming class + path
 *   (b) guardrail edit, LIVE spec/options/findings/plan → pass silently
 *   (c) non-guardrail edit                    → pass (zero behaviour change)
 *   (d) session store unreachable             → pass (FAIL OPEN)
 *   (e) rejected-approach ask                 → unchanged (positive control)
 *
 * plus the F3 dedup grain (per class; per FILE for migrations/secrets), the F6
 * filename sweep, the F7 opt-out, the F9 timestamp guard, and the
 * ask-never-deny contract from SECURITY.md.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CEREMONY_MAX_AGE_MS,
  GUARDRAIL_ASK_TTL_MS,
  GUARDRAIL_BACKSTOP_ENV,
  CLOCK_SKEW_TOLERANCE_MS,
  GUARDRAIL_RULES,
  PER_PATH_DEDUP_CLASSES,
  evaluateGuardrailBackstop,
  evaluatePreflightHook,
  guardrailAskSuppressed,
  guardrailBackstopDisabled,
  matchGuardrailPath,
  readHookState,
  readSessionCeremony,
  recordHookFire,
  toolInputTargetsGuardrail,
} from "../preflight-hook-core.js";
import { sessionHasLivePreWorkCeremony } from "../../debrief-gate.js";
import { GUARDRAIL_EXCLUDED_SEGMENTS } from "../../guardrail-rules.js";

let dir: string;
const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const recent = iso(NOW - 60 * 1000);
/** The backstop reads process.env by default; every call here passes an
 *  explicit empty env so a developer's own opt-out can't hide these tests. */
const ON = {} as Record<string, string | undefined>;

type Art = { id: string; type: string; status: string; createdAt: string };
const art = (type: string, status = "approved", createdAt: string = recent): Art =>
  ({ id: `${type}-${Math.random().toString(36).slice(2, 8)}`, type, status, createdAt }) as Art;

function seedSession(artifacts: Art[], sessionId = "s1"): void {
  const sd = path.join(dir, ".deeppairing", "sessions", sessionId);
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, "artifacts.json"), JSON.stringify(artifacts));
}

const edit = (rel: string) => ({ file_path: path.join(dir, rel), new_string: "whatever" });
/** Evaluate + apply the caller's stamp, i.e. what the hook entries actually do. */
const evalAndRecord = (rel: string, now = NOW) => {
  const d = evaluateGuardrailBackstop({ toolInput: edit(rel), projectRoot: dir, now, env: ON });
  if (d) recordHookFire(dir, d, now);
  return d;
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-guardrail-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// trigger predicate + the F6 filename sweep
// ---------------------------------------------------------------------------

/** F6 — every path here MUST fire; the review found the first cut silent on
 *  most of the second half of this list. */
const GUARDED: Array<[string, string]> = [
  [".github/workflows/ci.yml", "workflows"],
  [".circleci/config.yml", "workflows"],
  [".gitlab-ci.yml", "workflows"],
  ["Jenkinsfile", "workflows"],
  ["migrations/003_drop.sql", "migrations"],
  ["prisma/migrations/20260101_init/migration.sql", "migrations"],
  ["db/migrate/001.rb", "migrations"],
  ["supabase/migrations/x.sql", "migrations"],
  ["alembic/versions/ab12_add_col.py", "migrations"],
  ["Dockerfile", "infrastructure"],
  ["Dockerfile.prod", "infrastructure"],
  ["docker-compose.yml", "infrastructure"],
  ["docker-compose.prod.yml", "infrastructure"],
  ["compose.yaml", "infrastructure"],
  ["terraform.tfvars", "infrastructure"],
  ["terraform/main.tf", "infrastructure"],
  ["k8s/deploy.yaml", "infrastructure"],
  ["kubernetes/svc.yaml", "infrastructure"],
  ["helm/values.yaml", "infrastructure"],
  ["infrastructure/vpc.ts", "infrastructure"],
  [".env", "secrets"],
  [".env.production", "secrets"],
  [".env.staging", "secrets"],
  [".env.development", "secrets"],
  [".env.test", "secrets"],
  [".env.production.local", "secrets"],
  ["config/secrets.yml", "secrets"],
  ["config/credentials.yml.enc", "secrets"],
  ["config/master.key", "secrets"],
];

/**
 * Q1 item 7 — THE MONOREPO PATHS. Pre-Q1 these were all silent, because both
 * the matcher and the prefilter were root-relative only: deepPairing itself is
 * a monorepo, and so is most of the audience, so `packages/api/migrations/*`
 * never reached the backstop at all. They now fire, in both dir-class and
 * file-class rules.
 */
const GUARDED_NESTED: Array<[string, string]> = [
  ["packages/api/migrations/002_drop_users.sql", "migrations"],
  ["services/billing/db/migrate/003.rb", "migrations"],
  ["apps/web/prisma/migrations/20260101_init/migration.sql", "migrations"],
  ["packages/api/Dockerfile", "infrastructure"],
  ["packages/api/Dockerfile.prod", "infrastructure"],
  ["ops/terraform/main.tf", "infrastructure"],
  ["deploy/k8s/deploy.yaml", "infrastructure"],
  ["packages/api/docker-compose.yml", "infrastructure"],
  ["infra/prod.tfvars.json", "infrastructure"],
  ["apps/web/.env.production", "secrets"],
  ["services/api/config/secrets.yml", "secrets"],
  ["tools/ci/.gitlab-ci.yml", "workflows"],
  ["packages/api/.github/workflows/publish.yml", "workflows"],
];

/**
 * THE NEAR-MISS SWEEP (round-12 dogfood measured ZERO spurious asks across
 * these; item 7 must not change that). Every entry is a FILE NAMED LIKE a
 * guardrail directory, or a checked-in template — never a file INSIDE a
 * guardrail location. The trailing `(\/|$)` in the dir rule is what separates
 * the two, and it does so at any depth.
 */
const UNGUARDED = [
  ".env.example",
  ".env.sample",
  ".env.local.example",
  "src/migrations.js",
  "docs/migrations.md",
  "packages/api/src/migrations.ts",
  "src/k8s-helpers.ts",
  "src/index.ts",
  "docs/terraform-notes.md",
  "compose.ts",
  "lib/helm.ts",
  "scripts/kubernetes.md",
  "app/infrastructure.ts",
  "test/db/migrate.spec.ts",
];

/**
 * Concrete filenames per file-rule pattern, keyed by the pattern's own source so
 * ADDING a filePattern to GUARDRAIL_RULES without adding samples makes the
 * derived-probe test go quiet — which the count assertion below then catches.
 */
const SAMPLES_BY_PATTERN: Record<string, string[]> = {
  "(^|\\/)\\.gitlab-ci\\.ya?ml$": [".gitlab-ci.yml", ".gitlab-ci.yaml"],
  "(^|\\/)Jenkinsfile$": ["Jenkinsfile"],
  "(^|\\/)Dockerfile([.-][^/]*)?$": ["Dockerfile", "Dockerfile.prod", "Dockerfile-prod"],
  "(^|\\/)(docker-)?compose[^/]*\\.ya?ml$": [
    "docker-compose.yml",
    "docker-compose.prod.yml",
    "docker-compose-prod.yml",
    "compose.yaml",
    "compose-prod.yml",
  ],
  "(^|\\/)[^/]*\\.tfvars(\\.json)?$": ["terraform.tfvars", "prod.tfvars.json"],
  "(^|\\/)\\.env(\\.[^/]+)?$": [".env", ".env.production", ".env.staging"],
  "(^|\\/)config\\/secrets[^/]*$": ["config/secrets.yml", "config/secrets_prod.yml"],
  "(^|\\/)config\\/credentials[^/]*$": ["config/credentials.yml.enc", "config/credentials-dev.yml"],
  "(^|\\/)config\\/master\\.key$": ["config/master.key"],
};

describe("matchGuardrailPath — the trigger predicate (F6 sweep)", () => {
  it("fires on every guarded filename, reporting class + project-relative path", () => {
    for (const [rel, category] of GUARDED) {
      const m = matchGuardrailPath(dir, [path.join(dir, rel)]);
      expect(m, `expected ${rel} to match`).not.toBeNull();
      expect(m!.category, rel).toBe(category);
      expect(m!.path).toBe(rel);
    }
  });

  it("stays silent on templates and lookalikes (.env.example, nested migrations/)", () => {
    for (const rel of UNGUARDED) {
      expect(matchGuardrailPath(dir, [path.join(dir, rel)]), `${rel} should NOT match`).toBeNull();
    }
  });

  it("ignores paths outside the project root", () => {
    expect(matchGuardrailPath(dir, ["/somewhere/else/.github/workflows/ci.yml"])).toBeNull();
  });

  it("accepts a project-relative path (resolved against the root)", () => {
    expect(matchGuardrailPath(dir, [".github/workflows/ci.yml"])?.category).toBe("workflows");
  });

  /**
   * H1 — the false-positive frontier any-depth matching opened. Every probe is
   * DERIVED from GUARDRAIL_EXCLUDED_SEGMENTS itself, so a segment removed from
   * the table stops being asserted here rather than silently rotting.
   */
  it("H1 — vendored / generated / fixture / example trees never ask (derived from the exclusion table)", () => {
    const segments = /\(([^)]*)\)\(\\\/\)/.exec(GUARDRAIL_EXCLUDED_SEGMENTS.source)![1]
      .split("|")
      .map((x) => x.replace(/\\/g, ""));
    expect(segments.length).toBeGreaterThan(20);
    const silent: string[] = [];
    for (const seg of segments) {
      // The two shapes the review executed against the shipped hook.
      silent.push(`${seg}/somepkg/migrations/x.js`, `packages/api/${seg}/migrations/seed.sql`);
      // …and a file rule inside the same tree.
      silent.push(`${seg}/pkg/Dockerfile`, `${seg}/pkg/.env`);
    }
    for (const rel of silent) {
      expect(matchGuardrailPath(dir, [path.join(dir, rel)]), `SPURIOUS ask on ${rel}`).toBeNull();
      expect(toolInputTargetsGuardrail(dir, { file_path: path.join(dir, rel) }), `early exit fired on ${rel}`).toBe(false);
    }
    expect(silent.length).toBeGreaterThan(80);
    // The two the review named, spelled out.
    expect(matchGuardrailPath(dir, [path.join(dir, "node_modules/somepkg/migrations/x.js")])).toBeNull();
    expect(matchGuardrailPath(dir, [path.join(dir, "test/fixtures/migrations/seed.sql")])).toBeNull();
    // A segment NAME as the final component is untouched — only trees are
    // excluded, so `vendor.ts` or a `dist` file can still be a guardrail path.
    expect(matchGuardrailPath(dir, [path.join(dir, "migrations/dist")])?.category).toBe("migrations");
  });

  it("H1 — the exclusion does NOT eat the keeps: nested pins, root classes, and the round-12 misses all still fire", () => {
    for (const [rel, category] of [...GUARDED, ...GUARDED_NESTED]) {
      expect(matchGuardrailPath(dir, [path.join(dir, rel)])?.category, `exclusion swallowed ${rel}`).toBe(category);
    }
    for (const rel of [
      "Dockerfile-prod",
      "docker-compose-prod.yml",
      "compose-prod.yml",
      "config/secrets_prod.yml",
      "config/credentials-dev.yml",
      "prod.tfvars.json",
    ]) {
      expect(matchGuardrailPath(dir, [path.join(dir, rel)]), `round-12 miss regressed: ${rel}`).not.toBeNull();
    }
  });

  it("Q1 item 7 — nested (monorepo) guardrail paths fire; near-miss lookalikes stay silent", () => {
    for (const [rel, category] of GUARDED_NESTED) {
      const m = matchGuardrailPath(dir, [path.join(dir, rel)]);
      expect(m?.category, `expected ${rel} to fire`).toBe(category);
      expect(m!.path).toBe(rel);
    }
  });

  /**
   * Q1 item 1 — THE SUPERSET PROPERTY, quantified over GUARDRAIL_RULES itself.
   *
   * Round-12 found the hand-written prefilter was NOT the superset it claimed:
   * its trailing group rejected `-`/`_` continuations and `\.tfvars$` was
   * end-anchored, so Dockerfile-prod / docker-compose-prod.yml /
   * config/secrets_prod.yml / prod.tfvars.json failed it while these rules
   * guarded them — and the hook's early exit was the prefilter, so the backstop
   * was silently off for those paths in every ledger-free project. The prefilter
   * is DELETED; the early exit calls this same matcher. This test proves that
   * equivalence the way the old one should have: by GENERATING probe paths from
   * the rule table (each dir prefixed with the continuations the old regex
   * choked on), not from a hand-picked fixture list that can never notice a rule
   * nobody wrote a fixture for.
   */
  it("Q1 item 1 — the hook entries' early exit agrees with the matcher on every path DERIVED from GUARDRAIL_RULES", () => {
    const probes: string[] = [];
    const lookalikes: string[] = [];
    let filePatternProbes = 0;
    for (const rule of GUARDRAIL_RULES) {
      for (const d of rule.dirs) {
        probes.push(`${d}/f.txt`, `${d}/nested/f.txt`, `packages/a/${d}/f.txt`);
        // The continuations the drifted prefilter rejected, as SIBLING names —
        // these must NOT match (they are lookalikes, not guardrail dirs).
        lookalikes.push(`${d}-prod/f.txt`, `${d}_prod/f.txt`, `${d}.bak`);
      }
      for (const re of rule.filePatterns) {
        // M2 — a filePattern with NO samples used to contribute ZERO probes and
        // still pass (the dir probes alone cleared the count floor). Adding a
        // pattern without a sample now FAILS here rather than going untested.
        expect(
          SAMPLES_BY_PATTERN[re.source]?.length,
          `no SAMPLES_BY_PATTERN entry for ${rule.category} pattern ${re.source} — the derived-probe test would be blind to it`,
        ).toBeGreaterThan(0);
        // Reconstruct concrete filenames the pattern accepts, at root and nested.
        for (const sample of SAMPLES_BY_PATTERN[re.source]) {
          probes.push(sample, `packages/api/${sample}`, `a/b/c/${sample}`);
          filePatternProbes += 3;
        }
      }
    }
    probes.push(...lookalikes);
    expect(probes.length).toBeGreaterThan(60);
    expect(filePatternProbes, "file rules contributed no probes").toBeGreaterThan(40);
    for (const rel of probes) {
      const viaMatcher = matchGuardrailPath(dir, [path.join(dir, rel)]) !== null;
      const viaEarlyExit = toolInputTargetsGuardrail(dir, { file_path: path.join(dir, rel) });
      expect(viaEarlyExit, `early exit disagreed with the matcher on ${rel}`).toBe(viaMatcher);
    }
    // M2 — the `-prod` / `_prod` / `.bak` siblings are generated as things that
    // must NOT match. Asserting only "early exit === matcher" left that claim
    // completely unchecked (both being `true` would have passed).
    for (const rel of lookalikes) {
      expect(matchGuardrailPath(dir, [path.join(dir, rel)]), `lookalike ${rel} must not match`).toBeNull();
    }
    expect(lookalikes.length).toBeGreaterThan(20);
    // The exact six paths round-12 named as silently unguarded.
    for (const rel of [
      "Dockerfile-prod",
      "docker-compose-prod.yml",
      "compose-prod.yml",
      "config/secrets_prod.yml",
      "config/credentials-dev.yml",
      "prod.tfvars.json",
    ]) {
      expect(toolInputTargetsGuardrail(dir, { file_path: path.join(dir, rel) }), `round-12 miss: ${rel}`).toBe(true);
    }
    expect(toolInputTargetsGuardrail(dir, { file_path: path.join(dir, "src/index.ts") })).toBe(false);
    expect(toolInputTargetsGuardrail(dir, {})).toBe(false);
    // Separators are platform-native going in and posix coming out:
    // matchGuardrailPath rewrites path.relative's output (which uses `\` on
    // Windows) before matching, so the rule literals stay posix-only.
    const m = matchGuardrailPath(dir, [path.join(dir, ".github", "workflows", "ci.yml")]);
    expect(m?.category).toBe("workflows");
    expect(m?.path).toBe(".github/workflows/ci.yml");
  });

  it("every rule carries the ask's short note and the 🛡 section's full rationale", () => {
    for (const rule of GUARDRAIL_RULES) {
      expect(rule.note.length, rule.category).toBeGreaterThan(0);
      expect(rule.rationale).toMatch(/escalate/i);
    }
  });
});

// ---------------------------------------------------------------------------
// ceremony-present predicate
// ---------------------------------------------------------------------------

describe("sessionHasLivePreWorkCeremony — the ceremony-present predicate", () => {
  it("counts a LIVE findings/options/spec/plan as ceremony in flight", () => {
    for (const type of ["research", "decision", "spec", "plan"]) {
      for (const status of ["draft", "reviewing", "approved"]) {
        expect(sessionHasLivePreWorkCeremony([art(type, status)]), `${type}/${status}`).toBe(true);
      }
    }
  });

  it("F2 — a DRAFT counts IMMEDIATELY: the backstop catches the SKIP, not the un-reviewed landing", () => {
    // Requiring approval would nag straight through the non-blocking review
    // window the whole protocol is built on.
    expect(sessionHasLivePreWorkCeremony([art("spec", "draft")])).toBe(true);
  });

  it("does NOT count a DEAD ceremony artifact — a rejected spec is the case to ask about", () => {
    for (const status of ["superseded", "retracted", "obsolete", "rejected"]) {
      expect(sessionHasLivePreWorkCeremony([art("spec", status)]), status).toBe(false);
    }
  });

  it("does NOT count code artifacts — the changeset is the FLOOR, not pre-work ceremony", () => {
    expect(sessionHasLivePreWorkCeremony([art("changeset"), art("code_change"), art("debrief")])).toBe(false);
  });

  it("honours the caller's recency guard", () => {
    const isRecent = (a: { createdAt?: string }) => {
      const t = Date.parse(a?.createdAt ?? "");
      return Number.isFinite(t) ? NOW - t <= CEREMONY_MAX_AGE_MS : false;
    };
    expect(sessionHasLivePreWorkCeremony([art("spec", "approved", recent)], isRecent)).toBe(true);
    const ancient = iso(NOW - CEREMONY_MAX_AGE_MS - 60_000);
    expect(sessionHasLivePreWorkCeremony([art("spec", "approved", ancient)], isRecent)).toBe(false);
  });
});

describe("readSessionCeremony — three-way store readout", () => {
  it("reports UNREACHABLE when there is no session store at all", () => {
    expect(readSessionCeremony(dir, NOW)).toEqual({ reachable: false, hasLiveCeremony: false });
  });

  it("reports reachable + no ceremony for an empty session", () => {
    seedSession([]);
    expect(readSessionCeremony(dir, NOW)).toEqual({ reachable: true, hasLiveCeremony: false });
  });

  it("F1 — scope is the PROJECT: a live spec in ANY recent session licenses the edit (and a corrupt sibling doesn't break it)", () => {
    seedSession([], "s1");
    const bad = path.join(dir, ".deeppairing", "sessions", "s2");
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, "artifacts.json"), "{ not json");
    seedSession([art("spec")], "s3");
    expect(readSessionCeremony(dir, NOW)).toEqual({ reachable: true, hasLiveCeremony: true });
  });

  it("Q1 item 3 — a store whose sessions are ALL corrupt reports UNREACHABLE (silent, as SECURITY.md promises)", () => {
    // Pre-Q1 this fell through to reachable:true → the backstop ASKED, while
    // SECURITY.md said an unreadable store stays silent. The doc is the contract.
    const sd = path.join(dir, ".deeppairing", "sessions", "s1");
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, "artifacts.json"), "{ not json");
    const sd2 = path.join(dir, ".deeppairing", "sessions", "s2");
    fs.mkdirSync(sd2, { recursive: true });
    fs.writeFileSync(path.join(sd2, "artifacts.json"), '{"artifacts":[]}'); // present, not an array
    expect(readSessionCeremony(dir, NOW)).toEqual({ reachable: false, hasLiveCeremony: false });
    // …and end to end: the guardrail write passes silently.
    expect(evaluateGuardrailBackstop({ toolInput: edit("migrations/1.sql"), projectRoot: dir, now: NOW, env: ON })).toBeNull();
  });

  it("Q1 item 3 — a corrupt session BESIDE a healthy empty one still ASKS (a real skip is still a skip)", () => {
    seedSession([], "s1");
    const bad = path.join(dir, ".deeppairing", "sessions", "s2");
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, "artifacts.json"), "{ not json");
    expect(readSessionCeremony(dir, NOW)).toEqual({ reachable: true, hasLiveCeremony: false });
    expect(evaluateGuardrailBackstop({ toolInput: edit("migrations/1.sql"), projectRoot: dir, now: NOW, env: ON })?.fire).toBe(true);
  });

  it("Q1 item 2 — a FUTURE-dated ceremony artifact is not eternally live", () => {
    // `now - t <= MAX` with no lower bound made a 2030 spec license every
    // guardrail edit in the project, forever.
    seedSession([art("spec", "approved", iso(NOW + 4 * 365 * 24 * 60 * 60 * 1000))]);
    expect(readSessionCeremony(dir, NOW).hasLiveCeremony).toBe(false);
  });

  it("Q1 item 2 — small clock skew is still tolerated (a slightly-ahead stamp stays live)", () => {
    seedSession([art("spec", "approved", iso(NOW + CLOCK_SKEW_TOLERANCE_MS - 1000))]);
    expect(readSessionCeremony(dir, NOW).hasLiveCeremony).toBe(true);
  });

  it("ages ceremony out after one working arc", () => {
    seedSession([art("spec", "approved", iso(NOW - CEREMONY_MAX_AGE_MS - 1000))]);
    expect(readSessionCeremony(dir, NOW).hasLiveCeremony).toBe(false);
  });

  it("F9 — a missing or unparseable createdAt is NOT eternally recent", () => {
    // Written as literals (not via art()) so the ABSENT key really is absent —
    // passing `undefined` to a defaulted parameter would silently restore it.
    seedSession([{ id: "sp1", type: "spec", status: "approved" } as unknown as Art]);
    expect(readSessionCeremony(dir, NOW).hasLiveCeremony).toBe(false);
    fs.rmSync(path.join(dir, ".deeppairing"), { recursive: true, force: true });
    seedSession([{ id: "sp1", type: "spec", status: "approved", createdAt: "not-a-date" }]);
    expect(readSessionCeremony(dir, NOW).hasLiveCeremony).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// the five pinned cases
// ---------------------------------------------------------------------------

describe("evaluateGuardrailBackstop — the five pinned cases", () => {
  it("(a) guardrail edit with NO ceremony → ASK, in the HUMAN's voice, naming class and path", () => {
    seedSession([]);
    const d = evalAndRecord(".github/workflows/ci.yml");
    expect(d).not.toBeNull();
    expect(d!.fire).toBe(true);
    expect(d!.source).toBe("guardrail");
    expect(d!.guardrail?.category).toBe("workflows");
    // F4 + Q1 item 6 — SINGLE-ADDRESSED. The human's sentence comes first and
    // the string STARTS with it; the machine token and the agent instruction
    // ride the final bracketed line, subordinate but still greppable.
    expect(d!.reason!.startsWith("Allow this edit to .github/workflows/ci.yml?")).toBe(true);
    expect(d!.reason).toContain("It's a guardrail path (workflows — it affects every future deploy)");
    expect(d!.reason).toContain("Decline to have it presented for review first");
    // The clause dogfood praised: what would make this stop.
    expect(d!.reason).toContain("presenting findings, options, a spec, or a plan is what makes this prompt stop");
    // "your pair" read ambiguous when the pair was also reading the string.
    expect(d!.reason).not.toMatch(/your pair/);
    expect(d!.reason).not.toMatch(/\(Agent:/);
    // F1 — project scope, never "this session".
    expect(d!.reason).toContain("is live in this project's recent sessions");
    expect(d!.reason).not.toMatch(/live in this session/);
    // The greppable token survives, on the LAST line, with the agent instruction
    // (Claude Code feeds this reason back to the model on a decline).
    const lines = d!.reason!.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toContain("GUARDRAIL_ESCALATION");
    expect(lines[1]).toBe(
      "[GUARDRAIL_ESCALATION — agent: this is ESCALATED work. On a decline, present findings/options/a spec or plan before landing it.]",
    );
  });

  it("(a2) the round-11 repro — a DROP TABLE migration Write with no ceremony asks", () => {
    seedSession([]);
    const d = evaluateGuardrailBackstop({
      toolInput: { file_path: path.join(dir, "migrations/003_drop.sql"), content: "DROP TABLE users;" },
      projectRoot: dir,
      now: NOW,
      env: ON,
    });
    expect(d?.reason).toContain("Allow this edit to migrations/003_drop.sql?");
    expect(d?.reason).toContain("(migrations — hard to reverse)");
  });

  it("(b) guardrail edit WITH a live spec/options/findings/plan → PASS silently (no nagging the escalated arc)", () => {
    for (const type of ["research", "decision", "spec", "plan"]) {
      fs.rmSync(path.join(dir, ".deeppairing"), { recursive: true, force: true });
      seedSession([art(type)]);
      expect(evalAndRecord("migrations/1.sql"), `a live ${type} should license the guardrail edit`).toBeNull();
    }
  });

  it("(c) non-guardrail edit → PASS, and nothing is written (zero behaviour change for the low-risk class)", () => {
    seedSession([]);
    expect(evalAndRecord("src/index.ts")).toBeNull();
    expect(fs.existsSync(path.join(dir, ".deeppairing", "hooks-state.json"))).toBe(false);
  });

  it("(d) store unreachable → PASS (fail open), and no dedup state is stamped", () => {
    expect(evalAndRecord(".github/workflows/ci.yml")).toBeNull();
    expect(fs.existsSync(path.join(dir, ".deeppairing", "hooks-state.json"))).toBe(false);
  });

  it("fails open on a garbage sessions directory (a file where the dir should be)", () => {
    fs.mkdirSync(path.join(dir, ".deeppairing"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".deeppairing", "sessions"), "not a directory");
    expect(evalAndRecord(".github/workflows/ci.yml")).toBeNull();
  });

  it("F7 — DEEPPAIRING_GUARDRAIL_BACKSTOP=off disables THIS lane only", () => {
    seedSession([]);
    for (const v of ["off", "OFF", "0", "false"]) {
      expect(guardrailBackstopDisabled({ [GUARDRAIL_BACKSTOP_ENV]: v }), v).toBe(true);
      expect(
        evaluateGuardrailBackstop({
          toolInput: edit(".github/workflows/ci.yml"),
          projectRoot: dir,
          now: NOW,
          env: { [GUARDRAIL_BACKSTOP_ENV]: v },
        }),
      ).toBeNull();
    }
    expect(guardrailBackstopDisabled({})).toBe(false);
    expect(guardrailBackstopDisabled({ [GUARDRAIL_BACKSTOP_ENV]: "on" })).toBe(false);
    // …and the rejected-approach lane is unaffected by the opt-out.
    fs.writeFileSync(
      path.join(dir, ".deeppairing", "preferences.json"),
      JSON.stringify({ rejectedApproaches: [{ description: "global config", concept: "global mutable state" }] }),
    );
    const d = evaluatePreflightHook({
      toolName: "Edit",
      toolInput: { file_path: path.join(dir, "src/c.ts"), new_string: "export let cfg = {}; // global mutable state singleton" },
      projectRoot: dir,
      now: NOW,
      env: { [GUARDRAIL_BACKSTOP_ENV]: "off" },
    });
    expect(d.fire).toBe(true);
    expect(d.reason).toMatch(/REJECTED_APPROACH_BLOCKED/);
  });

  it("never emits deny as a DECISION word — the hook surface is always 'ask' (SECURITY.md contract)", () => {
    seedSession([]);
    const d = evalAndRecord(".env");
    expect(d!.source).toBe("guardrail");
    expect(d!.reason).not.toMatch(/permissionDecision/);
  });
});

// ---------------------------------------------------------------------------
// F3 — dedup grain
// ---------------------------------------------------------------------------

describe("dedup (F3) — per class, and per FILE for the irreversible classes", () => {
  it("workflows/infrastructure dedup per CLASS: a second file in the same class goes quiet", () => {
    seedSession([]);
    expect(evalAndRecord(".github/workflows/ci.yml")).not.toBeNull();
    expect(evalAndRecord(".github/workflows/release.yml", NOW + 60_000)).toBeNull();
  });

  it("migrations dedup per FILE: a SECOND migration inside the window RE-ARMS the ask", () => {
    seedSession([]);
    expect(evalAndRecord("migrations/1_add_index.sql")).not.toBeNull();
    // The exact review finding: a confirmed 1_add_index must not license this.
    const second = evalAndRecord("migrations/2_drop_users.sql", NOW + 20 * 60_000);
    expect(second, "a distinct migration must re-arm the ask").not.toBeNull();
    expect(second!.reason).toContain("migrations/2_drop_users.sql");
    // …while the SAME file stays quiet.
    expect(evalAndRecord("migrations/1_add_index.sql", NOW + 21 * 60_000)).toBeNull();
  });

  it("secrets dedup per FILE too", () => {
    seedSession([]);
    expect(evalAndRecord(".env")).not.toBeNull();
    expect(evalAndRecord(".env.production", NOW + 60_000)).not.toBeNull();
    expect(evalAndRecord(".env", NOW + 61_000)).toBeNull();
    expect(PER_PATH_DEDUP_CLASSES.has("secrets")).toBe(true);
    expect(PER_PATH_DEDUP_CLASSES.has("workflows")).toBe(false);
  });

  it("a DIFFERENT guardrail class always asks", () => {
    seedSession([]);
    expect(evalAndRecord(".github/workflows/ci.yml")).not.toBeNull();
    expect(evalAndRecord("migrations/1.sql", NOW + 1000)?.reason).toContain("migrations/1.sql");
  });

  it("re-opens after the window", () => {
    seedSession([]);
    evalAndRecord(".github/workflows/ci.yml");
    expect(guardrailAskSuppressed(dir, "workflows", ".github/workflows/ci.yml", NOW + GUARDRAIL_ASK_TTL_MS - 1)).toBe(true);
    expect(guardrailAskSuppressed(dir, "workflows", ".github/workflows/ci.yml", NOW + GUARDRAIL_ASK_TTL_MS + 1)).toBe(false);
    expect(evalAndRecord(".github/workflows/ci.yml", NOW + GUARDRAIL_ASK_TTL_MS + 1)).not.toBeNull();
  });

  it("F11 — ONE write: the fire log and the dedup stamp land together, preserving prior state", () => {
    const sp = path.join(dir, ".deeppairing", "hooks-state.json");
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, JSON.stringify({ version: 1, fires: [{ hook: "stop", reason: "pass" }], keepMe: 1 }));
    seedSession([]);
    evalAndRecord("migrations/1.sql");
    const state = JSON.parse(fs.readFileSync(sp, "utf-8"));
    expect(state.keepMe).toBe(1);
    expect(state.fires).toHaveLength(2);
    // F12 — the fire names the CLASS, for HookStatus legibility.
    expect(state.fires.at(-1).reason).toBe("guardrail:migrations");
    expect(state.guardrailAsks.migrations["migrations/1.sql"]).toBe(new Date(NOW).toISOString());
  });

  it("per-path entries older than the window are pruned on write (the map can't grow unbounded)", () => {
    seedSession([]);
    evalAndRecord("migrations/1.sql");
    evalAndRecord("migrations/2.sql", NOW + GUARDRAIL_ASK_TTL_MS + 5000);
    const state = JSON.parse(fs.readFileSync(path.join(dir, ".deeppairing", "hooks-state.json"), "utf-8"));
    expect(Object.keys(state.guardrailAsks.migrations)).toEqual(["migrations/2.sql"]);
  });

  it("an unreadable dedup file is NOT treated as suppression (conservative side)", () => {
    const sp = path.join(dir, ".deeppairing", "hooks-state.json");
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, "{ not json");
    expect(guardrailAskSuppressed(dir, "workflows", "x", NOW)).toBe(false);
  });

  it("Q1 item 2 — a FUTURE-dated dedup stamp does NOT suppress (it would suppress forever)", () => {
    const sp = path.join(dir, ".deeppairing", "hooks-state.json");
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(
      sp,
      JSON.stringify({
        version: 1,
        guardrailAsks: {
          workflows: iso(NOW + 4 * 365 * 24 * 60 * 60 * 1000),
          migrations: { "migrations/1.sql": iso(NOW + 4 * 365 * 24 * 60 * 60 * 1000) },
        },
      }),
    );
    expect(guardrailAskSuppressed(dir, "workflows", "x", NOW)).toBe(false);
    expect(guardrailAskSuppressed(dir, "migrations", "migrations/1.sql", NOW)).toBe(false);
    // …and small skew still suppresses.
    fs.writeFileSync(sp, JSON.stringify({ version: 1, guardrailAsks: { workflows: iso(NOW + 1000) } }));
    expect(guardrailAskSuppressed(dir, "workflows", "x", NOW)).toBe(true);
  });

  it("Q1 item 2 — a FUTURE-dated per-path stamp is PRUNED on the next write (it never expired)", () => {
    const sp = path.join(dir, ".deeppairing", "hooks-state.json");
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(
      sp,
      JSON.stringify({
        version: 1,
        guardrailAsks: { migrations: { "migrations/ancient.sql": iso(NOW + 4 * 365 * 24 * 60 * 60 * 1000) } },
      }),
    );
    seedSession([]);
    evalAndRecord("migrations/1.sql");
    const state = JSON.parse(fs.readFileSync(sp, "utf-8"));
    expect(Object.keys(state.guardrailAsks.migrations)).toEqual(["migrations/1.sql"]);
  });
});

// ---------------------------------------------------------------------------
// Q1 item 4 + item 5 — hooks-state durability and the fire's KIND
// ---------------------------------------------------------------------------

describe("hooks-state.json — durable, and honest about what happened", () => {
  const statePath = () => path.join(dir, ".deeppairing", "hooks-state.json");

  it("item 5 — a preflight fire records kind:\"ask\" (the UI rendered every ask as a green pass)", () => {
    seedSession([]);
    evalAndRecord("migrations/1.sql");
    const fire = JSON.parse(fs.readFileSync(statePath(), "utf-8")).fires.at(-1);
    expect(fire.kind).toBe("ask");
    expect(fire.hook).toBe("preflight");
    expect(fire.reason).toBe("guardrail:migrations");
  });

  it("item 5 — the rejected-approach lane records kind too", () => {
    seedSession([]);
    recordHookFire(dir, { fire: true, reason: "x", source: "session" }, NOW);
    const fire = JSON.parse(fs.readFileSync(statePath(), "utf-8")).fires.at(-1);
    expect(fire.kind).toBe("ask");
    expect(fire.reason).toBe("session");
  });

  it("item 4 — a CORRUPT state file is backed up before the reset (never a silent history drop)", () => {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), '{"version":1,"fires":[{"hook":"stop"}] TRUNCATED');
    seedSession([]);
    evalAndRecord("migrations/1.sql");
    const backups = fs
      .readdirSync(path.join(dir, ".deeppairing"))
      .filter((f) => f.startsWith("hooks-state.json.corrupt-"));
    expect(backups, "no salvage copy was written").toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, ".deeppairing", backups[0]), "utf-8")).toContain("TRUNCATED");
    // …and the hook still worked.
    expect(JSON.parse(fs.readFileSync(statePath(), "utf-8")).fires).toHaveLength(1);
  });

  it("item 4 — readHookState: absent → fresh, valid → parsed, array → reset (a JSON array is not a state object)", () => {
    expect(readHookState(statePath())).toEqual({ version: 1 });
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify({ version: 1, keepMe: 7 }));
    expect(readHookState(statePath()).keepMe).toBe(7);
    fs.writeFileSync(statePath(), "[]");
    expect(readHookState(statePath())).toEqual({ version: 1 });
  });

  it("item 4 — the write is tmp+rename: a reader never sees a torn file, and no tmp is left behind", () => {
    seedSession([]);
    for (let i = 0; i < 20; i++) evalAndRecord(`migrations/${i}.sql`, NOW + i);
    const dpDir = path.join(dir, ".deeppairing");
    expect(fs.readdirSync(dpDir).filter((f) => f.includes(".tmp."))).toEqual([]);
    expect(() => JSON.parse(fs.readFileSync(statePath(), "utf-8"))).not.toThrow();
    expect(JSON.parse(fs.readFileSync(statePath(), "utf-8")).fires).toHaveLength(20);
  });
});

// ---------------------------------------------------------------------------
// composition
// ---------------------------------------------------------------------------

describe("evaluatePreflightHook — composition with the rejected-approach gate", () => {
  it("(e) POSITIVE CONTROL: the rejected-approach ask is unchanged and still wins", () => {
    seedSession([]);
    fs.writeFileSync(
      path.join(dir, ".deeppairing", "preferences.json"),
      JSON.stringify({ rejectedApproaches: [{ description: "global config", concept: "global mutable state" }] }),
    );
    const d = evaluatePreflightHook({
      toolName: "Write",
      toolInput: { file_path: path.join(dir, "migrations/1.sql"), content: "-- global mutable state singleton" },
      projectRoot: dir,
      now: NOW,
      env: ON,
    });
    expect(d.fire).toBe(true);
    expect(d.reason).toMatch(/REJECTED_APPROACH_BLOCKED/);
    expect(d.reason).not.toMatch(/GUARDRAIL_ESCALATION/);
    expect(d.source).toBe("session");
    expect(d.guardrail).toBeUndefined();
  });

  it("falls through to the guardrail backstop when the ledger has nothing to say", () => {
    seedSession([]);
    const d = evaluatePreflightHook({
      toolName: "Edit",
      toolInput: edit(".github/workflows/ci.yml"),
      projectRoot: dir,
      now: NOW,
      env: ON,
    });
    expect(d.fire).toBe(true);
    expect(d.source).toBe("guardrail");
  });

  it("still returns {fire:false} for an ordinary edit with an empty store", () => {
    seedSession([]);
    const d = evaluatePreflightHook({ toolName: "Edit", toolInput: edit("src/a.ts"), projectRoot: dir, now: NOW, env: ON });
    expect(d).toEqual({ fire: false });
  });
});
