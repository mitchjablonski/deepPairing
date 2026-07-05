/**
 * J1 — global-store test guard (setupFiles, server vitest project).
 *
 * Field incident: search.test.ts seeded a rejected approach on a mkdtemp
 * project via FileStore.recordRejectedApproach(...), which mirrors into the
 * user-global philosophy ledger through getGlobalStore(). It never called
 * setGlobalStoreForTests(...), so the singleton defaulted to the developer's
 * REAL ~/.deeppairing/philosophy/v1.json — 222 test runs over a month wrote
 * "Deploy: Railway" rejections into cross-project memory.
 *
 * Most harnesses (routes.harness.ts, server-test-harness.ts, ...) already
 * redirect the singleton themselves; search.test.ts was simply missed. Rather
 * than patch one file, this runs for EVERY server test: a beforeEach points
 * the global-store singleton at an isolated tmp ledger, so no test — present
 * or future — can touch the real HOME ledger.
 *
 * Interop with harnesses that ALSO redirect: setupFiles hooks are registered
 * before the test file's own hooks, so beforeEach runs in the order
 * [this guard, harness] — the harness's redirect wins (last-wins), and
 * afterEach runs in reverse [harness, this guard] so the harness resets to
 * null first and this guard cleans up its tmp last. Idempotent either way.
 */
import { beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setGlobalStoreForTests } from "../store/global-store.js";

let guardTmpDir: string | null = null;

beforeEach(() => {
  guardTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-ledger-guard-"));
  setGlobalStoreForTests(path.join(guardTmpDir, "philosophy.json"));
});

afterEach(() => {
  setGlobalStoreForTests(null);
  if (guardTmpDir) {
    fs.rmSync(guardTmpDir, { recursive: true, force: true });
    guardTmpDir = null;
  }
});
