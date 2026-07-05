/**
 * J1 — proves the global-store test guard. Two layers:
 *  1. The server vitest setup (global-store-guard.setup.ts) redirects the
 *     singleton to an isolated tmp ledger before EVERY test, so even a test
 *     that forgets setGlobalStoreForTests(...) can't reach the real HOME path.
 *  2. Defense in depth: constructing the global store with the DEFAULT path
 *     under VITEST throws loudly instead of silently opening ~/.deeppairing.
 *
 * Regression target: the field bug where FileStore.recordRejectedApproach on a
 * fresh mkdtemp project mirrored "Deploy: Railway" into the developer's real
 * cross-project ledger 222 times.
 */
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GlobalStore, getGlobalStore } from "../global-store.js";
import { FileStore } from "../file-store.js";

const realHomeLedger = path.join(os.homedir(), ".deeppairing", "philosophy", "v1.json");

describe("J1 — global-store test guard", () => {
  it("getGlobalStore() under VITEST never resolves to the real HOME ledger", () => {
    // The setup file redirected the singleton in beforeEach — no test body
    // ever sees the real path, even without calling setGlobalStoreForTests.
    const ledgerPath = getGlobalStore().getLedgerPath();
    expect(ledgerPath).not.toBe(realHomeLedger);
    expect(ledgerPath.startsWith(path.join(os.homedir(), ".deeppairing"))).toBe(false);
  });

  it("constructing a default GlobalStore under VITEST throws loudly (defense in depth)", () => {
    // This is the failure a future un-redirected test now hits: a loud throw
    // that names the offending situation, instead of a silent HOME write.
    expect(() => new GlobalStore()).toThrow(/refused to open the real .*ledger under test/i);
    // An explicit tmp path is still fine — harnesses depend on this.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dp-guard-ok-"));
    expect(() => new GlobalStore(path.join(tmp, "philosophy.json"))).not.toThrow();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("regression: recordRejectedApproach (publish on) mirrors to tmp, never ~/.deeppairing", () => {
    // Belt-and-suspenders: point HOME at a throwaway dir so even a guard miss
    // can't touch the developer's real ledger while this test runs.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "dp-home-"));
    vi.stubEnv("HOME", fakeHome);
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-j1-"));

    const store = new FileStore(projectDir, "j1_session");
    store.setGlobalLedgerPublish(true); // exercise the cross-project mirror path
    store.recordRejectedApproach({
      description: "Deploy: Railway",
      reason: "too expensive",
      concept: "platform-as-a-service hosting",
    });
    store.forceFlush();

    // The mirror landed in the SETUP-redirected tmp ledger.
    const redirected = getGlobalStore().getLedgerPath();
    const ledger = JSON.parse(fs.readFileSync(redirected, "utf-8"));
    expect(ledger.concepts["platform-as-a-service hosting"]).toBeTruthy();

    // The (fake) HOME has no ledger at all — nothing leaked out of the tmp.
    expect(fs.existsSync(path.join(fakeHome, ".deeppairing"))).toBe(false);

    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });
});
