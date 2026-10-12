import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { prepareCheckpointReceiptObserver, checkpointReceiptEvidence, checkpointReceiptDiagnostic } from "./checkpoint-receipt-diagnostics.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("dp-receipt-diagnostic-")) throw new Error("unsafe fixture cleanup");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dp-receipt-diagnostic-"));
  roots.push(root);
  const state = path.join(root, ".deeppairing", "hooks-state.json");
  const session = "PRIVATE-SESSION-ID";
  const file = path.join(root, "PRIVATE-FILE.ts");
  const marker = path.join(path.dirname(state), "sessions", session, "code-checkpoints", crypto.createHash("sha256").update(file).digest("hex") + ".json");
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  return { root, state, session, file, marker };
}

describe("checkpoint pre-consumption diagnostics (#500), no authority changes", () => {
  it.each(["valid", "future", "expired", "missing", "mismatched"] as const)("reports distinct truthful %s metadata without receipt content", mode => {
    const f = fixture();
    const now = Date.now();
    if (mode !== "missing") {
      const at = now + (mode === "future" ? 120_000 : -120_000);
      const expiry = mode === "expired" ? now - 60_000 : now + 180_000;
      fs.writeFileSync(f.marker, JSON.stringify({ version: 1, at: new Date(at).toISOString(), expiresAt: new Date(expiry).toISOString(),
        sessionId: mode === "mismatched" ? "PRIVATE-OTHER-SESSION" : f.session,
        filePath: mode === "mismatched" ? path.join(f.root, "PRIVATE-OTHER-FILE") : f.file,
        artifactId: "PRIVATE-ARTIFACT-ID", rawInput: "PRIVATE-INPUT", credentials: "PRIVATE-TOKEN" }));
    }
    const observer = prepareCheckpointReceiptObserver(f.state);
    const child = spawnSync(process.execPath, ["--import", pathToFileURL(observer.preloadPath).href, "--input-type=module", "-e", `import fs from 'node:fs';
      const before = Date.now();
      if (Math.abs(before - new Date().getTime()) > 1000) throw new Error('observer changed native clock');
      try {fs.renameSync(${JSON.stringify(f.marker)},${JSON.stringify(f.marker + ".claim.synthetic")});}
      catch(e) {if(e.code!=='ENOENT') throw e;}
      Date.now();`], { cwd: f.root, encoding: "utf8", timeout: 5000 });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const evidence = checkpointReceiptEvidence(observer.evidencePath);
    const diagnostic = checkpointReceiptDiagnostic('{"exitCode":0}', observer.evidencePath);
    expect(diagnostic).not.toContain("PRIVATE");
    expect(diagnostic).not.toContain(f.root);
    expect(diagnostic.length).toBeLessThan(2000);
    expect(evidence).toMatchObject({ dateCalls: 2, wallSamples: [expect.objectContaining({ wallMs: expect.any(Number) }), expect.objectContaining({ wallMs: expect.any(Number) })] });
    const expected = mode === "missing" ? { exists: false, issue: "ENOENT", renameOutcome: "error", renameIssue: "ENOENT" }
      : { exists: true, atValid: true, expiryValid: true, versionMatches: true, artifactIdPresent: true,
        futureAtRead: mode === "future", expiredAtRead: mode === "expired", sessionMatches: mode !== "mismatched", fileMatches: mode !== "mismatched", renameOutcome: "ok" };
    expect(evidence, diagnostic).toMatchObject({ claims: [expected] });
    expect(() => expect("nag", diagnostic).toBe("")).toThrow(/checkpointReceipt.*claims/);
  });

  it("bounds, whitelists and labels unavailable or partial child evidence", () => {
    const f = fixture();
    const { evidencePath } = prepareCheckpointReceiptObserver(f.state);
    expect(checkpointReceiptEvidence(evidencePath)).toEqual({ issue: "unreadable" });
    fs.writeFileSync(evidencePath, JSON.stringify({ entryWallMs: 123, rawReceipt: "PRIVATE", wallSamples: Array.from({length: 20}, () => ({ wallMs: 124, secret: "PRIVATE" })),
      claims: Array.from({length: 10}, () => ({ exists: null, atMs: null, artifactId: "PRIVATE", sessionId: "PRIVATE", renameOutcome: "error", renameIssue: "EACCES" })) }));
    const evidence = checkpointReceiptEvidence(evidencePath);
    expect(evidence).toMatchObject({ partial: true, wallSamples: expect.any(Array), claims: expect.any(Array) });
    const text = JSON.stringify(evidence);
    expect(JSON.parse(text).claims).toHaveLength(4);
    expect(JSON.parse(text).wallSamples).toHaveLength(8);
    expect(text).not.toContain("PRIVATE");
    fs.writeFileSync(evidencePath, "{PRIVATE");
    expect(checkpointReceiptEvidence(evidencePath)).toEqual({ issue: "unreadable" });
    fs.writeFileSync(evidencePath, "x".repeat(8193));
    expect(checkpointReceiptEvidence(evidencePath)).toEqual({ issue: "oversize" });
  });
});
