import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleCheckFeedback } from "../tools/check-feedback.js";
import type { ToolContext } from "../tools/types.js";
import { FileStore } from "../../store/file-store.js";
import { setGlobalStoreForTests } from "../../store/global-store.js";

/**
 * H2-1 (#144) — a FROZEN cross-project philosophy ledger was INVISIBLE: v0.1.6
 * makes GlobalStore.write() refuse to overwrite an unreadable ledger (correct —
 * it preserves months of history), but recordInstance() returns void and every
 * call site swallows in try/catch, so the present_ tools and check_feedback
 * report success while nothing records, forever, with the only signal a
 * console.error on daemon stderr nobody sees. Fix: check_feedback surfaces a
 * `ledgerHealth` field in
 * structuredContent WHEN (and only when) the ledger is frozen.
 *
 * Fake, not mock: a real FileStore over a tmp dir (empty → the plain "proceed"
 * path) and a real GlobalStore redirected at a tmp ledger we corrupt on disk.
 */
let tmpDir: string;
let ledgerPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-cf-ledger-"));
  ledgerPath = path.join(tmpDir, "philosophy.json");
  // Wins over the global-store-guard's redirect (setupFiles beforeEach runs
  // first; this test-file beforeEach runs last → last-wins).
  setGlobalStoreForTests(ledgerPath);
});

afterEach(() => {
  setGlobalStoreForTests(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeCtx(): ToolContext {
  const store = new FileStore(tmpDir, "s1");
  const server = { notification: () => {} };
  return {
    server,
    store,
    broadcast: () => {},
    port: 4000,
    helpers: {} as ToolContext["helpers"],
    state: {
      checkFeedbackPollCount: 0,
      reportedRejectedVerdicts: new Set<string>(),
      reportedPlanVerdicts: new Set<string>(),
    },
    progressToken: "tok-1",
  } as unknown as ToolContext;
}

describe("H2-1 — check_feedback surfaces a frozen philosophy ledger", () => {
  it("OMITS ledgerHealth entirely when the ledger is healthy (byte-for-byte hot path)", async () => {
    // No ledger file at all == first run == healthy.
    const res = await handleCheckFeedback(makeCtx(), {});
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc).toBeDefined();
    expect("ledgerHealth" in sc).toBe(false);
  });

  it("INCLUDES ledgerHealth naming the path + remedy when the ledger is frozen", async () => {
    // Corrupt bytes on disk → read() marks it corrupt → writes are frozen.
    fs.writeFileSync(ledgerPath, "{ this is definitely not valid json ");
    const res = await handleCheckFeedback(makeCtx(), {});
    const sc = res.structuredContent as {
      ledgerHealth?: { state?: string; ledgerPath?: string; remedy?: string };
    };
    expect(sc.ledgerHealth).toBeDefined();
    expect(sc.ledgerHealth!.state).toBe("frozen");
    expect(sc.ledgerHealth!.ledgerPath).toBe(ledgerPath);
    expect(sc.ledgerHealth!.remedy).toMatch(/doctor/);
  });
});
