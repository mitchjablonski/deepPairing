import fs from "node:fs";
import path from "node:path";
import { runPreflight } from "../mcp/preflight-validator.js";
import { sessionHasLivePreWorkCeremony } from "../debrief-gate.js";
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
  deny: boolean;
  reason?: string;
  source?: "session" | "team" | "guardrail";
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
//   (migrations, .github/workflows, infra, .env/secret files), AND no live
//   pre-work ceremony exists in the session.
//   → permissionDecision "ask", naming the class + the matched path.
//
//   NEVER "deny" (SECURITY.md's ask-never-deny contract), always local-only
//   (project .deeppairing/ reads + one small state write), and FAIL OPEN on any
//   error, unreadable store, or unreachable session store.
//
// The hard design question was how NOT to nag legitimately-escalated work. The
// backstop fires ONLY in the exact skip case: if the agent already did the
// ceremony — a LIVE findings/options/spec/plan in the session, i.e. the
// escalated arc IS in flight — the guardrail edit passes SILENTLY. Liveness is
// defined once, next to the debrief gate's (debrief-gate.ts
// sessionHasLivePreWorkCeremony), and counts LIVE artifacts only.
//
// A non-guardrail edit is completely untouched: one regex test against the file
// path, no extra I/O, no output. Zero behaviour change for the low-risk class —
// that is the point.

/** Recency window for a pre-work ceremony artifact — one working arc. Long
 *  enough that an approved spec still covers a multi-hour implementation run
 *  (re-asking mid-arc would be the nag failure); short enough that YESTERDAY's
 *  spec cannot licence today's unceremonious migration. */
export const CEREMONY_MAX_AGE_MS = 8 * 60 * 60 * 1000;

/** Dedup window for a fired guardrail ask, per guardrail CLASS. See
 *  guardrailAskSuppressed for why per-class-per-window is the right grain. */
export const GUARDRAIL_ASK_TTL_MS = 30 * 60 * 1000;

export interface GuardrailMarker {
  category: string;
  /** Project-root-relative paths that define the class. */
  roots: string[];
  rationale: string;
}

/**
 * The guardrail class table. This is a hand-maintained MIRROR of
 * senseProjectGuardrails (store/project-signals.ts) — the set the 🛡 section of
 * the first-call hint renders — kept byte-equivalent by
 * guardrail-backstop-parity.test.ts, which runs BOTH over a fixture matrix.
 *
 * Why mirrored and not imported: this module is loaded by the init-generated
 * hook under plain `node` out of .deeppairing/hooks/, so it must stay
 * dependency-light (Node builtins only). project-signals imports
 * @deeppairing/shared. Same discipline as readTeamPreferences above, which
 * re-implements parseTeamPreferencesFile for the same reason.
 */
export const GUARDRAIL_MARKERS: GuardrailMarker[] = [
  {
    category: "migrations",
    roots: ["migrations", "db/migrate", "prisma/migrations", "supabase/migrations"],
    rationale: "Migrations are hard to reverse.",
  },
  {
    category: "workflows",
    roots: [".github/workflows"],
    rationale: "CI workflows affect every future deploy.",
  },
  {
    category: "infrastructure",
    roots: [
      "Dockerfile",
      "docker-compose.yml",
      "docker-compose.yaml",
      "infrastructure",
      "terraform",
      "k8s",
      "kubernetes",
      "helm",
    ],
    rationale: "Infrastructure changes affect production surfaces.",
  },
  {
    category: "secrets",
    roots: [".env", ".env.local", ".env.production", "config/secrets.yml"],
    rationale: "Secret files must never leak into the session or a commit.",
  },
];

/**
 * ZERO-I/O prefilter over a raw tool_input path, used by BOTH hook copies to
 * decide whether the guardrail evaluation is worth paying for at all. Kept
 * deliberately LOOSE (it matches nested occurrences the authoritative
 * root-relative matcher rejects) — a false positive here costs one cheap
 * evaluation, never an ask. The init-generated .mjs cannot import, so
 * setup-tasks.ts INTERPOLATES this exact literal into the generated script:
 * parity is by construction, and pinned by the parity test.
 */
export const GUARDRAIL_PATH_PREFILTER =
  /(^|\/)(\.github\/workflows|migrations|db\/migrate|prisma\/migrations|supabase\/migrations|Dockerfile|docker-compose|infrastructure|terraform|k8s|kubernetes|helm|\.env|config\/secrets)(\/|\.|$)/;

/** True when any path in the tool_input could plausibly be a guardrail path.
 *  Windows separators normalized so the same literal works on both platforms. */
export function looksLikeGuardrailPath(toolInput: any): boolean {
  try {
    const fp = toolInput?.file_path ?? toolInput?.filePath;
    if (typeof fp !== "string" || !fp) return false;
    return GUARDRAIL_PATH_PREFILTER.test(fp.replace(/\\/g, "/"));
  } catch {
    return false;
  }
}

export interface GuardrailMatch {
  category: string;
  /** The project-relative path that matched (what the human sees named). */
  path: string;
  /** The guardrail root that owns it. */
  root: string;
  rationale: string;
}

/**
 * Authoritative match: is this edit's target under a guardrail root of THIS
 * project? Root-relative, like senseProjectGuardrails — `packages/db/migrations`
 * does NOT match, exactly as the 🛡 section wouldn't list it. A path outside the
 * project root never matches.
 *
 * Deliberately NOT gated on fs.existsSync of the root. senseProjectGuardrails
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
      for (const marker of GUARDRAIL_MARKERS) {
        for (const root of marker.roots) {
          if (rel === root || rel.startsWith(root + "/")) {
            return { category: marker.category, path: rel, root, rationale: marker.rationale };
          }
        }
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
 * Three-way on purpose:
 *   - store UNREACHABLE (no .deeppairing/sessions, or an unreadable dir) →
 *     reachable:false → the caller FAILS OPEN and never asks. We cannot tell
 *     whether the ceremony happened, and a hook must not block on ignorance.
 *   - reachable, a LIVE research/decision/spec/plan within CEREMONY_MAX_AGE_MS
 *     → hasLiveCeremony:true → pass silently.
 *   - reachable, nothing live → the exact skip case → ask.
 *
 * Scans every session dir (the hook has no session id, same as the Stop hook)
 * and stops at the first session with live ceremony. An individual unparseable
 * artifacts.json is skipped, not fatal — one corrupt session must not suppress
 * a real ceremony in another.
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
  const isRecent = (a: { createdAt?: string }) => {
    const t = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
    return !t || now - t <= CEREMONY_MAX_AGE_MS;
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
 * DEDUP. PreToolUse never learns the human's answer — "allow" and "decline" both
 * come back as silence, and an allowed Edit is followed by more Edits that fire
 * the hook again. Left alone the backstop would re-ask on every write of the
 * arc: the nag failure that killed reasoning cards.
 *
 * So the ask is treated as DELIVERED once per guardrail CLASS per
 * GUARDRAIL_ASK_TTL_MS. Per CLASS, not per FILE, because the message is about
 * the ARC ("this is escalated work — present it before landing it"), not about
 * an individual file; re-asking for the second workflow file in the same arc
 * says nothing new. The window re-opens after 30 idle minutes in that class,
 * matching the hooks' existing "recent work" convention (the Stop hook's
 * abandoned-draft guard).
 *
 * State rides in .deeppairing/hooks-state.json — the file the hooks already
 * write and the companion UI already reads — under a `guardrailAsks` map, next
 * to `fires`. Unreadable state → NOT suppressed (ask), the conservative side.
 */
export function guardrailAskSuppressed(projectRoot: string, category: string, now: number = Date.now()): boolean {
  try {
    const sp = path.join(projectRoot, ".deeppairing", "hooks-state.json");
    const state = JSON.parse(fs.readFileSync(sp, "utf-8"));
    const at = state?.guardrailAsks?.[category];
    if (typeof at !== "string") return false;
    const t = new Date(at).getTime();
    if (!Number.isFinite(t)) return false;
    return now - t < GUARDRAIL_ASK_TTL_MS;
  } catch {
    return false;
  }
}

/** Stamp a fired guardrail ask. Preserves every other key in hooks-state.json
 *  (the `fires` log the entries append after this) and never throws. */
export function recordGuardrailAsk(projectRoot: string, category: string, now: number = Date.now()): void {
  try {
    const sp = path.join(projectRoot, ".deeppairing", "hooks-state.json");
    let state: any = { version: 1 };
    try {
      const parsed = JSON.parse(fs.readFileSync(sp, "utf-8"));
      if (parsed && typeof parsed === "object") state = parsed;
    } catch {
      /* fresh file */
    }
    state.version = 1;
    if (!state.guardrailAsks || typeof state.guardrailAsks !== "object") state.guardrailAsks = {};
    state.guardrailAsks[category] = new Date(now).toISOString();
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, JSON.stringify(state));
  } catch {
    /* recording must never fail the hook itself */
  }
}

/** The human-facing (and agent-facing) ask text. GUARDRAIL_ESCALATION is the
 *  greppable marker, mirroring REJECTED_APPROACH_BLOCKED on the other lane. */
export function guardrailReason(match: GuardrailMatch): string {
  return (
    `GUARDRAIL_ESCALATION — this touches a guardrail path (${match.category}: ${match.path}). ` +
    `${match.rationale} That makes this ESCALATED work: present findings/options/a spec or plan for review ` +
    `before it lands, or confirm here to proceed. ` +
    `(No findings, options, spec, or plan is live in this session — that's why you're being asked.)`
  );
}

/**
 * The guardrail backstop, end to end. Returns the ask decision or null.
 *
 * Side effect by design: when it decides to ask, it stamps the dedup record, so
 * both hand-maintained hook copies stay thin and cannot drift on the dedup
 * rule. Every step is individually try/caught and the whole thing is wrapped —
 * any fault yields null (pass).
 */
export function evaluateGuardrailBackstop(args: {
  toolInput: any;
  projectRoot: string;
  now?: number;
}): HookDecision | null {
  const { toolInput, projectRoot } = args;
  const now = args.now ?? Date.now();
  try {
    const fp = toolInput?.file_path ?? toolInput?.filePath;
    if (typeof fp !== "string" || !fp) return null;
    const match = matchGuardrailPath(projectRoot, [fp]);
    if (!match) return null; // (c) non-guardrail edit → pass, zero behaviour change
    const ceremony = readSessionCeremony(projectRoot, now);
    if (!ceremony.reachable) return null; // (d) store unreachable → FAIL OPEN
    if (ceremony.hasLiveCeremony) return null; // (b) the escalated arc is in flight → pass silently
    if (guardrailAskSuppressed(projectRoot, match.category, now)) return null; // already asked this arc
    recordGuardrailAsk(projectRoot, match.category, now);
    return { deny: true, reason: guardrailReason(match), source: "guardrail" }; // (a) the skip case
  } catch {
    return null; // FAIL OPEN
  }
}

/** Evaluate a PreToolUse Edit/Write/MultiEdit against the project's rejected
 *  approaches + team prefs, then (P1) against the guardrail backstop. Returns
 *  deny + the LLM-facing reason, or {deny:false}.
 *
 *  ORDER: the rejected-approach/team gate runs FIRST and its message is
 *  returned verbatim when it fires — it is the older, harder signal ("you are
 *  re-attempting something your pair refused"), and its wording is pinned by
 *  tests. The guardrail backstop is the fallback for the case that gate has
 *  nothing to say about. */
export function evaluatePreflightHook(args: {
  toolName: string;
  toolInput: any;
  projectRoot: string;
  now?: number;
}): HookDecision {
  const { toolName, toolInput, projectRoot } = args;
  const { strings, paths } = buildProposals(toolName, toolInput);
  if (strings.length === 0) return { deny: false };

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
    return { deny: true, reason: toHookReason(result.block.message), source: result.block.source };
  }
  return evaluateGuardrailBackstop({ toolInput, projectRoot, now: args.now }) ?? { deny: false };
}
