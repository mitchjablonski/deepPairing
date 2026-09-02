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
import { setProjectRegistryPathForTests } from "../store/project-registry.js";
import { clearContextBankCache } from "../store/context-bank.js";

let guardTmpDir: string | null = null;

beforeEach(() => {
  guardTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-ledger-guard-"));
  setGlobalStoreForTests(path.join(guardTmpDir, "philosophy.json"));
  // The project registry (~/.deeppairing/projects.json) is the SAME hazard
  // class as the ledger above — a user-global file under the real HOME that a
  // daemon-startup path writes to. Redirect it for every test on the same
  // beforeEach so no run can ever append to the developer's real project list.
  setProjectRegistryPathForTests(path.join(guardTmpDir, "projects.json"));
  // The context-bank scan cache is module-level. Without this, a bank built in
  // one test is served to the next (whose fixture tree is a different tmpdir),
  // producing order-dependent phantom passes/failures.
  clearContextBankCache();
});

afterEach(() => {
  setGlobalStoreForTests(null);
  setProjectRegistryPathForTests(null);
  clearContextBankCache();
  if (guardTmpDir) {
    fs.rmSync(guardTmpDir, { recursive: true, force: true });
    guardTmpDir = null;
  }
});
