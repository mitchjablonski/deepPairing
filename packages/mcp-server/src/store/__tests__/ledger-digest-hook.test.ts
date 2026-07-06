import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { materializeHookLedgerDigest, hookLedgerDigestPath } from "../ledger-digest.js";
import { getGlobalStore, setGlobalStoreForTests } from "../global-store.js";

/**
 * Phase-1 (C) — the daemon materializes the global 'avoid' set into the hot
 * hook's plain-text digest. Proves the derived-'avoid' concepts land in the
 * file the dependency-free hook reads.
 */

let projectRoot: string;
let ledgerPath: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-hookdigest-"));
  ledgerPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dp-ledger-")), "v1.json");
  setGlobalStoreForTests(ledgerPath);
});
afterEach(() => {
  setGlobalStoreForTests(null);
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe("materializeHookLedgerDigest", () => {
  it("writes derived-'avoid' concepts to .deeppairing/hooks/ledger-digest.json", () => {
    // One rejection with no approvals → deriveStance === "avoid".
    getGlobalStore().recordInstance("pay-per-request hosting", {
      project: "proj-a",
      sessionId: "s1",
      verdict: "rejected",
      reason: "expensive",
    });
    materializeHookLedgerDigest(projectRoot);

    const digest = JSON.parse(fs.readFileSync(hookLedgerDigestPath(projectRoot), "utf-8"));
    expect(digest.version).toBe(1);
    expect(digest.avoidConcepts).toContain("pay-per-request hosting");
  });

  it("excludes concepts whose derived stance is NOT 'avoid' (e.g. approved)", () => {
    getGlobalStore().recordInstance("in-process LRU", {
      project: "proj-a",
      sessionId: "s1",
      verdict: "approved",
    });
    materializeHookLedgerDigest(projectRoot);
    const digest = JSON.parse(fs.readFileSync(hookLedgerDigestPath(projectRoot), "utf-8"));
    expect(digest.avoidConcepts).not.toContain("in-process LRU");
  });

  it("is idempotent — an unchanged avoid set does not rewrite the file", () => {
    getGlobalStore().recordInstance("global mutable state", { project: "p", sessionId: "s", verdict: "rejected" });
    materializeHookLedgerDigest(projectRoot);
    const p = hookLedgerDigestPath(projectRoot);
    const mtime1 = fs.statSync(p).mtimeMs;
    materializeHookLedgerDigest(projectRoot);
    expect(fs.statSync(p).mtimeMs).toBe(mtime1);
  });
});
