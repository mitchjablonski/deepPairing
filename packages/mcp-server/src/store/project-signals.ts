import fs from "node:fs";
import path from "node:path";
import type { TeamPreference } from "@deeppairing/shared";
import { parseTeamPreferencesFile } from "@deeppairing/shared";

export interface ProjectGuardrail {
  /** Short identifier like "migrations" or "workflows". */
  category: string;
  /** Relative path(s) that triggered the guardrail. */
  paths: string[];
  /** Human-readable rationale — why the agent should escalate here. */
  rationale: string;
}

/**
 * Sense the project's sensitive areas by filesystem signals alone — no
 * config. Runs once on FileStore construction; cached per instance. The
 * agent receives these in firstCallHint and knows to stay supervised for
 * changes in these paths even when global autonomy is "autonomous".
 */
export function senseProjectGuardrails(projectRoot: string): ProjectGuardrail[] {
  const guardrails: ProjectGuardrail[] = [];
  const exists = (rel: string) => {
    try { return fs.existsSync(path.join(projectRoot, rel)); } catch { return false; }
  };

  const migrationPaths = ["migrations", "db/migrate", "prisma/migrations", "supabase/migrations"].filter(exists);
  if (migrationPaths.length > 0) {
    guardrails.push({
      category: "migrations",
      paths: migrationPaths,
      rationale: "Migrations are hard to reverse — escalate to supervised for changes here.",
    });
  }

  const workflowPath = ".github/workflows";
  if (exists(workflowPath)) {
    guardrails.push({
      category: "workflows",
      paths: [workflowPath],
      rationale: "CI workflows affect every future deploy — escalate for changes here.",
    });
  }

  const infraPaths = ["Dockerfile", "docker-compose.yml", "docker-compose.yaml", "infrastructure", "terraform", "k8s", "kubernetes", "helm"].filter(exists);
  if (infraPaths.length > 0) {
    guardrails.push({
      category: "infrastructure",
      paths: infraPaths,
      rationale: "Infrastructure changes affect production surfaces — escalate here.",
    });
  }

  const secretPaths = [".env", ".env.local", ".env.production", "config/secrets.yml"].filter(exists);
  if (secretPaths.length > 0) {
    guardrails.push({
      category: "secrets",
      paths: secretPaths,
      rationale: "Secret files must never leak into the session or a commit — escalate here.",
    });
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
