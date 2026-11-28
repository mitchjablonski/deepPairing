import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ERROR_CODES } from "../error-codes.js";
import { sha256Hex, stableStringify, wireForm } from "../mcp/proposal-resolution.js";
import type { ToolResult } from "../mcp/tools/types.js";
import type { Artifact, Comment, PreflightTrace } from "@deeppairing/shared";
import type { PageRevisionFeedbackProof } from "../store/page-revision-feedback.js";

/**
 * Shared pieces of the standalone request-ID receipt (#679). Each standalone
 * present route binds one caller-chosen UUID to one input fingerprint in a
 * 0600 receipt beside the session's records, derives deterministic record ids
 * from it, and replays (same input) or refuses (changed input) a retry.
 * The per-tool recovery logic stays with each tool, because what counts as
 * "the durable records" differs (options: artifact + decision; page: artifact).
 */

export const receiptDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export interface StandaloneCloseoutSnapshot {
  record(file: string, key: string, id: string): Record<string, unknown> | undefined;
  artifact(id: string): Artifact | undefined;
  comment(id: string): Comment | undefined;
  hasOtherChild(parentId: string, childId: string): boolean;
  trace(artifactId: string): PreflightTrace | undefined;
  verifyFeedback(parentId: string, proof: PageRevisionFeedbackProof): void;
}

export interface StandaloneReplaySnapshot extends StandaloneCloseoutSnapshot {
  getArtifacts(): readonly Artifact[];
}

export function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return undefined;
    throw err;
  }
}

/** Read a durable file without following a replacement or a nonregular entry. */
export function readRegularJsonFile(file: string): unknown {
  const expected = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!expected) return undefined;
  if (!expected.isFile()) throw new Error("Standalone review record is not a regular file.");
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  const fd = fs.openSync(file, flags);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
      throw new Error("Standalone review record changed while it was opened.");
    }
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

/** Read only the one durable record owned by an operation. */
export function readSessionRecord(dir: string, file: string, key: string, id: string): Record<string, unknown> | undefined {
  const raw = readJsonFile(path.join(dir, file));
  if (raw === undefined) return undefined;
  const rows = z.array(z.record(z.string(), z.unknown())).parse(raw).filter((row) => row[key] === id);
  if (rows.length > 1) throw new Error("Standalone review history has conflicting records.");
  return rows[0];
}

export function operationDigest(value: unknown): string {
  return sha256Hex(stableStringify(wireForm(value)));
}

/** The deterministic id stem for one tool's operation in one session. */
export function standaloneOperationKey(projectRoot: string, sessionId: string, toolName: string, operationId: string): string {
  return operationDigest([projectRoot, sessionId, toolName, operationId]).slice(0, 32);
}

/** The typed refusal for a request ID reused with changed input. */
export function standaloneOperationConflict(inputNoun: string): ToolResult {
  return {
    content: [{ type: "text", text: `This request ID is already bound to different ${inputNoun}. Retry with the original input or use a new UUID for changed input.` }],
    isError: true,
    structuredContent: { code: ERROR_CODES.standalone_operation_conflict },
  };
}
