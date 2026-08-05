import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-write.js";
import {
  normalizeFeatureId,
  FEATURE_ID_MAX,
  type FeatureOverrides,
} from "./session-scan.js";

/**
 * #206 (I1) — the human's project-level corrections to the DERIVED Features
 * grouping, persisted at `.deeppairing/feature-overrides.json` (alongside
 * daemon.json / metrics.json / preferences.json). The Features view is a
 * read-model with nothing of its own to persist EXCEPT the human's edits, so
 * this is the one small file that carries them:
 *   - `groupTitles`        — RENAME a group's display title (groupKey → title).
 *   - `artifactAssignments`— MOVE an artifact into a group (artifactId →
 *     groupKey). This is a HUMAN override — TOP precedence in groupByFeature,
 *     above an agent's explicit `featureId`, the parent chain, and the title
 *     prefix. The reserved `__ungrouped__` target pulls an artifact OUT of every
 *     feature.
 *
 * Project-level (NOT per-session): a feature spans sessions, so its corrections
 * must too. Reads are salvage-tolerant — a missing OR corrupt file degrades to
 * empty overrides (the derived grouping still renders), never throws. Writes go
 * through writeJsonAtomic (unique pid+ts+random tmp + rename) so a concurrent
 * writer can't tear the file. Human corrections are rare, so writes are
 * synchronous write-through (no debounce): the next GET /api/features must see
 * the change immediately.
 */

export interface FeatureOverridesFile {
  version: 1;
  groupTitles: Record<string, string>;
  artifactAssignments: Record<string, string>;
}

const VERSION = 1 as const;

// #206 (I1, review Fix 2) — log the "file is a newer version" case at most once
// per process, so a future v2 written by a newer daemon doesn't spam the log on
// every read while an older daemon is (safely) ignoring it.
let loggedUnknownVersion = false;

/** The reserved key that pulls an artifact OUT of every feature. Mirrors
 *  session-scan's UNGROUPED_ID (kept in sync via the assignment write path). */
export const UNGROUPED_KEY = "__ungrouped__";

/** A display title is human free-text — cap it generously so a rename can't
 *  bloat the file, but don't otherwise constrain it. */
const TITLE_MAX = 120;

function overridesPath(projectRoot: string): string {
  return path.join(projectRoot, ".deeppairing", "feature-overrides.json");
}

function emptyOverrides(): FeatureOverridesFile {
  return { version: VERSION, groupTitles: {}, artifactAssignments: {} };
}

/** Keep only well-shaped string→string entries; drop anything malformed so one
 *  bad key can't poison the whole map (salvage discipline). */
function sanitizeRecord(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k === "string" && k.length > 0 && typeof v === "string" && v.length > 0) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Read the overrides file from disk, degrading to empty on missing/corrupt.
 * Returns the FULL file shape; {@link toFeatureOverrides} narrows it to what
 * groupByFeature consumes.
 */
export function readFeatureOverridesFile(projectRoot: string): FeatureOverridesFile {
  const file = overridesPath(projectRoot);
  try {
    if (!fs.existsSync(file)) return emptyOverrides();
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<FeatureOverridesFile>;
    // #206 (I1, review Fix 2) — GATE on version instead of blindly coercing to 1.
    // A future v2 file (written by a newer daemon) may carry a shape this reader
    // doesn't understand; down-sanitizing it through the v1 shape would silently
    // corrupt or drop the newer data on the next write. Treat an unknown version
    // as empty (the derived grouping still works) rather than misinterpret it.
    if (parsed?.version !== VERSION) {
      if (!loggedUnknownVersion) {
        loggedUnknownVersion = true;
        console.error(
          `[deepPairing] feature-overrides.json has version ${String(parsed?.version)} (this daemon understands ${VERSION}); ignoring its overrides to avoid corrupting newer data.`,
        );
      }
      return emptyOverrides();
    }
    return {
      version: VERSION,
      groupTitles: sanitizeRecord(parsed?.groupTitles),
      artifactAssignments: sanitizeRecord(parsed?.artifactAssignments),
    };
  } catch {
    // Missing ≠ corrupt, but both degrade to empty here: the derived grouping
    // is fully functional without any overrides, so a bad file must never take
    // the Features view down.
    return emptyOverrides();
  }
}

/** The narrowed shape groupByFeature applies. */
export function toFeatureOverrides(file: FeatureOverridesFile): FeatureOverrides {
  return { groupTitles: file.groupTitles, artifactAssignments: file.artifactAssignments };
}

/** Convenience: read + narrow in one call (the GET /api/features path). */
export function readFeatureOverrides(projectRoot: string): FeatureOverrides {
  return toFeatureOverrides(readFeatureOverridesFile(projectRoot));
}

function writeFeatureOverridesFile(projectRoot: string, data: FeatureOverridesFile): void {
  const file = overridesPath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, data);
}

/**
 * RENAME a group's display title. An empty/whitespace title CLEARS the override
 * (the group falls back to its mined/derived label). Returns the updated file.
 */
export function setFeatureGroupTitle(
  projectRoot: string,
  groupKey: string,
  title: string,
): FeatureOverridesFile {
  const file = readFeatureOverridesFile(projectRoot);
  const key = groupKey.trim();
  if (!key) return file;
  const clean = title.trim().slice(0, TITLE_MAX);
  if (clean) file.groupTitles[key] = clean;
  else delete file.groupTitles[key];
  writeFeatureOverridesFile(projectRoot, file);
  return file;
}

/**
 * MOVE an artifact into a group. The target groupKey is normalized through the
 * SAME slug family the miner/agent-tag path uses (so a human who types
 * "Milestone 7" lands on `milestone-7`, converging with everything else), except
 * the reserved `__ungrouped__` which passes through verbatim. An empty target
 * CLEARS the assignment (the artifact reverts to its derived group). Returns the
 * updated file.
 */
export function assignArtifactToFeature(
  projectRoot: string,
  artifactId: string,
  groupKey: string,
): FeatureOverridesFile {
  const file = readFeatureOverridesFile(projectRoot);
  const id = artifactId.trim();
  if (!id) return file;
  const rawKey = groupKey.trim();
  if (!rawKey) {
    delete file.artifactAssignments[id];
  } else if (rawKey === UNGROUPED_KEY) {
    file.artifactAssignments[id] = UNGROUPED_KEY;
  } else {
    // #206 (I1, review Fix 3) — DELIBERATE: an arbitrary target key that matches
    // no existing group ESTABLISHES a new one (groupByFeature will materialize it
    // with a de-slugged label). A move is allowed to create a feature, not only
    // file into an existing one; this whole path is auth-gated (hash + bearer),
    // so it's the human's own deliberate act, never an untrusted caller's.
    // normalizeFeatureId is idempotent (review Fix 1), so re-normalizing a group
    // id the UI posted back (e.g. "milestone-7") is a no-op — the artifact lands
    // in exactly the group the human clicked, never a divergent twin.
    const normalized = normalizeFeatureId(rawKey)?.slug ?? rawKey.slice(0, FEATURE_ID_MAX);
    file.artifactAssignments[id] = normalized;
  }
  writeFeatureOverridesFile(projectRoot, file);
  return file;
}
