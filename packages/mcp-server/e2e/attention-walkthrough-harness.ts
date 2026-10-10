import { execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, type Page, type Locator, type TestInfo } from "./test.js";
import { spawnDiagnosticProcess, teardownDaemon, attachDaemonOutput } from "./daemon-harness.js";
import { redactDiagnostic } from "./diagnostics.js";

export interface SeedOperation { session: string; route: string; body: unknown }
export interface WalkthroughCase {
  id: string;
  task: string;
  boundSession: string;
  seed: SeedOperation[];
  restartAfterSeed?: boolean;
}
export interface FocusStop {
  tag: string; role: string | null; name: string; testId: string | null; disabled: boolean;
}
interface Capture { step: string; atMs: number; screenshot: string; aria: Record<string, string>; visibleText: string }
interface Assertion { label: string; passed: boolean }
interface RuntimeProvenance {
  gitSha: string; trackedWorktreeDirty: boolean; trackedDiffSha256: string;
  daemonEntrySha256: string; distManifestSha256: string; distFiles: number;
  webManifestSha256: string; webFiles: number; sharedManifestSha256: string;
  harnessSourceSha256: string; lockfileSha256: string;
}
interface DaemonOptions {
  diagnostics?: (proc: ChildProcess | undefined, info: TestInfo) => Promise<void>;
  /** Test-only causal setup-failure seam; the real daemon is already ready. */
  readyCheck?: (daemon: AttentionDaemon) => Promise<void>;
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const LIMITS = {
  keyboard: 1024, liveRegions: 256, liveText: 600, aria: 16_384, visibleText: 12_000,
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

async function directoryDigest(directory: string): Promise<{ sha256: string; files: number }> {
  const entries = (await fs.readdir(directory, { recursive: true })).sort();
  const manifest: Array<{ path: string; sha256: string }> = [];
  for (const entry of entries) {
    const file = path.join(directory, entry);
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) throw new Error("Runtime digest refuses symbolic links");
    if (stat.isFile()) manifest.push({ path: entry.split(path.sep).join("/"), sha256: digest(await fs.readFile(file)) });
  }
  return { sha256: digest(JSON.stringify(manifest)), files: manifest.length };
}

/** HEAD is source identity, not proof that dist is fresh. Fingerprint the
 * actual daemon modules, served web tree and shared runtime independently. */
async function runtimeProvenance(): Promise<RuntimeProvenance> {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: packageRoot, maxBuffer: 32 * 1024 * 1024 });
  const dist = await directoryDigest(path.join(packageRoot, "dist"));
  const web = await directoryDigest(path.join(packageRoot, "dist/web"));
  const shared = await directoryDigest(path.resolve(packageRoot, "../shared/dist"));
  const harness = [];
  for (const relative of ["playwright.attention.config.ts", "e2e/attention-walkthrough-harness.ts", "e2e/attention-walkthroughs.walkthrough.ts"]) {
    harness.push({ path: relative, sha256: digest(await fs.readFile(path.join(packageRoot, relative))) });
  }
  return {
    gitSha: git("rev-parse", "HEAD").toString().trim(),
    trackedWorktreeDirty: git("status", "--porcelain", "--untracked-files=no").length > 0,
    trackedDiffSha256: digest(git("diff", "HEAD", "--binary")),
    daemonEntrySha256: digest(await fs.readFile(path.join(packageRoot, "dist/daemon/index.js"))),
    distManifestSha256: dist.sha256, distFiles: dist.files,
    webManifestSha256: web.sha256, webFiles: web.files,
    sharedManifestSha256: shared.sha256,
    harnessSourceSha256: digest(JSON.stringify(harness)),
    lockfileSha256: digest(await fs.readFile(path.resolve(packageRoot, "../../pnpm-lock.yaml"))),
  };
}

/** A fresh real daemon per matrix row, never a discovery of somebody else's daemon. */
export class AttentionDaemon {
  readonly seedJournal: Array<SeedOperation | { operation: "restart" }> = [];
  readonly runtimes: RuntimeProvenance[] = [];
  readonly root: string;
  readonly home: string;
  readonly project: string;
  private proc?: ChildProcess;
  private token = "";
  baseURL = "";
  hash = "";
  private port?: number;

  private constructor(root: string, private readonly options: DaemonOptions) {
    this.root = root;
    this.home = path.join(root, "home");
    this.project = path.join(root, "project");
  }

  static async create(info: TestInfo, options: DaemonOptions = {}): Promise<AttentionDaemon> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dp-attention-"));
    const daemon = new AttentionDaemon(root, options);
    try {
      await fs.mkdir(daemon.home);
      await fs.mkdir(daemon.project);
      await daemon.start();
      await options.readyCheck?.(daemon);
      return daemon;
    } catch (error) {
      await daemon.diagnostics(info, true);
      try { await daemon.close(info); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Walkthrough setup failed and owned cleanup was not confirmed"); }
      throw error;
    }
  }

  private async start(): Promise<void> {
    const entry = path.join(packageRoot, "dist/daemon/index.js");
    await fs.access(entry); // README requires the cold built runtime.
    this.runtimes.push(await runtimeProvenance());
    this.proc = spawnDiagnosticProcess(process.execPath, [entry], {
      cwd: this.project,
      env: {
        ...process.env, HOME: this.home, USERPROFILE: this.home,
        DEEPPAIRING_PROJECT_ROOT: this.project,
        DEEPPAIRING_NO_OPEN: "1", BROWSER: "none",
      },
    });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (this.proc.exitCode !== null || this.proc.signalCode !== null) {
        throw new Error("Owned walkthrough daemon exited before readiness");
      }
      try {
        const meta = JSON.parse(await fs.readFile(path.join(this.project, ".deeppairing/daemon.json"), "utf8")) as {
          port?: number; authToken?: string; pid?: number;
        };
        if (meta.pid === this.proc.pid && meta.port && meta.authToken) {
          this.port = meta.port;
          this.baseURL = `http://127.0.0.1:${meta.port}`;
          const response = await fetch(`${this.baseURL}/api/daemon-info`, { signal: AbortSignal.timeout(1500) });
          const live = await response.json() as { pid?: number; projectHash?: string };
          if (response.ok && live.pid === this.proc.pid && live.projectHash) {
            const floor = Number(process.env.DEEPPAIRING_PORT_BASE);
            const span = Number(process.env.DEEPPAIRING_PORT_SPAN);
            if (!(meta.port >= floor && meta.port < floor + span)) throw new Error("Daemon escaped test port window");
            this.token = meta.authToken;
            this.hash = live.projectHash;
            return;
          }
        }
      } catch (error) {
        if (String(error).includes("escaped test port")) throw error;
        // Missing/mid-write metadata or startup HTTP: bounded retry.
      }
      await sleep(100);
    }
    throw new Error("Owned walkthrough daemon did not become ready within 20s");
  }

  async post(session: string, route: string, body: unknown): Promise<void> {
    if (!/^[a-z0-9_-]+$/i.test(session)) throw new Error("Invalid synthetic session id");
    const response = await fetch(`${this.baseURL}/api/internal/sessions/${session}/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Synthetic seed ${session}/${route} failed: HTTP ${response.status}`);
    this.seedJournal.push({ session, route, body });
  }

  async artifacts(session: string): Promise<Array<{ id: string; status: string }>> {
    const response = await fetch(`${this.baseURL}/api/internal/sessions/${session}/artifacts`, {
      headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Synthetic artifact read failed: HTTP ${response.status}`);
    return (await response.json() as { artifacts: Array<{ id: string; status: string }> }).artifacts;
  }

  async seed(operations: SeedOperation[]): Promise<void> {
    for (const op of operations) await this.post(op.session, op.route, op.body);
  }

  async restart(info: TestInfo): Promise<void> {
    await this.stop(info);
    await this.start();
    this.seedJournal.push({ operation: "restart" });
  }

  async stop(info: TestInfo): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    await this.diagnostics(info);
    await teardownDaemon(proc, this.port);
    // Shared teardown logs a bounded give-up instead of throwing. Deleting a
    // still-used store is forbidden here: prove exit AND active TCP refusal.
    if (proc.exitCode === null && proc.signalCode === null) throw new Error("Daemon still alive; owned sandbox retained");
    const port = this.port;
    if (port !== undefined) {
      const refused = await new Promise<boolean>((resolve) => {
        const socket = net.connect({ host: "127.0.0.1", port });
        const done = (value: boolean) => { socket.destroy(); resolve(value); };
        socket.once("connect", () => done(false));
        socket.once("error", (e: NodeJS.ErrnoException) => done(e.code === "ECONNREFUSED" || e.code === "ECONNRESET"));
        socket.setTimeout(500, () => done(false));
      });
      if (!refused) throw new Error("Daemon port not confirmed released; owned sandbox retained");
    }
    this.proc = undefined;
    this.port = undefined;
  }

  private async diagnostics(info: TestInfo, force = false): Promise<void> {
    try {
      if (this.options.diagnostics) await this.options.diagnostics(this.proc, info);
      else await attachDaemonOutput(this.proc, info, { force });
    } catch (error) {
      // Diagnostic I/O is secondary. It must never skip owned cleanup or
      // replace the causal setup error (including full/unwritable outputs).
      console.warn(`[attention] diagnostic attachment failed: ${redactDiagnostic(String(error)).slice(0, 500)}`);
    }
  }

  async close(info: TestInfo): Promise<void> {
    await this.stop(info);
    const canonical = await fs.realpath(this.root);
    const tempRoot = await fs.realpath(os.tmpdir());
    if (path.dirname(canonical) !== tempRoot || !path.basename(canonical).startsWith("dp-attention-")) {
      throw new Error("Refusing cleanup outside owned mkdtemp sandbox");
    }
    await fs.rm(canonical, { recursive: true, force: true });
  }
}

/** Only synthetic DOM text, never HTML, headers, browser storage or WS frames. */
export class AttentionEvidence {
  readonly keys: Array<{ key: string; atMs: number; focused: FocusStop }> = [];
  readonly captures: Capture[] = [];
  readonly assertions: Assertion[] = [];
  private readonly started = Date.now();
  private keyboardTruncated = false;
  private pressCount = 0;

  constructor(readonly page: Page, readonly info: TestInfo, readonly row: {
    scenario: WalkthroughCase; mode: "OFF" | "ON"; viewport: { width: number; height: number }; manifest: string[];
  }) {}

  async observe(): Promise<void> {
    await this.page.addInitScript(({ mode, limits }) => {
      localStorage.setItem("dp-next-up-bar", mode === "ON" ? "1" : "0");
      localStorage.setItem("dp-theme", "dark");
      const evidence = { entries: [] as Array<{ atMs: number; role: string | null; live: string | null; text: string }>, truncated: false };
      (window as unknown as { __attentionEvidence: typeof evidence }).__attentionEvidence = evidence;
      const last = new WeakMap<Element, string>();
      const sample = () => {
        for (const el of document.querySelectorAll('[aria-live], [role="status"], [role="alert"], [role="log"]')) {
          const live = el.getAttribute("aria-live");
          if (live === "off") continue;
          const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, limits.liveText);
          if (last.get(el) === text) continue;
          last.set(el, text);
          if (!text) continue;
          if (evidence.entries.length >= limits.liveRegions) { evidence.truncated = true; continue; }
          evidence.entries.push({ atMs: Math.round(performance.now()), role: el.getAttribute("role"), live, text });
        }
      };
      const observer = new MutationObserver(sample);
      observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-live", "role"] });
      document.addEventListener("DOMContentLoaded", sample, { once: true });
      window.addEventListener("pagehide", () => observer.disconnect(), { once: true });
    }, { mode: this.row.mode, limits: LIMITS });
  }

  async press(key: string): Promise<void> {
    await this.page.keyboard.press(key);
    this.pressCount++;
    const focused = await this.page.evaluate((): FocusStop => {
      const el = document.activeElement;
      return {
        tag: el?.tagName ?? "NONE", role: el?.getAttribute("role") ?? null,
        name: (el?.getAttribute("aria-label") ?? el?.getAttribute("title") ?? el?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
        testId: el?.getAttribute("data-testid") ?? null,
        disabled: el instanceof HTMLButtonElement ? el.disabled : false,
      };
    });
    if (this.keys.length < LIMITS.keyboard) this.keys.push({ key, atMs: Date.now() - this.started, focused });
    else this.keyboardTruncated = true;
  }

  async activate(target: Locator): Promise<void> {
    await expect(target).toBeVisible();
    await expect(target).toBeEnabled();
    for (let i = 0; i < 120; i++) {
      if (await target.evaluate((el) => el === document.activeElement)) { await this.press("Enter"); return; }
      await this.press("Tab");
    }
    throw new Error("Keyboard journey could not reach target in 120 Tab stops");
  }

  async check(label: string, assertion: () => Promise<void>): Promise<void> {
    try { await assertion(); this.assertions.push({ label, passed: true }); }
    catch (error) { this.assertions.push({ label, passed: false }); throw error; }
  }

  async capture(step: string): Promise<void> {
    const screenshot = `${step}.png`;
    await this.page.screenshot({ path: this.info.outputPath(screenshot), fullPage: false });
    const aria: Record<string, string> = {};
    for (const [name, locator] of Object.entries({
      nextUp: this.page.getByRole("region", { name: "Next up", exact: true }),
      pending: this.page.getByRole("region", { name: "Waiting for you", exact: true }),
      sessions: this.page.getByRole("navigation", { name: "Sessions", exact: true }),
      main: this.page.getByRole("main"),
    })) {
      if (await locator.count()) aria[name] = redactDiagnostic(await locator.first().ariaSnapshot()).slice(0, LIMITS.aria);
    }
    this.captures.push({ step, atMs: Date.now() - this.started, screenshot, aria, visibleText: redactDiagnostic(await this.page.locator("body").innerText()).slice(0, LIMITS.visibleText) });
  }

  async save(status: "passed" | "failed", cleanup: "removed" | "retained", failure?: unknown, executedSeed: readonly unknown[] = [], startups: readonly RuntimeProvenance[] = []): Promise<void> {
    const liveRegions = await this.page.evaluate(() =>
      (window as unknown as { __attentionEvidence?: unknown }).__attentionEvidence ?? { entries: [], truncated: false },
    ).catch(() => ({ entries: [], truncated: false, unavailable: true }));
    const atSave = await runtimeProvenance();
    const evidence = {
      schemaVersion: 1,
      runtime: {
        gitSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: packageRoot, encoding: "utf8" }).trim(),
        node: process.version, platform: process.platform,
        playwright: require("@playwright/test/package.json").version as string,
        browser: this.page.context().browser()?.version() ?? "unknown",
        startups, atSave,
        builtRuntimeStable: startups.every((start) => start.distManifestSha256 === atSave.distManifestSha256 && start.sharedManifestSha256 === atSave.sharedManifestSha256),
        provenanceLimit: "A clean tracked tree is not cold-build proof. Actual built runtime and harness digests are recorded; build:clean is a documented precondition, not inferred from HEAD.",
      },
      syntheticOnly: true, status, cleanup, mode: this.row.mode, viewport: this.row.viewport,
      scenario: { id: this.row.scenario.id, task: this.row.scenario.task, boundSession: this.row.scenario.boundSession },
      matrix: { caseCount: this.row.manifest.length, cases: this.row.manifest },
      seedDigest: createHash("sha256").update(JSON.stringify(executedSeed)).digest("hex"),
      seedOperations: executedSeed,
      recipeDigest: createHash("sha256").update(JSON.stringify(this.row.scenario.seed)).digest("hex"),
      keyboard: { presses: this.pressCount, truncated: this.keyboardTruncated, events: this.keys },
      clocks: { keyboardAndCaptures: "milliseconds since row start", liveRegions: "milliseconds since page navigation" },
      assertions: this.assertions, captures: this.captures, liveRegions,
      limitations: [
        "Synthetic internal API seeding is not a live Claude task; seeding influences agent-activity signals.",
        "Chromium, dark, reduced motion, two desktop sizes only; no humans, real screen readers, speech timing, usability verdict, pilot or default-rollout approval.",
        "ARIA/live DOM changes are bounded potential-announcement proxies, not accessibility speech; aria-live=off is excluded.",
        "Disconnected sampled after browser-observed outage; the 60-second escalation is not measured.",
        "Tab-search journeys are reproducible automation, not optimal human paths or legacy keystroke-count replication.",
      ],
      ...(failure ? { failure: redactDiagnostic(String(failure)).slice(0, 2000) } : {}),
    };
    const file = this.info.outputPath("evidence.v1.json");
    await fs.writeFile(file, redactDiagnostic(JSON.stringify(evidence, null, 2)));
    await this.info.attach("attention-evidence-v1", { path: file, contentType: "application/json" });
  }
}
