// Shared setup for the routes.*.test.ts suite (split from the original
// monolithic routes.test.ts). NOT a test file — the vitest "server" project
// only includes src/**/*.test.ts, so the .harness.ts name keeps it out of
// the run while staying importable next to the split files.
import { createHttpRoutes } from "../routes.js";
import { FileStore } from "../../store/file-store.js";
import { setGlobalStoreForTests } from "../../store/global-store.js";
import { projectHashOf } from "../../project-root.js";
import { __resetMetricsCacheForTests } from "../../store/metrics-store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// II2 — fail-closed X-Project-Hash. Wrap any test-constructed Hono app so
// the gate doesn't trip on every existing test. Tests that exercise the gate
// itself construct an unwrapped app via createHttpRoutes directly, or pass
// an explicit X-Project-Hash header to override the auto-injected one.
export function withHash<T extends { request: any }>(appLike: T, root: string): T {
  const projectHash = projectHashOf(root);
  const origRequest = appLike.request.bind(appLike);
  (appLike as any).request = (url: any, init?: any) => {
    const headers = new Headers(init?.headers || {});
    if (!headers.has("X-Project-Hash")) headers.set("X-Project-Hash", projectHash);
    return origRequest(url, { ...(init || {}), headers });
  };
  return appLike;
}

export type RoutesApp = ReturnType<typeof createHttpRoutes>;

export interface RoutesTestContext {
  tmpDir: string;
  store: FileStore;
  app: RoutesApp;
}

/** The original file's beforeEach body — each split file registers this. */
export function createRoutesTestContext(): RoutesTestContext {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-route-test-"));
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
  const store = new FileStore(tmpDir, "test_session");
  const app = withHash(createHttpRoutes(store, tmpDir), tmpDir);
  return { tmpDir, store, app };
}

/** The original file's afterEach body. */
export function destroyRoutesTestContext(ctx: { tmpDir: string; store: FileStore }): void {
  // Force flush so the FileStore's debounced writer doesn't fire after rmSync
  // removes tmpDir (that race surfaces as an unhandled ENOENT in the runner).
  ctx.store.forceFlush();
  __resetMetricsCacheForTests(); // SP3 — clear debounced metrics timers before rmSync
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
  setGlobalStoreForTests(null);
}
