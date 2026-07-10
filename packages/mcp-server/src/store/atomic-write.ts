import fs from "node:fs";
import { randomBytes } from "node:crypto";

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
export function writeJsonAtomic(
  filePath: string,
  value: unknown,
  indent = 2,
  opts?: { mode?: number },
): void {
  writeStringAtomic(filePath, JSON.stringify(value, null, indent), opts);
}

/**
 * Atomic write of an already-serialized string. Same temp+rename guarantee as
 * writeJsonAtomic; split out so a caller that has already stringified (e.g. to
 * compare against a skip-unchanged cache) doesn't pay JSON.stringify twice.
 */
export function writeStringAtomic(filePath: string, data: string, opts?: { mode?: number }): void {
  // Sibling temp path so the rename is on the same filesystem (cross-fs
  // renames are NOT atomic; a tmp under /tmp would defeat the purpose
  // when filePath is on a different volume).
  // AA6.2 — append randomBytes so two writes from the same process to
  // the same path within the same millisecond can't race onto identical
  // tmp filenames. Without this, debounced flush bursts could have one
  // write's writeFileSync truncate another's tmp before its rename.
  const tmp = filePath + ".tmp." + process.pid + "." + Date.now() + "." + randomBytes(4).toString("hex");
  if (opts?.mode !== undefined) {
    // H2-3 (#146) — mode-controlled atomic write, for a secret-bearing file
    // (daemon.json carries the bearer token). Create the temp at the target
    // mode BEFORE any content is written — a default-umask temp then renamed
    // would expose the secret world-readable for the pre-rename window, and
    // rename preserves the SOURCE file's mode, so the destination would also
    // stay 0644. O_EXCL|O_NOFOLLOW additionally refuses a pre-planted
    // symlink/file at the (random) temp path. fchmod normalizes to the EXACT
    // mode regardless of umask (which can only strip bits, never add — so the
    // file is never more permissive than requested at any instant). rename
    // then carries that mode onto the destination.
    const O_NOFOLLOW = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    const fd = fs.openSync(
      tmp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW,
      opts.mode,
    );
    try {
      fs.fchmodSync(fd, opts.mode);
      fs.writeFileSync(fd, data);
    } finally {
      fs.closeSync(fd);
    }
  } else {
    fs.writeFileSync(tmp, data);
  }
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
 * Match the .tmp.PID.TS[.RAND] pattern from above. Exported for cleanup
 * paths in tests + a future doctor sweep. Won't match arbitrary user
 * files. AA6.2 added the optional hex-suffix tail so cleanup still
 * recognises post-AA6 atomic-write tmps.
 */
export function isAtomicTmpFile(filename: string): boolean {
  return /\.tmp\.\d+\.\d+(?:\.[0-9a-f]+)?$/.test(filename);
}
