import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { runPreflight } from "../mcp/preflight-validator.js";
import { sessionHasLivePreWorkCeremony } from "../debrief-gate.js";
// Q1 — the ONE guardrail rule table, in a Node-builtins-only leaf module that
// store/project-signals.ts, setup-tasks.ts and both hook entries also import.
// F14's hand-written "loose superset" prefilter is GONE: the hook entries call
// matchGuardrailPath (the authoritative matcher) in their early exit instead,
// so there is no second definition left to drift. See guardrail-rules.ts.
import { GUARDRAIL_RULES, matchGuardrailPath, toolInputTargetsGuardrail } from "../guardrail-rules.js";
import type { GuardrailMatch, GuardrailRule } from "../guardrail-rules.js";
export { GUARDRAIL_RULES, matchGuardrailPath, toolInputTargetsGuardrail };
export type { GuardrailMatch, GuardrailRule };
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
 * Q1 item 2 — the LOWER bound both windows were missing.
 *
 * Every recency test here was `now - t <= MAX`, which is satisfied by any
 * timestamp in the FUTURE, without limit. Two ways that disarms the gate, both
 * reachable without malice (a container with a skewed clock, a restored backup,
 * a hand-edited JSON):
 *   - a ceremony artifact stamped 2030 is "live" FOREVER, so no guardrail edit
 *     in this project ever asks again;
 *   - a dedup stamp in the future suppresses the ask forever AND survives every
 *     prune, because pruning used the same one-sided test.
 * A timestamp more than this far ahead of `now` is therefore treated as NOT
 * recent / NOT suppressing, and is pruned on the next write. The tolerance
 * absorbs ordinary clock skew (NTP jitter, a VM resuming) without absorbing a
 * wrong year.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/** True when `t` is within [now - maxAgeMs, now + CLOCK_SKEW_TOLERANCE_MS]. */
export function withinWindow(t: number, now: number, maxAgeMs: number): boolean {
  if (!Number.isFinite(t)) return false;
  const age = now - t;
  return age <= maxAgeMs && age >= -CLOCK_SKEW_TOLERANCE_MS;
}

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

/**
 * The guardrail class table, the file-rule predicates and the authoritative
 * matcher now live in ../guardrail-rules.ts — ONE definition shared by this
 * core, both hook entries, setup-tasks' generated script, and
 * senseProjectGuardrails. Re-exported at the top of this file so every existing
 * import site (and both hook copies) keeps working unchanged.
 */

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
 *   - store UNREACHABLE (no .deeppairing/sessions, an unreadable dir, or —
 *     Q1 item 3 — a dir whose every artifacts.json is present but unparseable)
 *     → reachable:false → the caller FAILS OPEN and never asks. We cannot tell
 *     whether the ceremony happened, and a hook must not block on ignorance.
 *   - reachable, a LIVE research/decision/spec/plan within CEREMONY_MAX_AGE_MS
 *     → hasLiveCeremony:true → pass silently.
 *   - reachable, nothing live → the exact skip case → ask.
 *
 * An individual unparseable artifacts.json is skipped, not fatal — one corrupt
 * session must not suppress a real ceremony in another, and a real SKIP beside
 * a corrupt session still deserves the ask. But when EVERY store present is
 * corrupt (Q1 item 3) there is no evidence either way, and SECURITY.md's stated
 * contract is "missing or unreadable → stays silent" — so that case reports
 * UNREACHABLE. Pre-Q1 the loop fell through to reachable:true and ASKED, i.e.
 * the code did the opposite of what the doc promised.
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
  // F9 + Q1 item 2 — bounded on BOTH sides: a missing/unparseable createdAt is
  // not eternally recent, and neither is a createdAt in the year 2030.
  const isRecent = (a: { createdAt?: string }) =>
    withinWindow(Date.parse(a?.createdAt ?? ""), now, CEREMONY_MAX_AGE_MS);
  // Q1 item 3 — count what we could actually READ, so an all-corrupt store
  // reports UNREACHABLE rather than "reachable, no ceremony" (see the header).
  let storesSeen = 0;
  let storesParsed = 0;
  for (const id of ids) {
    let arr: unknown;
    try {
      const af = path.join(sessionsDir, id, "artifacts.json");
      if (!fs.existsSync(af)) continue;
      storesSeen++;
      arr = JSON.parse(fs.readFileSync(af, "utf-8"));
      if (!Array.isArray(arr)) continue; // present but not a session store
    } catch {
      continue; // one bad session file must not decide the whole answer
    }
    storesParsed++;
    try {
      if (sessionHasLivePreWorkCeremony(arr as never[], isRecent)) {
        return { reachable: true, hasLiveCeremony: true };
      }
    } catch {
      continue;
    }
  }
  // Every artifacts.json present was unreadable → we cannot tell whether the
  // ceremony happened. SECURITY.md's contract is "missing OR unreadable store →
  // stays silent", so this is the fail-open case, not the ask case.
  if (storesSeen > 0 && storesParsed === 0) return { reachable: false, hasLiveCeremony: false };
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
    // Q1 item 2 — a FUTURE stamp does not suppress (it would suppress forever).
    return withinWindow(Date.parse(at), now, GUARDRAIL_ASK_TTL_MS - 1);
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
        // Q1 item 2 — the prune uses the SAME two-sided test as the suppression
        // check, so a future-dated stamp is dropped instead of living forever.
        const t = typeof at === "string" ? Date.parse(at) : NaN;
        if (withinWindow(t, now, GUARDRAIL_ASK_TTL_MS - 1)) byPath[p] = at as string;
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
 * Q1 item 4 — the atomic write, ported into the hook lane.
 *
 * hooks-state.json had FOUR unlocked read-modify-write writers — this one, both
 * Stop copies (the plugin-bundled entry and setup-tasks' generated twin), and
 * the generated checkpoint script — all ending in a plain `fs.writeFileSync`. Two hooks firing in the same instant could interleave a
 * torn write, and the next reader's `JSON.parse` throws — at which point the
 * catch below used to reset the file to `{version:1}`, DISCARDING every prior
 * fire with no backup. That is the exact failure the project's own salvage rule
 * forbids ("back up before any committing drop").
 *
 * Same tmp+rename guarantee as store/atomic-write.ts's writeStringAtomic, but
 * re-implemented here in Node builtins only: this module is dynamically
 * imported by the init-generated `.mjs` under plain `node`, so it cannot reach
 * into the store layer. (Same discipline as readTeamPreferences above.)
 */
export function writeHookStateAtomic(statePath: string, state: unknown): void {
  const tmp = `${statePath}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, statePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never mask the real error */ }
    throw err;
  }
}

/**
 * M1 (round-12 adversarial review) — the atomic write was necessary and NOT
 * sufficient.
 *
 * tmp+rename guarantees no reader ever sees a torn file. It does NOT serialize
 * read-modify-write: two hooks that both read state N and both rename their
 * N+1 leave one of the two updates gone. Measured with 8 parallel invocations:
 * 8 asks were emitted, but only 4 fire records and — the part that matters — 4
 * DEDUP STAMPS survived. A dropped stamp means the same file asks again inside
 * its 30-minute window, which is the spurious-ask failure H1 is about.
 *
 * So the whole RMW runs under an O_EXCL lockfile. Hooks are sub-100 ms
 * processes, so a short spin is the right shape (no async, no dependency):
 *   - O_EXCL create is the atomic test-and-set;
 *   - a lock older than LOCK_STALE_MS is BROKEN, so a hook killed mid-write
 *     cannot wedge every later one;
 *   - failing to acquire within LOCK_MAX_WAIT_MS proceeds UNSYNCHRONIZED
 *     rather than dropping the record — degraded beats silent, and a hook may
 *     never fail the tool call it is gating.
 */
const LOCK_STALE_MS = 5_000;
const LOCK_SPIN_MS = 2;
const LOCK_MAX_WAIT_MS = 500;

/** Synchronous sleep — the hook lane has no async seam to yield through. */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* SharedArrayBuffer unavailable — spin-free fallback: just retry */
  }
}

/** Returns the lock path on success, or null to proceed unsynchronized. */
export function acquireHookStateLock(statePath: string, now: number = Date.now()): string | null {
  const lock = `${statePath}.lock`;
  const deadline = now + LOCK_MAX_WAIT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY));
      return lock;
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lock); // a crashed hook must not wedge the next one
          continue;
        }
      } catch {
        continue; // the holder released it between our open and our stat
      }
      if (Date.now() >= deadline) return null;
      sleepSync(LOCK_SPIN_MS);
    }
  }
}

export function releaseHookStateLock(lock: string | null): void {
  if (!lock) return;
  try {
    fs.unlinkSync(lock);
  } catch {
    /* already gone */
  }
}

/**
 * Q1 item 4 — read hooks-state.json, and NEVER silently discard history.
 *
 * Three outcomes:
 *   - absent            → a fresh `{version:1}`, no backup (nothing was lost);
 *   - present + valid   → the parsed object;
 *   - present + corrupt → a fresh object, but the bytes are first copied to
 *     `hooks-state.json.corrupt-<ISO>` so the fire log is recoverable by hand.
 *     The backup is best-effort: if it fails we still reset, because a hook may
 *     never fail the tool call it is gating.
 */
export function readHookState(statePath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(statePath, "utf-8");
  } catch {
    return { version: 1 }; // absent / unreadable — nothing to salvage
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* fall through to the salvage copy */
  }
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(`${statePath}.corrupt-${stamp}`, raw);
  } catch {
    /* best-effort */
  }
  return { version: 1 };
}

/**
 * The single hooks-state writer for the preflight lane (F11/F12). Appends the
 * fire to the capped `fires` log AND — when the fire came from the guardrail
 * backstop — stamps the dedup record, in ONE read-modify-write. Both
 * hand-maintained hook copies call this instead of carrying their own
 * recordFire, so the write shape cannot drift between them.
 *
 * The fire reason names the guardrail CLASS ("guardrail:migrations"), not a
 * bare "guardrail" — the companion UI's HookStatus renders these verbatim.
 *
 * Q1 item 5 — it also records `kind`. Pre-Q1 a preflight fire carried neither
 * `exitCode` nor any other outcome marker, while the Stop/checkpoint hooks write
 * `exitCode`; HookStatus keys on `exitCode === 2`, so EVERY guardrail ask and
 * every rejected-approach block rendered as a green "pass" — the UI said the
 * opposite of what happened. Every fire on this lane surfaces as
 * permissionDecision "ask", so this lane always writes `"ask"`. The contract
 * with the UI side (landed separately) is `kind?: "ask" | "pass"` — OPTIONAL,
 * so a record written by an older build, or by the Stop/checkpoint hooks (which
 * deliberately keep writing `exitCode` instead: a stderr nag that exits 0 is
 * honestly neither), keeps rendering exactly as it does today. There is no
 * `kind` declaration in this file to point at; the field is written here and
 * typed where the fire log is read.
 */
export function recordHookFire(projectRoot: string, decision: HookDecision, now: number = Date.now()): void {
  try {
    const sp = path.join(projectRoot, ".deeppairing", "hooks-state.json");
    // Before the lock — O_EXCL needs the directory to exist.
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    const lock = acquireHookStateLock(sp);
    try {
      const state = readHookState(sp);
      state.version = 1;
      const fires = Array.isArray(state.fires) ? state.fires : [];
      fires.push({
        at: new Date(now).toISOString(),
        hook: "preflight",
        kind: "ask" as const,
        reason: decision.guardrail ? `guardrail:${decision.guardrail.category}` : decision.source || "blocked",
      });
      state.fires = fires.slice(-FIRE_LOG_CAP);
      if (decision.guardrail) stampGuardrailAsk(state, decision.guardrail, now);
      writeHookStateAtomic(sp, state);
    } finally {
      releaseHookStateLock(lock);
    }
  } catch {
    /* recording must never fail the hook itself */
  }
}

/**
 * The human-facing ask text (F4, restructured in Q1 item 6).
 *
 * The rejected-approach lane got stripArtifactClause (#169) and toHookReason
 * (F6) precisely because a message written FOR THE AGENT reads wrong in a
 * permission prompt. This lane was written for the prompt from the start, but
 * round-12 found it DOUBLE-ADDRESSED: it opened with a screaming machine token,
 * embedded a parenthetical "(Agent: ...)" mid-paragraph inside the human's
 * dialog, and said "your pair" in a sentence the pair was also reading.
 *
 * The string still has to serve both readers — Claude Code feeds
 * permissionDecisionReason back to the model when the human declines, so the
 * agent instruction must stay. So it is SEQUENCED rather than deleted: the
 * human's decision comes first, in plain prose, and the machine-greppable token
 * plus the agent instruction ride together on a final bracketed line, visually
 * subordinate but still `grep GUARDRAIL_ESCALATION`-able (mirroring
 * REJECTED_APPROACH_BLOCKED on the other lane).
 *
 * The "what would make this stop" clause is kept — dogfood singled it out as
 * the reason the ask doesn't feel like a nag.
 */
export function guardrailReason(match: GuardrailMatch): string {
  return (
    `Allow this edit to ${match.path}? ` +
    `It's a guardrail path (${match.category} — ${match.note}), and no findings, options, spec, or plan ` +
    `is live in this project's recent sessions. Decline to have it presented for review first — ` +
    `presenting findings, options, a spec, or a plan is what makes this prompt stop.\n` +
    `[GUARDRAIL_ESCALATION — agent: this is ESCALATED work. On a decline, present findings/options/a spec ` +
    `or plan before landing it.]`
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
