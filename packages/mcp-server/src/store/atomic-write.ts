import fs from "node:fs";

/**
 * Z4 — atomic JSON file write.
 *
 * Failure mode this closes: synchronous `fs.writeFileSync(path, json)`
 * is NOT atomic. A SIGKILL (or a host crash) during the write leaves
 * the file partially written. The next read sees truncated JSON,
 * `JSON.parse` throws, the caller's catch falls back to `{}` — and
 * EVERY prior entry in the file is silently lost.
 *
 * Architecture council Y review flagged this for preflight-traces.json
 * specifically (Y1' added a sync rewrite per `present_*` call, with
 * `revise_artifact` doubling the writes per turn). The same risk
 * applies to every other sidecar JSON in this file (annotations,
 * retrospectives, etc.) — they're not migrated yet because each is
 * its own targeted fix. This helper exists so the migration is
 * mechanical when we get to it.
 *
 * The fix: write to a sibling temp file, then `renameSync` it onto
 * the destination. POSIX `rename` is atomic — readers either see the
 * old content or the new content, never a half-written byte stream.
 *
 * Limitations:
 * - On Windows, rename onto an existing file is not strictly atomic;
 *   `fs.renameSync` translates to MoveFileEx with the OVERWRITE flag,
 *   which is "atomic enough" for our use case (a partially-written
 *   .tmp left behind is harmless since we always read the destination
 *   path, never the .tmp).
 * - We don't fsync the parent directory — a host crash could lose the
 *   rename even after it returned. That's a stronger guarantee than
 *   we need; the goal is "no torn writes," not "every byte survives a
 *   power cut."
 *
 * Caller is responsible for the parent dir existing (matches the
 * `fs.writeFileSync` contract this replaces).
 */
export function writeJsonAtomic(filePath: string, value: unknown, indent = 2): void {
  const data = JSON.stringify(value, null, indent);
  // Sibling temp path so the rename is on the same filesystem (cross-fs
  // renames are NOT atomic; a tmp under /tmp would defeat the purpose
  // when filePath is on a different volume).
  const tmp = filePath + ".tmp." + process.pid + "." + Date.now();
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // Best-effort cleanup so an interrupted rename doesn't leave a
    // pile of .tmp.PID.TS files in the session dir.
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

/**
 * Match the .tmp.PID.TS pattern from above. Exported for cleanup paths
 * in tests + a future doctor sweep. Won't match arbitrary user files.
 */
export function isAtomicTmpFile(filename: string): boolean {
  return /\.tmp\.\d+\.\d+$/.test(filename);
}
