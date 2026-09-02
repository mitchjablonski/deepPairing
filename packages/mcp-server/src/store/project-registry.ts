import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-write.js";
import { salvageLog } from "./salvage.js";

/**
 * Project registry — `~/.deeppairing/projects.json`.
 *
 * The context bank's ONLY way to see a project whose daemon isn't running.
 * The `/api/projects` sweep discovers LIVE daemons by probing 128 ports; a
 * project you last touched three weeks ago has no daemon and is therefore
 * invisible to it. That is exactly the project the bank exists to remind you
 * about ("where did I leave off?"), so the daemon leaves a breadcrumb at
 * startup and the bank reads the breadcrumbs.
 *
 * Design constraints (all learned the hard way elsewhere in this codebase):
 *  - **Additive, new file.** Nothing else reads or writes projects.json, so a
 *    corrupt/absent file can never damage pre-existing state.
 *  - **Never crash the daemon.** Every entry point is total: a corrupt file,
 *    an unreadable HOME, a full disk — all degrade to "empty registry" plus a
 *    salvage log line. A breadcrumb store is not worth a failed boot.
 *  - **Atomic write** (temp + rename) so a SIGKILL mid-write can't leave a
 *    torn file that the next boot reads as empty and overwrites.
 *  - **Keep, don't prune, missing paths.** A project on an unmounted volume
 *    (or a worktree you deleted) is FLAGGED `stale` on read, never dropped —
 *    dropping it would silently lose the "you have work over there" signal the
 *    moment a drive is unplugged. Forgetting is the user's call, not ours.
 *  - **Test isolation mirrors global-store.ts.** The default path is the real
 *    HOME; under VITEST/NODE_ENV=test that path THROWS unless a test redirected
 *    it, so no test run can ever write into the developer's real
 *    ~/.deeppairing (the J1 incident: 222 runs polluted the real ledger).
 */

const REGISTRY_VERSION = 1 as const;

export interface ProjectRegistryEntry {
  /** Absolute path to the project root (the dir holding `.deeppairing/`). */
  projectRoot: string;
  /** Display name — basename of the root at the time it was last seen. */
  name: string;
  /** ISO timestamp of the last daemon startup for this project. */
  lastSeen: string;
}

/** A registry entry as READ — same fields plus the derived liveness flag. */
export interface ProjectRegistryReadEntry extends ProjectRegistryEntry {
  /** True when `projectRoot` no longer exists on disk. Flagged, never pruned. */
  stale: boolean;
}

interface RegistryFile {
  version: typeof REGISTRY_VERSION;
  /** Keyed by projectRoot (Record, not Map — house rule). */
  projects: Record<string, ProjectRegistryEntry>;
}

function realHomeRegistryPath(): string {
  return path.join(os.homedir(), ".deeppairing", "projects.json");
}

/** Test-only override of the registry path (see setProjectRegistryPathForTests). */
let testPathOverride: string | null = null;

/**
 * Mirrors global-store.ts's J1 guard. The default path is the developer's REAL
 * ~/.deeppairing/projects.json; refuse it loudly under a test context so a test
 * that forgets to redirect FAILS in CI instead of silently writing the
 * developer's own project list. The server vitest setup redirects this in a
 * beforeEach for every test (src/__tests__/global-store-guard.setup.ts).
 */
export function projectRegistryPath(): string {
  if (testPathOverride) return testPathOverride;
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    throw new Error(
      "The project registry refused to open the real ~/.deeppairing/projects.json " +
        `under test (${realHomeRegistryPath()}). Call ` +
        "setProjectRegistryPathForTests(<tmpPath>) — the server vitest setup does " +
        "this in a beforeEach for every test, so this usually means the registry " +
        "was touched at module-eval time before hooks ran.",
    );
  }
  return realHomeRegistryPath();
}

/** Test-only: point the registry at a temp file (null clears the override). */
export function setProjectRegistryPathForTests(p: string | null): void {
  testPathOverride = p;
}

/** Empty registry — the value every failure path degrades to. */
function emptyFile(): RegistryFile {
  return { version: REGISTRY_VERSION, projects: {} };
}

/**
 * Read the raw registry file. Missing → empty. Corrupt (unparseable, wrong
 * top-level shape) → empty + a salvage log line. Individual malformed entries
 * are dropped, not fatal: a registry is a cache of breadcrumbs, so salvaging
 * what's readable always beats refusing the whole file.
 */
function readFile(): RegistryFile {
  let filePath: string;
  try {
    filePath = projectRegistryPath();
  } catch (err) {
    // The test guard throwing is a REAL failure signal — re-throw so the
    // offending test fails loudly instead of quietly reading an empty registry.
    throw err;
  }
  let raw: unknown;
  try {
    if (!fs.existsSync(filePath)) return emptyFile();
    raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    salvageLog("projects.json", `unreadable/unparseable — starting from empty (${String(err)})`);
    return emptyFile();
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    salvageLog("projects.json", "wrong top-level shape — starting from empty");
    return emptyFile();
  }
  const projectsRaw = (raw as { projects?: unknown }).projects;
  if (!projectsRaw || typeof projectsRaw !== "object" || Array.isArray(projectsRaw)) {
    salvageLog("projects.json", "missing/invalid `projects` map — starting from empty");
    return emptyFile();
  }
  const projects: Record<string, ProjectRegistryEntry> = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(projectsRaw as Record<string, unknown>)) {
    const v = value as Partial<ProjectRegistryEntry> | null;
    if (!v || typeof v !== "object" || typeof v.projectRoot !== "string" || !v.projectRoot) {
      dropped++;
      continue;
    }
    projects[key] = {
      projectRoot: v.projectRoot,
      name: typeof v.name === "string" && v.name ? v.name : path.basename(v.projectRoot),
      lastSeen: typeof v.lastSeen === "string" ? v.lastSeen : new Date(0).toISOString(),
    };
  }
  if (dropped > 0) salvageLog("projects.json", `dropped ${dropped} malformed entr${dropped === 1 ? "y" : "ies"}`);
  return { version: REGISTRY_VERSION, projects };
}

/**
 * Upsert this project's breadcrumb. Called once per daemon startup.
 *
 * TOTAL by construction — the caller (daemon/index.ts) is on the boot path, so
 * any throw here would be a failed daemon start over a cache file. Returns
 * whether the write landed so callers can log, never throws (except under the
 * test guard, which is a deliberate loud failure).
 */
export function upsertProject(projectRoot: string, now: Date = new Date()): boolean {
  try {
    const filePath = projectRegistryPath();
    const file = readFile();
    const key = path.resolve(projectRoot);
    file.projects[key] = {
      projectRoot: key,
      name: path.basename(key) || key,
      lastSeen: now.toISOString(),
    };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeJsonAtomic(filePath, file);
    return true;
  } catch (err) {
    if (process.env.VITEST || process.env.NODE_ENV === "test") throw err;
    salvageLog("projects.json", `upsert failed (non-fatal): ${String(err)}`);
    return false;
  }
}

/**
 * Every known project, newest-`lastSeen` first, each flagged `stale` when its
 * root no longer exists on disk. Total: a corrupt registry reads as `[]`.
 */
export function readProjectRegistry(): ProjectRegistryReadEntry[] {
  const file = readFile();
  return Object.values(file.projects)
    .map((entry) => ({
      ...entry,
      stale: !existsSafe(entry.projectRoot),
    }))
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

/** existsSync that can't throw (EACCES on a permission-denied parent, ENOTDIR, …). */
function existsSafe(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}
