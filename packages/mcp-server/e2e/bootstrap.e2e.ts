import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The real-browser regression guard for the companion UI bootstrap (II2.2 /
 * II2.3 / GG2). Boots a real daemon from the built dist on a temp project,
 * navigates Chromium to it, and asserts the end-to-end chain that the unit
 * tests can only check in halves:
 *
 *   served HTML carries window.__dpProjectHash  (II2.3 — the doc the browser
 *     actually loads on a top-level navigation)
 *   → the store seeds the hash before its first request
 *   → the WS upgrade carries projectHash → 101 → `connected`
 *   → no fail-closed 403 on the bootstrap surface
 *
 * If this passes, "disconnected, reconnecting" / "could not load the ledger;
 * 403" cannot regress silently.
 */
const __dir = path.dirname(fileURLToPath(import.meta.url));
const daemonJs = path.resolve(__dir, "../dist/daemon.js");

let proc: ChildProcess | undefined;
let projectRoot: string;
let baseURL: string;
let expectedHash: string;

test.beforeAll(async () => {
  if (!fs.existsSync(daemonJs)) {
    throw new Error(`dist/daemon.js missing at ${daemonJs} — run \`pnpm build\` before the e2e suite.`);
  }
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-e2e-"));
  proc = spawn(process.execPath, [daemonJs], {
    env: { ...process.env, DEEPPAIRING_PROJECT_ROOT: projectRoot },
    stdio: "ignore",
  });

  // The daemon scans 3847+ for a free port and writes the bound one to
  // .deeppairing/daemon.json. Wait until it's written AND reachable.
  const infoPath = path.join(projectRoot, ".deeppairing", "daemon.json");
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) {
    if (fs.existsSync(infoPath)) {
      try {
        const info = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
        if (info.port) {
          // daemon.json carries port/pid but not the hash; /api/daemon-info
          // (public post-II2.2) is the source of truth for projectHash.
          const res = await fetch(`http://localhost:${info.port}/api/daemon-info`).catch(() => null);
          if (res?.ok) {
            const di = (await res.json()) as { projectHash?: string };
            port = info.port;
            expectedHash = di.projectHash ?? "";
          }
        }
      } catch {
        /* daemon.json mid-write — retry */
      }
    }
    if (!port) await new Promise((r) => setTimeout(r, 100));
  }
  if (!port) throw new Error("daemon did not become reachable within 10s");
  baseURL = `http://localhost:${port}`;
});

test.afterAll(async () => {
  // Await the daemon's actual exit before removing its project dir. The demo
  // test makes the daemon create + asynchronously flush a session; killing it
  // and rmSync-ing immediately races those writes (ENOTEMPTY on a sessions/
  // subdir that gets a late flush after the recursive walk started). Wait for
  // the process to be gone, then remove with retries as a belt-and-suspenders
  // for any straggling FS settle.
  if (proc) {
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      proc!.once("exit", done);
      proc!.kill();
      setTimeout(done, 3000); // safety net if exit never fires
    });
  }
  if (projectRoot) {
    fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("companion UI boots: served HTML injects the hash, the WS connects, and the ledger loads", async ({ page }) => {
  // Collect any fail-closed 403s on /api/* — the read-hash regression class
  // (every SPA read must carry X-Project-Hash, else the gate 403s it).
  const forbidden: string[] = [];
  page.on("response", (r) => {
    if (r.status() === 403) {
      const p = new URL(r.url()).pathname;
      if (p.startsWith("/api/")) forbidden.push(p);
    }
  });

  await page.goto(baseURL, { waitUntil: "domcontentloaded" });

  // II2.3 — the document served on the top-level navigation carries the hash.
  await expect
    .poll(() => page.evaluate(() => (window as Window & { __dpProjectHash?: string }).__dpProjectHash))
    .toBe(expectedHash);

  // The full chain completed: the WS upgrade carried the seeded hash → 101 →
  // the store flipped to connected (this is what "disconnected, reconnecting"
  // would fail).
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as any).__dpConnectionStore?.getState?.()?.connected ?? false,
        ),
      { timeout: 15_000 },
    )
    .toBe(true);

  // The store bound the right project (not a stale/empty hash).
  const storeHash = await page.evaluate(
    () => (window as any).__dpConnectionStore?.getState?.()?.projectHash,
  );
  expect(storeHash).toBe(expectedHash);

  // The reported symptom guard: with the hash bound, the ledger digest loads
  // instead of 403ing ("could not load the ledger; 403"). Fetched through the
  // store's headers, exactly as stores/ledger.ts does.
  const ledgerStatus = await page.evaluate(async () => {
    const cs = (window as any).__dpConnectionStore?.getState?.();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cs?.projectHash) headers["X-Project-Hash"] = cs.projectHash;
    if (cs?.sessionId) headers["X-Session-Id"] = cs.sessionId;
    return (await fetch("/api/ledger/digest", { headers })).status;
  });
  expect(ledgerStatus, "ledger digest must not be gate-403'd once the hash is bound").toBe(200);

  // Give late-mounting panels (skill banner, hook status, metrics, sessions)
  // a moment to fire their reads, then assert none hit the fail-closed gate.
  await page.waitForTimeout(1500);
  expect(forbidden, "no /api read should 403 — every SPA fetch must carry X-Project-Hash").toEqual([]);
});

test("FD-2 — `init demo` runs against the daemon with no project hash (cold-clone hero path)", async ({ request }) => {
  // Reproduces exactly what `cli/init.ts demoCmd` does: a hashless POST to
  // /api/demo/run. Before the FD-2 gate exemption this fail-closed 403'd, so
  // `node dist/cli/init.js demo` — the single command the README leads with —
  // died on a fresh clone with "daemon responded 403".
  const res = await request.post(`${baseURL}/api/demo/run`);
  expect(res.status(), "the scripted demo must not be gate-403'd").toBe(200);
  const body = (await res.json()) as { sessionId?: string };
  expect(body.sessionId, "demo run returns a fresh demo session id").toMatch(/^demo_/);
});
