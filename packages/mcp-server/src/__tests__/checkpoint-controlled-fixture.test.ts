import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { FileStore } from "../store/file-store.js";
import { deriveSessionId } from "../session-id.js";
import { ensureCheckpointHook } from "../cli/setup-tasks.js";
import { withGlobalStore, type GlobalStoreFixture } from "./global-store-fixture.js";
import { beginHookSpawn, hookSpawnDiagnostic } from "./hook-spawn-diagnostics.js";
import { prepareCheckpointReceiptObserver, checkpointReceiptDiagnostic, checkpointReceiptEvidence, type CheckpointFixtureClock } from "./checkpoint-receipt-diagnostics.js";
import { CHECKPOINT_FIXTURE_EPOCH_MS as epoch, normalizeMintedCheckpointReceipt } from "./checkpoint-controlled-fixture.js";

let fx: GlobalStoreFixture;
let store: FileStore;
let sequence: number;
beforeEach(() => {
  fx = withGlobalStore("dp-controlled-checkpoint-");
  store = fx.track(new FileStore(fx.dir, deriveSessionId(fx.dir, "session-a").sessionId));
  sequence = 0;
  ensureCheckpointHook(fx.dir);
});
afterEach(() => fx.dispose());

function mint(type: "code_change" | "changeset" = "code_change") {
  return store.createArtifact({ id: `controlled-${++sequence}`, type, title: "synthetic edit", content: type === "code_change"
    ? { filePath: "src/a.ts", changeType: "modify", before: "old", after: "new", reasoning: "synthetic" }
    : { files: [{ path: "src/a.ts", changeType: "modified", hunks: [] }] } });
}
function run(clock: CheckpointFixtureClock) {
  const observation = beginHookSpawn("controlled generated checkpoint", 5000, path.join(fx.dir, ".deeppairing/hooks-state.json"));
  const observer = prepareCheckpointReceiptObserver(observation.statePath, clock);
  const child = spawnSync(process.execPath, ["--import", pathToFileURL(observer.preloadPath).href, path.join(fx.dir, ".deeppairing/hooks/checkpoint.mjs")], {
    cwd: fx.dir, encoding: "utf8", timeout: 5000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: fx.dir, CLAUDE_CODE_SESSION_ID: "session-a" },
    input: JSON.stringify({ tool_name: "Edit", session_id: "session-a", tool_input: { file_path: "src/a.ts" } }),
  });
  const diagnostic = checkpointReceiptDiagnostic(hookSpawnDiagnostic(observation, child), observer.evidencePath);
  expect(child.error, diagnostic).toBeUndefined();
  expect(child.status, diagnostic).toBe(0);
  const state = JSON.parse(fs.readFileSync(observation.statePath, "utf8"));
  expect(state.fires.at(-1), diagnostic).toMatchObject({ hook: "checkpoint", exitCode: 0 });
  expect(state.fires.at(-1).reason, diagnostic).not.toMatch(/^error:/);
  return { child, diagnostic, evidence: checkpointReceiptEvidence(observer.evidencePath) };
}

describe("explicit owned checkpoint fixture clock (test-only)", () => {
  it.each(["code_change", "changeset"] as const)("verifies genuine %s mint metadata and TTL before normalizing", type => {
    const artifact = mint(type);
    const receiptPath = normalizeMintedCheckpointReceipt(fx.dir, artifact, "src/a.ts");
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    expect(receipt).toMatchObject({ artifactId: artifact.id, sessionId: artifact.sessionId, filePath: path.join(fx.dir, "src/a.ts"),
      at: new Date(epoch).toISOString(), expiresAt: new Date(epoch + (type === "changeset" ? 600_000 : 60_000)).toISOString() });
    // Normalization never changes the genuine artifact timestamp.
    expect(store.getArtifacts().find(value => value.id === artifact.id)?.createdAt).toBe(artifact.createdAt);
  });

  it("refuses mismatched mint metadata or TTL before overwriting the receipt", () => {
    const artifact = mint();
    const receiptPath = normalizeMintedCheckpointReceipt(fx.dir, artifact, "src/a.ts");
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    const original = { ...receipt, at: artifact.createdAt, expiresAt: new Date(Date.parse(artifact.createdAt) + 60_000).toISOString() };
    for (const mutation of [{ artifactId: "wrong" }, { sessionId: "wrong" }, { filePath: "wrong" }, { version: 2 }, { at: "invalid" }, { expiresAt: artifact.createdAt }]) {
      const text = JSON.stringify({ ...original, ...mutation });
      fs.writeFileSync(receiptPath, text);
      expect(() => normalizeMintedCheckpointReceipt(fx.dir, artifact, "src/a.ts")).toThrow();
      expect(fs.readFileSync(receiptPath, "utf8")).toBe(text);
    }
    expect(() => normalizeMintedCheckpointReceipt(fx.dir, { ...artifact, sessionId: "../escape" }, "src/a.ts")).toThrow();
  });

  it("a declared backward input causes future refusal, but cannot invalidate the monotonic fixture premise", () => {
    for (const controlled of [false, true]) {
      const artifact = mint();
      const receiptPath = normalizeMintedCheckpointReceipt(fx.dir, artifact, "src/a.ts");
      const result = run({ inputEpochMs: epoch + 2000, inputWallStepMs: -7000, ...(controlled ? { epochMs: epoch } : {}) });
      if (controlled) expect(result.child.stderr, result.diagnostic).toBe("");
      else expect(result.child.stderr, result.diagnostic).toContain("present_code_change");
      expect(fs.existsSync(receiptPath), result.diagnostic).toBe(false); // Both outcomes claim once; refusal also consumes.
      expect(result.evidence, result.diagnostic).toMatchObject({ mode: controlled ? "fixture-monotonic" : "controlled-input",
        claims: [expect.objectContaining({ versionMatches: true, sessionMatches: true, fileMatches: true, futureAtEffectiveRead: !controlled })] });
      if (!("wallSamples" in result.evidence)) throw new Error(result.diagnostic);
      const samples = result.evidence.wallSamples;
      const before = samples[0]!, after = samples[1]!;
      expect(Number(after.inputWallMs) - Number(before.inputWallMs), result.diagnostic).toBeLessThan(-6000);
      if (controlled) expect(Number(after.effectiveMs), result.diagnostic).toBeGreaterThanOrEqual(Number(before.effectiveMs));
      expect(samples.every(sample => Number.isFinite(sample.wallMs)), result.diagnostic).toBe(true);
      expect(result.diagnostic).not.toContain(fx.dir);
      expect(result.diagnostic).not.toContain(artifact.id);
    }
  });

  it.each(["valid", "future", "expired", "invalid-time", "mismatched-session"] as const)("preserves generated authority outcome for declared %s receipt", mode => {
    const artifact = mint();
    const receiptPath = normalizeMintedCheckpointReceipt(fx.dir, artifact, "src/a.ts");
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    if (mode === "future") { receipt.at = new Date(epoch + 120_000).toISOString(); receipt.expiresAt = new Date(epoch + 180_000).toISOString(); }
    if (mode === "expired") { receipt.at = new Date(epoch - 120_000).toISOString(); receipt.expiresAt = new Date(epoch - 60_000).toISOString(); }
    if (mode === "invalid-time") receipt.at = "invalid";
    if (mode === "mismatched-session") receipt.sessionId = "wrong";
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    const result = run({ epochMs: epoch });
    if (mode === "valid") expect(result.child.stderr, result.diagnostic).toBe("");
    else expect(result.child.stderr, result.diagnostic).toContain("present_code_change");
    expect(fs.existsSync(receiptPath), result.diagnostic).toBe(false);
    expect(result.evidence, result.diagnostic).toMatchObject({ mode: "fixture-monotonic", claims: [expect.objectContaining({
      futureAtEffectiveRead: mode === "future", expiredAtEffectiveRead: mode === "expired",
      atValid: mode !== "invalid-time", sessionMatches: mode !== "mismatched-session",
    })] });
  });
});
