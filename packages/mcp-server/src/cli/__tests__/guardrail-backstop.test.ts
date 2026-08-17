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
  GUARDRAIL_PATH_PREFILTER,
  GUARDRAIL_RULES,
  PER_PATH_DEDUP_CLASSES,
  evaluateGuardrailBackstop,
  evaluatePreflightHook,
  guardrailAskSuppressed,
  guardrailBackstopDisabled,
  looksLikeGuardrailPath,
  matchGuardrailPath,
  readSessionCeremony,
  recordHookFire,
} from "../preflight-hook-core.js";
import { sessionHasLivePreWorkCeremony } from "../../debrief-gate.js";

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

/** Must NOT fire — templates, lookalikes, and nested (non-root) directories. */
const UNGUARDED = [
  ".env.example",
  ".env.sample",
  ".env.local.example",
  "packages/db/migrations/1.sql",
  "src/k8s-helpers.ts",
  "src/index.ts",
  "docs/terraform-notes.md",
  "compose.ts",
];

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

  it("the zero-I/O prefilter is a strict SUPERSET of the matcher (a false negative would silently disable the backstop)", () => {
    for (const [rel] of GUARDED) {
      expect(looksLikeGuardrailPath({ file_path: `/abs/project/${rel}` }), `prefilter missed ${rel}`).toBe(true);
    }
    expect(looksLikeGuardrailPath({ file_path: "/abs/project/src/index.ts" })).toBe(false);
    expect(looksLikeGuardrailPath({})).toBe(false);
    // Windows separators normalize.
    expect(looksLikeGuardrailPath({ file_path: "C:\\proj\\.github\\workflows\\ci.yml" })).toBe(true);
    // The literal is what setup-tasks interpolates into the init-generated hook.
    expect(String(GUARDRAIL_PATH_PREFILTER)).toContain(".github");
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
    // F4 — leads with the decision the human owns, not an agent instruction.
    expect(d!.reason).toContain("GUARDRAIL_ESCALATION");
    expect(d!.reason).toContain("Allow this edit to .github/workflows/ci.yml?");
    expect(d!.reason).toContain("It's a guardrail path (workflows — it affects every future deploy)");
    expect(d!.reason).toContain("Decline to have your pair present it for review first.");
    // F1 — project scope, never "this session".
    expect(d!.reason).toContain("is live in this project's recent sessions");
    expect(d!.reason).not.toMatch(/live in this session/);
    // The agent-facing instruction follows (it is fed back on a decline).
    expect(d!.reason).toMatch(/\(Agent: this is ESCALATED work/);
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
