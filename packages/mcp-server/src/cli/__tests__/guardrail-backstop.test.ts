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
 * plus the dedup rule (per guardrail CLASS per 30-minute window) and the
 * ask-never-deny contract from SECURITY.md.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CEREMONY_MAX_AGE_MS,
  GUARDRAIL_ASK_TTL_MS,
  GUARDRAIL_MARKERS,
  GUARDRAIL_PATH_PREFILTER,
  evaluateGuardrailBackstop,
  evaluatePreflightHook,
  guardrailAskSuppressed,
  looksLikeGuardrailPath,
  matchGuardrailPath,
  readSessionCeremony,
  recordGuardrailAsk,
} from "../preflight-hook-core.js";
import { sessionHasLivePreWorkCeremony } from "../../debrief-gate.js";

let dir: string;
const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const recent = iso(NOW - 60 * 1000);

type Art = { id: string; type: string; status: string; createdAt: string };
const art = (type: string, status = "approved", createdAt = recent): Art => ({
  id: `${type}-${Math.random().toString(36).slice(2, 8)}`,
  type,
  status,
  createdAt,
});

function seedSession(artifacts: Art[], sessionId = "s1"): void {
  const sd = path.join(dir, ".deeppairing", "sessions", sessionId);
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, "artifacts.json"), JSON.stringify(artifacts));
}

const edit = (rel: string) => ({ file_path: path.join(dir, rel), new_string: "whatever" });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-guardrail-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("matchGuardrailPath — the trigger predicate", () => {
  it("matches every class the 🛡 section names, and reports class + relative path", () => {
    const cases: Array<[string, string]> = [
      [".github/workflows/ci.yml", "workflows"],
      ["migrations/003_drop.sql", "migrations"],
      ["prisma/migrations/20260101_init/migration.sql", "migrations"],
      ["db/migrate/001.rb", "migrations"],
      ["supabase/migrations/x.sql", "migrations"],
      ["Dockerfile", "infrastructure"],
      ["docker-compose.yml", "infrastructure"],
      ["terraform/main.tf", "infrastructure"],
      ["k8s/deploy.yaml", "infrastructure"],
      ["kubernetes/svc.yaml", "infrastructure"],
      ["helm/values.yaml", "infrastructure"],
      ["infrastructure/vpc.ts", "infrastructure"],
      [".env", "secrets"],
      [".env.production", "secrets"],
      ["config/secrets.yml", "secrets"],
    ];
    for (const [rel, category] of cases) {
      const m = matchGuardrailPath(dir, [path.join(dir, rel)]);
      expect(m, `expected ${rel} to match`).not.toBeNull();
      expect(m!.category).toBe(category);
      expect(m!.path).toBe(rel);
    }
  });

  it("is ROOT-relative, like senseProjectGuardrails — a nested migrations/ dir does NOT match", () => {
    expect(matchGuardrailPath(dir, [path.join(dir, "packages/db/migrations/1.sql")])).toBeNull();
    expect(matchGuardrailPath(dir, [path.join(dir, "src/k8s-helpers.ts")])).toBeNull();
    expect(matchGuardrailPath(dir, [path.join(dir, "Dockerfile.dev")])).toBeNull();
  });

  it("ignores paths outside the project root", () => {
    expect(matchGuardrailPath(dir, ["/somewhere/else/.github/workflows/ci.yml"])).toBeNull();
  });

  it("accepts a project-relative path (resolved against the root)", () => {
    expect(matchGuardrailPath(dir, [".github/workflows/ci.yml"])?.category).toBe("workflows");
  });

  it("the zero-I/O prefilter is a SUPERSET of the authoritative matcher (never misses a real match)", () => {
    for (const marker of GUARDRAIL_MARKERS) {
      for (const root of marker.roots) {
        const probe = `/abs/project/${root}${root.includes(".") && !root.includes("/") ? "" : "/file.txt"}`;
        expect(looksLikeGuardrailPath({ file_path: probe }), `prefilter missed ${root}`).toBe(true);
      }
    }
    expect(looksLikeGuardrailPath({ file_path: "/abs/project/src/index.ts" })).toBe(false);
    expect(looksLikeGuardrailPath({})).toBe(false);
    // Windows separators normalize.
    expect(looksLikeGuardrailPath({ file_path: "C:\\proj\\.github\\workflows\\ci.yml" })).toBe(true);
    // The literal is what setup-tasks interpolates into the init-generated hook.
    expect(String(GUARDRAIL_PATH_PREFILTER)).toContain(".github");
  });
});

describe("sessionHasLivePreWorkCeremony — the ceremony-present predicate", () => {
  it("counts a LIVE findings/options/spec/plan as ceremony in flight", () => {
    for (const type of ["research", "decision", "spec", "plan"]) {
      for (const status of ["draft", "reviewing", "approved"]) {
        expect(sessionHasLivePreWorkCeremony([art(type, status)]), `${type}/${status}`).toBe(true);
      }
    }
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
    const isRecent = (a: { createdAt?: string }) => NOW - new Date(a.createdAt ?? 0).getTime() <= CEREMONY_MAX_AGE_MS;
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

  it("finds ceremony in ANY session dir, and survives a corrupt sibling", () => {
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
});

describe("evaluateGuardrailBackstop — the five pinned cases", () => {
  it("(a) guardrail edit with NO ceremony → ASK, naming the class and the path", () => {
    seedSession([]);
    const d = evaluateGuardrailBackstop({ toolInput: edit(".github/workflows/ci.yml"), projectRoot: dir, now: NOW });
    expect(d).not.toBeNull();
    expect(d!.deny).toBe(true);
    expect(d!.source).toBe("guardrail");
    expect(d!.reason).toContain("GUARDRAIL_ESCALATION");
    expect(d!.reason).toContain("workflows: .github/workflows/ci.yml");
    expect(d!.reason).toMatch(/ESCALATED work/);
    expect(d!.reason).toMatch(/present findings\/options\/a spec or plan/);
  });

  it("(a2) the round-11 repro — a DROP TABLE migration Write with no ceremony asks", () => {
    seedSession([]);
    const d = evaluateGuardrailBackstop({
      toolInput: { file_path: path.join(dir, "migrations/003_drop.sql"), content: "DROP TABLE users;" },
      projectRoot: dir,
      now: NOW,
    });
    expect(d?.reason).toContain("migrations: migrations/003_drop.sql");
  });

  it("(b) guardrail edit WITH a live spec/options/findings/plan → PASS silently (no nagging the escalated arc)", () => {
    for (const type of ["research", "decision", "spec", "plan"]) {
      fs.rmSync(path.join(dir, ".deeppairing"), { recursive: true, force: true });
      seedSession([art(type)]);
      const d = evaluateGuardrailBackstop({ toolInput: edit("migrations/1.sql"), projectRoot: dir, now: NOW });
      expect(d, `a live ${type} should license the guardrail edit`).toBeNull();
    }
  });

  it("(c) non-guardrail edit → PASS, and nothing is written (zero behaviour change for the low-risk class)", () => {
    seedSession([]);
    const d = evaluateGuardrailBackstop({ toolInput: edit("src/index.ts"), projectRoot: dir, now: NOW });
    expect(d).toBeNull();
    expect(fs.existsSync(path.join(dir, ".deeppairing", "hooks-state.json"))).toBe(false);
  });

  it("(d) store unreachable → PASS (fail open), and no dedup state is stamped", () => {
    // No .deeppairing/sessions at all.
    const d = evaluateGuardrailBackstop({ toolInput: edit(".github/workflows/ci.yml"), projectRoot: dir, now: NOW });
    expect(d).toBeNull();
    expect(fs.existsSync(path.join(dir, ".deeppairing", "hooks-state.json"))).toBe(false);
  });

  it("fails open on a garbage sessions directory (a file where the dir should be)", () => {
    fs.mkdirSync(path.join(dir, ".deeppairing"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".deeppairing", "sessions"), "not a directory");
    const d = evaluateGuardrailBackstop({ toolInput: edit(".github/workflows/ci.yml"), projectRoot: dir, now: NOW });
    expect(d).toBeNull();
  });

  it("never emits deny as a DECISION word — the hook surface is always 'ask' (SECURITY.md contract)", () => {
    seedSession([]);
    const d = evaluateGuardrailBackstop({ toolInput: edit(".env"), projectRoot: dir, now: NOW });
    // `deny: true` is the INTERNAL "this fires" flag; both hook entries render it
    // as permissionDecision "ask". Pinned end-to-end in the parity test.
    expect(d!.source).toBe("guardrail");
    expect(d!.reason).not.toMatch(/permissionDecision/);
  });
});

describe("dedup — per guardrail CLASS per window", () => {
  it("asks once, then goes silent for the rest of the window", () => {
    seedSession([]);
    expect(evaluateGuardrailBackstop({ toolInput: edit(".github/workflows/ci.yml"), projectRoot: dir, now: NOW })).not.toBeNull();
    // Same class, different FILE, one minute later → silent (the message is about
    // the arc, not the file).
    expect(
      evaluateGuardrailBackstop({ toolInput: edit(".github/workflows/release.yml"), projectRoot: dir, now: NOW + 60_000 }),
    ).toBeNull();
  });

  it("a DIFFERENT guardrail class still asks — the dedup is per class", () => {
    seedSession([]);
    expect(evaluateGuardrailBackstop({ toolInput: edit(".github/workflows/ci.yml"), projectRoot: dir, now: NOW })).not.toBeNull();
    const second = evaluateGuardrailBackstop({ toolInput: edit("migrations/1.sql"), projectRoot: dir, now: NOW + 1000 });
    expect(second?.reason).toContain("migrations:");
  });

  it("re-opens after the window", () => {
    seedSession([]);
    evaluateGuardrailBackstop({ toolInput: edit(".github/workflows/ci.yml"), projectRoot: dir, now: NOW });
    expect(guardrailAskSuppressed(dir, "workflows", NOW + GUARDRAIL_ASK_TTL_MS - 1)).toBe(true);
    expect(guardrailAskSuppressed(dir, "workflows", NOW + GUARDRAIL_ASK_TTL_MS + 1)).toBe(false);
    expect(
      evaluateGuardrailBackstop({ toolInput: edit(".github/workflows/ci.yml"), projectRoot: dir, now: NOW + GUARDRAIL_ASK_TTL_MS + 1 }),
    ).not.toBeNull();
  });

  it("stamping preserves every other key in hooks-state.json (the `fires` log the entries append)", () => {
    const sp = path.join(dir, ".deeppairing", "hooks-state.json");
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, JSON.stringify({ version: 1, fires: [{ hook: "stop", reason: "pass" }] }));
    recordGuardrailAsk(dir, "workflows", NOW);
    const state = JSON.parse(fs.readFileSync(sp, "utf-8"));
    expect(state.fires).toHaveLength(1);
    expect(state.guardrailAsks.workflows).toBe(new Date(NOW).toISOString());
  });

  it("an unreadable dedup file is NOT treated as suppression (conservative side)", () => {
    const sp = path.join(dir, ".deeppairing", "hooks-state.json");
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, "{ not json");
    expect(guardrailAskSuppressed(dir, "workflows", NOW)).toBe(false);
  });
});

describe("evaluatePreflightHook — composition with the rejected-approach gate", () => {
  it("(e) POSITIVE CONTROL: the rejected-approach ask is unchanged and still wins", () => {
    seedSession([]);
    fs.writeFileSync(
      path.join(dir, ".deeppairing", "preferences.json"),
      JSON.stringify({ rejectedApproaches: [{ description: "global config", concept: "global mutable state" }] }),
    );
    // A guardrail path AND a rejected-approach match: the older, harder signal wins.
    const d = evaluatePreflightHook({
      toolName: "Write",
      toolInput: { file_path: path.join(dir, "migrations/1.sql"), content: "-- global mutable state singleton" },
      projectRoot: dir,
      now: NOW,
    });
    expect(d.deny).toBe(true);
    expect(d.reason).toMatch(/REJECTED_APPROACH_BLOCKED/);
    expect(d.reason).not.toMatch(/GUARDRAIL_ESCALATION/);
    expect(d.source).toBe("session");
  });

  it("falls through to the guardrail backstop when the ledger has nothing to say", () => {
    seedSession([]);
    const d = evaluatePreflightHook({
      toolName: "Edit",
      toolInput: edit(".github/workflows/ci.yml"),
      projectRoot: dir,
      now: NOW,
    });
    expect(d.deny).toBe(true);
    expect(d.source).toBe("guardrail");
  });

  it("still returns {deny:false} for an ordinary edit with an empty store", () => {
    seedSession([]);
    const d = evaluatePreflightHook({ toolName: "Edit", toolInput: edit("src/a.ts"), projectRoot: dir, now: NOW });
    expect(d).toEqual({ deny: false });
  });
});
