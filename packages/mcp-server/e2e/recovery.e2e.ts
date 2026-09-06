import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { teardownDaemon, portOf } from "./daemon-harness.js";

/**
 * #339 — real-browser evidence for session RECOVERY (the acceptance clause the
 * deterministic FakeAdapter tests in stores/__tests__/connection.test.ts cannot
 * stand in for). A real Chromium tab against a real daemon booted from the
 * built dist, on an ISOLATED project root + HOME + port window, proves:
 *
 *   1. daemon restart → the tab notices the outage, reconnects to the NEW
 *      daemon process on the same deterministic port, and hydrates the
 *      COMPLETE snapshot (artifacts persisted before the restart AND one
 *      created only on the new daemon) through the two live doors the store
 *      has — the `connected` frame and the AA2 `daemon_resumed` refetch.
 *   2. leaving replay is browser-observable: the read-only historical frame
 *      is swapped for the live session atomically (no "Couldn't leave replay").
 *   3. leaving replay while the daemon is DOWN stays fail-closed under the
 *      replay write lock, surfaces the bounded sticky Retry toast after the
 *      product's own 10s exit timeout, and completes on its own once a daemon
 *      is back — the H1 arc from the #373 review, in a real tab.
 *
 * Isolation: mkdtemp project root + HOME, DEEPPAIRING_PORT_BASE relocated to a
 * per-run window well away from the canonical 3847-3974 product window and
 * from vitest's 20000+ windows, bounded teardown via daemon-harness. No
 * arbitrary sleeps: every wait is an expect.poll / locator wait on a product
 * signal with a bounded timeout. Tests are serial — each builds on the daemon
 * state the previous one left behind.
 */
const __dir = path.dirname(fileURLToPath(import.meta.url));
const daemonJs = path.resolve(__dir, "../dist/daemon/index.js");

// An explicit caller override wins (reproducing a specific window); otherwise
// 12000..15999 (+128 span) — disjoint from the product window and from the
// vitest per-worker windows (20128..32191), below the Linux ephemeral range.
const PORT_BASE = process.env.DEEPPAIRING_PORT_BASE ?? String(12000 + (process.pid % 4000));
const PORT_SPAN = process.env.DEEPPAIRING_PORT_SPAN ?? "128";

const LIVE = "live";
const PAST = "past";
const RESTART_TOAST = "Daemon restarted — checking session state";
const RECOVERED_TOAST = "Daemon recovered — session state refetched";
const REPLAY_STUCK_TOAST = "Couldn't leave replay";

interface Daemon {
  proc: ChildProcess;
  baseURL: string;
  token: string;
  startedAt: string;
}

let home: string;
let projectRoot: string;
let daemon: Daemon | undefined;

async function bootDaemon(): Promise<Daemon> {
  const proc = spawn(process.execPath, [daemonJs], {
    env: {
      ...process.env,
      HOME: home,
      DEEPPAIRING_PROJECT_ROOT: projectRoot,
      DEEPPAIRING_NO_OPEN: "1",
      DEEPPAIRING_PORT_BASE: PORT_BASE,
      DEEPPAIRING_PORT_SPAN: PORT_SPAN,
    },
    stdio: "ignore",
  });
  const daemonJson = path.join(projectRoot, ".deeppairing", "daemon.json");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const info = JSON.parse(fs.readFileSync(daemonJson, "utf-8")) as { port?: number; authToken?: string; pid?: number };
      // A stale daemon.json from the previous process would point at a dead
      // port; only trust the file once it names THIS process.
      if (info.port && info.authToken && info.pid === proc.pid) {
        const res = await fetch(`http://localhost:${info.port}/api/daemon-info`).catch(() => null);
        if (res?.ok) {
          const di = (await res.json()) as { startedAt?: string; pid?: number };
          if (di.pid === proc.pid) {
            const base = Number(PORT_BASE);
            expect(info.port, "daemon bound inside the isolated port window").toBeGreaterThanOrEqual(base);
            expect(info.port, "daemon bound inside the isolated port window").toBeLessThan(base + Number(PORT_SPAN));
            return { proc, baseURL: `http://localhost:${info.port}`, token: info.authToken, startedAt: di.startedAt ?? "" };
          }
        }
      }
    } catch {
      /* daemon.json missing or mid-write — retry */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill("SIGKILL");
  throw new Error("daemon did not become reachable within 15s");
}

async function stopDaemon(): Promise<void> {
  if (!daemon) return;
  await teardownDaemon(daemon.proc, portOf(daemon.baseURL));
  daemon = undefined;
}

function internal(d: Daemon, sid: string) {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${d.token}` };
  return async (route: string, body: unknown) => {
    const res = await fetch(`${d.baseURL}/api/internal/sessions/${sid}/${route}`, {
      method: "POST", headers, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`seed ${sid}/${route} failed: ${res.status}`);
  };
}

const research = (id: string, title: string) => ({
  id, type: "research", title,
  content: { summary: `${title}.`, findings: [{ category: "Recovery", title, detail: title, significance: "low" }] },
});

interface StoreProbe {
  connected: boolean;
  hydrated: boolean;
  sessionId: string | null;
  daemonStartedAt: string | null;
}

/** The connection store as the tab sees it. A probe that lands while the tab
 *  is mid-navigation (the app's own chunk-skew auto-reload, for one) has no
 *  execution context; report "not connected" so an expect.poll keeps polling
 *  instead of failing on the transient. */
const storeState = (page: Page): Promise<StoreProbe> =>
  page
    .evaluate(() => {
      const s = (window as any).__dpConnectionStore?.getState?.() ?? {};
      return {
        connected: Boolean(s.connected),
        hydrated: Boolean(s.hydrated),
        sessionId: (s.sessionId as string | null) ?? null,
        daemonStartedAt: (s.daemonStartedAt as string | null) ?? null,
      };
    })
    .catch((err: unknown) => {
      if (/Execution context was destroyed|Target closed|navigation/i.test(String(err))) {
        return { connected: false, hydrated: false, sessionId: null, daemonStartedAt: null };
      }
      throw err;
    });

/** Evidence for the report: every navigation the tab performs after goto and
 *  every console error, attached as annotations (never a raw trace upload). */
function observeTab(page: Page, testInfo: { annotations: Array<{ type: string; description?: string }> }): void {
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) testInfo.annotations.push({ type: "navigation", description: frame.url() });
  });
  page.on("console", (m) => {
    if (m.type() === "error") testInfo.annotations.push({ type: "console-error", description: m.text().slice(0, 300) });
  });
  page.on("pageerror", (e) => testInfo.annotations.push({ type: "page-error", description: e.message.slice(0, 300) }));
}

/** Every /api/* 403 seen on the page — the fail-closed hash-gate regression class. */
function collectForbidden(page: Page): string[] {
  const forbidden: string[] = [];
  page.on("response", (r) => {
    if (r.status() === 403 && new URL(r.url()).pathname.startsWith("/api/")) forbidden.push(new URL(r.url()).pathname);
  });
  return forbidden;
}

// The sidebar row's accessible name is "<title> <status label>" (the status
// suffix keeps this strict — identically-titled pending chips elsewhere in the
// chrome carry no status). Every seeded artifact here is a draft.
const artifactRow = (page: Page, title: string) => page.getByRole("button", { name: new RegExp(`^${title} Draft`) });
const exitReplayButton = (page: Page) => page.getByTitle("Exit replay (Esc)");

/**
 * The settled-tab scenarios wait for the detail pane's lazy artifact view to
 * have rendered (its chunk resolved) before the outage begins — a product
 * signal, not a network-quiet timer. The outage-DURING-load case is not
 * excluded by this: it has its own test below with a held chunk.
 */
async function settleTab(page: Page, detailArtifactId: string): Promise<void> {
  await expect(page.locator(`[data-artifact-id="${detailArtifactId}"]`)).toBeVisible({ timeout: 15_000 });
  // The detail container mounts before its lazy view resolves; the Suspense
  // fallback is the honest "chunk still loading" signal.
  await expect(viewLoading(page)).toHaveCount(0, { timeout: 15_000 });
}

const viewLoading = (page: Page) => page.getByLabel("Loading artifact view");

const chunkBoundary = (page: Page) => page.getByTestId("chunk-boundary");

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  if (!fs.existsSync(daemonJs)) {
    throw new Error(`dist/daemon/index.js missing at ${daemonJs} — run \`pnpm build\` before the e2e suite.`);
  }
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dp-339-home-"));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-339-"));
  daemon = await bootDaemon();

  // A finished session on disk (registered, seeded, wrapper gone) — the replay
  // target. After the restart below it is never registered again, so the
  // `?session=past` deep link routes it to read-only replay.
  const past = internal(daemon, PAST);
  await past("register", { title: "Past session" });
  await past("artifacts", research("res_past", "Past research"));
  await past("unregister", {});

  // The live session this tab binds to.
  const live = internal(daemon, LIVE);
  await live("register", { title: "Live session" });
  await live("artifacts", research("res_before", "Before restart"));
});

test.afterAll(async () => {
  await stopDaemon();
  for (const dir of [projectRoot, home]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("daemon restart: the tab reconnects to the new process and hydrates the complete snapshot", async ({ page }, testInfo) => {
  // The adapter's reconnect backoff is 1s/2s/4s/8s/16s (31s cumulative before
  // the sixth attempt); the tab must be allowed to find the new daemon on its
  // own schedule, so the test budget is the product's, not the 30s default.
  test.setTimeout(90_000);
  observeTab(page, testInfo);
  const forbidden = collectForbidden(page);
  await page.goto(`${daemon!.baseURL}/?session=${LIVE}`, { waitUntil: "domcontentloaded" });
  await expect(artifactRow(page, "Before restart")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => storeState(page), { timeout: 15_000 }).toMatchObject({
    connected: true, hydrated: true, sessionId: LIVE, daemonStartedAt: daemon!.startedAt,
  });
  const firstStartedAt = daemon!.startedAt;
  const port = portOf(daemon!.baseURL);
  await settleTab(page, "res_before");

  // Kill the daemon (bounded barrier: process gone AND port released) and make
  // sure the tab saw the outage before a replacement exists.
  await stopDaemon();
  await expect.poll(() => storeState(page).then((s) => s.connected), { timeout: 15_000 }).toBe(false);

  // The replacement process: same project root → same deterministic port, so
  // the tab's reconnect loop (1s/2s/4s/8s backoff) finds it on its own. The
  // wrapper re-registers the session (FileStore reloads it from disk) and
  // creates one artifact that only ever existed on the NEW daemon.
  daemon = await bootDaemon();
  expect(portOf(daemon.baseURL), "restart rebinds the same deterministic port").toBe(port);
  expect(daemon.startedAt).not.toBe(firstStartedAt);
  const live = internal(daemon, LIVE);
  await live("register", { title: "Live session" });
  await live("artifacts", research("res_after", "After restart"));
  const readyAt = Date.now();
  await expect.poll(() => storeState(page).then((s) => s.connected), { timeout: 45_000 }).toBe(true);
  testInfo.annotations.push({ type: "reconnect-latency-ms", description: String(Date.now() - readyAt) });

  // AA2 — the wrapper reports its auto-re-registration; the daemon broadcasts
  // `daemon_resumed`, the tab refetches /api/state and only claims recovery
  // after a COMPLETE hydration. Both toasts are product signals (8s ttl).
  await live("recovered", {});
  await expect(page.getByText(RESTART_TOAST)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(RECOVERED_TOAST)).toBeVisible({ timeout: 10_000 });

  // Complete hydration from the new daemon: what was persisted before the
  // restart and what was created after it, on the same bound session.
  await expect(artifactRow(page, "Before restart")).toBeVisible({ timeout: 15_000 });
  await expect(artifactRow(page, "After restart")).toBeVisible({ timeout: 15_000 });
  const after = await storeState(page);
  expect(after).toMatchObject({ connected: true, hydrated: true, sessionId: LIVE });
  expect(forbidden, "no fail-closed 403 on any /api/* read during the restart").toEqual([]);

  // Evidence, not an assertion: whether the reconnect's own `connected` frame
  // also carried the new process identity depends on whether the socket came
  // back before or after the wrapper re-registered (the daemon greets a session
  // client only once its store exists). The converged state above is what the
  // tab guarantees either way.
  testInfo.annotations.push({
    type: "restart-doors",
    description: after.daemonStartedAt === daemon.startedAt
      ? "connected frame (new daemonStartedAt) + daemon_resumed refetch"
      : "daemon_resumed refetch only (socket reconnected before the wrapper re-registered)",
  });
});

for (const closeOrder of ["before chunk failure", "after chunk failure"] as const) {
test(`daemon outage with close delivered ${closeOrder} keeps the frame and recovers`, async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  observeTab(page, testInfo);
  const forbidden = collectForbidden(page);

  if (closeOrder === "after chunk failure") {
    await page.addInitScript(() => {
      const w = window as Window & { __delayChunkClose?: boolean; __pendingChunkClose?: Array<() => void> };
      const descriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, "onclose");
      if (!descriptor?.set) throw new Error("WebSocket close descriptor missing");
      Object.defineProperty(WebSocket.prototype, "onclose", {
        configurable: true, get: descriptor.get,
        set(handler: ((this: WebSocket, event: CloseEvent) => unknown) | null) {
          descriptor.set!.call(this, function (this: WebSocket, event: CloseEvent) {
            const deliver = () => handler?.call(this, event);
            if (w.__delayChunkClose) (w.__pendingChunkClose ??= []).push(deliver);
            else deliver();
          });
        },
      });
    });
  }

  // Controlled delayed chunk: hold the detail pane's lazy artifact-view script
  // until the daemon is gone, then fail it the way the network would. Every
  // other request flows normally.
  let releaseChunk: () => void = () => {};
  const chunkHeld = new Promise<void>((resolve) => { releaseChunk = resolve; });
  let heldUrl = "";
  await page.route(/\/assets\/ResearchArtifact-[^/]+\.js(\?.*)?$/, async (route) => {
    heldUrl = route.request().url();
    await chunkHeld;
    await route.abort("connectionrefused");
  });
  const navigations: string[] = [];
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) navigations.push(f.url()); });

  await page.goto(`${daemon!.baseURL}/?session=${LIVE}`, { waitUntil: "domcontentloaded" });
  await expect(artifactRow(page, "Before restart")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => storeState(page), { timeout: 15_000 }).toMatchObject({ connected: true, hydrated: true, sessionId: LIVE });
  // The default artifact is selected after hydration; its view's chunk request
  // is then intercepted and held, so the pane is suspended on the skeleton.
  await expect.poll(() => heldUrl, { timeout: 15_000 }).toMatch(/ResearchArtifact/);
  await expect(viewLoading(page)).toBeVisible();

  const port = portOf(daemon!.baseURL);
  if (closeOrder === "after chunk failure") {
    await page.evaluate(() => { (window as Window & { __delayChunkClose?: boolean }).__delayChunkClose = true; });
  }
  await stopDaemon();
  if (closeOrder === "after chunk failure") {
    await page.waitForFunction(() => (window as Window & { __pendingChunkClose?: unknown[] }).__pendingChunkClose?.length);
    expect((await storeState(page)).connected).toBe(true);
  } else {
    await expect.poll(() => storeState(page).then((s) => s.connected), { timeout: 15_000 }).toBe(false);
  }
  expect(await fetch(`http://localhost:${port}/api/daemon-info`).then(() => false, () => true)).toBe(true);

  // Now the chunk fails, during the outage. Pre-fix: vite:preloadError →
  // unconditional reload → chrome-error:// and the tab is gone.
  releaseChunk();
  await expect(chunkBoundary(page)).toBeVisible({ timeout: 15_000 });
  await expect(chunkBoundary(page)).toHaveAttribute("data-outage", "true");
  await expect(page.getByText("This view couldn't load while the daemon was away")).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
  // The valid frame is still on screen and the tab never navigated away.
  await expect(artifactRow(page, "Before restart")).toBeVisible();
  expect(navigations.filter((u) => u.startsWith("chrome-error://"))).toEqual([]);
  expect(page.url()).toBe(`http://localhost:${port}/?session=${LIVE}`);
  const navigationsBeforeRecovery = navigations.length;
  if (closeOrder === "after chunk failure") {
    await page.evaluate(() => {
      const w = window as Window & { __delayChunkClose?: boolean; __pendingChunkClose?: Array<() => void> };
      w.__delayChunkClose = false;
      for (const deliver of w.__pendingChunkClose?.splice(0) ?? []) deliver();
    });
    await expect.poll(() => storeState(page).then((s) => s.connected)).toBe(false);
  }

  // The daemon returns; the wrapper re-registers. The tab reconnects on its
  // own backoff, and the ONE deferred reload lands on the same URL, rebinding
  // through the normal bootstrap with the fresh chunk served.
  await page.unroute(/\/assets\/ResearchArtifact-[^/]+\.js(\?.*)?$/);
  daemon = await bootDaemon();
  expect(portOf(daemon.baseURL)).toBe(port);
  const live = internal(daemon, LIVE);
  await live("register", { title: "Live session" });
  await live("artifacts", research("res_after_outage", "After outage"));

  await expect.poll(() => navigations.length, { timeout: 45_000 }).toBeGreaterThan(navigationsBeforeRecovery);
  expect(navigations.slice(navigationsBeforeRecovery)).toEqual([`http://localhost:${port}/?session=${LIVE}`]);
  await settleTab(page, "res_before");
  await expect(artifactRow(page, "Before restart")).toBeVisible({ timeout: 15_000 });
  await expect(artifactRow(page, "After outage")).toBeVisible({ timeout: 15_000 });
  await expect(chunkBoundary(page)).toHaveCount(0);
  await expect.poll(() => storeState(page), { timeout: 15_000 }).toMatchObject({
    connected: true, hydrated: true, sessionId: LIVE, daemonStartedAt: daemon.startedAt,
  });
  expect(forbidden).toEqual([]);
  // Exactly one reload, and only after the origin answered again.
  expect(navigations.length).toBe(navigationsBeforeRecovery + 1);
});
}

test("online chunk skew reloads once, then the loop guard retains the frame", async ({ page }) => {
  const navigations: string[] = [];
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  await page.route(/\/assets\/ResearchArtifact-[^/]+\.js(\?.*)?$/, route => route.abort("failed"));
  await page.goto(`${daemon!.baseURL}/?session=${LIVE}`, { waitUntil: "domcontentloaded" });
  await expect(chunkBoundary(page)).toHaveAttribute("data-recovery", "blocked", { timeout: 15_000 });
  expect(navigations).toEqual([`${daemon!.baseURL}/?session=${LIVE}`, `${daemon!.baseURL}/?session=${LIVE}`]);
  await expect(artifactRow(page, "Before restart")).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
});

test("replay exit is browser-observable: the historical frame is swapped for the live session", async ({ page }, testInfo) => {
  observeTab(page, testInfo);
  const forbidden = collectForbidden(page);
  await page.goto(`${daemon!.baseURL}/?session=${PAST}`, { waitUntil: "domcontentloaded" });
  // The unregistered id lands in read-only replay over the live binding.
  await expect(exitReplayButton(page)).toBeVisible({ timeout: 15_000 });
  await expect(artifactRow(page, "Past research")).toBeVisible({ timeout: 15_000 });
  await expect(artifactRow(page, "Before restart")).toHaveCount(0);
  await expect.poll(() => storeState(page).then((s) => s.sessionId)).toBe(LIVE);

  await exitReplayButton(page).click();

  await expect(exitReplayButton(page)).toHaveCount(0, { timeout: 15_000 });
  await expect(artifactRow(page, "Before restart")).toBeVisible({ timeout: 15_000 });
  await expect(artifactRow(page, "After restart")).toBeVisible({ timeout: 15_000 });
  await expect(artifactRow(page, "Past research")).toHaveCount(0);
  await expect(page.getByText(REPLAY_STUCK_TOAST)).toHaveCount(0);
  expect(forbidden).toEqual([]);
});

test("replay exit with the daemon down stays locked, offers the bounded Retry, and completes once a daemon is back", async ({ page }, testInfo) => {
  // The product's own exit timeout is 10s; this test waits for it, not a sleep.
  test.setTimeout(90_000);
  observeTab(page, testInfo);
  await page.goto(`${daemon!.baseURL}/?session=${PAST}`, { waitUntil: "domcontentloaded" });
  await expect(exitReplayButton(page)).toBeVisible({ timeout: 15_000 });
  await expect(artifactRow(page, "Past research")).toBeVisible({ timeout: 15_000 });
  await settleTab(page, "res_past");

  const port = portOf(daemon!.baseURL);
  await stopDaemon();
  await expect.poll(() => storeState(page).then((s) => s.connected), { timeout: 15_000 }).toBe(false);

  await exitReplayButton(page).click();

  // Fail-closed: no live snapshot can arrive, so the historical frame stays
  // under the replay write lock and the sticky Retry appears after the
  // bounded wait — never a blank panel, never editable history.
  await expect(page.getByText(REPLAY_STUCK_TOAST)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(exitReplayButton(page)).toBeVisible();
  await expect(artifactRow(page, "Past research")).toBeVisible();

  // A daemon returns on the same port. The tab's reconnect loop finds it
  // FIRST — before any wrapper has re-registered the session — so the daemon
  // has no store to greet the socket with and the exit stays pending under
  // the lock (this is the ordering a real restart produces whenever the
  // browser's backoff beats the wrapper's re-registration).
  daemon = await bootDaemon();
  expect(portOf(daemon.baseURL)).toBe(port);
  await expect.poll(() => storeState(page).then((s) => s.connected), { timeout: 45_000 }).toBe(true);
  await expect(exitReplayButton(page)).toBeVisible();
  await expect(page.getByText(REPLAY_STUCK_TOAST)).toBeVisible();

  // The wrapper re-registers; nothing reaches the already-open socket. The
  // sticky Retry is the user's door: it re-runs the exit on a fresh socket,
  // whose greeting is the awaited complete snapshot.
  const live = internal(daemon, LIVE);
  await live("register", { title: "Live session" });
  await page.getByRole("button", { name: "Retry" }).click();

  await expect(exitReplayButton(page)).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText(REPLAY_STUCK_TOAST)).toHaveCount(0);
  await expect(artifactRow(page, "Before restart")).toBeVisible({ timeout: 15_000 });
  await expect(artifactRow(page, "After restart")).toBeVisible({ timeout: 15_000 });
  await expect(artifactRow(page, "Past research")).toHaveCount(0);
  await expect.poll(() => storeState(page), { timeout: 15_000 }).toMatchObject({
    connected: true, hydrated: true, sessionId: LIVE, daemonStartedAt: daemon.startedAt,
  });
});
