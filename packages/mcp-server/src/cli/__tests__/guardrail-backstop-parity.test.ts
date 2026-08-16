/**
 * P1 (round-11) — PARITY INSURANCE for the guardrail backstop.
 *
 * The backstop has to agree with TWO other things, and both agreements are the
 * kind that rot silently:
 *
 *  1. THE SENSED SET. The guidance tells the agent the backstop covers "the
 *     guardrail paths" — the ones the 🛡 first-call-hint section lists, which
 *     come from senseProjectGuardrails (store/project-signals.ts). The hook
 *     cannot import that module (it must stay Node-builtins-only so the
 *     init-generated .mjs can load it under plain `node`), so it carries a
 *     hand-maintained MIRROR, GUARDRAIL_MARKERS. This runs both over a fixture
 *     project and asserts they name the same classes and the same roots.
 *
 *  2. THE TWO HOOK COPIES. Same shape as stop-hook-debrief-parity.test.ts: the
 *     committed plugin bundle (claude-plugin/server/preflight.mjs, what
 *     marketplace users execute) and the init-generated .deeppairing/hooks/
 *     preflight.mjs are hand-maintained twins. This runs BOTH over one case
 *     matrix and asserts they agree with each other AND with the expected
 *     outcome — including the ask-never-deny contract from SECURITY.md.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GUARDRAIL_MARKERS, GUARDRAIL_PATH_PREFILTER, matchGuardrailPath } from "../preflight-hook-core.js";
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
// 1. the sensed set
// ---------------------------------------------------------------------------

describe("GUARDRAIL_MARKERS mirrors senseProjectGuardrails (the 🛡 set the hint renders)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-gr-parity-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** Materialize every marker root — dirs as dirs, dotted/known files as files. */
  const FILE_ROOTS = new Set([
    "Dockerfile",
    "docker-compose.yml",
    "docker-compose.yaml",
    ".env",
    ".env.local",
    ".env.production",
    "config/secrets.yml",
  ]);
  function materializeAll(): void {
    for (const marker of GUARDRAIL_MARKERS) {
      for (const root of marker.roots) {
        const abs = path.join(dir, root);
        if (FILE_ROOTS.has(root)) {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, "");
        } else {
          fs.mkdirSync(abs, { recursive: true });
        }
      }
    }
  }

  it("names the same classes, in the same order, over the same roots", () => {
    materializeAll();
    const sensed = senseProjectGuardrails(dir);
    expect(sensed.map((g) => g.category)).toEqual(GUARDRAIL_MARKERS.map((m) => m.category));
    for (const g of sensed) {
      const mirror = GUARDRAIL_MARKERS.find((m) => m.category === g.category)!;
      expect(g.paths, `roots drifted for ${g.category}`).toEqual(mirror.roots);
    }
  });

  it("every sensed guardrail path is matched by the hook (no class the hint names is unguarded)", () => {
    materializeAll();
    for (const g of senseProjectGuardrails(dir)) {
      for (const p of g.paths) {
        const probe = FILE_ROOTS.has(p) ? p : `${p}/whatever.txt`;
        const m = matchGuardrailPath(dir, [path.join(dir, probe)]);
        expect(m?.category, `${probe} was not matched`).toBe(g.category);
        expect(GUARDRAIL_PATH_PREFILTER.test(probe)).toBe(true);
      }
    }
  });

  it("DOCUMENTED divergence: the hook also covers creating the FIRST file in a guardrail location", () => {
    // Nothing materialized — senseProjectGuardrails sees no guardrails at all…
    expect(senseProjectGuardrails(dir)).toEqual([]);
    // …but a Write that CREATES the project's first migration is guardrail work
    // by definition, and the edited path is its own evidence.
    expect(matchGuardrailPath(dir, [path.join(dir, "migrations/001_init.sql")])?.category).toBe("migrations");
    expect(matchGuardrailPath(dir, [path.join(dir, ".github/workflows/ci.yml")])?.category).toBe("workflows");
    // That is the ONLY direction of divergence: the hook never matches a path
    // outside the mirrored root set.
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
  /** artifacts.json content, or null to leave the session store ABSENT. */
  artifacts: Art[] | null;
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
    expectAsk: "GUARDRAIL_ESCALATION — this touches a guardrail path (workflows: .github/workflows/ci.yml)",
  },
  {
    name: "(a2) round-11 repro: DROP TABLE migration Write, no ceremony → ask",
    artifacts: [],
    toolName: "Write",
    file: "migrations/003_drop.sql",
    expectAsk: "GUARDRAIL_ESCALATION — this touches a guardrail path (migrations: migrations/003_drop.sql)",
  },
  { name: "(b) guardrail Edit + live spec → pass", artifacts: [art("sp1", "spec")], toolName: "Edit", file: "migrations/1.sql", expectAsk: null },
  { name: "(b2) guardrail Edit + live findings → pass", artifacts: [art("r1", "research", "draft")], toolName: "Edit", file: ".env", expectAsk: null },
  { name: "(b3) guardrail Edit + live options → pass", artifacts: [art("d1", "decision")], toolName: "Edit", file: "Dockerfile", expectAsk: null },
  { name: "(b4) guardrail Edit + REJECTED spec → ask (the ceremony isn't standing)", artifacts: [art("sp1", "spec", "rejected")], toolName: "Edit", file: "terraform/main.tf", expectAsk: "infrastructure: terraform/main.tf" },
  { name: "(c) non-guardrail Edit → pass (zero behaviour change)", artifacts: [], toolName: "Edit", file: "src/index.ts", expectAsk: null },
  { name: "(c2) nested migrations/ (not root-relative) → pass", artifacts: [], toolName: "Edit", file: "packages/db/migrations/1.sql", expectAsk: null },
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
      fs.writeFileSync(path.join(sd, "artifacts.json"), JSON.stringify(c.artifacts));
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
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
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

  it.skipIf(!initCoreBuilt)("the init-generated script carries the SAME prefilter literal as the core (parity by construction)", () => {
    expect(initScript).not.toBeNull();
    const src = fs.readFileSync(initScript!, "utf-8");
    expect(src).toContain(String(GUARDRAIL_PATH_PREFILTER));
    expect(src).toContain("looksLikeGuardrailPath");
  });

  it.skipIf(!bundleBuilt)("NEITHER copy can ever emit permissionDecision 'deny' (SECURITY.md ask-never-deny)", () => {
    const bundleSrc = fs.readFileSync(committedBundle, "utf-8");
    expect(bundleSrc).not.toMatch(/permissionDecision["']?\s*:\s*["']deny["']/);
    expect(bundleSrc).toMatch(/permissionDecision["']?\s*:\s*["']ask["']/);
  });

  it.skipIf(!bundleBuilt)("dedup: a second edit in the same guardrail class goes silent (no nagging the arc)", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-gr-dedup-"));
    try {
      const sd = path.join(projectDir, ".deeppairing", "sessions", "s1");
      fs.mkdirSync(sd, { recursive: true });
      fs.writeFileSync(path.join(sd, "artifacts.json"), "[]");
      const fire = (rel: string) =>
        execFileSync("node", [committedBundle], {
          input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: path.join(projectDir, rel), new_string: "x" } }),
          encoding: "utf-8",
          env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
        }).trim();
      expect(fire(".github/workflows/ci.yml")).toContain("GUARDRAIL_ESCALATION");
      expect(fire(".github/workflows/release.yml")).toBe("");
      // A different class is a different message, so it still asks.
      expect(fire("migrations/1.sql")).toContain("migrations:");
      // The dedup record rides in the file the UI already reads, beside `fires`.
      const state = JSON.parse(fs.readFileSync(path.join(projectDir, ".deeppairing", "hooks-state.json"), "utf-8"));
      expect(Object.keys(state.guardrailAsks).sort()).toEqual(["migrations", "workflows"]);
      expect(state.fires.length).toBeGreaterThanOrEqual(2);
      expect(state.fires.at(-1).reason).toBe("guardrail");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
