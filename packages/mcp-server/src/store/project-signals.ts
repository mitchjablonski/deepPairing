import fs from "node:fs";
import path from "node:path";
import type { TeamPreference } from "@deeppairing/shared";
import { parseTeamPreferencesFile } from "@deeppairing/shared";
import { GUARDRAIL_RULES, matchesGuardrailFile } from "../guardrail-rules.js";

export interface ProjectGuardrail {
  /** Short identifier like "migrations" or "workflows". */
  category: string;
  /** Relative path(s) that triggered the guardrail. */
  paths: string[];
  /** Human-readable rationale — why the agent should escalate here. */
  rationale: string;
}

/**
 * The sensed guardrail classes.
 *
 * Q1 (round-12) — this used to be `GUARDRAIL_SENSORS`, a byte-identical
 * copy-paste of the hook's `GUARDRAIL_RULES`, kept honest by a parity test. The
 * review's verdict was blunt: the two frank copies never drifted, but the copy
 * count itself was the defect (the guardrail path set lived in five source
 * locations). Both now IMPORT the one table in `../guardrail-rules.ts` — a
 * Node-builtins-only leaf module, light enough for the hook's dependency
 * contract and for the CLI cold start. What survives here is only what is
 * genuinely different: the sensor ENUMERATES (it has no edit in hand, so it
 * needs filesystem existence) while the matcher CLASSIFIES a given path.
 *
 * The scope divergence is deliberate and documented: the matcher matches
 * guardrail dirs at any depth (the monorepo fix — `packages/api/migrations/*`),
 * this sensor stays ROOT-relative because walking a whole monorepo on every
 * FileStore construction is not worth it. The divergence runs in the safe
 * direction (everything rendered in the 🛡 section is something the hook asks
 * about) and is pinned in both directions by
 * cli/__tests__/guardrail-backstop-parity.test.ts.
 */

/** Directories whose entries can produce a file-rule hit. Root plus `config/`
 *  — every file rule above is rooted in one of the two. */
const FILE_SCAN_DIRS = ["", "config"];

/**
 * Sense the project's sensitive areas by filesystem signals alone — no
 * config. Runs once on FileStore construction; cached per instance. The
 * agent receives these in firstCallHint and knows to stay supervised for
 * changes in these paths even when global autonomy is "autonomous", and the
 * preflight backstop asks before a write to one of them lands without ceremony.
 *
 * Reports the paths it actually FOUND, so the 🛡 hint section names real files
 * (`.env.staging`, `Dockerfile.prod`) rather than a canned list.
 */
export function senseProjectGuardrails(projectRoot: string): ProjectGuardrail[] {
  const isDir = (rel: string) => {
    try { return fs.statSync(path.join(projectRoot, rel)).isDirectory(); } catch { return false; }
  };
  // One readdir per scan dir, shared across all four sensors.
  const candidates: string[] = [];
  for (const dir of FILE_SCAN_DIRS) {
    try {
      for (const name of fs.readdirSync(path.join(projectRoot, dir) || projectRoot)) {
        candidates.push(dir ? `${dir}/${name}` : name);
      }
    } catch {
      /* missing or unreadable — nothing to contribute */
    }
  }

  const guardrails: ProjectGuardrail[] = [];
  for (const sensor of GUARDRAIL_RULES) {
    const paths = [
      ...sensor.dirs.filter(isDir),
      ...candidates.filter((rel) => matchesGuardrailFile(sensor, rel)),
    ];
    if (paths.length > 0) {
      guardrails.push({ category: sensor.category, paths, rationale: sensor.rationale });
    }
  }
  return guardrails;
}

/**
 * Load and validate `.deeppairing/team.json`. Returns [] for any failure
 * mode (missing, unreadable, malformed) — team prefs are advisory; we never
 * crash a session over a broken file. The caller can log if it cares.
 */
/**
 * Strip JSONC-style `//` line comments so team.json can ship with a header
 * explaining what the kinds mean. Naive but good enough: strips a leading
 * `//...` only when the comment starts at the beginning of the line
 * (after whitespace) — avoids clobbering `//` inside strings like URLs.
 */
function stripJsoncComments(src: string): string {
  return src
    .split("\n")
    .map((line) => (/^\s*\/\//.test(line) ? "" : line))
    .join("\n");
}

export function loadTeamPreferences(basePath: string): TeamPreference[] {
  const filePath = path.join(basePath, "team.json");
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = JSON.parse(stripJsoncComments(fs.readFileSync(filePath, "utf-8")));
    const parsed = parseTeamPreferencesFile(raw);
    if (!parsed) {
      console.warn(`[deepPairing] team.json failed schema validation; ignoring`);
      return [];
    }
    return parsed.preferences;
  } catch (err) {
    console.warn(`[deepPairing] Could not load team.json: ${err}`);
    return [];
  }
}
