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
const resultSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  htmlUrl: z.string(),
  state: z.enum(["COMMENTED", "CHANGES_REQUESTED", "APPROVED"]),
  commitId: z.string().regex(/^[0-9a-f]{40}$/).optional(),
}).strict();

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
  state: z.enum(["reserved", "sending", "succeeded", "failed", "unknown"]),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  result: resultSchema.optional(),
}).strict().superRefine((value, ctx) => {
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
    if (!sessionId || sessionId.includes("..") || /[/\\\0]/.test(sessionId)) {
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
      const raw = fs.readFileSync(this.journalPath, "utf8");
      if (raw.length > 8 * 1024 * 1024) throw new Error("Journal exceeds safety limit");
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
      throw new ReviewPostJournalError("corrupt", "Review-post journal is unreadable or invalid; preserve it and reconcile before posting.");
    }
  }

  /** Legacy data is advisory elsewhere, but it must fail CLOSED at the posting boundary. */
  private legacy(): PostedReviewRecord[] {
    try {
      const raw = fs.readFileSync(this.legacyPath, "utf8");
      if (raw.length > 8 * 1024 * 1024) throw new Error("History exceeds safety limit");
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
      throw new ReviewPostJournalError("corrupt", "Posted-review history is unreadable or invalid; preserve it and reconcile before posting.");
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
    try { return fn(); }
    finally {
      // No age/PID stealing. An operator replacement must not be unlinked by a late owner.
      if (fs.readFileSync(this.claimPath, "utf8") !== token) {
        throw new ReviewPostJournalError("stale", "Review-post claim changed while held; stop writers and inspect state.");
      }
      fs.unlinkSync(this.claimPath);
    }
  }

  list(): ReviewPostOperation[] { return this.read().operations; }

  reserve(identity: ReviewPostIdentity, repost = false): ReviewPostLease {
    const parsed = reviewPostIdentitySchema.parse(identity);
    return this.claim(() => {
      const journal = this.read();
      const legacy = this.legacy(); // Validate even when repost was explicitly requested.
      const prior = journal.operations.filter(op => op.identity.target === parsed.target);
      const unresolved = prior.find(op => ["reserved", "sending", "unknown"].includes(op.state));
      if (unresolved) {
        throw new ReviewPostJournalError("blocked", `Review operation ${unresolved.id} is ${unresolved.state}; reconcile it before another post. Repost does not bypass uncertainty.`);
      }
      if (!repost && (prior.some(op => op.state === "succeeded") || legacy.some(op => samePrTarget(op, parsed.target)))) {
        throw new ReviewPostJournalError("blocked", "This session already posted to that PR; fresh human repost authorization is required.");
      }
      if (journal.operations.length >= 4096) throw new ReviewPostJournalError("blocked", "Review-post journal is full; archive with all writers stopped before posting.");
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
