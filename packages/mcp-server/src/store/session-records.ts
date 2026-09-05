import fs from "node:fs";
import { performance } from "node:perf_hooks";

type RecordValue = Record<string, unknown>;

function object(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Apply only this writer's field changes to the latest committed record.
 * Arrays are indivisible values; conflicting changes to the same value use
 * last successful flush wins. Record-level external deletion is handled below. */
function mergeValue(base: unknown, local: unknown, disk: unknown, field?: string): unknown {
  if (JSON.stringify(base) === JSON.stringify(local)) return disk;
  if (field === "statusHistory" && Array.isArray(local) && Array.isArray(disk)) {
    const prior = Array.isArray(base) ? base : [];
    if (prior.every((entry, i) => JSON.stringify(entry) === JSON.stringify(local[i]))) {
      const history = [...disk];
      const seen = new Set(history.map((entry) => JSON.stringify(entry)));
      for (const entry of local.slice(prior.length)) {
        const encoded = JSON.stringify(entry);
        if (!seen.has(encoded)) { history.push(entry); seen.add(encoded); }
      }
      return history;
    }
  }
  if (object(base) && object(local) && object(disk)) {
    const merged: RecordValue = { ...disk };
    for (const key of new Set([...Object.keys(base), ...Object.keys(local)])) {
      if (JSON.stringify(base[key]) === JSON.stringify(local[key])) continue;
      if (!Object.hasOwn(local, key)) delete merged[key];
      else Object.defineProperty(merged, key, {
        value: mergeValue(base[key], local[key], disk[key], key),
        enumerable: true, configurable: true, writable: true,
      });
    }
    return merged;
  }
  return local;
}

export function mergeSessionRecords<T>(
  baseline: T[], local: T[], disk: T[], key: (value: T) => string,
): T[] {
  const before = new Map(baseline.map((record) => [key(record), record]));
  const current = new Map(local.map((record) => [key(record), record]));
  const merged = new Map(disk.map((record) => [key(record), record]));
  for (const id of before.keys()) {
    if (!current.has(id)) merged.delete(id);
  }
  for (const [id, record] of current) {
    if (!before.has(id)) merged.set(id, record);
    else if (merged.has(id)) merged.set(id, mergeValue(before.get(id), record, merged.get(id)) as T);
  }
  return [...merged.values()];
}

/** Cooperating FileStore writers serialize the complete read/merge/write
 * section. Never break locks by age: a paused live writer could still commit.
 * After a crash, an operator may remove the lock ONLY after stopping writers.
 * Timeout/failure throws; callers must never continue with an unlocked write. */
export function withSessionFlushLock<T>(filePath: string, run: () => T): T {
  const deadline = performance.now() + 250;
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  let fd: number;
  for (;;) {
    try {
      fd = fs.openSync(filePath, "wx", 0o600);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (performance.now() >= deadline) {
        throw Object.assign(new Error(`Session flush lock busy: ${filePath}. Stop all writers before removing an abandoned lock.`), { code: "ELOCKED" });
      }
      Atomics.wait(waitArray, 0, 0, 10);
    }
  }
  let result!: T;
  let failed = false;
  let failure: unknown;
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    result = run();
  } catch (err) {
    failed = true;
    failure = err;
  }
  // Always attempt both cleanup operations, but preserve the original failure.
  // A cleanup-only failure still propagates (an orphan lock needs attention).
  for (const cleanup of [() => fs.closeSync(fd), () => fs.unlinkSync(filePath)]) {
    try { cleanup(); } catch (err) {
      if (!failed) { failed = true; failure = err; }
    }
  }
  if (failed) throw failure;
  return result;
}
