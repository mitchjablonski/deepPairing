import fs from "node:fs";
import { performance } from "node:perf_hooks";

type RecordValue = Record<string, unknown>;

export class SessionReviewConflictError extends Error {
  readonly code = "ESESSIONREVIEWCONFLICT";

  constructor(readonly artifactId: string) {
    super(
      `Artifact ${artifactId} has changed content and a concurrent review verdict. ` +
      "Stop and restart the session writer, then review the persisted artifact before authorizing it.",
    );
    this.name = "SessionReviewConflictError";
  }
}

export function isSessionReviewConflictError(error: unknown): error is SessionReviewConflictError {
  return error instanceof SessionReviewConflictError ||
    (!!error && typeof error === "object" &&
      (error as { code?: unknown }).code === "ESESSIONREVIEWCONFLICT");
}

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

const REVIEW_VERDICTS = new Set(["approved", "rejected", "revised"]);
const REVIEWED_IDENTITY_FIELDS = ["content", "version", "type", "parentId"] as const;

function reviewVerdictChanged(base: RecordValue, candidate: RecordValue): boolean {
  return JSON.stringify(base.status) !== JSON.stringify(candidate.status) &&
    REVIEW_VERDICTS.has(String(candidate.status));
}

function changesetReviewChanged(base: RecordValue, candidate: RecordValue): boolean {
  if (base.type !== "changeset" || candidate.type !== "changeset") return false;
  const baseContent = object(base.content) ? base.content : {};
  const candidateContent = object(candidate.content) ? candidate.content : {};
  return JSON.stringify([baseContent.reviewState, baseContent.reviewReasons]) !==
    JSON.stringify([candidateContent.reviewState, candidateContent.reviewReasons]);
}

function reviewAuthorityChanged(base: RecordValue, candidate: RecordValue): boolean {
  return reviewVerdictChanged(base, candidate) || changesetReviewChanged(base, candidate);
}

/** Plan execution progress and changeset file dispositions are not proposal
 * identity. Reviewers approve plan step text/order/action and changeset file
 * contents; execution status and reviewState/reviewReasons are authority
 * layered onto that proposal. Identically named fields in other artifact
 * types remain review-bearing content. */
function reviewedContent(record: RecordValue): unknown {
  const content = record.content;
  if (!object(content)) return content;
  if (record.type === "plan" && Array.isArray(content.steps)) {
    return {
      ...content,
      steps: content.steps.map((step) => {
        if (!object(step)) return step;
        const { status: _status, statusNote: _statusNote, ...proposal } = step;
        return proposal;
      }),
    };
  }
  if (record.type === "changeset") {
    const { reviewState: _reviewState, reviewReasons: _reviewReasons, ...proposal } = content;
    return proposal;
  }
  return content;
}

function reviewedIdentityChanged(base: RecordValue, candidate: RecordValue): boolean {
  return REVIEWED_IDENTITY_FIELDS.some(
    (field) => JSON.stringify(field === "content" ? reviewedContent(base) : base[field]) !==
      JSON.stringify(field === "content" ? reviewedContent(candidate) : candidate[field]),
  );
}

/** Artifact records need one safety rule beyond the generic deterministic
 * last-flush policy: a review verdict cannot be transplanted onto proposal
 * content that the reviewer did not see. Metadata such as title and featureId
 * remains independently mergeable. */
export function mergeArtifactRecords<T extends object>(
  baseline: T[], local: T[], disk: T[], key: (value: T) => string,
): T[] {
  const before = new Map(baseline.map((record) => [key(record), record]));
  const current = new Map(local.map((record) => [key(record), record]));
  const persisted = new Map(disk.map((record) => [key(record), record]));

  for (const [id, baseValue] of before) {
    const localRecord = current.get(id);
    const diskRecord = persisted.get(id);
    if (!localRecord || !diskRecord) continue;
    const base = baseValue as RecordValue;
    const localValue = localRecord as RecordValue;
    const diskValue = diskRecord as RecordValue;
    if (
      (reviewAuthorityChanged(base, localValue) && reviewedIdentityChanged(base, diskValue)) ||
      (reviewAuthorityChanged(base, diskValue) && reviewedIdentityChanged(base, localValue))
    ) {
      throw new SessionReviewConflictError(id);
    }
  }

  return mergeSessionRecords(baseline, local, disk, key);
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
