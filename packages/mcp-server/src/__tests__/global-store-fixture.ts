/**
 * F3 (#197) — the single owner of a test's philosophy-ledger lifecycle.
 *
 * Retires the #134 ENOENT flake class. Pre-F3, ~26 of the 33 files that
 * redirected the global store did `setGlobalStoreForTests(tmpDir/philosophy.json)`
 * then `rmSync(tmpDir)` on teardown WITHOUT first cancelling any FileStore's
 * debounced flush — so a pending `setTimeout` could fire a write against a
 * gone tmpdir and surface as an unhandled ENOENT that flakes the whole run
 * (the exact race team-preferences-preflight.test.ts's openStores/dispose()
 * pattern was added to close).
 *
 * `withGlobalStore()` OWNS create + register + dispose + cleanup:
 *   - create   — an isolated tmp dir (also usable as a project root) holding
 *                the ledger at `<dir>/philosophy.json`.
 *   - register — points the module-level global-store singleton at that ledger
 *                (`setGlobalStoreForTests`), so no test touches the real
 *                ~/.deeppairing ledger.
 *   - dispose  — cancels every tracked store's debounced flush (`dispose()`,
 *                the #134 fix — cancel WITHOUT writing; falls back to
 *                `forceFlush()` for anything that only exposes that), clears the
 *                debounced metrics-store timers (`__resetMetricsCacheForTests`,
 *                the SP3 sibling flake), resets the singleton to null, then
 *                removes the dir — in that order, so no timer outlives its dir.
 *
 * Guarded by global-store-fixture.guard.test.ts: no test file may call
 * `setGlobalStoreForTests` outside this fixture, so the flake class can't creep
 * back. The global-store-guard.setup.ts setupFile (which redirects the singleton
 * in a beforeEach for EVERY server test) and this module are the only allowed
 * callers.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setGlobalStoreForTests } from "../store/global-store.js";
import { __resetMetricsCacheForTests } from "../store/metrics-store.js";

/** Anything the fixture can safely tear down (FileStore satisfies both). */
interface Teardownable {
  dispose?: () => void;
  forceFlush?: () => void;
}

export interface GlobalStoreFixture {
  /** The tmp dir holding the isolated ledger — also a valid project root. */
  readonly dir: string;
  /** The ledger path the singleton was pointed at (`<dir>/philosophy.json`). */
  readonly ledgerPath: string;
  /**
   * Register a FileStore (or any object with `dispose()`/`forceFlush()`) so the
   * fixture cancels its debounced flush before the dir is removed. Returns the
   * store, so a construction can be wrapped inline:
   * `const store = fx.track(new FileStore(fx.dir, sid));`
   */
  track<T extends Teardownable>(store: T): T;
  /**
   * Tear down: cancel every tracked store's debounced flush, clear the metrics
   * cache timers, reset the global-store singleton to null, then remove the dir.
   */
  dispose(): void;
}

/**
 * Open an isolated global-store fixture. Call in `beforeEach`/`beforeAll`
 * (or inline in a test) and call the returned `dispose()` in the matching
 * teardown. `dirPrefix` names the mkdtemp prefix for readable temp paths.
 */
export function withGlobalStore(dirPrefix = "dp-test-"): GlobalStoreFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), dirPrefix));
  const ledgerPath = path.join(dir, "philosophy.json");
  setGlobalStoreForTests(ledgerPath);
  const tracked: Teardownable[] = [];

  return {
    dir,
    ledgerPath,
    track(store) {
      tracked.push(store);
      return store;
    },
    dispose() {
      for (const s of tracked) {
        // dispose() cancels the debounced flush WITHOUT writing (the #134 fix);
        // forceFlush() is the write-then-cancel fallback for stores that only
        // expose it. Either cancels the timer that would otherwise fire post-rm.
        if (typeof s.dispose === "function") s.dispose();
        else if (typeof s.forceFlush === "function") s.forceFlush();
      }
      __resetMetricsCacheForTests();
      setGlobalStoreForTests(null);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
