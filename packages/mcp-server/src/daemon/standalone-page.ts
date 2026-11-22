import path from "node:path";
import { PageContentSchema } from "@deeppairing/shared";
import { z } from "zod";
import { ERROR_CODES, TOOL_ERROR_CODES, TOOL_ERROR_RETRYABLE } from "../error-codes.js";
import { callFingerprint } from "../mcp/proposal-resolution.js";
import { preflightRejectedApproaches } from "../mcp/tool-helpers.js";
import { presentPage } from "../mcp/tools/present-page.js";
import type { BroadcastFn, ToolResult } from "../mcp/tools/types.js";
import { writeJsonAtomic } from "../store/atomic-write.js";
import { withFileLock } from "../store/file-lock.js";
import type { FileStore } from "../store/file-store.js";
import {
  operationDigest,
  readJsonFile,
  readSessionRecord,
  receiptDigestSchema,
  standaloneOperationConflict,
  standaloneOperationKey,
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

/**
 * #679/#680 — present an HTML page from the standalone CLI through the SAME
 * presentPage() handler MCP uses (validation, project-contained file read,
 * rejection gate on the page's visible text, secret scan). Only the id and the
 * write are owned here, so a request-ID retry replays instead of duplicating.
 *
 * The route validates the project, standalone session, operation id and body
 * size (including the decoded inline page cap) before entering here.
 */
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
  const args: Record<string, unknown> = {};
  for (const key of ["title", "summary", "concept", "html", "path"] as const) {
    if (input[key] !== undefined) args[key] = input[key];
  }

  const sessionId = store.getSessionId();
  const dir = path.join(projectRoot, ".deeppairing", "sessions", sessionId);
  const receiptPath = path.join(dir, `present-page-${operationId}.json`);
  // A file-backed page is bound to its path, not to the bytes it held: the
  // watcher may record later saves, and a retry of the same call must still
  // replay the artifact it created.
  const fingerprint = callFingerprint("present_page", args);
  const artifactId = `art_${standaloneOperationKey(projectRoot, sessionId, "present_page", operationId)}`;

  const save = (receipt: Receipt) => writeJsonAtomic(receiptPath, receipt, 2, { mode: 0o600 });
  const lock = <T>(run: () => T) => withFileLock(path.join(dir, ".standalone-page.lock"), run);
  const conflict = () => standaloneOperationConflict("page input");
  const reply = (content: unknown): ToolResult => {
    const saved = PageContentSchema.safeParse(content);
    const sourcePath = saved.success ? saved.data.sourcePath : undefined;
    return {
      content: [{ type: "text", text: `This operation already presented page artifact ${artifactId}.` }],
      structuredContent: { artifactId, ...(sourcePath ? { sourcePath } : {}), replayed: true },
    };
  };

  function recover(receipt: Receipt, verifyOnly = false): ToolResult | null {
    const disk = readSessionRecord(dir, "artifacts.json", "id", artifactId);
    if (disk) {
      if (disk.sessionId !== sessionId || disk.type !== "page") {
        throw new Error("Standalone page operation has a conflicting durable artifact.");
      }
      if (!receipt.committed) {
        if (!receipt.contentDigest || contentDigest(disk.content) !== receipt.contentDigest) {
          throw new Error("Durable standalone page does not match its prepared receipt.");
        }
        save({ ...receipt, committed: true });
      }
      return reply(disk.content);
    }
    if (receipt.committed || verifyOnly) throw new Error("Standalone page operation is missing its durable artifact.");
    const buffered = store.getArtifacts().find((row) => row.id === artifactId);
    if (!buffered) return null; // Nothing was written. Only a fresh, gated present may create it.
    if (buffered.sessionId !== sessionId || buffered.type !== "page" ||
        !receipt.contentDigest || contentDigest(buffered.content) !== receipt.contentDigest) {
      throw new Error("Standalone page artifact does not match its receipt.");
    }
    store.forceFlush();
    return recover(receipt, true);
  }

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
        const receipt = receiptSchema.parse(readJsonFile(receiptPath));
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
