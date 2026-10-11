/** Controlled-time scope fixtures, not a replacement for real-clock mint tests. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const CHECKPOINT_FIXTURE_EPOCH_MS = Date.UTC(2026, 0, 1);

interface MintedArtifact {
  id: string;
  sessionId: string;
  type: string;
  createdAt: string;
}

/** Verify the actual mint BEFORE normalizing only this owned receipt's timestamps. */
export function normalizeMintedCheckpointReceipt(
  root: string, artifact: MintedArtifact, filePath: string, epochMs = CHECKPOINT_FIXTURE_EPOCH_MS,
) {
  assert.ok(Number.isFinite(epochMs), "finite controlled fixture epoch");
  const absoluteFile = path.resolve(root, filePath);
  const key = crypto.createHash("sha256").update(absoluteFile).digest("hex");
  const receiptPath = path.join(root, ".deeppairing/sessions", artifact.sessionId, "code-checkpoints", `${key}.json`);
  // Caller supplies an artifact minted by this owned fixture's FileStore. Refuse
  // path traversal before reading/writing any receipt, including malformed tests.
  const sessions = path.resolve(root, ".deeppairing/sessions") + path.sep;
  assert.ok(path.resolve(receiptPath).startsWith(sessions), "owned receipt path");
  assert.equal(path.basename(artifact.sessionId), artifact.sessionId, "single session path component");
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.version, 1, "genuine receipt version");
  assert.equal(receipt.artifactId, artifact.id, "genuine artifact match");
  assert.equal(receipt.sessionId, artifact.sessionId, "genuine session match");
  assert.equal(receipt.filePath, absoluteFile, "genuine canonical file match");
  assert.equal(receipt.at, artifact.createdAt, "genuine artifact mint timestamp");
  const mintedAt = Date.parse(receipt.at);
  const ttl = artifact.type === "changeset" ? 600_000 : 60_000;
  assert.ok(Number.isFinite(mintedAt), "genuine finite mint timestamp");
  assert.equal(Date.parse(receipt.expiresAt) - mintedAt, ttl, "genuine receipt TTL");
  fs.writeFileSync(receiptPath, JSON.stringify({ ...receipt,
    at: new Date(epochMs).toISOString(), expiresAt: new Date(epochMs + ttl).toISOString(),
  }));
  return receiptPath;
}
