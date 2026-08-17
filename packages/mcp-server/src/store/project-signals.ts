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
 * The sensed guardrail classes.
 *
 * P1 F6 (round-11 adversarial review) — these were a fixed filename list
 * (`.env`, `.env.local`, `.env.production`, `Dockerfile`, `docker-compose.yml`,
 * four migration dirs). That silently left `.env.staging`, `.env.production.local`,
 * `Dockerfile.prod`, `docker-compose.prod.yml`, `compose.yaml`,
 * `terraform.tfvars`, `.gitlab-ci.yml`, `Jenkinsfile`, `.circleci/config.yml`,
 * `alembic/versions/*`, `config/master.key` and `config/credentials.yml.enc`
 * unsensed — and, once the preflight backstop started keying off the same set,
 * unguarded. Prefix/glob rules instead of a filename list.
 *
 * The preflight hook carries a hand-maintained MIRROR of these rules
 * (cli/preflight-hook-core.ts GUARDRAIL_RULES) because it must load under plain
 * `node` with no @deeppairing/shared. guardrail-backstop-parity.test.ts runs
 * BOTH over one fixture matrix of real filenames and fails if they disagree.
 */
interface GuardrailSensor {
  category: string;
  rationale: string;
  /** Root-relative directory prefixes. */
  dirs: string[];
  /** Root-relative file predicate (posix separators, full relative path). */
  file: (rel: string) => boolean;
}

/** A dotenv file that is NOT a checked-in template. */
function isRealDotenv(name: string): boolean {
  if (!/^\.env(\.[^/]+)?$/.test(name)) return false;
  return !/\.(example|sample|template|dist)$/i.test(name);
}

const GUARDRAIL_SENSORS: GuardrailSensor[] = [
  {
    category: "migrations",
    rationale: "Migrations are hard to reverse — escalate to supervised for changes here.",
    dirs: ["migrations", "db/migrate", "prisma/migrations", "supabase/migrations", "alembic/versions"],
    file: () => false,
  },
  {
    category: "workflows",
    rationale: "CI workflows affect every future deploy — escalate for changes here.",
    dirs: [".github/workflows", ".circleci"],
    file: (rel) => rel === ".gitlab-ci.yml" || rel === ".gitlab-ci.yaml" || rel === "Jenkinsfile",
  },
  {
    category: "infrastructure",
    rationale: "Infrastructure changes affect production surfaces — escalate here.",
    dirs: ["infrastructure", "terraform", "k8s", "kubernetes", "helm"],
    file: (rel) =>
      /^Dockerfile([.-][^/]*)?$/.test(rel) ||
      /^(docker-)?compose[^/]*\.ya?ml$/.test(rel) ||
      /^[^/]*\.tfvars(\.json)?$/.test(rel),
  },
  {
    category: "secrets",
    rationale: "Secret files must never leak into the session or a commit — escalate here.",
    dirs: [],
    file: (rel) =>
      isRealDotenv(rel) ||
      /^config\/secrets[^/]*$/.test(rel) ||
      /^config\/credentials[^/]*$/.test(rel) ||
      rel === "config/master.key",
  },
];

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
  for (const sensor of GUARDRAIL_SENSORS) {
    const paths = [
      ...sensor.dirs.filter(isDir),
      ...candidates.filter((rel) => sensor.file(rel)),
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
