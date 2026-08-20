/**
 * P1 (round-11) / Q1 (round-12) — PARITY INSURANCE for the guardrail backstop.
 *
 *  1. THE SENSED SET. The guidance tells the agent the backstop covers "the
 *     guardrail paths" — the ones the 🛡 first-call-hint section lists, which
 *     come from senseProjectGuardrails (store/project-signals.ts).
 *
 *     Q1 changed the shape of this guarantee. Pre-Q1 the hook carried a
 *     hand-maintained MIRROR of the sensor's table (plus a third hand-written
 *     "loose superset" regex), and this file was the insurance against drift.
 *     Now there is ONE table — src/guardrail-rules.ts — that both import, so
 *     class-for-class agreement is true BY CONSTRUCTION and the interesting
 *     question is the remaining, deliberate DIVERGENCE: the matcher classifies
 *     a path handed to it (so it covers the first file in a guardrail location,
 *     and nested/monorepo locations), while the sensor enumerates what exists at
 *     the project ROOT. This asserts that divergence runs in the SAFE direction
 *     only — everything the 🛡 section renders is something the hook asks about,
 *     and the hook never matches outside the shared table.
 *
 *  2. THE TWO HOOK COPIES. Same shape as stop-hook-debrief-parity.test.ts: the
 *     committed plugin bundle (claude-plugin/server/preflight.mjs, what
 *     marketplace users execute) and the init-generated .deeppairing/hooks/
 *     preflight.mjs are hand-maintained twins. This runs BOTH over one case
 *     matrix and asserts they agree with each other AND with the expected
 *     outcome — including the ask-never-deny contract from SECURITY.md.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GUARDRAIL_RULES, matchGuardrailPath, toolInputTargetsGuardrail } from "../preflight-hook-core.js";
import { senseProjectGuardrails } from "../../store/project-signals.js";
import { ensurePreflightHook } from "../setup-tasks.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// __tests__ → cli → src → mcp-server → packages → repo root
const repoRoot = path.resolve(here, "../../../../..");
const committedBundle = path.join(repoRoot, "claude-plugin", "server", "preflight.mjs");
const bundleBuilt = fs.existsSync(committedBundle);
const distCore = path.resolve(here, "../../../dist/cli/preflight-hook-core.js");
const initCoreBuilt = fs.existsSync(distCore);

// ---------------------------------------------------------------------------
// 1. the sensed set — ONE fixture matrix, both implementations
// ---------------------------------------------------------------------------

/**
 * F6 — every filename the review found unguarded, plus the originals. `null`
 * means "must be classified as NOT a guardrail" by both implementations.
 * `dir: true` materializes a directory containing the file.
 */
const SWEEP: Array<{ rel: string; category: string | null }> = [
  // workflows
  { rel: ".github/workflows/ci.yml", category: "workflows" },
  { rel: ".circleci/config.yml", category: "workflows" },
  { rel: ".gitlab-ci.yml", category: "workflows" },
  { rel: "Jenkinsfile", category: "workflows" },
  // migrations
  { rel: "migrations/001_init.sql", category: "migrations" },
  { rel: "db/migrate/001.rb", category: "migrations" },
  { rel: "prisma/migrations/20260101_init/migration.sql", category: "migrations" },
  { rel: "supabase/migrations/x.sql", category: "migrations" },
  { rel: "alembic/versions/ab12_add_col.py", category: "migrations" },
  // infrastructure
  { rel: "Dockerfile", category: "infrastructure" },
  { rel: "Dockerfile.prod", category: "infrastructure" },
  { rel: "docker-compose.yml", category: "infrastructure" },
  { rel: "docker-compose.prod.yml", category: "infrastructure" },
  { rel: "compose.yaml", category: "infrastructure" },
  { rel: "terraform.tfvars", category: "infrastructure" },
  { rel: "terraform/main.tf", category: "infrastructure" },
  { rel: "k8s/deploy.yaml", category: "infrastructure" },
  { rel: "kubernetes/svc.yaml", category: "infrastructure" },
  { rel: "helm/values.yaml", category: "infrastructure" },
  { rel: "infrastructure/vpc.ts", category: "infrastructure" },
  // secrets
  { rel: ".env", category: "secrets" },
  { rel: ".env.local", category: "secrets" },
  { rel: ".env.production", category: "secrets" },
  { rel: ".env.staging", category: "secrets" },
  { rel: ".env.development", category: "secrets" },
  { rel: ".env.test", category: "secrets" },
  { rel: ".env.production.local", category: "secrets" },
  { rel: "config/secrets.yml", category: "secrets" },
  { rel: "config/credentials.yml.enc", category: "secrets" },
  { rel: "config/master.key", category: "secrets" },
  // NOT guardrails — checked-in templates and lookalikes (files NAMED like
  // guardrail dirs, which item 7's any-depth matching must keep silent).
  { rel: ".env.example", category: null },
  { rel: ".env.sample", category: null },
  { rel: "src/index.ts", category: null },
  { rel: "src/migrations.js", category: null },
  { rel: "docs/migrations.md", category: null },
  { rel: "src/k8s-helpers.ts", category: null },
  { rel: "compose.ts", category: null },
];

/**
 * Q1 item 7 — paths the HOOK guards and the SENSOR does not: nested (monorepo)
 * guardrail locations. The sensor stays root-relative on purpose (it enumerates
 * with no edit in hand); the hook classifies the path it was handed. Listed
 * separately so the "same classification" assertion above stays exact and this
 * divergence is stated rather than smuggled.
 */
const NESTED_ONLY: Array<{ rel: string; category: string }> = [
  { rel: "packages/api/migrations/002_drop_users.sql", category: "migrations" },
  { rel: "services/billing/db/migrate/003.rb", category: "migrations" },
  { rel: "packages/api/Dockerfile.prod", category: "infrastructure" },
  { rel: "ops/terraform/main.tf", category: "infrastructure" },
  { rel: "apps/web/.env.production", category: "secrets" },
  { rel: "packages/api/.github/workflows/publish.yml", category: "workflows" },
];

describe("GUARDRAIL_RULES mirrors senseProjectGuardrails (the 🛡 set the hint renders)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-gr-parity-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** Materialize every sweep path as a real file (creating parent dirs). */
  function materializeAll(): void {
    for (const { rel } of SWEEP) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, "");
    }
  }

  /** What senseProjectGuardrails thinks each swept path is. A directory-rule
   *  hit is reported as the DIR, so map a file back through its ancestors. */
  function sensedCategoryOf(rel: string, sensed: ReturnType<typeof senseProjectGuardrails>): string | null {
    for (const g of sensed) {
      for (const p of g.paths) {
        if (rel === p || rel.startsWith(p + "/")) return g.category;
      }
    }
    return null;
  }

  it("classifies every swept filename identically to the hook's mirror (F6, both directions)", () => {
    materializeAll();
    const sensed = senseProjectGuardrails(dir);
    for (const { rel, category } of SWEEP) {
      expect(sensedCategoryOf(rel, sensed), `sensor disagreed on ${rel}`).toBe(category);
      expect(matchGuardrailPath(dir, [path.join(dir, rel)])?.category ?? null, `hook disagreed on ${rel}`).toBe(category);
    }
  });

  it("the 🛡 section stays honest: every path the sensor RENDERS is one the hook would ask about", () => {
    materializeAll();
    for (const g of senseProjectGuardrails(dir)) {
      for (const p of g.paths) {
        // Directory rules render the dir; probe a file inside it.
        const isDir = fs.statSync(path.join(dir, p)).isDirectory();
        const probe = isDir ? `${p}/whatever.txt` : p;
        expect(matchGuardrailPath(dir, [path.join(dir, probe)])?.category, `${probe} rendered but unguarded`).toBe(g.category);
        // Q1 — and the hook entries' EARLY EXIT agrees, because it is the same
        // function. The deleted prefilter is exactly what used to be able to
        // disagree here (and did, on six real paths).
        expect(
          toolInputTargetsGuardrail(dir, { file_path: path.join(dir, probe) }),
          `early exit would have skipped ${probe}`,
        ).toBe(true);
      }
    }
  });

  it("Q1 — the sensor and the hook read the SAME table object (one source, not two in sync)", () => {
    // Not a value comparison: project-signals imports GUARDRAIL_RULES, so a rule
    // added to the table reaches both surfaces without a second edit. This pins
    // the property the old byte-identical copy could only approximate.
    materializeAll();
    const sensedCategories = senseProjectGuardrails(dir).map((g) => g.category);
    expect(sensedCategories).toEqual(GUARDRAIL_RULES.map((r) => r.category));
    for (const rule of GUARDRAIL_RULES) {
      expect(rule.note.length, rule.category).toBeGreaterThan(0);
      expect(rule.rationale).toMatch(/escalate/i);
      // Machine-readable, which is what let the prefilter be deleted rather
      // than hand-written: no opaque predicate functions in the table.
      for (const re of rule.filePatterns) expect(re.source.startsWith("(^|\\/)"), re.source).toBe(true);
    }
  });

  it("Q1 item 7 — DOCUMENTED divergence: the hook covers NESTED guardrail locations, the root-scanning sensor does not", () => {
    for (const { rel, category } of NESTED_ONLY) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, "");
      expect(matchGuardrailPath(dir, [abs])?.category, `hook missed nested ${rel}`).toBe(category);
    }
    // The sensor sees none of them — it scans the root (plus config/) only.
    expect(senseProjectGuardrails(dir)).toEqual([]);
  });

  it("DOCUMENTED divergence: the hook also covers creating the FIRST file in a guardrail location", () => {
    // Nothing materialized — senseProjectGuardrails sees no guardrails at all…
    expect(senseProjectGuardrails(dir)).toEqual([]);
    // …but a Write that CREATES the project's first migration is guardrail work
    // by definition, and the edited path is its own evidence.
    expect(matchGuardrailPath(dir, [path.join(dir, "migrations/001_init.sql")])?.category).toBe("migrations");
    expect(matchGuardrailPath(dir, [path.join(dir, ".github/workflows/ci.yml")])?.category).toBe("workflows");
    // That is the ONLY direction of divergence: the hook never matches a path
    // outside the mirrored rule set.
    expect(matchGuardrailPath(dir, [path.join(dir, "src/app.ts")])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. the two hook copies
// ---------------------------------------------------------------------------

const NOW = Date.now();
const recent = new Date(NOW - 60 * 1000).toISOString();
type Art = { id: string; type: string; status: string; createdAt: string };
const art = (id: string, type: string, status = "approved", createdAt = recent): Art => ({ id, type, status, createdAt });

interface Case {
  name: string;
  /** artifacts.json content, null to leave the session store ABSENT, or
   *  "corrupt" to write an unparseable one (Q1 item 3). */
  artifacts: Art[] | null | "corrupt";
  toolName: string;
  /** project-relative target path. */
  file: string;
  /** null = pass silently; a string = the ask reason must contain it. */
  expectAsk: string | null;
  /** seed a rejected-approach ledger + matching content (positive control). */
  rejected?: { concept: string; content: string };
}

const MATRIX: Case[] = [
  {
    name: "(a) guardrail Edit, no ceremony → ask",
    artifacts: [],
    toolName: "Edit",
    file: ".github/workflows/ci.yml",
    expectAsk: "Allow this edit to .github/workflows/ci.yml?",
  },
  {
    name: "(a2) round-11 repro: DROP TABLE migration Write, no ceremony → ask",
    artifacts: [],
    toolName: "Write",
    file: "migrations/003_drop.sql",
    expectAsk: "It's a guardrail path (migrations — hard to reverse)",
  },
  {
    name: "(a3) F6 sweep on the wire: .env.staging asks",
    artifacts: [],
    toolName: "Write",
    file: ".env.staging",
    expectAsk: "Allow this edit to .env.staging?",
  },
  {
    name: "(a4) F6 sweep on the wire: Dockerfile.prod asks",
    artifacts: [],
    toolName: "Edit",
    file: "Dockerfile.prod",
    expectAsk: "(infrastructure — it affects production surfaces)",
  },
  {
    name: "(a5) F1 wording on the wire: the ask says project's recent sessions",
    artifacts: [],
    toolName: "Edit",
    file: "Jenkinsfile",
    expectAsk: "is live in this project's recent sessions",
  },
  { name: "(b) guardrail Edit + live spec → pass", artifacts: [art("sp1", "spec")], toolName: "Edit", file: "migrations/1.sql", expectAsk: null },
  { name: "(b2) guardrail Edit + live findings → pass", artifacts: [art("r1", "research", "draft")], toolName: "Edit", file: ".env", expectAsk: null },
  { name: "(b3) guardrail Edit + live options → pass", artifacts: [art("d1", "decision")], toolName: "Edit", file: "Dockerfile", expectAsk: null },
  { name: "(b4) F2: a DRAFT spec counts immediately → pass", artifacts: [art("sp1", "spec", "draft")], toolName: "Edit", file: "terraform/main.tf", expectAsk: null },
  { name: "(b5) guardrail Edit + REJECTED spec → ask (the ceremony isn't standing)", artifacts: [art("sp1", "spec", "rejected")], toolName: "Edit", file: "terraform/main.tf", expectAsk: "Allow this edit to terraform/main.tf?" },
  { name: "(c) non-guardrail Edit → pass (zero behaviour change)", artifacts: [], toolName: "Edit", file: "src/index.ts", expectAsk: null },
  {
    // Q1 item 7 — this case FLIPPED. deepPairing is a monorepo and so is the
    // audience; a root-relative-only matcher was blind to the layout its own
    // repo uses. Both copies must agree on the new answer.
    name: "(c2) nested migrations/ in a monorepo → ASK (Q1 item 7)",
    artifacts: [],
    toolName: "Edit",
    file: "packages/db/migrations/1.sql",
    expectAsk: "Allow this edit to packages/db/migrations/1.sql?",
  },
  {
    name: "(c4) near-miss: a file NAMED like a guardrail dir stays silent",
    artifacts: [],
    toolName: "Edit",
    file: "src/migrations.js",
    expectAsk: null,
  },
  {
    // The exact class round-12 found silently unguarded in ledger-free projects:
    // the deleted prefilter rejected `-` continuations, so this never reached
    // the matcher at all.
    name: "(a6) Q1 item 1 — Dockerfile-prod (prefilter miss) now asks on both copies",
    artifacts: [],
    toolName: "Write",
    file: "Dockerfile-prod",
    expectAsk: "(infrastructure — it affects production surfaces)",
  },
  {
    name: "(a7) Q1 item 1 — prod.tfvars.json (prefilter miss) now asks on both copies",
    artifacts: [],
    toolName: "Write",
    file: "prod.tfvars.json",
    expectAsk: "Allow this edit to prod.tfvars.json?",
  },
  {
    name: "(a8) Q1 item 1 — config/secrets_prod.yml (prefilter miss) now asks on both copies",
    artifacts: [],
    toolName: "Write",
    file: "config/secrets_prod.yml",
    expectAsk: "(secrets — secrets must never leak into a commit)",
  },
  {
    // Q1 item 3 — the doc said an unreadable store stays silent; the code asked.
    name: "(d2) Q1 item 3 — an ALL-CORRUPT session store → pass (silent, per SECURITY.md)",
    artifacts: "corrupt",
    toolName: "Edit",
    file: "migrations/1.sql",
    expectAsk: null,
  },
  { name: "(c3) .env.example is a template, not a secret → pass", artifacts: [], toolName: "Write", file: ".env.example", expectAsk: null },
  { name: "(d) no session store at all → pass (FAIL OPEN)", artifacts: null, toolName: "Edit", file: ".github/workflows/ci.yml", expectAsk: null },
  {
    name: "(e) positive control: rejected-approach ask still fires, unchanged",
    artifacts: [],
    toolName: "Edit",
    file: "src/c.ts",
    expectAsk: "REJECTED_APPROACH_BLOCKED",
    rejected: { concept: "global mutable state", content: "export let cfg = {}; // global mutable state singleton" },
  },
];

/** Run one hook script over one case; returns the parsed hookSpecificOutput or null. */
function runCase(script: string, c: Case): { decision: string | null; reason: string | null } {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-gr-hook-"));
  try {
    if (c.artifacts !== null) {
      const sd = path.join(projectDir, ".deeppairing", "sessions", "s1");
      fs.mkdirSync(sd, { recursive: true });
      fs.writeFileSync(
        path.join(sd, "artifacts.json"),
        c.artifacts === "corrupt" ? "{ not json" : JSON.stringify(c.artifacts),
      );
    }
    if (c.rejected) {
      fs.mkdirSync(path.join(projectDir, ".deeppairing"), { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, ".deeppairing", "preferences.json"),
        JSON.stringify({ rejectedApproaches: [{ description: "global config", concept: c.rejected.concept }] }),
      );
    }
    const file = path.join(projectDir, c.file);
    const toolInput =
      c.toolName === "Write"
        ? { file_path: file, content: c.rejected?.content ?? "DROP TABLE users;" }
        : { file_path: file, new_string: c.rejected?.content ?? "some change" };
    const out = execFileSync("node", [script], {
      input: JSON.stringify({ tool_name: c.toolName, tool_input: toolInput }),
      encoding: "utf-8",
      // The backstop honours DEEPPAIRING_GUARDRAIL_BACKSTOP=off (F7); make sure
      // a developer's own opt-out can't silently pass this suite.
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, DEEPPAIRING_GUARDRAIL_BACKSTOP: "" },
    }).trim();
    if (!out) return { decision: null, reason: null };
    const parsed = JSON.parse(out).hookSpecificOutput;
    return { decision: parsed.permissionDecision, reason: parsed.permissionDecisionReason };
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

describe("the two hand-maintained hook copies agree on the guardrail matrix", () => {
  let initScript: string | null = null;
  let initProject: string;

  beforeEach(() => {
    initProject = fs.mkdtempSync(path.join(os.tmpdir(), "dp-gr-init-"));
    if (!initCoreBuilt) return;
    const res = ensurePreflightHook(initProject);
    const p = path.join(initProject, ".deeppairing", "hooks", "preflight.mjs");
    initScript = res.ok && fs.existsSync(p) ? p : null;
  });
  afterEach(() => fs.rmSync(initProject, { recursive: true, force: true }));

  for (const c of MATRIX) {
    it.skipIf(!bundleBuilt)(`${c.name} — plugin bundle`, () => {
      const r = runCase(committedBundle, c);
      if (c.expectAsk === null) {
        expect(r.decision, `expected silence, got: ${r.reason}`).toBeNull();
      } else {
        // SECURITY.md: ask-never-deny. Every fire is "ask".
        expect(r.decision).toBe("ask");
        expect(r.reason).toContain(c.expectAsk);
      }
    });

    it.skipIf(!bundleBuilt || !initCoreBuilt)(`${c.name} — init-generated script agrees`, () => {
      expect(initScript, "ensurePreflightHook did not write a script").not.toBeNull();
      const bundleResult = runCase(committedBundle, c);
      const initResult = runCase(initScript!, c);
      expect(initResult.decision).toBe(bundleResult.decision);
      expect(initResult.reason).toBe(bundleResult.reason);
      if (c.expectAsk !== null) expect(initResult.reason).toContain(c.expectAsk);
    });
  }

  it.skipIf(!initCoreBuilt)("Q1 — the init-generated script carries NO copy of the rule set: it imports the one table", () => {
    expect(initScript).not.toBeNull();
    const src = fs.readFileSync(initScript!, "utf-8");
    // The early exit calls the authoritative matcher out of the leaf module…
    expect(src).toContain("rules.matchGuardrailPath");
    expect(src).toContain("RULES_URL");
    expect(src).toMatch(/guardrail-rules\.js/);
    // …and carries no second definition of the path set to drift.
    expect(src).not.toMatch(/GUARDRAIL_PATH_PREFILTER/);
    expect(src).not.toMatch(/looksLikeGuardrailPath/);
    expect(src, "an inlined rule literal reappeared").not.toContain("alembic/versions");
    // F11 — it must NOT carry its own fire-log writer any more.
    expect(src).toContain("mod.recordHookFire");
    expect(src).not.toMatch(/function recordFire/);
  });

  it.skipIf(!initCoreBuilt)("Q1 — the stamped RULES_URL actually RESOLVES (an unresolvable one would silently skip the backstop)", () => {
    // The E1-review failure mode, one level down: setup-tasks resolves the rule
    // module ON DISK beside the entry, so a layout it doesn't know about stamps
    // a nonexistent URL. The generated hook fails SAFE on an import error
    // (it keeps going), but the stamp must still be right in the layouts we own.
    const src = fs.readFileSync(initScript!, "utf-8");
    const stamped = /const RULES_URL = "([^"]+)"/.exec(src)?.[1];
    expect(stamped, "no RULES_URL stamped").toBeTruthy();
    expect(fs.existsSync(fileURLToPath(stamped!)), `stamped RULES_URL does not exist: ${stamped}`).toBe(true);
  });

  it.skipIf(!bundleBuilt)("Q1 — the plugin bundle ships the rule module beside the matcher core", () => {
    // Marketplace installs run setup-tasks out of the bundled daemon, so both
    // stamped URLs resolve to files in claude-plugin/server/.
    expect(fs.existsSync(path.join(repoRoot, "claude-plugin", "server", "guardrail-rules.js"))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, "claude-plugin", "server", "preflight-hook-core.js"))).toBe(true);
  });

  it.skipIf(!bundleBuilt)("NEITHER copy can ever emit permissionDecision 'deny' (SECURITY.md ask-never-deny)", () => {
    const bundleSrc = fs.readFileSync(committedBundle, "utf-8");
    expect(bundleSrc).not.toMatch(/permissionDecision["']?\s*:\s*["']deny["']/);
    expect(bundleSrc).toMatch(/permissionDecision["']?\s*:\s*["']ask["']/);
  });

  it.skipIf(!bundleBuilt)("F3 dedup on the wire: class-level for workflows, per-FILE for migrations", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-gr-dedup-"));
    try {
      const sd = path.join(projectDir, ".deeppairing", "sessions", "s1");
      fs.mkdirSync(sd, { recursive: true });
      fs.writeFileSync(path.join(sd, "artifacts.json"), "[]");
      const fire = (rel: string) =>
        execFileSync("node", [committedBundle], {
          input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: path.join(projectDir, rel), new_string: "x" } }),
          encoding: "utf-8",
          env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, DEEPPAIRING_GUARDRAIL_BACKSTOP: "" },
        }).trim();
      // workflows: arc-level message → the second file in the class is quiet.
      expect(fire(".github/workflows/ci.yml")).toContain("GUARDRAIL_ESCALATION");
      expect(fire(".github/workflows/release.yml")).toBe("");
      // migrations: each file is separately irreversible → a DISTINCT migration
      // re-arms, the SAME one stays quiet.
      expect(fire("migrations/1_add_index.sql")).toContain("migrations/1_add_index.sql");
      expect(fire("migrations/2_drop_users.sql")).toContain("migrations/2_drop_users.sql");
      expect(fire("migrations/1_add_index.sql")).toBe("");
      // The dedup record rides in the file the UI already reads, beside `fires`.
      const state = JSON.parse(fs.readFileSync(path.join(projectDir, ".deeppairing", "hooks-state.json"), "utf-8"));
      expect(typeof state.guardrailAsks.workflows).toBe("string"); // class-level
      expect(Object.keys(state.guardrailAsks.migrations).sort()).toEqual([
        "migrations/1_add_index.sql",
        "migrations/2_drop_users.sql",
      ]); // per-path
      // F12 — the fire log names the class.
      expect(state.fires.at(-1).reason).toBe("guardrail:migrations");
      // Q1 item 5 — and says it was an ASK, so the companion UI stops rendering
      // every guardrail block as a green "pass".
      expect(state.fires.at(-1).kind).toBe("ask");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  /**
   * M1 (round-12 adversarial review) — CONCURRENCY, measured with real
   * processes.
   *
   * The first cut of this pin was a sequential for-loop inside one process,
   * which would have passed with the atomic write reverted — it proved nothing.
   * Claude Code fires PreToolUse per tool call and an agent can have several in
   * flight; tmp+rename stops a torn READ but not a lost UPDATE, and a lost
   * update here is a lost DEDUP STAMP, i.e. the same migration asks again inside
   * its 30-minute window. Measured pre-fix: 8 invocations → 8 asks, 4 records.
   *
   * So: spawn N real hook processes at once, against N distinct migration files
   * (per-FILE dedup, so every one legitimately asks), and require every ask to
   * leave both a fire record and a stamp behind.
   */
  it.skipIf(!bundleBuilt)("M1 — 8 PARALLEL hook processes leave 8 fires, 8 dedup stamps, and a parseable file", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-gr-par-"));
    try {
      const sd = path.join(projectDir, ".deeppairing", "sessions", "s1");
      fs.mkdirSync(sd, { recursive: true });
      fs.writeFileSync(path.join(sd, "artifacts.json"), "[]");
      const N = 8;
      const rels = Array.from({ length: N }, (_, i) => `migrations/${i}_change.sql`);
      const runs = rels.map(
        (rel) =>
          new Promise<string>((resolve, reject) => {
            const child = spawn("node", [committedBundle], {
              env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, DEEPPAIRING_GUARDRAIL_BACKSTOP: "" },
              stdio: ["pipe", "pipe", "inherit"],
            });
            let out = "";
            child.stdout.on("data", (d) => (out += d));
            child.on("error", reject);
            child.on("close", () => resolve(out.trim()));
            child.stdin.end(
              JSON.stringify({
                tool_name: "Edit",
                tool_input: { file_path: path.join(projectDir, rel), new_string: "x" },
              }),
            );
          }),
      );
      const outs = await Promise.all(runs);

      // Every one of the N is a distinct irreversible file → all N must ask.
      const asked = outs.filter((o) => o.includes("GUARDRAIL_ESCALATION"));
      expect(asked, `only ${asked.length}/${N} asked`).toHaveLength(N);

      const sp = path.join(projectDir, ".deeppairing", "hooks-state.json");
      const state = JSON.parse(fs.readFileSync(sp, "utf-8")); // parseable = not torn
      // …and every ask left a record. This is the assertion that fails without
      // the lock (atomic rename alone drops roughly half).
      expect(state.fires, "fire records were lost to a concurrent write").toHaveLength(N);
      expect(Object.keys(state.guardrailAsks.migrations).sort(), "dedup stamps were lost").toEqual([...rels].sort());
      // No lock or temp file survives a clean run.
      expect(fs.readdirSync(path.join(projectDir, ".deeppairing")).filter((f) => f.includes(".lock") || f.includes(".tmp."))).toEqual([]);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  }, 30_000);

  it.skipIf(!bundleBuilt)("H1 — the shipped hook is SILENT on vendored / fixture trees (the spurious-ask frontier)", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-gr-excl-"));
    try {
      const sd = path.join(projectDir, ".deeppairing", "sessions", "s1");
      fs.mkdirSync(sd, { recursive: true });
      fs.writeFileSync(path.join(sd, "artifacts.json"), "[]");
      const run = (rel: string) =>
        execFileSync("node", [committedBundle], {
          input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: path.join(projectDir, rel), content: "x" } }),
          encoding: "utf-8",
          env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, DEEPPAIRING_GUARDRAIL_BACKSTOP: "" },
        }).trim();
      // The exact two the review executed, plus the shapes a real
      // "add a migration-runner package with tests" session produces.
      for (const rel of [
        "node_modules/somepkg/migrations/x.js",
        "test/fixtures/migrations/seed.sql",
        "packages/runner/__fixtures__/migrations/001.sql",
        "packages/runner/testdata/migrations/002.sql",
        "dist/migrations/bundle.js",
        "examples/basic/docker-compose.yml",
        "coverage/lcov-report/.env",
      ]) {
        expect(run(rel), `SPURIOUS ask on ${rel}`).toBe("");
      }
      // …while the package's own real migration still asks.
      expect(run("packages/runner/migrations/001_init.sql")).toContain("GUARDRAIL_ESCALATION");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!bundleBuilt)("F7 opt-out works on the wire (and leaves the rejected-approach lane alone)", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-gr-optout-"));
    try {
      const sd = path.join(projectDir, ".deeppairing", "sessions", "s1");
      fs.mkdirSync(sd, { recursive: true });
      fs.writeFileSync(path.join(sd, "artifacts.json"), "[]");
      fs.writeFileSync(
        path.join(projectDir, ".deeppairing", "preferences.json"),
        JSON.stringify({ rejectedApproaches: [{ description: "global config", concept: "global mutable state" }] }),
      );
      const run = (rel: string, body: string) =>
        execFileSync("node", [committedBundle], {
          input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: path.join(projectDir, rel), new_string: body } }),
          encoding: "utf-8",
          env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, DEEPPAIRING_GUARDRAIL_BACKSTOP: "off" },
        }).trim();
      expect(run("migrations/1.sql", "DROP TABLE users;")).toBe("");
      expect(run("src/c.ts", "export let cfg = {}; // global mutable state singleton")).toContain("REJECTED_APPROACH_BLOCKED");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
