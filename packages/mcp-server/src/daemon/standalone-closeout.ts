import fs from "node:fs";
import path from "node:path";
import { ArtifactSchema, CommentSchema, DecisionRequestSchema, DecisionResponseSchema, PreflightTraceSchema, RequestSchema } from "@deeppairing/shared";
import { z } from "zod";
import { ERROR_CODES } from "../error-codes.js";
import { isStandaloneSessionForProject } from "../standalone-session-id.js";
import { writeJsonAtomic } from "../store/atomic-write.js";
import type { FileStore } from "../store/file-store.js";
import { withSessionFlushLock } from "../store/session-records.js";
import { provePageRevisionFeedback } from "../store/page-revision-feedback.js";
import { planStandaloneOptionsRecovery } from "./standalone-options.js";
import { planStandalonePageRecovery } from "./standalone-page.js";
import { readJsonFile, readRegularJsonFile, type StandaloneReplaySnapshot } from "./standalone-receipts.js";
import { planStandalonePageRevisionRecovery } from "./standalone-revise-page.js";

const receiptName = /^(present-options|present-page|revise-page)-([0-9a-f-]+)\.json$/;
const receiptPrefix = /^(?:present-options|present-page|revise-page)-.*\.json$/;
const operationIdSchema = z.string().uuid();
const markerSchema = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  endedAt: z.string().datetime(),
}).strict();
type EndMarker = z.infer<typeof markerSchema>;
export type StandaloneReviewState = { state: "open" | "closing" } | { state: "ended"; endedAt: string };

export class StandaloneCloseoutError extends Error {
  constructor(readonly code: typeof ERROR_CODES.session_marker_invalid | typeof ERROR_CODES.session_save_pending, message: string) {
    super(message);
  }
}

type Entry = {
  writers: number;
  close?: Promise<EndMarker>;
  drained?: () => void;
};

function readCollection<T>(dir: string, file: string, schema: z.ZodType<T>, key: (row: T) => string): Map<string, T> {
  const raw = readRegularJsonFile(path.join(dir, file));
  if (raw === undefined) return new Map();
  if (!Array.isArray(raw)) throw new Error("Standalone review has a malformed durable collection.");
  const rows = new Map<string, T>();
  for (const row of raw) {
    if (!schema.safeParse(row).success) throw new Error("Standalone review has a malformed durable record.");
    const id = key(row as T);
    if (!id || rows.has(id)) throw new Error("Standalone review history contains duplicate or missing durable record identities.");
    // Keep the original representation for receipt digests.
    rows.set(id, row as T);
  }
  return rows;
}

function closeoutSnapshot(dir: string, sessionId: string, store?: FileStore): StandaloneReplaySnapshot {
  const artifacts = readCollection(dir, "artifacts.json", ArtifactSchema, (row) => row.id);
  const comments = readCollection(dir, "comments.json", CommentSchema, (row) => row.id);
  const decisions = readCollection(dir, "decisions.json", DecisionRequestSchema.extend({
    artifactId: z.string(), createdAt: z.string().datetime(), resolvedAt: z.string().datetime().optional(),
    acknowledged: z.boolean().optional(), response: DecisionResponseSchema.optional(),
  }), (row) => row.decisionId);
  readCollection(dir, "requests.json", RequestSchema, (row) => row.id);
  readCollection(dir, "plan-reviews.json", z.object({
    artifactId: z.string(), createdAt: z.string().datetime(), resolvedAt: z.string().datetime().optional(),
    verdict: z.enum(["approved", "revised", "rejected"]).optional(), feedback: z.string().optional(),
  }), (row) => row.artifactId);
  readCollection(dir, "render-failures.json", z.object({
    artifactId: z.string(), visualId: z.string(), error: z.string(), title: z.string().optional(),
    at: z.string().datetime(), acknowledged: z.boolean().optional(),
  }), (row) => JSON.stringify([row.artifactId, row.visualId]));
  const rawTraces = readRegularJsonFile(path.join(dir, "preflight-traces.json"));
  const traces = z.record(z.string(), PreflightTraceSchema).parse(rawTraces === undefined ? {} : rawTraces);
  for (const [id, trace] of Object.entries(traces)) {
    if (trace.artifactId !== id) throw new Error("Standalone review has a mismatched durable preflight trace.");
  }
  const byParent = new Map<string, string[]>();
  const addChild = (index: Map<string, string[]>, parentId: string | null, id: string) => {
    if (parentId === null) return;
    const children = index.get(parentId);
    if (children) children.push(id);
    else index.set(parentId, [id]);
  };
  for (const row of artifacts.values()) {
    if (row.sessionId !== sessionId) throw new Error("Standalone review contains a foreign artifact.");
    addChild(byParent, row.parentId, row.id);
  }
  for (const row of comments.values()) {
    if (row.sessionId !== sessionId) throw new Error("Standalone review contains a foreign comment.");
  }
  for (const row of decisions.values()) {
    const linked = artifacts.get(row.artifactId);
    if (linked?.type !== "decision" || linked.content?.decisionId !== row.decisionId) {
      throw new Error("Standalone review contains an unowned or mismatched decision.");
    }
  }
  const visibleArtifacts = store ? new Map(store.getArtifacts().map((row) => [row.id, row])) : artifacts;
  const visibleComments = store ? new Map(store.getComments().map((row) => [row.id, row])) : comments;
  const visibleParents = new Map<string, string[]>();
  for (const row of visibleArtifacts.values()) addChild(visibleParents, row.parentId, row.id);
  return {
    record(file, key, id) {
      if (file === "comments.json") return comments.get(id);
      if (file === "decisions.json") return decisions.get(id);
      if (file !== "artifacts.json") throw new Error("Unknown standalone closeout collection.");
      if (key === "id") return artifacts.get(id);
      const children = byParent.get(id) ?? [];
      if (children.length > 1) throw new Error("Standalone review history has conflicting successors.");
      return children[0] ? artifacts.get(children[0]) : undefined;
    },
    artifact: (id) => visibleArtifacts.get(id),
    comment: (id) => visibleComments.get(id),
    hasOtherChild: (parentId, childId) => (visibleParents.get(parentId) ?? []).some((id) => id !== childId),
    trace: (id) => traces[id],
    getArtifacts: () => [...artifacts.values()],
    verifyFeedback(parentId, proof) {
      const current = provePageRevisionFeedback([...artifacts.values()], [...comments.values()], sessionId, parentId, proof.commentIds, store?.getComments() ?? [...comments.values()]);
      if (!current || current.digest !== proof.digest || current.includesRuleOut !== proof.includesRuleOut) {
        throw new Error("Standalone revision feedback no longer matches its receipt.");
      }
    },
  };
}

/** The caller has verified the exact project, session directory, and End marker. */
export function readStandaloneReplaySnapshot(projectRoot: string, sessionId: string): StandaloneReplaySnapshot {
  return closeoutSnapshot(path.join(projectRoot, ".deeppairing", "sessions", sessionId), sessionId);
}

/** Settle only exact caller-owned effects that were durable before this scan. */
function reconcileReceipts(projectRoot: string, dir: string, store: FileStore, checkDeadline: () => void): void {
  const receipts: Array<{ kind: string; operationId: string }> = [];
  const directory = fs.opendirSync(dir);
  try {
    for (let file = directory.readSync(); file; file = directory.readSync()) {
      checkDeadline();
      if (!receiptPrefix.test(file.name)) continue;
      const match = receiptName.exec(file.name);
      if (!file.isFile() || !match?.[1] || !operationIdSchema.safeParse(match[2]).success) {
        throw new Error("Standalone review has a malformed operation receipt name.");
      }
      receipts.push({ kind: match[1], operationId: match[2]! });
    }
  } finally {
    directory.closeSync();
  }
  // Validate even with zero receipts, before a generic flush can salvage an
  // ambiguous record. The planning pass changes neither receipts nor feedback.
  const snapshot = closeoutSnapshot(dir, store.getSessionId(), store);
  const quiet = () => {};
  const repairs: Array<() => void> = [];
  receipts.sort((a, b) => a.kind.localeCompare(b.kind) || a.operationId.localeCompare(b.operationId));
  for (const { kind, operationId } of receipts) {
    checkDeadline();
    const repair = kind === "present-options" ? planStandaloneOptionsRecovery(projectRoot, store, operationId, quiet, snapshot) :
      kind === "present-page" ? planStandalonePageRecovery(projectRoot, store, operationId, snapshot) :
      planStandalonePageRevisionRecovery(projectRoot, store, operationId, quiet, snapshot);
    if (repair) repairs.push(repair);
  }
  for (const repair of repairs) {
    checkDeadline();
    repair();
  }
}

/** Internal coordinator. Only the daemon's verified exact session lookup should
 * supply stores. The daemon does not expose End until all writers are covered. */
export class StandaloneCloseout {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly projectRoot: string,
    private readonly getStore: (sessionId: string) => FileStore | undefined,
    private readonly timeoutMs = 5_000,
    private readonly onEnded?: (sessionId: string, endedAt: string) => void,
    private readonly drainWatchedSaves?: (sessionId: string) => Promise<void>,
  ) {}

  private directory(sessionId: string): string {
    if (!isStandaloneSessionForProject(sessionId, this.projectRoot)) {
      throw new Error("Review does not belong to this standalone project.");
    }
    const dir = path.join(this.projectRoot, ".deeppairing", "sessions", sessionId);
    if (!fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error("Standalone review does not exist.");
    }
    return dir;
  }

  private readMarker(dir: string, sessionId: string): EndMarker | undefined {
    const file = path.join(dir, "review-ended.json");
    try {
      const stat = fs.lstatSync(file, { throwIfNoEntry: false });
      if (!stat) return;
      const marker = stat.isFile() && markerSchema.safeParse(readJsonFile(file));
      if (marker && marker.success && marker.data.sessionId === sessionId) return marker.data;
    } catch { /* Unreadable markers also fail closed. */ }
    throw new StandaloneCloseoutError(ERROR_CODES.session_marker_invalid,
      "The standalone review's End marker cannot be verified. Review its session files before retrying.");
  }

  state(sessionId: string): StandaloneReviewState {
    const marker = this.readMarker(this.directory(sessionId), sessionId);
    if (marker) return { state: "ended", endedAt: marker.endedAt };
    return { state: this.entries.get(sessionId)?.close ? "closing" : "open" };
  }

  /** Release in a finally block after the operation settles, even on abort. */
  admitWrite(sessionId: string): (() => void) | undefined {
    if (this.state(sessionId).state !== "open") return;
    const entry = this.entry(sessionId);
    entry.writers++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--entry.writers) return;
      entry.drained?.();
      if (!entry.close) this.entries.delete(sessionId);
    };
  }

  /** A save arriving during a failed closeout still needs its turn. Waiting
   * for the attempt here does not itself count as an admitted writer. */
  async admitWatchedWrite(sessionId: string): Promise<(() => void) | undefined> {
    for (;;) {
      const closing = this.entries.get(sessionId)?.close;
      if (!closing) return this.admitWrite(sessionId);
      try { await closing; } catch { /* retry admission after a failed close */ }
    }
  }

  private entry(sessionId: string): Entry {
    const current = this.entries.get(sessionId);
    if (current) return current;
    const created = { writers: 0 };
    this.entries.set(sessionId, created);
    return created;
  }

  async end(sessionId: string): Promise<EndMarker> {
    const dir = this.directory(sessionId);
    const marker = this.readMarker(dir, sessionId);
    if (marker) return marker;
    const store = this.getStore(sessionId);
    if (store?.getSessionId() !== sessionId || store.projectRoot !== this.projectRoot) {
      throw new Error("Resume this standalone review in its project before ending it.");
    }
    const entry = this.entry(sessionId);
    if (entry.close) return entry.close;
    const deadline = performance.now() + this.timeoutMs;
    const checkDeadline = () => {
      if (performance.now() >= deadline) throw new Error("Standalone closeout timed out; retry End review.");
    };
    // Reserve the already-observed saves synchronously at the admission cut.
    // A timed-out drain still owns its permit until it actually settles.
    const releaseWatchDrain = this.drainWatchedSaves && this.admitWrite(sessionId);
    let watchDrainError: unknown;
    entry.close = Promise.resolve().then(async () => {
      if (entry.writers) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Standalone writes are still settling; retry End review.")), Math.max(0, deadline - performance.now()));
          entry.drained = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
      if (watchDrainError) throw watchDrainError;
      checkDeadline();
      reconcileReceipts(this.projectRoot, dir, store, checkDeadline);
      store.forceFlush();
      checkDeadline();
      // The session is drained. Take the existing flush lock only for this
      // final synchronous check/write, never across an await.
      const committed = withSessionFlushLock(path.join(dir, ".flush.lock"), () => {
        const existing = this.readMarker(dir, sessionId);
        if (existing) return existing;
        checkDeadline();
        const committed: EndMarker = { version: 1, sessionId, endedAt: new Date().toISOString() };
        writeJsonAtomic(path.join(dir, "review-ended.json"), committed, 2, { mode: 0o600 });
        return committed;
      });
      this.onEnded?.(sessionId, committed.endedAt);
      return committed;
    }).finally(() => {
      entry.close = undefined;
      entry.drained = undefined;
      if (!entry.writers) this.entries.delete(sessionId);
    });
    if (releaseWatchDrain) {
      void this.drainWatchedSaves!(sessionId)
        .catch((error: unknown) => { watchDrainError = error; })
        .finally(releaseWatchDrain);
    }
    return entry.close;
  }
}
