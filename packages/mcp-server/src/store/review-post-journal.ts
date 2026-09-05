import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { writeJsonAtomic } from "./atomic-write.js";
import { parsePrReference, validRepoName, validRepoOwner } from "../github/pr-reference.js";
import { samePrTarget, type PostedReviewRecord } from "./posted-reviews.js";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const eventSchema = z.enum(["COMMENT", "REQUEST_CHANGES", "APPROVE"]);
const timestampSchema = z.iso.datetime();
export const reviewPostResultSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  htmlUrl: z.string(),
  state: z.enum(["COMMENTED", "CHANGES_REQUESTED", "APPROVED"]),
  commitId: z.string().regex(/^[0-9a-f]{40}$/).optional(),
}).strict();
const resultSchema = reviewPostResultSchema;
export const reviewPostLeaseSchema = z.object({ operationId: z.uuid(), token: z.uuid() }).strict();

export const reviewPostIdentitySchema = z.object({
  target: z.string(),
  event: eventSchema,
  reviewedHeadSha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  payloadDigest: digestSchema,
  authorizationDigest: digestSchema,
}).strict().superRefine((value, ctx) => {
  if (canonicalReviewTarget(value.target) !== value.target) {
    ctx.addIssue({ code: "custom", message: "Expected a canonical GitHub PR target" });
  }
  if (value.event === "APPROVE" && !value.reviewedHeadSha) {
    ctx.addIssue({ code: "custom", message: "Approval requires reviewed commit identity" });
  }
});

const operationSchema = z.object({
  id: z.uuid(),
  tokenDigest: digestSchema,
  sessionId: z.string().min(1),
  identity: reviewPostIdentitySchema,
  state: z.enum(["reserved", "sending", "succeeded", "failed", "unknown", "abandoned"]),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  result: resultSchema.optional(),
  operatorAcknowledgement: z.object({
    acknowledgedAt: timestampSchema,
    priorState: z.enum(["sending", "unknown"]),
    operationDigest: digestSchema,
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.state === "abandoned") !== (value.operatorAcknowledgement !== undefined)) {
    ctx.addIssue({ code: "custom", message: "Only operator-abandoned uncertainty carries an acknowledgement" });
  }
  if ((value.state === "succeeded") !== (value.result !== undefined)) {
    ctx.addIssue({ code: "custom", message: "Only success carries a remote review identity" });
  }
  if (value.result && !resultMatches(value.identity, value.result)) {
    ctx.addIssue({ code: "custom", message: "Remote review identity does not match the operation" });
  }
});

const journalSchema = z.object({
  version: z.literal(1),
  operations: z.array(operationSchema).max(4096),
}).strict();
type Journal = z.infer<typeof journalSchema>;
export type ReviewPostIdentity = z.infer<typeof reviewPostIdentitySchema>;
export type ReviewPostOperation = z.infer<typeof operationSchema>;
export type ReviewPostResult = z.infer<typeof resultSchema>;
export interface ReviewPostLease { operationId: string; token: string }

export class ReviewPostJournalError extends Error {
  constructor(readonly reason: "busy" | "blocked" | "corrupt" | "stale" | "invalid", message: string) {
    super(message);
    this.name = "ReviewPostJournalError";
  }
}

/** No network resolution here: callers must prepare a complete target first. */
export function canonicalReviewTarget(ref: string): string | null {
  const parsed = parsePrReference(ref);
  return parsed?.owner && parsed.repo
    ? `https://github.com/${parsed.owner.toLowerCase()}/${parsed.repo.toLowerCase()}/pull/${parsed.number}`
    : null;
}

/** Digest stable JSON data, including array order (inline comment order matters). */
export function reviewPostDigest(value: unknown): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v).sort().map(k => [k, stable((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function resultMatches(identity: ReviewPostIdentity, result: ReviewPostResult): boolean {
  const states = { COMMENT: "COMMENTED", REQUEST_CHANGES: "CHANGES_REQUESTED", APPROVE: "APPROVED" } as const;
  return result.state === states[identity.event] &&
    (!identity.reviewedHeadSha || result.commitId === identity.reviewedHeadSha) &&
    result.htmlUrl.toLowerCase() === `${identity.target}#pullrequestreview-${result.id}`;
}

/** Enforce the limit during reads as well as before allocation, including a
 * file that grows after fstat. Regular files only; descriptors always close. */
function readBoundedFile(file: string, maxBytes: number): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("File exceeds inspection safety limit or is not regular");
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) return Buffer.concat(chunks, total);
      total += count;
      if (total > maxBytes) throw new Error("File exceeds inspection safety limit");
      chunks.push(chunk.subarray(0, count));
    }
    throw new Error("File exceeds inspection safety limit");
  } finally {
    fs.closeSync(fd);
  }
}

export function validateReviewPostResult(identity: ReviewPostIdentity, result: unknown): ReviewPostResult {
  const parsed = resultSchema.parse(result);
  if (!resultMatches(identity, parsed)) {
    throw new ReviewPostJournalError("invalid", "Remote review identity does not match the attempted post");
  }
  return parsed;
}

/** Short local critical sections only. The caller must never send gh inside this class. */
export class ReviewPostJournal {
  readonly journalPath: string;
  readonly claimPath: string;
  private readonly legacyPath: string;
  private readonly markerPath: string;

  constructor(
    projectRoot: string,
    private readonly sessionId: string,
    private readonly persist: (filePath: string, value: unknown) => void = writeJsonAtomic,
  ) {
    if (!sessionId || sessionId === "." || sessionId.includes("..") || /[/\\\0]/.test(sessionId) ||
        sessionId.trim() !== sessionId || /[. ]$/.test(sessionId)) {
      throw new ReviewPostJournalError("invalid", "Invalid session ID for review-post journal");
    }
    const dir = path.join(projectRoot, ".deeppairing", "sessions", sessionId);
    this.journalPath = path.join(dir, "review-post-operations.json");
    this.claimPath = path.join(dir, ".review-post.lock");
    this.legacyPath = path.join(dir, "posted-reviews.json");
    this.markerPath = path.join(dir, ".review-post-protocol-v1");
  }

  private read(): Journal {
    try {
      const raw = readBoundedFile(this.journalPath, 8 * 1024 * 1024).toString("utf8");
      const journal = journalSchema.parse(JSON.parse(raw));
      const ids = new Set<string>();
      const activeTargets = new Set<string>();
      for (const op of journal.operations) {
        if (op.sessionId !== this.sessionId || ids.has(op.id)) throw new Error("Invalid operation/session identity");
        ids.add(op.id);
        if (["reserved", "sending", "unknown"].includes(op.state)) {
          if (activeTargets.has(op.identity.target)) throw new Error("Overlapping unresolved operations");
          activeTargets.add(op.identity.target);
        }
      }
      return journal;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && !fs.existsSync(this.markerPath)) {
        return { version: 1, operations: [] };
      }
      throw new ReviewPostJournalError("corrupt", `Review-post journal is unreadable or invalid: ${this.journalPath}. Preserve it and inspect before posting.`);
    }
  }

  /** Legacy data is advisory elsewhere, but it must fail CLOSED at the posting boundary. */
  readLegacyHistory(): PostedReviewRecord[] {
    try {
      const raw = readBoundedFile(this.legacyPath, 8 * 1024 * 1024).toString("utf8");
      return z.array(z.object({
        pr: z.string().refine(v => parsePrReference(v) !== null),
        prNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        owner: z.string().refine(validRepoOwner).optional(), repo: z.string().refine(validRepoName).optional(),
        event: eventSchema,
        reviewId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        url: z.url(), postedAt: timestampSchema,
        commentCount: z.number().int().nonnegative(),
      }).passthrough().refine(v => {
        const parsed = parsePrReference(v.pr);
        const posted = parsePrReference(v.url);
        return parsed?.number === v.prNumber &&
          posted?.number === v.prNumber && !!posted.owner && !!posted.repo &&
          (!v.owner || !parsed.owner || v.owner.toLowerCase() === parsed.owner.toLowerCase()) &&
          (!v.repo || !parsed.repo || v.repo.toLowerCase() === parsed.repo.toLowerCase()) &&
          (!v.owner || v.owner.toLowerCase() === posted.owner.toLowerCase()) &&
          (!v.repo || v.repo.toLowerCase() === posted.repo.toLowerCase()) &&
          (!parsed.owner || parsed.owner.toLowerCase() === posted.owner.toLowerCase()) &&
          (!parsed.repo || parsed.repo.toLowerCase() === posted.repo.toLowerCase());
      })).parse(JSON.parse(raw));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new ReviewPostJournalError("corrupt", `Posted-review history is unreadable or invalid: ${this.legacyPath}. Preserve it and inspect before posting.`);
    }
  }

  private claim<T>(fn: () => T): T {
    const token = randomUUID();
    let fd: number;
    try { fd = fs.openSync(this.claimPath, "wx", 0o600); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ReviewPostJournalError("busy", "Review-post state is locked. Retry later; never remove a claim while a writer may still be running.");
      }
      throw err;
    }
    try { fs.writeFileSync(fd, token); }
    catch (err) { fs.closeSync(fd); fs.unlinkSync(this.claimPath); throw err; }
    fs.closeSync(fd);
    let primaryFailed = false;
    try { return fn(); }
    catch (err) { primaryFailed = true; throw err; }
    finally {
      // No age/PID stealing. An operator replacement must not be unlinked by a late owner.
      try {
        if (fs.readFileSync(this.claimPath, "utf8") !== token) {
          throw new ReviewPostJournalError("stale", "Review-post claim changed while held; stop writers and inspect state.");
        }
        fs.unlinkSync(this.claimPath);
      } catch (err) {
        // Preserve the durable-write failure; a cleanup error must not disguise
        // whether the primary transition was confirmed. A retained lock blocks.
        if (!primaryFailed) throw err;
      }
    }
  }

  list(): ReviewPostOperation[] { return this.read().operations; }

  /** Read-only diagnostics. Never print raw bytes, fencing tokens, or payloads. */
  inspect(): object {
    const metadata = (file: string) => {
      try {
        const stat = fs.lstatSync(file);
        return { path: file, exists: true, bytes: stat.size, modifiedAt: stat.mtime.toISOString(),
          regularFile: stat.isFile() && !stat.isSymbolicLink() };
      } catch (err) {
        return { path: file, exists: (err as NodeJS.ErrnoException).code !== "ENOENT", unreadable: true };
      }
    };
    const validate = (read: () => unknown) => {
      try { read(); return { valid: true }; }
      catch (err) { return { valid: false, error: err instanceof ReviewPostJournalError ? err.message : "Unreadable state" }; }
    };
    let claimDigest: string | undefined;
    try { claimDigest = this.readClaimDigest(); } catch { /* metadata still explains an unreadable claim */ }
    return {
      journal: { ...metadata(this.journalPath), ...validate(() => this.read()) },
      legacyHistory: { ...metadata(this.legacyPath), ...validate(() => this.readLegacyHistory()) },
      protocolMarker: metadata(this.markerPath),
      claim: { ...metadata(this.claimPath), ...(claimDigest ? { digest: claimDigest } : {}) },
    };
  }

  private readClaimDigest(): string {
    const stat = fs.lstatSync(this.claimPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) {
      throw new ReviewPostJournalError("invalid", "Claim must be a regular file of at most 4096 bytes; inspect it manually.");
    }
    return createHash("sha256").update(readBoundedFile(this.claimPath, 4096)).digest("hex");
  }

  /** Operator-only, offline coordination: this is NOT a process-liveness proof.
   * The explicit assertion excludes concurrent replacement after comparison. */
  releaseClaim(expectedDigest: string, allWritersStopped: boolean): void {
    if (allWritersStopped !== true || !digestSchema.safeParse(expectedDigest).success) {
      throw new ReviewPostJournalError("invalid", "Claim release requires all writers stopped and the inspected claim digest.");
    }
    if (this.readClaimDigest() !== expectedDigest) {
      throw new ReviewPostJournalError("stale", "Claim changed since inspection; it was not removed.");
    }
    fs.unlinkSync(this.claimPath);
  }

  /** An explicit operator accepts duplicate risk, not evidence of non-delivery.
   * Never exposed to MCP/daemon mutation routes or automatic retry logic. */
  acknowledgeUnknown(operationId: string, expectedDigest: string,
    allWritersStopped: boolean, acceptDuplicateRisk: boolean): void {
    if (allWritersStopped !== true || acceptDuplicateRisk !== true || !digestSchema.safeParse(expectedDigest).success) {
      throw new ReviewPostJournalError("invalid", "Acknowledgement requires all writers stopped, duplicate-risk acceptance, and the inspected operation digest.");
    }
    this.update(operationId, op => {
      if (!["sending", "unknown"].includes(op.state) || reviewPostDigest(op) !== expectedDigest) {
        throw new ReviewPostJournalError("stale", "Operation changed or is not uncertain; no acknowledgement recorded.");
      }
      op.operatorAcknowledgement = {
        acknowledgedAt: new Date().toISOString(), priorState: op.state as "sending" | "unknown",
        operationDigest: expectedDigest,
      };
      op.state = "abandoned";
    });
  }

  reserve(identity: ReviewPostIdentity, repost = false): ReviewPostLease {
    const parsed = reviewPostIdentitySchema.parse(identity);
    return this.claim(() => {
      const journal = this.read();
      const legacy = this.readLegacyHistory(); // Validate even when repost was explicitly requested.
      const prior = journal.operations.filter(op => op.identity.target === parsed.target);
      const unresolved = prior.find(op => ["reserved", "sending", "unknown"].includes(op.state));
      if (unresolved) {
        throw new ReviewPostJournalError("blocked", `Review operation ${unresolved.id} is ${unresolved.state}; reconcile it before another post. Repost does not bypass uncertainty.`);
      }
      if (!repost && (prior.some(op => op.state === "succeeded" || op.state === "abandoned") || legacy.some(op => samePrTarget(op, parsed.target)))) {
        throw new ReviewPostJournalError("blocked", "This session already posted or acknowledged an uncertain post to that PR; fresh human repost authorization is required.");
      }
      if (journal.operations.length >= 4096) throw new ReviewPostJournalError("blocked", "Review-post journal is full; stop writers and perform a history-preserving migration before posting. Do not delete or reset the journal.");
      const lease = { operationId: randomUUID(), token: randomUUID() };
      const now = new Date().toISOString();
      journal.operations.push({
        id: lease.operationId, tokenDigest: reviewPostDigest(lease.token), sessionId: this.sessionId,
        identity: parsed, state: "reserved", createdAt: now, updatedAt: now,
      });
      // Written first: a missing journal after protocol adoption is not a fresh
      // session. An interrupted first reservation safely requires local repair.
      if (!fs.existsSync(this.markerPath)) {
        fs.writeFileSync(this.markerPath, "1\n", { flag: "wx", mode: 0o600 });
      }
      this.persist(this.journalPath, journal);
      return lease;
    });
  }

  private update(operationId: string, mutate: (op: ReviewPostOperation) => void): void {
    this.claim(() => {
      const journal = this.read();
      const op = journal.operations.find(op => op.id === operationId);
      if (!op) throw new ReviewPostJournalError("stale", "Review-post reservation is absent");
      mutate(op);
      op.updatedAt = new Date().toISOString();
      this.persist(this.journalPath, journalSchema.parse(journal));
    });
  }

  private transition(lease: ReviewPostLease, mutate: (op: ReviewPostOperation) => void): void {
    this.update(lease.operationId, op => {
      if (op.tokenDigest !== reviewPostDigest(lease.token)) {
        throw new ReviewPostJournalError("stale", "Review-post reservation belongs to another caller");
      }
      mutate(op);
    });
  }

  /** Deliberately not idempotent: a repeated sending response must NEVER authorize a second POST. */
  markSending(lease: ReviewPostLease, identity: ReviewPostIdentity): void {
    this.transition(lease, op => {
      if (op.state !== "reserved" || reviewPostDigest(op.identity) !== reviewPostDigest(reviewPostIdentitySchema.parse(identity))) {
        throw new ReviewPostJournalError("stale", "Review-post reservation changed or may already have been sent");
      }
      op.state = "sending";
    });
  }

  failBeforeSending(lease: ReviewPostLease): void {
    this.transition(lease, op => {
      if (op.state !== "reserved") throw new ReviewPostJournalError("stale", "A possibly sent review cannot be marked failed");
      op.state = "failed";
    });
  }

  /** Explicit operator recovery. Cancelling only reserved atomically fences the original caller. */
  cancelReserved(operationId: string): void {
    this.update(operationId, op => {
      if (op.state !== "reserved") throw new ReviewPostJournalError("stale", "A possibly sent review cannot be cancelled");
      op.state = "failed";
    });
  }

  markUnknown(lease: ReviewPostLease): void {
    this.transition(lease, op => {
      if (op.state !== "sending" && op.state !== "unknown") throw new ReviewPostJournalError("stale", "Only a possibly sent review can become unknown");
      op.state = "unknown";
    });
  }

  succeed(lease: ReviewPostLease, result: ReviewPostResult): void {
    const parsed = resultSchema.parse(result);
    this.transition(lease, op => {
      if (!["sending", "unknown", "succeeded"].includes(op.state) || !resultMatches(op.identity, parsed) ||
          (op.result && reviewPostDigest(op.result) !== reviewPostDigest(parsed))) {
        throw new ReviewPostJournalError("stale", "Remote review does not match this possibly sent operation");
      }
      op.state = "succeeded";
      op.result = parsed;
    });
  }

  /** No POST: caller must independently verify the remote review before recording recovery. */
  reconcileSucceeded(operationId: string, identity: ReviewPostIdentity, result: ReviewPostResult): void {
    const parsed = resultSchema.parse(result);
    this.update(operationId, op => {
      if (!["sending", "unknown", "succeeded"].includes(op.state) ||
          reviewPostDigest(op.identity) !== reviewPostDigest(reviewPostIdentitySchema.parse(identity)) ||
          !resultMatches(op.identity, parsed) || (op.result && reviewPostDigest(op.result) !== reviewPostDigest(parsed))) {
        throw new ReviewPostJournalError("stale", "Remote review does not match the unresolved operation");
      }
      op.state = "succeeded";
      op.result = parsed;
    });
  }
}
