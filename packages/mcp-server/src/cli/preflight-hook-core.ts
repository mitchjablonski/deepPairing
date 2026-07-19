import fs from "node:fs";
import path from "node:path";
import { runPreflight } from "../mcp/preflight-validator.js";
import type { RejectedApproach } from "../store/store-interface.js";
import type { TeamPreference } from "@deeppairing/shared";

/**
 * WP5 — the brains of the PreToolUse hook, split out so it's UNIT-TESTABLE and
 * shares the EXACT matcher the MCP-side preflight uses (no drift). The hook
 * .mjs is a thin stdin/stdout shell around evaluatePreflightHook.
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
  source?: "session" | "team";
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

/** Evaluate a PreToolUse Edit/Write/MultiEdit against the project's rejected
 *  approaches + team prefs. Returns deny + the matcher's LLM-facing reason, or
 *  {deny:false}. Pure given the projectRoot's on-disk ledgers. */
export function evaluatePreflightHook(args: {
  toolName: string;
  toolInput: any;
  projectRoot: string;
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
  if (!result.blocked) return { deny: false };
  // #169 + F6 — hook-facing reason: drop the agent-only "artifact was NOT
  // created" tail AND reword "refused" → "paused for your review" (the gate
  // asks the human, it doesn't hard-refuse). The REJECTED_APPROACH_BLOCKED
  // prefix + the rationale/concept/reason are preserved.
  return { deny: true, reason: toHookReason(result.block.message), source: result.block.source };
}
