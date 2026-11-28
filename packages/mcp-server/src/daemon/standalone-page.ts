import path from "node:path";
import { isClosedArtifactStatus, PageContentSchema, type Artifact } from "@deeppairing/shared";
import { z } from "zod";
import { ERROR_CODES, TOOL_ERROR_CODES, TOOL_ERROR_RETRYABLE } from "../error-codes.js";
import { callFingerprint } from "../mcp/proposal-resolution.js";
import { preflightRejectedApproaches } from "../mcp/tool-helpers.js";
import { presentPage } from "../mcp/tools/present-page.js";
import type { BroadcastFn, ToolResult } from "../mcp/tools/types.js";
import { writeJsonAtomic } from "../store/atomic-write.js";
import { withFileLock } from "../store/file-lock.js";
import type { FileStore } from "../store/file-store.js";
import { findPageSuccessor } from "./page-successor.js";
import {
  operationDigest,
  readJsonFile,
  readSessionRecord,
  readRegularJsonFile,
  receiptDigestSchema,
  standaloneOperationConflict,
  standaloneOperationKey,
  type StandaloneCloseoutSnapshot,
  type StandaloneReplaySnapshot,
} from "./standalone-receipts.js";

const receiptSchema = z.object({
  version: z.literal(1),
  fingerprint: receiptDigestSchema,
  /** Digest of the page payload about to be written (title excluded: it can be renamed). */
  contentDigest: receiptDigestSchema.optional(),
  committed: z.literal(true).optional(),
}).strict();
type Receipt = z.infer<typeof receiptSchema>;

/** The page input after the route decoded it. Exactly one of html / path. */
export interface StandalonePageArgs {
  title?: unknown;
  summary?: unknown;
  concept?: unknown;
  html?: string;
  path?: string;
}

/** A client-supplied path must be project-relative: never absolute on any platform. */
export function isClientRelativePath(p: string): boolean {
  return !path.isAbsolute(p) && !path.win32.isAbsolute(p) && !/^[\\/]/.test(p) && !p.includes("\0");
}

function contentDigest(content: unknown): string {
  const { title: _title, ...payload } = PageContentSchema.parse(content);
  return operationDigest(payload);
}

function inputRefusal(message: string): ToolResult {
  const code = TOOL_ERROR_CODES.INPUT_VALIDATION_FAILED;
  return {
    content: [{ type: "text", text: `${code}: present page refused — ${message} The artifact was NOT created.` }],
    isError: true,
    _meta: { code, retryable: TOOL_ERROR_RETRYABLE[code] },
  };
}

function pageIdentity(projectRoot: string, sessionId: string, operationId: string) {
  const dir = path.join(projectRoot, ".deeppairing", "sessions", sessionId);
  return {
    dir, receiptPath: path.join(dir, `present-page-${operationId}.json`),
    artifactId: `art_${standaloneOperationKey(projectRoot, sessionId, "present_page", operationId)}`,
  };
}

function pageArgs(input: StandalonePageArgs): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const key of ["title", "summary", "concept", "html", "path"] as const) {
    if (input[key] !== undefined) args[key] = input[key];
  }
  return args;
}

function pageReplayReply(artifactId: string, disk: Record<string, unknown>, artifacts: readonly Artifact[]): ToolResult {
  const saved = PageContentSchema.safeParse(disk.content);
  const sourcePath = saved.success ? saved.data.sourcePath : undefined;
  // The backing artifact keeps its own status; any successor is reported separately.
  const backing = artifacts.find((a) => a.id === artifactId);
  const latest = backing && findPageSuccessor(backing, artifacts);
  const version = backing?.version ?? (typeof disk.version === "number" ? disk.version : 1);
  const status = String(backing?.status ?? disk.status ?? "draft");
  const current = latest
    ? { currentArtifactId: latest.id, currentVersion: latest.version, currentStatus: latest.status }
    : undefined;
  const moved = current
    ? ` It is ${status}; the page has since moved to v${current.currentVersion} (${current.currentArtifactId}, ${current.currentStatus}).`
    : isClosedArtifactStatus(status) ? ` It is ${status}.` : "";
  return {
    content: [{ type: "text", text: `This operation already presented page artifact ${artifactId} (v${version}).${moved}` }],
    structuredContent: { artifactId, ...(sourcePath ? { sourcePath } : {}), replayed: true, status, ...(current ?? {}) },
  };
}

export function replayEndedStandalonePage(projectRoot: string, sessionId: string, operationId: string,
  input: StandalonePageArgs, readSnapshot: () => StandaloneReplaySnapshot): ToolResult | null {
  const { artifactId, receiptPath } = pageIdentity(projectRoot, sessionId, operationId);
  const saved = readRegularJsonFile(receiptPath);
  if (saved === undefined) return null;
  const receipt = receiptSchema.parse(saved);
  if (!receipt.committed) return null;
  if (input.path !== undefined && !isClientRelativePath(input.path)) {
    return inputRefusal("`path` must be relative to the project root; absolute paths are not accepted from the CLI.");
  }
  if (receipt.fingerprint !== callFingerprint("present_page", pageArgs(input))) return standaloneOperationConflict("page input");

  const snapshot = readSnapshot();
  const disk = snapshot.record("artifacts.json", "id", artifactId);
  if (!disk || disk.sessionId !== sessionId || disk.type !== "page" ||
      !receipt.contentDigest || contentDigest(disk.content) !== receipt.contentDigest) {
    throw new Error("Durable standalone page does not match its committed receipt.");
  }
  return pageReplayReply(artifactId, disk, snapshot.getArtifacts());
}

function pageOperation(
  projectRoot: string,
  store: FileStore,
  operationId: string,
) {
  const sessionId = store.getSessionId();
  const { dir, receiptPath, artifactId } = pageIdentity(projectRoot, sessionId, operationId);

  const save = (receipt: Receipt) => writeJsonAtomic(receiptPath, receipt, 2, { mode: 0o600 });
  const lock = <T>(run: () => T) => withFileLock(path.join(dir, ".standalone-page.lock"), run);
  const readReceipt = () => receiptSchema.parse(readJsonFile(receiptPath));

  function recover(receipt: Receipt, verifyOnly = false, durableOnly = false, snapshot?: StandaloneCloseoutSnapshot): ToolResult | null {
    const disk = snapshot ? snapshot.record("artifacts.json", "id", artifactId) : readSessionRecord(dir, "artifacts.json", "id", artifactId);
    if (disk) {
      if (disk.sessionId !== sessionId || disk.type !== "page") {
        throw new Error("Standalone page operation has a conflicting durable artifact.");
      }
      if (!receipt.committed) {
        if (!receipt.contentDigest || contentDigest(disk.content) !== receipt.contentDigest) {
          throw new Error("Durable standalone page does not match its prepared receipt.");
        }
        if (!snapshot) save({ ...receipt, committed: true });
      }
      if (snapshot) return { content: [] };
      return pageReplayReply(artifactId, disk, store.getArtifacts());
    }
    if (receipt.committed || verifyOnly) throw new Error("Standalone page operation is missing its durable artifact.");
    const buffered = snapshot ? snapshot.artifact(artifactId) : store.getArtifacts().find((row) => row.id === artifactId);
    if (!buffered) return null; // Nothing was written. Only a fresh, gated present may create it.
    if (durableOnly) throw new Error("Standalone page has buffered effects without a durable artifact.");
    if (buffered.sessionId !== sessionId || buffered.type !== "page" ||
        !receipt.contentDigest || contentDigest(buffered.content) !== receipt.contentDigest) {
      throw new Error("Standalone page artifact does not match its receipt.");
    }
    store.forceFlush();
    return recover(receipt, true);
  }

  return { artifactId, receiptPath, save, lock, readReceipt, recover };
}

/** Settle an existing receipt without loading source HTML or admitting a proposal. */
export function planStandalonePageRecovery(projectRoot: string, store: FileStore, operationId: string,
  snapshot: StandaloneCloseoutSnapshot): (() => void) | undefined {
  const operation = pageOperation(projectRoot, store, operationId);
  const receipt = operation.readReceipt();
  const found = operation.recover(receipt, false, true, snapshot);
  if (!found || receipt.committed) return;
  return () => { operation.lock(() => operation.recover(operation.readReceipt(), false, true)); };
}

/** Authenticated routes validate the project, standalone session, operation id and body size. */
export async function presentStandalonePage(
  projectRoot: string,
  store: FileStore,
  operationId: string,
  input: StandalonePageArgs,
  port: number,
  broadcast: BroadcastFn,
): Promise<ToolResult> {
  if (input.path !== undefined && !isClientRelativePath(input.path)) {
    return inputRefusal("`path` must be relative to the project root; absolute paths are not accepted from the CLI.");
  }
  const args = pageArgs(input);
  // A file-backed receipt binds the path, even after its source bytes change.
  const fingerprint = callFingerprint("present_page", args);
  const { artifactId, receiptPath, save, lock, readReceipt, recover } = pageOperation(projectRoot, store, operationId);
  const conflict = () => standaloneOperationConflict("page input");
  const existing = lock(() => {
    const saved = readJsonFile(receiptPath);
    if (saved === undefined) {
      save({ version: 1, fingerprint });
      return null;
    }
    const receipt = receiptSchema.parse(saved);
    return receipt.fingerprint === fingerprint ? recover(receipt) : conflict();
  });
  if (existing) return existing;

  let refusalReason: string | undefined;
  let sourcePath: string | undefined;
  const result = await presentPage({
    store, port, broadcast,
    helpers: {
      tryElicit: async () => null,
      autoNameSession: async () => {},
      getPassiveFeedback: async () => "",
      beginPresentIdempotency: async () => ({}),
      preflightRejectedApproaches: async (...gateInput) => {
        const preflight = await preflightRejectedApproaches(store, broadcast, ...gateInput);
        if (!preflight.ok && typeof preflight.event.match.reason === "string") refusalReason = preflight.event.match.reason;
        return preflight;
      },
    },
  }, args, {
    projectRoot,
    standalone: {
      artifactId,
      persist: (createInput) => lock(() => {
        const receipt = readReceipt();
        if (receipt.fingerprint !== fingerprint) return { replay: conflict() };
        const replay = recover(receipt);
        if (replay) return { replay };
        const prepared: Receipt = { ...receipt, contentDigest: contentDigest(createInput.content) };
        save(prepared);
        const artifact = store.createArtifact(createInput);
        store.forceFlush();
        // Confirm the durable artifact before marking this operation complete.
        recover(prepared, true);
        sourcePath = PageContentSchema.parse(artifact.content).sourcePath;
        return { artifact };
      }),
    },
  });
  if (result.isError && refusalReason !== undefined) {
    return { ...result, structuredContent: { ...result.structuredContent, code: ERROR_CODES.rejected_approach_blocked, reason: refusalReason } };
  }
  if (result.isError || result.structuredContent?.replayed === true) return result;
  return { ...result, structuredContent: { ...result.structuredContent, artifactId, ...(sourcePath ? { sourcePath } : {}) } };
}
