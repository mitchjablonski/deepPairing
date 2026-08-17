import fs from "node:fs";
import path from "node:path";
import { runPreflight } from "../mcp/preflight-validator.js";
import { sessionHasLivePreWorkCeremony } from "../debrief-gate.js";
// F14 — the prefilter lives in its own ~20-line module so setup-tasks.ts (CLI
// cold start) can interpolate the literal without importing the matcher core.
// Re-exported here so both hook entries keep a single import site.
import { GUARDRAIL_PATH_PREFILTER, looksLikeGuardrailPath } from "./guardrail-prefilter.js";
export { GUARDRAIL_PATH_PREFILTER, looksLikeGuardrailPath };
import type { RejectedApproach } from "../store/store-interface.js";
import type { TeamPreference } from "@deeppairing/shared";

/**
 * WP5 — the brains of the PreToolUse hook, split out so it's UNIT-TESTABLE and
 * shares the EXACT matcher the MCP-side preflight uses (no drift). The hook
 * .mjs is a thin stdin/stdout shell around evaluatePreflightHook.
 *
 * TWO gates live here, in this order (see evaluatePreflightHook):
 *   1. the rejected-approach / team-preference matcher (WP5, original);
 *   2. P1's GUARDRAIL BACKSTOP (bottom half of this file) — a guardrail-path
 *      write with no live pre-work ceremony asks the human.
 * Both surface as permissionDecision "ask"; neither ever denies.
 *
 * Why a hook at all: the MCP-side preflight only fires when the agent
 * voluntarily announces intent through a present_* tool. A model that just
 * calls Edit/Write directly sails past the gate. This runs the same
 * rejected-approach matcher against the ACTUAL edit, at the platform level, so
 * "refuses on your behalf" holds even when the protocol is skipped.
 *
 * Everything here is dependency-light (Node builtins + the zero-runtime-dep
 * matcher) so the built JS imports cleanly from .deeppairing/hooks/ via plain
 * `node`, regardless of how deepPairing was installed.
 */

/** Read session rejected approaches from .deeppairing/preferences.json. Mirrors
 *  FileStore.normalizeRejectedApproaches (legacy bare-string entries → {description}).
 *
 *  LOCAL-ONLY by design. The hook is a HARD gate (permissionDecision: "ask"),
 *  and cross-project stances are ADVISORY-first — they must never hard-block a
 *  direct Edit/Write. Cross-project awareness reaches the agent advisorily via
 *  the first-call-hint preamble + the present_* preflight trace's cross-project
 *  near-misses, NOT here. So this reads ONLY this project's ledger. */
export function readRejectedApproaches(projectRoot: string): RejectedApproach[] {
  const p = path.join(projectRoot, ".deeppairing", "preferences.json");
  try {
    if (!fs.existsSync(p)) return [];
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    const list = raw?.rejectedApproaches;
    if (!Array.isArray(list)) return [];
    return list
      .map((e: any): RejectedApproach =>
        typeof e === "string"
          ? { description: e }
          : {
              description: String(e?.description ?? ""),
              reason: e?.reason,
              rejectedAt: e?.rejectedAt,
              sourceArtifactId: e?.sourceArtifactId,
              concept: e?.concept,
            },
      )
      .filter((r) => r.description);
  } catch {
    return [];
  }
}

/** Read team preferences from .deeppairing/team.json (JSONC — `//` line comments
 *  stripped). Lightweight runtime guard rather than the zod schema so the built
 *  hook stays free of @deeppairing/shared at runtime. runPreflight only reads
 *  kind / concept / rationale / scope. */
export function readTeamPreferences(projectRoot: string): TeamPreference[] {
  const p = path.join(projectRoot, ".deeppairing", "team.json");
  try {
    if (!fs.existsSync(p)) return [];
    const stripped = fs
      .readFileSync(p, "utf-8")
      .split("\n")
      .map((l) => (/^\s*\/\//.test(l) ? "" : l))
      .join("\n");
    const raw = JSON.parse(stripped);
    if (!raw || raw.version !== 1 || !Array.isArray(raw.preferences)) return [];
    // ALL-OR-NOTHING, mirroring the canonical parseTeamPreferencesFile (zod
    // safeParse of the whole file): if ANY entry is malformed the MCP loader
    // returns [] and does NOT enforce, so the hook must do the same — otherwise
    // it would block on a rule the MCP side ignores (an over-block for a gate
    // that's meant to mirror the existing preflight).
    const KINDS = new Set(["require", "prefer", "avoid"]);
    const valid = raw.preferences.every(
      (x: any) =>
        x &&
        typeof x.id === "string" &&
        typeof x.concept === "string" &&
        x.concept.length > 0 &&
        typeof x.rationale === "string" &&
        KINDS.has(x.kind),
    );
    return valid ? (raw.preferences as TeamPreference[]) : [];
  } catch {
    return [];
  }
}

/** Pull the matchable text + paths out of a PreToolUse tool_input. We match the
 *  NEW content only (what's being introduced) — Edit's new_string is precise;
 *  Write's content is the whole file. Plus the file path (catches e.g. a
 *  "railway" in a config filename). */
export function buildProposals(
  _toolName: string,
  toolInput: any,
): { strings: string[]; paths: string[] } {
  const strings: string[] = [];
  const paths: string[] = [];
  const fp = toolInput?.file_path ?? toolInput?.filePath;
  if (typeof fp === "string" && fp) {
    strings.push(fp);
    paths.push(fp);
  }
  if (typeof toolInput?.content === "string") strings.push(toolInput.content); // Write
  if (typeof toolInput?.new_string === "string") strings.push(toolInput.new_string); // Edit
  if (Array.isArray(toolInput?.edits)) {
    for (const e of toolInput.edits) {
      if (typeof e?.new_string === "string") strings.push(e.new_string); // MultiEdit
    }
  }
  return { strings: strings.filter(Boolean), paths: paths.filter(Boolean) };
}

export interface HookDecision {
  /** F14 — the gate FIRED. Named `fire`, not `deny`: every fire on this surface
   *  renders as permissionDecision "ask" (SECURITY.md's ask-never-deny
   *  contract), and a field called `deny` invited exactly the misreading that a
   *  hook here can block an edit. It cannot. */
  fire: boolean;
  reason?: string;
  source?: "session" | "team" | "guardrail";
  /** Present only on a guardrail-backstop fire — what the caller stamps for
   *  dedup and names in the fire log. */
  guardrail?: GuardrailMatch;
}

/**
 * #169 — runPreflight's block message ends with "The artifact was NOT created."
 * That clause is written for the AGENT-facing present_* tool error (where a tool
 * call really did fail to create an artifact). But the SAME message is reused as
 * the human's PreToolUse permission prompt for a raw Edit/Write — where there is
 * no artifact, and the edit isn't refused outright, it's paused for the human to
 * allow or deny. So the clause is meaningless (and misleading) on the hook
 * surface. Strip it HERE, in the hook lane only — the agent-facing MCP tool
 * error (tool-helpers.ts) keeps runPreflight's message verbatim.
 */
export function stripArtifactClause(message: string): string {
  return message.replace(/\s*The artifact was NOT created\.\s*$/, "").trimEnd();
}

/**
 * F6 — the shared runPreflight headline reads "<Tool> refused —". That's true on
 * the AGENT-facing present_* tool error (the tool call really did refuse to
 * create the artifact), but wrong on the HOOK surface: the PreToolUse gate emits
 * permissionDecision "ask", i.e. it PAUSES the Edit for the human to allow or
 * deny — it does not refuse it. Reword the verb for the hook lane only; the
 * agent-facing message (tool-helpers.ts) keeps "refused" verbatim.
 */
export function toHookReason(message: string): string {
  return stripArtifactClause(message).replace(" refused — ", " paused for your review — ");
}

// ===========================================================================
// P1 (round-11) — THE GUARDRAIL BACKSTOP
// ===========================================================================
//
// Round-11 verification found the guidance describing a mechanism that did not
// exist: SKILL.md and the first-call hint both told the agent "the preflight
// gate escalates guardrail-path edits itself regardless", while the preflight
// hook had ZERO guardrail logic — guardrails were SENSED (store/project-signals)
// and rendered as hint TEXT only. That matters because O1 (v0.1.33) widened the
// licence to skip the pre-work gates for "low-risk" work and cites this backstop
// as the reason a MISCLASSIFIED guardrail edit is still safe. The only thing
// holding the line was the agent's own reading of the hint.
//
// This is the mechanism, built to the contract the guidance already promised:
//
//   TRIGGER — a write-class tool (Edit/Write/MultiEdit) whose target path falls
//   under one of the guardrail classes senseProjectGuardrails detects
//   (migrations, CI, infra, secrets), AND no live pre-work ceremony exists in
//   this project's recent sessions.
//   → permissionDecision "ask", naming the class + the matched path.
//
//   NEVER "deny" (SECURITY.md's ask-never-deny contract), always local-only
//   (project .deeppairing/ reads + one small state write), and FAIL OPEN on any
//   error, unreadable store, or unreachable session store.
//
// The hard design question was how NOT to nag legitimately-escalated work. The
// backstop fires ONLY in the exact skip case: if the agent already did the
// ceremony — a LIVE findings/options/spec/plan — the guardrail edit passes
// SILENTLY. Liveness is defined once, next to the debrief gate's
// (debrief-gate.ts sessionHasLivePreWorkCeremony), and counts LIVE artifacts
// only.
//
// A non-guardrail edit is completely untouched: one regex test against the file
// path, no extra I/O, no output. Zero behaviour change for the low-risk class —
// that is the point.

/** F7 — the escape hatch. `DEEPPAIRING_GUARDRAIL_BACKSTOP=off` disables THIS
 *  lane only; the rejected-approach / team-preference gate is unaffected (it
 *  enforces a promise the human made to themselves and stays on). Documented in
 *  SECURITY.md and SKILL.md. */
export const GUARDRAIL_BACKSTOP_ENV = "DEEPPAIRING_GUARDRAIL_BACKSTOP";

/** True when the human has switched the backstop off for this process. */
export function guardrailBackstopDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env[GUARDRAIL_BACKSTOP_ENV] ?? "").trim().toLowerCase();
  return v === "off" || v === "0" || v === "false";
}

/** Recency window for a pre-work ceremony artifact — one working arc. Long
 *  enough that an approved spec still covers a multi-hour implementation run
 *  (re-asking mid-arc would be the nag failure); short enough that YESTERDAY's
 *  spec cannot licence today's unceremonious migration. Documented to the agent
 *  in SKILL.md's Guardrails section. */
export const CEREMONY_MAX_AGE_MS = 8 * 60 * 60 * 1000;

/** Dedup window for a fired guardrail ask. See guardrailAskSuppressed for the
 *  grain (per class, and per FILE within the two irreversible classes). */
export const GUARDRAIL_ASK_TTL_MS = 30 * 60 * 1000;

/**
 * F3 — classes deduped per matched FILE rather than per class.
 *
 * The hook cannot observe the human's answer: allow and decline are both
 * silence. For `workflows` and `infrastructure` the ask is genuinely an
 * ARC-level message (the second workflow file in the same arc says nothing
 * new), so one ask per class per window is right. For `migrations` and
 * `secrets` it is not: each file is a separately irreversible act, and a
 * confirmed `migrations/1_add_index.sql` must not silently license
 * `migrations/2_drop_users.sql` twenty minutes later. Those two classes key on
 * class + matched path.
 */
export const PER_PATH_DEDUP_CLASSES = new Set(["migrations", "secrets"]);

export interface GuardrailRule {
  category: string;
  /** Rationale rendered by the 🛡 first-call-hint section (full sentence). */
  rationale: string;
  /** Short lowercase clause for the human-facing ask ("hard to reverse"). */
  note: string;
  /** Root-relative directory prefixes. `rel === d` or `rel` under `d/`. */
  dirs: string[];
  /** Root-relative file predicate (posix separators, full relative path). */
  file: (rel: string) => boolean;
}

/** Shared helper: a dotenv file that is NOT a checked-in template. */
function isRealDotenv(name: string): boolean {
  if (!/^\.env(\.[^/]+)?$/.test(name)) return false;
  return !/\.(example|sample|template|dist)$/i.test(name);
}

/**
 * The guardrail class table. This is a hand-maintained MIRROR of
 * senseProjectGuardrails (store/project-signals.ts) — the set the 🛡 section of
 * the first-call hint renders — kept honest by
 * guardrail-backstop-parity.test.ts, which runs BOTH over one fixture matrix of
 * real filenames and asserts they agree class-for-class, in both directions.
 *
 * Why mirrored and not imported: this module is loaded by the init-generated
 * hook under plain `node` out of .deeppairing/hooks/, so it must stay
 * dependency-light (Node builtins only). project-signals imports
 * @deeppairing/shared. Same discipline as readTeamPreferences above, which
 * re-implements parseTeamPreferencesFile for the same reason.
 *
 * F6 — the rules are PREFIX/GLOB, not a fixed filename list. The first cut
 * matched only `.env`/`.env.local`/`.env.production`, `Dockerfile`,
 * `docker-compose.yml` and four migration dirs, so `.env.staging`,
 * `Dockerfile.prod`, `compose.yaml`, `terraform.tfvars`, `.gitlab-ci.yml`,
 * `Jenkinsfile`, `.circleci/config.yml`, `alembic/versions/*`,
 * `config/master.key` and `config/credentials.yml.enc` all sailed through — the
 * highest-consequence miss class for a backstop whose whole job is the
 * irreversible edit.
 */
export const GUARDRAIL_RULES: GuardrailRule[] = [
  {
    category: "migrations",
    rationale: "Migrations are hard to reverse — escalate to supervised for changes here.",
    note: "hard to reverse",
    dirs: ["migrations", "db/migrate", "prisma/migrations", "supabase/migrations", "alembic/versions"],
    file: () => false,
  },
  {
    category: "workflows",
    rationale: "CI workflows affect every future deploy — escalate for changes here.",
    note: "it affects every future deploy",
    dirs: [".github/workflows", ".circleci"],
    file: (rel) => rel === ".gitlab-ci.yml" || rel === ".gitlab-ci.yaml" || rel === "Jenkinsfile",
  },
  {
    category: "infrastructure",
    rationale: "Infrastructure changes affect production surfaces — escalate here.",
    note: "it affects production surfaces",
    dirs: ["infrastructure", "terraform", "k8s", "kubernetes", "helm"],
    file: (rel) =>
      /^Dockerfile([.-][^/]*)?$/.test(rel) ||
      /^(docker-)?compose[^/]*\.ya?ml$/.test(rel) ||
      /^[^/]*\.tfvars(\.json)?$/.test(rel),
  },
  {
    category: "secrets",
    rationale: "Secret files must never leak into the session or a commit — escalate here.",
    note: "secrets must never leak into a commit",
    dirs: [],
    file: (rel) =>
      isRealDotenv(rel) ||
      /^config\/secrets[^/]*$/.test(rel) ||
      /^config\/credentials[^/]*$/.test(rel) ||
      rel === "config/master.key",
  },
];

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
 * project? Root-relative, like senseProjectGuardrails — `packages/db/migrations`
 * does NOT match, exactly as the 🛡 section wouldn't list it. A path outside the
 * project root never matches.
 *
 * Deliberately NOT gated on fs.existsSync of the rule's root. senseProjectGuardrails
 * needs existsSync because it enumerates classes with no edit in hand; here the
 * EDITED PATH ITSELF is the evidence. The two sets therefore differ in exactly
 * one case — creating the FIRST file in a guardrail location (a project's first
 * migration, its first CI workflow) — which is guardrail work by definition and
 * is included on purpose. The divergence is pinned by the parity test.
 */
export function matchGuardrailPath(projectRoot: string, paths: string[]): GuardrailMatch | null {
  try {
    for (const raw of paths) {
      if (typeof raw !== "string" || !raw) continue;
      const abs = path.resolve(projectRoot, raw);
      const rel = path.relative(projectRoot, abs).replace(/\\/g, "/");
      if (!rel || rel === ".." || rel.startsWith("../")) continue; // outside the project
      for (const rule of GUARDRAIL_RULES) {
        const hit =
          rule.dirs.some((d) => rel === d || rel.startsWith(d + "/")) || rule.file(rel);
        if (hit) return { category: rule.category, path: rel, rationale: rule.rationale, note: rule.note };
      }
    }
    return null;
  } catch {
    return null; // FAIL OPEN
  }
}

export interface CeremonyReadout {
  /** False when the session store could not be read at all — fail open. */
  reachable: boolean;
  hasLiveCeremony: boolean;
}

/**
 * Read the project's session store and answer "is the escalated arc in flight?"
 *
 * SCOPE IS THE PROJECT, NOT ONE SESSION — deliberate (F1). A PreToolUse hook is
 * handed no deepPairing session id, and narrowing to a guessed "current"
 * session (newest mtime, say) would false-ask whenever two agents interleave in
 * one project — the cardinal sin for a gate whose whole design goal is not to
 * nag legitimate work. So a live spec in ANY recent session of this project
 * licenses the edit, and every surface that describes the mechanism says
 * "this project's recent sessions", never "this session".
 *
 * Three-way on purpose:
 *   - store UNREACHABLE (no .deeppairing/sessions, or an unreadable dir) →
 *     reachable:false → the caller FAILS OPEN and never asks. We cannot tell
 *     whether the ceremony happened, and a hook must not block on ignorance.
 *   - reachable, a LIVE research/decision/spec/plan within CEREMONY_MAX_AGE_MS
 *     → hasLiveCeremony:true → pass silently.
 *   - reachable, nothing live → the exact skip case → ask.
 *
 * An individual unparseable artifacts.json is skipped, not fatal — one corrupt
 * session must not suppress a real ceremony in another.
 */
export function readSessionCeremony(projectRoot: string, now: number = Date.now()): CeremonyReadout {
  const sessionsDir = path.join(projectRoot, ".deeppairing", "sessions");
  let ids: string[];
  try {
    if (!fs.existsSync(sessionsDir)) return { reachable: false, hasLiveCeremony: false };
    ids = fs.readdirSync(sessionsDir);
  } catch {
    return { reachable: false, hasLiveCeremony: false };
  }
  // F9 — an artifact with a missing or unparseable createdAt is NOT treated as
  // eternally recent. Pre-F9 (`!t || …`) a single timestamp-less ceremony
  // artifact licensed guardrail edits forever.
  const isRecent = (a: { createdAt?: string }) => {
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
      continue; // one bad session file must not decide the whole answer
    }
  }
  return { reachable: true, hasLiveCeremony: false };
}

/**
 * DEDUP. PreToolUse never learns the human's answer — "allow" and "decline"
 * both come back as silence, and an allowed Edit is followed by more Edits that
 * fire the hook again. Left alone the backstop would re-ask on every write of
 * the arc: the nag failure that killed reasoning cards.
 *
 * So the ask is treated as DELIVERED once per GUARDRAIL_ASK_TTL_MS, keyed:
 *   - per CLASS for `workflows` / `infrastructure` — the message is about the
 *     arc ("this is escalated work"), and the second workflow file says nothing
 *     new;
 *   - per CLASS + FILE for `migrations` / `secrets` (PER_PATH_DEDUP_CLASSES) —
 *     each file there is a separately irreversible act, so a confirmed
 *     `migrations/1_add_index.sql` must not silently license
 *     `migrations/2_drop_users.sql` inside the same window.
 *
 * State rides in .deeppairing/hooks-state.json — the file the hooks already
 * write and the companion UI already reads — under a `guardrailAsks` map beside
 * `fires`: a class maps either to an ISO string (class-level) or to a
 * {path: ISO} object (per-path). Unreadable state → NOT suppressed (ask), the
 * conservative side.
 */
export function guardrailAskSuppressed(
  projectRoot: string,
  category: string,
  matchedPath: string,
  now: number = Date.now(),
): boolean {
  try {
    const sp = path.join(projectRoot, ".deeppairing", "hooks-state.json");
    const state = JSON.parse(fs.readFileSync(sp, "utf-8"));
    const entry = state?.guardrailAsks?.[category];
    const at = PER_PATH_DEDUP_CLASSES.has(category)
      ? (entry && typeof entry === "object" ? entry[matchedPath] : undefined)
      : entry;
    if (typeof at !== "string") return false;
    const t = Date.parse(at);
    if (!Number.isFinite(t)) return false;
    return now - t < GUARDRAIL_ASK_TTL_MS;
  } catch {
    return false;
  }
}

/** Apply a fired guardrail ask to an in-memory hooks-state object. Split out so
 *  the stamp and the `fires` append are ONE read-modify-write (F11). Prunes
 *  per-path entries older than the window so the map can't grow unbounded. */
function stampGuardrailAsk(state: Record<string, unknown>, match: GuardrailMatch, now: number): void {
  const asks = (state.guardrailAsks && typeof state.guardrailAsks === "object"
    ? state.guardrailAsks
    : {}) as Record<string, unknown>;
  const iso = new Date(now).toISOString();
  if (PER_PATH_DEDUP_CLASSES.has(match.category)) {
    const prev = asks[match.category];
    const byPath: Record<string, string> = {};
    if (prev && typeof prev === "object") {
      for (const [p, at] of Object.entries(prev as Record<string, unknown>)) {
        const t = typeof at === "string" ? Date.parse(at) : NaN;
        if (Number.isFinite(t) && now - t < GUARDRAIL_ASK_TTL_MS) byPath[p] = at as string;
      }
    }
    byPath[match.path] = iso;
    asks[match.category] = byPath;
  } else {
    asks[match.category] = iso;
  }
  state.guardrailAsks = asks;
}

const FIRE_LOG_CAP = 50;

/**
 * The single hooks-state writer for the preflight lane (F11/F12). Appends the
 * fire to the capped `fires` log AND — when the fire came from the guardrail
 * backstop — stamps the dedup record, in ONE read-modify-write. Both
 * hand-maintained hook copies call this instead of carrying their own
 * recordFire, so the write shape cannot drift between them.
 *
 * The fire reason names the guardrail CLASS ("guardrail:migrations"), not a
 * bare "guardrail" — the companion UI's HookStatus renders these verbatim.
 */
export function recordHookFire(projectRoot: string, decision: HookDecision, now: number = Date.now()): void {
  try {
    const sp = path.join(projectRoot, ".deeppairing", "hooks-state.json");
    let state: Record<string, unknown> = { version: 1 };
    try {
      const parsed = JSON.parse(fs.readFileSync(sp, "utf-8"));
      if (parsed && typeof parsed === "object") state = parsed;
    } catch {
      /* fresh file */
    }
    state.version = 1;
    const fires = Array.isArray(state.fires) ? state.fires : [];
    fires.push({
      at: new Date(now).toISOString(),
      hook: "preflight",
      reason: decision.guardrail ? `guardrail:${decision.guardrail.category}` : decision.source || "blocked",
    });
    state.fires = fires.slice(-FIRE_LOG_CAP);
    if (decision.guardrail) stampGuardrailAsk(state, decision.guardrail, now);
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, JSON.stringify(state));
  } catch {
    /* recording must never fail the hook itself */
  }
}

/**
 * The human-facing ask text (F4).
 *
 * The rejected-approach lane got stripArtifactClause (#169) and toHookReason
 * (F6) precisely because a message written FOR THE AGENT reads wrong in a
 * permission prompt. This lane is written for the prompt from the start: it
 * leads with the decision the human owns, names what makes the path load-bearing
 * and what is missing, and says what declining will do. The agent-facing
 * instruction follows in parentheses — the reason string is fed back to the
 * model when the human declines, so it has to serve both readers, in that order.
 *
 * GUARDRAIL_ESCALATION stays as the greppable prefix, mirroring
 * REJECTED_APPROACH_BLOCKED on the other lane.
 */
export function guardrailReason(match: GuardrailMatch): string {
  return (
    `GUARDRAIL_ESCALATION — Allow this edit to ${match.path}? ` +
    `It's a guardrail path (${match.category} — ${match.note}), and no findings, options, spec, or plan ` +
    `is live in this project's recent sessions. Decline to have your pair present it for review first. ` +
    `(Agent: this is ESCALATED work — on a decline, present findings/options/a spec or plan before landing it.)`
  );
}

/**
 * The guardrail backstop, end to end. Returns the ask decision or null.
 *
 * PURE (F11): it decides, it does not write. The caller stamps the dedup record
 * via recordHookFire, folded into the same write as the fire log.
 *
 * Every step is individually try/caught and the whole thing is wrapped — any
 * fault yields null (pass).
 */
export function evaluateGuardrailBackstop(args: {
  toolInput: unknown;
  projectRoot: string;
  now?: number;
  env?: Record<string, string | undefined>;
}): HookDecision | null {
  const { projectRoot } = args;
  const now = args.now ?? Date.now();
  try {
    if (guardrailBackstopDisabled(args.env ?? process.env)) return null; // F7 — opt-out
    const input = args.toolInput as { file_path?: unknown; filePath?: unknown } | null;
    const fp = input?.file_path ?? input?.filePath;
    if (typeof fp !== "string" || !fp) return null;
    const match = matchGuardrailPath(projectRoot, [fp]);
    if (!match) return null; // (c) non-guardrail edit → pass, zero behaviour change
    // F10 — the cheap check first: one small JSON read beats scanning every
    // session dir, and inside a confirmed arc this is the common path.
    if (guardrailAskSuppressed(projectRoot, match.category, match.path, now)) return null;
    const ceremony = readSessionCeremony(projectRoot, now);
    if (!ceremony.reachable) return null; // (d) store unreachable → FAIL OPEN
    if (ceremony.hasLiveCeremony) return null; // (b) the escalated arc is in flight → pass silently
    return { fire: true, reason: guardrailReason(match), source: "guardrail", guardrail: match }; // (a)
  } catch {
    return null; // FAIL OPEN
  }
}

/** Evaluate a PreToolUse Edit/Write/MultiEdit against the project's rejected
 *  approaches + team prefs, then (P1) against the guardrail backstop. Returns
 *  `fire` + the reason to surface, or {fire:false}.
 *
 *  ORDER: the rejected-approach/team gate runs FIRST and its message is
 *  returned verbatim when it fires — it is the older, harder signal ("you are
 *  re-attempting something your pair refused"), and its wording is pinned by
 *  tests. The guardrail backstop is the fallback for the case that gate has
 *  nothing to say about. */
export function evaluatePreflightHook(args: {
  toolName: string;
  toolInput: unknown;
  projectRoot: string;
  now?: number;
  env?: Record<string, string | undefined>;
}): HookDecision {
  const { toolName, toolInput, projectRoot } = args;
  const { strings, paths } = buildProposals(toolName, toolInput);
  if (strings.length === 0) return { fire: false };

  const result = runPreflight({
    toolName,
    proposalStrings: strings,
    proposalPaths: paths,
    rejectedApproaches: readRejectedApproaches(projectRoot),
    teamPreferences: readTeamPreferences(projectRoot),
  });
  if (result.blocked) {
    // #169 + F6 — hook-facing reason: drop the agent-only "artifact was NOT
    // created" tail AND reword "refused" → "paused for your review" (the gate
    // asks the human, it doesn't hard-refuse). The REJECTED_APPROACH_BLOCKED
    // prefix + the rationale/concept/reason are preserved.
    return { fire: true, reason: toHookReason(result.block.message), source: result.block.source };
  }
  return evaluateGuardrailBackstop({ toolInput, projectRoot, now: args.now, env: args.env }) ?? { fire: false };
}
