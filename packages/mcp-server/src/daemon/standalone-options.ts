import path from "node:path";
import { DecisionRequestSchema } from "@deeppairing/shared";
import { z } from "zod";
import { ERROR_CODES } from "../error-codes.js";
import { callFingerprint } from "../mcp/proposal-resolution.js";
import { preflightRejectedApproaches } from "../mcp/tool-helpers.js";
import { handlePresentOptions } from "../mcp/tools/present-options.js";
import type { BroadcastFn, ToolResult } from "../mcp/tools/types.js";
import { writeJsonAtomic } from "../store/atomic-write.js";
import { withFileLock } from "../store/file-lock.js";
import type { FileStore } from "../store/file-store.js";
import {
  operationDigest as digest,
  readJsonFile as readJson,
  readSessionRecord as readRecord,
  receiptDigestSchema as digestSchema,
  standaloneOperationConflict,
  standaloneOperationKey,
  type StandaloneCloseoutSnapshot,
} from "./standalone-receipts.js";

const receiptSchema = z.object({
  version: z.literal(1),
  fingerprint: digestSchema,
  proposalDigest: digestSchema.optional(),
  decisionDigest: digestSchema.optional(),
  committed: z.literal(true).optional(),
}).strict();

function optionsOperation(
  projectRoot: string,
  store: FileStore,
  operationId: string,
  broadcast: BroadcastFn,
) {
  const sessionId = store.getSessionId();
  const dir = path.join(projectRoot, ".deeppairing", "sessions", sessionId);
  const receiptPath = path.join(dir, `present-options-${operationId}.json`);
  const key = standaloneOperationKey(projectRoot, sessionId, "present_options", operationId);
  const artifactId = `art_${key}`;
  const decisionId = `dec_${key}`;

  const save = (receipt: z.infer<typeof receiptSchema>) => writeJsonAtomic(receiptPath, receipt, 2, { mode: 0o600 });
  const lock = <T>(run: () => T) => withFileLock(path.join(dir, ".standalone-options.lock"), run);
  const readReceipt = () => receiptSchema.parse(readJson(receiptPath));
  const reply = (): ToolResult => ({
    content: [{ type: "text", text: `This operation already presented artifact ${artifactId} and decision ${decisionId}.` }],
    structuredContent: { artifactId, decisionId, replayed: true },
  });

  function recover(receipt: z.infer<typeof receiptSchema>, verifyOnly = false, durableOnly = false,
    snapshot?: StandaloneCloseoutSnapshot): ToolResult | null {
    const diskArtifact = snapshot ? snapshot.record("artifacts.json", "id", artifactId) : readRecord(dir, "artifacts.json", "id", artifactId);
    const diskDecision = snapshot ? snapshot.record("decisions.json", "decisionId", decisionId) : readRecord(dir, "decisions.json", "decisionId", decisionId);
    if (diskDecision && !diskArtifact) throw new Error("Standalone decision has no durable artifact.");
    if (diskArtifact && diskDecision) {
      const link = z.object({ decisionId: z.literal(decisionId) }).safeParse(diskArtifact.content);
      if (!receipt.proposalDigest || !receipt.decisionDigest || diskArtifact.sessionId !== sessionId ||
          diskArtifact.type !== "decision" || !link.success || diskDecision.artifactId !== artifactId) {
        throw new Error("Standalone operation has missing or conflicting durable links.");
      }
      if (!receipt.committed) {
        // Both writes may have survived an interrupted receipt update. Verify
        // the original decision payload, ignoring mutable title/status/retract
        // metadata on the artifact and any later response on the decision.
        if (digest(DecisionRequestSchema.parse(diskArtifact.content)) !== receipt.decisionDigest ||
            digest(DecisionRequestSchema.parse(diskDecision)) !== receipt.decisionDigest) {
          throw new Error("Durable standalone decision does not match its prepared receipt.");
        }
        if (!snapshot) save({ ...receipt, committed: true });
      }
      return reply();
    }
    if (receipt.committed || verifyOnly) throw new Error("Standalone operation is missing one or both durable records.");

    const bufferedArtifact = snapshot ? snapshot.artifact(artifactId) : store.getArtifacts().find((row) => row.id === artifactId);
    const bufferedDecision = store.getDecision(decisionId);
    if (durableOnly && !diskArtifact && (bufferedArtifact || bufferedDecision)) {
      throw new Error("Standalone decision has buffered effects without a durable artifact.");
    }
    const artifact = diskArtifact ?? bufferedArtifact;
    if (!artifact) {
      if (bufferedDecision) throw new Error("Standalone operation is missing its artifact.");
      return null; // No artifact was written. Only a fresh successful preflight may create it.
    }
    const proposal = { type: artifact.type, title: artifact.title, content: artifact.content };
    if (artifact.sessionId !== sessionId || artifact.type !== "decision" || digest(proposal) !== receipt.proposalDigest ||
        (bufferedArtifact && digest({ type: bufferedArtifact.type, title: bufferedArtifact.title, content: bufferedArtifact.content }) !== receipt.proposalDigest)) {
      throw new Error("Standalone operation artifact does not match its receipt.");
    }
    const expected = { ...DecisionRequestSchema.parse(artifact.content), artifactId };
    if (expected.decisionId !== decisionId || digest(DecisionRequestSchema.parse(expected)) !== receipt.decisionDigest) {
      throw new Error("Standalone operation decision does not match its receipt.");
    }
    if (bufferedDecision && (bufferedDecision.artifactId !== artifactId ||
        digest(DecisionRequestSchema.parse(bufferedDecision)) !== receipt.decisionDigest)) {
      throw new Error("Standalone operation has a conflicting decision.");
    }
    // Another daemon's stale cache must not create a decision for an artifact
    // it has not loaded, or infer a verdict for a reviewed artifact.
    if (!bufferedArtifact) throw new Error("Reload the daemon session before repairing its standalone operation.");
    if (!bufferedDecision) {
      if (artifact.status !== "draft" || bufferedArtifact.status !== "draft") {
        throw new Error("Cannot recreate a missing decision for a reviewed standalone artifact.");
      }
      if (!snapshot) store.recordDecisionRequest(expected);
    }
    if (snapshot) return reply();
    store.forceFlush();
    const repaired = recover(receipt, true);
    broadcast({ type: "daemon_resumed" });
    return repaired;
  }

  return { artifactId, decisionId, receiptPath, save, lock, readReceipt, recover };
}

/** Validate the closeout snapshot before returning any repair work. */
export function planStandaloneOptionsRecovery(projectRoot: string, store: FileStore, operationId: string,
  broadcast: BroadcastFn, snapshot: StandaloneCloseoutSnapshot): (() => void) | undefined {
  const operation = optionsOperation(projectRoot, store, operationId, broadcast);
  const receipt = operation.readReceipt();
  const found = operation.recover(receipt, false, true, snapshot);
  if (!found || receipt.committed) return;
  return () => { operation.lock(() => operation.recover(operation.readReceipt(), false, true)); };
}

/** The route validates the project, standalone session and operation id before entering here. */
export async function presentStandaloneOptions(
  projectRoot: string,
  store: FileStore,
  operationId: string,
  args: Record<string, unknown>,
  port: number,
  broadcast: BroadcastFn,
): Promise<ToolResult> {
  const { artifactId, decisionId, receiptPath, save, lock, readReceipt, recover } = optionsOperation(projectRoot, store, operationId, broadcast);
  const fingerprint = callFingerprint("present_options", args);
  const conflict = () => standaloneOperationConflict("options input");
  const existing = lock(() => {
    const saved = readJson(receiptPath);
    if (saved === undefined) {
      save({ version: 1, fingerprint });
      return null;
    }
    const receipt = receiptSchema.parse(saved);
    return receipt.fingerprint === fingerprint ? recover(receipt) : conflict();
  });
  if (existing) return existing;

  let refusalReason: string | undefined;
  const result = await handlePresentOptions({
    store, port, broadcast,
    helpers: {
      tryElicit: async () => null,
      autoNameSession: async () => {},
      getPassiveFeedback: async () => "",
      beginPresentIdempotency: async () => ({}),
      preflightRejectedApproaches: async (...input) => {
        const preflight = await preflightRejectedApproaches(store, broadcast, ...input);
        if (!preflight.ok && typeof preflight.event.match.reason === "string") refusalReason = preflight.event.match.reason;
        return preflight;
      },
    },
  }, args, {
    artifactId, decisionId,
    persist: (input, decision) => lock(() => {
      const receipt = readReceipt();
      if (receipt.fingerprint !== fingerprint) return { replay: conflict() };
      const replay = recover(receipt);
      if (replay) return { replay };
      const prepared = {
        ...receipt,
        proposalDigest: digest({ type: input.type, title: input.title, content: input.content }),
        decisionDigest: digest(DecisionRequestSchema.parse(decision)),
      };
      save(prepared);
      const artifact = store.createArtifact(input);
      store.recordDecisionRequest(decision);
      store.forceFlush();
      // Confirm the durable pair before marking this operation complete.
      recover(prepared, true);
      return { artifact };
    }),
  });
  if (result.isError && refusalReason !== undefined) {
    return { ...result, structuredContent: { ...result.structuredContent, code: ERROR_CODES.rejected_approach_blocked, reason: refusalReason } };
  }
  return result;
}
