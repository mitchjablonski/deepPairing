import { findRejectedApproachMatch, meaningfulTokens, normalizeConceptKey, containmentBlockAllowed } from "../mcp/preflight-validator.js";
import { scanForSecrets } from "../secret-scan.js";
import type { IStore, RejectedApproach, StanceAddedVia, StanceRequestedBy } from "./store-interface.js";

/**
 * #620 Phase 1 item 1 — a human records a stance from the terminal:
 * `deeppairing stance add <what> -- <why>` (CLI) and `/deeppairing:reject
 * <what> -- <why>` (the plugin wrapper, which calls the `record_stance` MCP
 * tool with the human's words verbatim). Both doors go through THIS module —
 * the same parser, validation, recovery guard and write — so they cannot
 * drift.
 *
 * ONE PERSISTENCE PATH, NOTHING NEW MATCHED. A stance added here is an
 * ordinary project-local row in `.deeppairing/preferences.json`
 * `rejectedApproaches`, written by `IStore.recordRejectedApproach` (the same
 * write a rejected artifact or "None of these fit" uses), keyed like
 * recordRejectedOptionConcept: `description === concept === <what>`,
 * `reason === <why>`. The present_* gate, the PreToolUse hook, the gate log's
 * Retire, allow-once, the cross-project publish opt-in and a daemon restart
 * all treat it like any other stance. The only addition is provenance
 * (`addedVia`, `requestedBy`), which nothing matches on.
 *
 * ADD-ONLY. An existing row with the same key is reported and never rewritten
 * (its reason is not replaced); there is no remove/retire/weaken path here.
 * Correction and removal stay where they were: "Retire this stance" in the
 * companion gate log (human, behind a confirm), or a hand edit of
 * preferences.json (an agent Edit/Write there always asks).
 *
 * HUMAN REQUEST ONLY, BY CONTRACT NOT BY PROOF. The MCP door accepts only
 * `requestedBy: "user"` and the human's verbatim `<what> -- <why>` text; it is
 * described as never to be called on the agent's own initiative or from
 * reviewer/agent prose. Over stdio the server cannot tell who typed the words,
 * so `requestedBy` is SELF-REPORTED, like the `UI`/`CLI` label on a stance
 * allowance: it names the door's claim, it never authenticates anyone.
 */

/** A stance is a short phrase you could say out loud. Longer is a paste. */
export const STANCE_CONCEPT_MIN = 3;
export const STANCE_CONCEPT_MAX = 120;
/** Same bounds as the reason on `stance allow` (cli/stance-allow.ts). */
export const STANCE_REASON_MIN = 3;
export const STANCE_REASON_MAX = 280;

export const STANCE_USAGE = "<what to avoid> -- <why>";

/**
 * Text deepPairing's own recovery paths put in front of the gate: the commands
 * and buttons used to get out of a wrong block, and the state files they
 * touch. A stance that would match any of these is refused, so a stance never
 * stands between you and the way out of a stance. Checked with the REAL
 * matcher (findRejectedApproachMatch), so the guard and the gate agree.
 */
export const RECOVERY_PROBES: readonly string[] = [
  "deeppairing doctor --fix",
  "/deeppairing:doctor",
  "/deeppairing:stance",
  "/deeppairing:reject",
  "deeppairing stance allow",
  "deeppairing stance exceptions revoke",
  "deeppairing stance add",
  "deeppairing philosophy remove",
  "deeppairing philosophy publish off",
  "Allow this proposal once",
  "Retire this stance",
  "check_feedback",
  "record_stance",
  ".deeppairing/preferences.json",
  ".deeppairing/team.json",
];

/** Control, format (bidi, zero-width), private-use, surrogate and line/para
 *  separator characters. A stance is quoted back in prompts and terminals; an
 *  invisible character would make two stances look identical. */
const HIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/u;

export type StanceInputResult =
  | { ok: true; concept: string; reason: string }
  | { ok: false; error: string };

/** Collapse runs of whitespace (incl. newlines/tabs) to one space and trim. */
function tidy(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Split `<what> -- <why>`. The separator is the FIRST ` -- ` (or, from a CLI
 * argv, a standalone `--` token), so a reason may itself contain `--`. No
 * separator → empty reason → refused by validation.
 */
export function parseStanceArguments(raw: string | readonly string[]): { what: string; why: string } {
  if (Array.isArray(raw)) {
    const at = raw.indexOf("--");
    if (at >= 0) return { what: raw.slice(0, at).join(" "), why: raw.slice(at + 1).join(" ") };
    return parseStanceArguments(raw.join(" "));
  }
  const m = /^([\s\S]*?)\s--(?:\s+|$)([\s\S]*)$/.exec(` ${raw as string}`);
  if (!m) return { what: raw as string, why: "" };
  // Drop the one space prepended above (it lets a bare leading `-- why` split).
  return { what: m[1]!.slice(1), why: m[2]! };
}

/**
 * Validate + tidy a stance. Concept hygiene for a HUMAN-WORDED key: whitespace
 * collapsed, bounded, no hidden characters, nothing secret-shaped, at least one
 * word the matcher can use, and nothing that would block a recovery path. The
 * words are otherwise kept as typed (store/concept-hygiene.ts strips a leading
 * path only from machine-derived titles, never from a concept you wrote).
 */
export function validateStanceInput(input: { what: unknown; why: unknown }): StanceInputResult {
  if (typeof input.what !== "string" || typeof input.why !== "string") {
    return { ok: false, error: `Both what to avoid and why are required, as text: ${STANCE_USAGE}.` };
  }
  const visible = (s: string) => s.replace(/[\t\n\r]/g, " ");
  if (HIDDEN_CHARS.test(visible(input.what)) || HIDDEN_CHARS.test(visible(input.why))) {
    return { ok: false, error: "The stance contains control or invisible characters. Type it again as plain text." };
  }
  const concept = tidy(input.what);
  const reason = tidy(input.why);
  if (!concept) return { ok: false, error: `Say what to avoid: ${STANCE_USAGE}.` };
  if (!reason) {
    return { ok: false, error: `A reason is required after " -- ": ${STANCE_USAGE}. It is quoted back whenever the stance fires.` };
  }
  if (concept.length < STANCE_CONCEPT_MIN) return { ok: false, error: `What to avoid is too short (at least ${STANCE_CONCEPT_MIN} characters).` };
  if (concept.length > STANCE_CONCEPT_MAX) {
    return { ok: false, error: `What to avoid is ${concept.length} characters; keep it to a short phrase (at most ${STANCE_CONCEPT_MAX}). The gate matches words, so name the approach in the words the agent would use.` };
  }
  if (reason.length < STANCE_REASON_MIN) return { ok: false, error: `The reason is too short (at least ${STANCE_REASON_MIN} characters).` };
  if (reason.length > STANCE_REASON_MAX) return { ok: false, error: `The reason is ${reason.length} characters; keep it to ${STANCE_REASON_MAX} or fewer.` };
  if (scanForSecrets(concept).length > 0 || scanForSecrets(reason).length > 0) {
    return { ok: false, error: "The stance looks like it contains a secret (a key or token shape). Describe the approach without it." };
  }
  if (meaningfulTokens(concept).length === 0) {
    return { ok: false, error: `"${concept}" has no word the gate can match on (only short or common words). Name the approach, e.g. "global mutable state for config".` };
  }
  const recovery = findRejectedApproachMatch([...RECOVERY_PROBES], [{ description: concept, concept }]);
  if (recovery) {
    return { ok: false, error: `"${concept}" would also match deepPairing's own recovery path ("${recovery.proposal}"), which a stance must never block. Name the approach more specifically.` };
  }
  return { ok: true, concept, reason };
}

/**
 * What the stance will and won't catch, in plain words. Derived from the
 * matcher's own rules (findRejectedApproachMatch), so it describes the gate.
 */
export function describeStanceCoverage(concept: string): string[] {
  const lower = concept.toLowerCase();
  const specific = lower.includes(":") ? lower.split(":").slice(1).join(":").trim() : "";
  const tokens = [...new Set(meaningfulTokens(concept))];
  const lines = [
    `Catches: a present_* proposal, or an Edit/Write/MultiEdit, whose text contains the phrase "${concept}" (whole words, any case). A present_* proposal is refused; a direct edit pauses for your answer.`,
  ];
  if (specific) lines.push(`Catches: the part after the colon, "${specific}", on its own (the part before it is treated as a category).`);
  if (containmentBlockAllowed(concept)) {
    lines.push(`Catches: text containing all of these words in any order, with simple word forms (state/states): ${tokens.join(", ")}.`);
  } else {
    lines.push("Single-word stance: only the word itself, or a proposal naming exactly this concept, is caught.");
  }
  lines.push("Also caught: a short proposal field (a title or option name) made only of words from this phrase, in order.");
  lines.push("Won't catch: rewordings that use different words (this is word matching, not meaning), Bash commands, or notebook edits. If the hook errors or can't read the stance file, the edit proceeds (fail-open).");
  return lines;
}

export type RecordStanceOutcome =
  | { status: "recorded"; concept: string; reason: string }
  | { status: "exists"; concept: string; existing: RejectedApproach }
  | { status: "invalid"; error: string };

/**
 * The one write path both doors share. Validates, refuses a duplicate key
 * (case/whitespace-insensitive) WITHOUT touching the existing row, then records
 * through the store's ordinary rejected-approach write.
 */
export async function recordStance(
  store: Pick<IStore, "recordRejectedApproach" | "getSessionMemory">,
  input: { what: unknown; why: unknown; addedVia: StanceAddedVia; requestedBy: StanceRequestedBy },
): Promise<RecordStanceOutcome> {
  const v = validateStanceInput(input);
  if (!v.ok) return { status: "invalid", error: v.error };
  const key = normalizeConceptKey(v.concept);
  const memory = await store.getSessionMemory();
  const existing = memory.rejectedApproaches.find(
    (r) => normalizeConceptKey(r.description) === key || (typeof r.concept === "string" && normalizeConceptKey(r.concept) === key),
  );
  if (existing) return { status: "exists", concept: v.concept, existing };
  await store.recordRejectedApproach({
    description: v.concept,
    concept: v.concept,
    reason: v.reason,
    addedVia: input.addedVia,
    requestedBy: input.requestedBy,
  });
  return { status: "recorded", concept: v.concept, reason: v.reason };
}

/** How a project stance came to exist, for listings and readback. */
export function stanceProvenance(r: RejectedApproach): string {
  const who = r.requestedBy === "user" ? "user (self-reported)" : "unknown";
  if (r.addedVia === "cli") return `added with \`deeppairing stance add\`, requested by: ${who}`;
  if (r.addedVia === "mcp") return `added with /deeppairing:reject (record_stance), requested by: ${who}`;
  if (r.sourceArtifactId) return `rejected in the companion (${r.sourceArtifactId})`;
  return "rejected in the companion";
}

/** The text both doors print after a write. `scope` names the project. */
export function formatRecordStanceOutcome(outcome: RecordStanceOutcome, scope: string): { ok: boolean; text: string } {
  if (outcome.status === "invalid") return { ok: false, text: `Nothing was recorded. ${outcome.error}` };
  if (outcome.status === "exists") {
    const e = outcome.existing;
    return {
      ok: true,
      text:
        `Nothing changed: ${scope} already has the stance "${e.concept ?? e.description}"` +
        (e.reason ? ` (reason: "${e.reason}")` : " (no reason recorded)") +
        `, ${stanceProvenance(e)}. An existing stance is never rewritten here; to change it, retire it ("Retire this stance" in the companion's gate log) and add it again.`,
    };
  }
  return {
    ok: true,
    text: [
      "Stance recorded.",
      `  Concept: "${outcome.concept}"`,
      `  Reason:  "${outcome.reason}" (quoted back whenever it fires)`,
      `  Scope:   ${scope} only (.deeppairing/preferences.json). Other projects see it only as an advisory nudge, and only if this project publishes to the cross-project ledger.`,
      ...describeStanceCoverage(outcome.concept).map((l) => `  ${l}`),
      `To correct or remove it: "Retire this stance" in the companion's gate log when it fires, or delete its row from .deeppairing/preferences.json yourself (an agent edit there always asks).`,
    ].join("\n"),
  };
}
