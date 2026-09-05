/**
 * #342 — THE hook behavioural contract, run against every lane.
 *
 * The issue's acceptance criterion: "run the same behavioral contract tests
 * against generated hooks and bundled/plugin entrypoints". Before the
 * consolidation there was nothing to share — the lanes were four separate
 * implementations, so a test written against one proved nothing about the
 * others, which is how #332's lock bug and #333's ReferenceError reached
 * production in the generated lane while the bundled lane was fine.
 *
 * Lanes:
 *   generated stop        — what ensureStopHook writes into a project
 *   generated checkpoint  — what ensureCheckpointHook writes into a project
 *   bundled stop          — claude-plugin/server/stop.mjs (rebuilt from source)
 *   core                  — preflight-hook-core.js, the module the generated
 *                           preflight hook dynamically imports (lock cases)
 *
 * Everything runs in a CHILD PROCESS with an explicit `timeout`, because
 * Vitest cannot interrupt a synchronous infinite loop in its own worker: a
 * regression must fail the test, not hang the suite.
 *
 * Every case asserts the invariants a hook may never break:
 *   - exit status 0 (fail open — a hook may never fail the tool call);
 *   - no `deny` anywhere on stdout;
 *   - the fire log grew by EXACTLY ONE record (#332 review M2: asserting on
 *     `fires.at(-1)` against a log that is never reset can pass on a record the
 *     hook under test did not write);
 *   - no uncaught stack trace on stderr.
 */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { buildSync } from "esbuild";
import { ensureStopHook, ensureCheckpointHook } from "../../cli/setup-tasks.js";

const TIMEOUT = 10_000;

type Lane = "generated stop" | "generated checkpoint" | "bundled stop" | "core";
const STOP_LANES: Lane[] = ["generated stop", "bundled stop"];
const HOOK_LANES: Lane[] = ["generated stop", "generated checkpoint", "bundled stop"];
const ALL_LANES: Lane[] = [...HOOK_LANES, "core"];

/** esbuild output for the lanes that aren't written by the installer. */
let buildDir: string;
const bundled: Record<string, string> = {};

beforeAll(() => {
  buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-contract-build-"));
  for (const [key, entry] of [
    ["bundled stop", "cli/stop-hook-entry"],
    ["core", "cli/preflight-hook-core"],
  ] as const) {
    const outfile = path.join(buildDir, `${path.basename(entry)}.mjs`);
    buildSync({
      entryPoints: [fileURLToPath(new URL(`../../${entry}.ts`, import.meta.url))],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
    });
    bundled[key] = outfile;
  }
}, 60_000);
afterAll(() => fs.rmSync(buildDir, { recursive: true, force: true }));

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

/**
 * A FRESH project root per case. Sharing one root across cases is what made
 * the #332 suite's `fires.at(-1)` assertion untrustworthy; a per-case root plus
 * a length delta makes "this hook wrote this record" checkable.
 */
function makeRoot(prefix = "dp-contract-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  ensureStopHook(root);
  ensureCheckpointHook(root);
  // A project that has run `deeppairing init` and started a session — the
  // shape every lane's real work path needs. Cases about a MISSING sessions
  // dir remove it explicitly.
  fs.mkdirSync(path.join(root, ".deeppairing", "sessions"), { recursive: true });
  return root;
}

function statePath(root: string): string {
  return path.join(root, ".deeppairing", "hooks-state.json");
}

function fires(root: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(statePath(root), "utf8"));
    const f = (parsed as { fires?: unknown }).fires;
    return Array.isArray(f) ? f : [];
  } catch {
    return [];
  }
}

/** A default stdin payload that reaches each lane's real work. */
function defaultInput(lane: Lane): string {
  return lane === "generated checkpoint"
    ? JSON.stringify({ tool_name: "Edit", session_id: "s-a", tool_input: { file_path: "src/app.ts" } })
    : "{}";
}

type RunOptions = {
  input?: string;
  /** Extra JS run via `--import` before the hook: the fs-boundary fake. */
  preload?: string;
  env?: Record<string, string | undefined>;
  /** `core` lane only — the expression to evaluate against the module. */
  coreScript?: string;
};

function run(lane: Lane, root: string, opts: RunOptions = {}): SpawnSyncReturns<string> {
  const args: string[] = [];
  if (opts.preload) {
    const preload = path.join(root, `preload.${Math.random().toString(16).slice(2)}.mjs`);
    fs.writeFileSync(preload, opts.preload);
    args.push("--import", pathToFileURL(preload).href);
  }
  if (lane === "core") {
    args.push(
      "--input-type=module",
      "-e",
      `import * as core from ${JSON.stringify(pathToFileURL(bundled["core"]!).href)};\n${
        opts.coreScript ??
        `const l = core.acquireHookStateLock(${JSON.stringify(statePath(root))}); console.log(l); core.releaseHookStateLock(l);`
      }`,
    );
  } else if (lane === "bundled stop") {
    args.push(bundled["bundled stop"]!);
  } else {
    args.push(path.join(root, ".deeppairing/hooks", lane === "generated stop" ? "stop.mjs" : "checkpoint.mjs"));
  }
  return spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    input: opts.input ?? defaultInput(lane),
    timeout: TIMEOUT,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, DEEPPAIRING_PROJECT_ROOT: root, ...opts.env },
  });
}

/** Exit 0, never deny, no uncaught stack, and exactly one new fire record. */
function expectOneCleanFire(lane: Lane, root: string, opts: RunOptions = {}): string {
  const before = fires(root).length;
  const result = run(lane, root, opts);
  // `result.error` is set when spawnSync had to kill the child on `timeout` —
  // this is the assertion that turns a hang into a failure.
  expect(result.error, `${lane}: ${result.stderr}`).toBeUndefined();
  expect(result.status, `${lane}: ${result.stderr}`).toBe(0);
  expect(result.stdout).not.toContain("deny");
  expect(result.stderr).not.toContain("ReferenceError");
  expect(result.stderr, `${lane} leaked a stack trace`).not.toMatch(/^\s+at .+:\d+:\d+$/m);
  const after = fires(root);
  expect(after.length - before, `${lane} fire delta`).toBe(1);
  const record = after.at(-1) as { exitCode?: number; reason?: string };
  expect(record.exitCode).toBe(0);
  expect(typeof record.reason).toBe("string");
  return record.reason!;
}

/**
 * An fs-boundary FAKE (not a mock framework): the real filesystem everywhere
 * except the one path and one syscall the case is about.
 *
 * Each injection appends to `$DP_FAULT_LOG`. A fault that never fires would
 * make its case vacuously green — the hook would simply take the happy path
 * and satisfy every invariant — so `expectFaultFired` asserts the log is
 * non-empty. This is the difference between "the hook survived the fault" and
 * "the fault was a no-op".
 */
function fsFault(target: string, syscalls: Record<string, string>): string {
  return `import fs from 'node:fs';
const LOG = process.env.DP_FAULT_LOG;
const hit = p => String(p).includes(${JSON.stringify(target)});
const fail = (call, code) => {
  try { fs.appendFileSync(LOG, call + ':' + code + '\\n'); } catch {}
  throw Object.assign(new Error('injected ' + code), {code});
};
${Object.entries(syscalls)
  .map(
    ([call, code]) =>
      `{ const real = fs.${call}; fs.${call} = (p, ...a) => hit(p) ? fail(${JSON.stringify(call)}, ${JSON.stringify(code)}) : real(p, ...a); }`,
  )
  .join("\n")}
`;
}

/** Asserts the injected fault actually fired at least once. */
function expectFaultFired(log: string): void {
  expect(fs.existsSync(log), "the injected fault never fired — the case is vacuous").toBe(true);
  expect(fs.readFileSync(log, "utf8").trim().length, "the injected fault never fired").toBeGreaterThan(0);
}

/** A path for one case's fault log, inside that case's own root. */
function faultLog(root: string): string {
  return path.join(root, `fault.${Math.random().toString(16).slice(2)}.log`);
}

// ---------------------------------------------------------------------------

describe.each(HOOK_LANES)("%s — malformed input", (lane) => {
  it.each(["{bad", "null", "[]", '"a string"', "", "   ", '{"tool_name":123}', '{"tool_input":{"file_path":42}}'])(
    "exits 0 and records exactly one fire for stdin %j",
    (input) => {
      expectOneCleanFire(lane, makeRoot(), { input });
    },
  );
});

describe.each(STOP_LANES)("%s — malformed session data", (lane) => {
  it.each(["{bad", "null", "[]", "[null]", '{"a":1}', '[{"status":"draft"}]', '[{"type":"plan","status":"draft","createdAt":"nonsense"}]'])(
    "exits 0 and records exactly one fire for artifacts.json %j",
    (body) => {
      const root = makeRoot();
      const session = path.join(root, ".deeppairing/sessions/s1");
      fs.mkdirSync(session, { recursive: true });
      fs.writeFileSync(path.join(session, "artifacts.json"), body);
      expectOneCleanFire(lane, root);
    },
  );
});

describe.each(HOOK_LANES)("%s — missing directories", (lane) => {
  it("exits 0 with no .deeppairing at all", () => {
    const root = makeRoot();
    fs.rmSync(path.join(root, ".deeppairing/sessions"), { recursive: true, force: true });
    expectOneCleanFire(lane, root);
  });

  it("exits 0 with a sessions dir that is a file", () => {
    const root = makeRoot();
    const sessions = path.join(root, ".deeppairing/sessions");
    fs.rmSync(sessions, { recursive: true, force: true });
    fs.writeFileSync(sessions, "not a directory");
    expectOneCleanFire(lane, root);
  });

  it("exits 0 when hooks-state.json cannot be created at all", () => {
    // .deeppairing/hooks-state.json's PARENT is a file, so mkdir + O_EXCL both
    // fail. Nothing can be recorded — the hook must still exit 0.
    const root = makeRoot();
    const script =
      lane === "bundled stop"
        ? bundled["bundled stop"]!
        : path.join(root, ".deeppairing/hooks", lane === "generated stop" ? "stop.mjs" : "checkpoint.mjs");
    const jail = fs.mkdtempSync(path.join(os.tmpdir(), "dp-contract-jail-"));
    roots.push(jail);
    fs.writeFileSync(path.join(jail, ".deeppairing"), "not a directory");
    const result = spawnSync(process.execPath, [script], {
      cwd: jail,
      encoding: "utf8",
      input: defaultInput(lane),
      timeout: TIMEOUT,
      env: { ...process.env, CLAUDE_PROJECT_DIR: jail, DEEPPAIRING_PROJECT_ROOT: jail },
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("deny");
  });
});

describe.each(HOOK_LANES)("%s — corrupt hooks-state", (lane) => {
  it("salvages the bytes and still records its fire", () => {
    const root = makeRoot();
    fs.mkdirSync(path.dirname(statePath(root)), { recursive: true });
    fs.writeFileSync(statePath(root), "{not json");
    // fires() reads 0 from the corrupt file, and the hook writes exactly one.
    expectOneCleanFire(lane, root);
    const salvaged = fs.readdirSync(path.join(root, ".deeppairing")).filter((f) => f.includes(".corrupt-"));
    expect(salvaged.length).toBe(1);
  });
});

describe.each(ALL_LANES)("%s — filesystem faults on the lock", (lane) => {
  it.each([
    ["open EACCES", { openSync: "EACCES" }],
    ["open ENOSPC", { openSync: "ENOSPC" }],
    ["open ENOENT", { openSync: "ENOENT" }],
    ["stat EACCES after EEXIST", { openSync: "EEXIST", statSync: "EACCES" }],
    ["stat ENOENT after EEXIST (repeated disappearance)", { openSync: "EEXIST", statSync: "ENOENT" }],
    ["live contention", { openSync: "EEXIST" }],
  ])("stays bounded and fails open on %s", (_name, syscalls) => {
    const root = makeRoot();
    const log = faultLog(root);
    const preload = fsFault("hooks-state.json.lock", syscalls);
    const env = { DP_FAULT_LOG: log };
    if (lane === "core") {
      const result = run(lane, root, { preload, env });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      // null means "proceed unsynchronized", never "throw" and never "spin".
      expect(result.stdout.trim()).toBe("null");
    } else {
      expectOneCleanFire(lane, root, { preload, env });
    }
    expectFaultFired(log);
  });
});

describe.each(ALL_LANES)("%s — stale lock recovery", (lane) => {
  function plantStaleLock(root: string): string {
    const lock = statePath(root) + ".lock";
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, "");
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(lock, old, old);
    return lock;
  }

  it("breaks a stale lock and leaves none behind", () => {
    const root = makeRoot();
    const lock = plantStaleLock(root);
    if (lane === "core") {
      const result = run(lane, root);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(lock);
    } else {
      expectOneCleanFire(lane, root);
    }
    expect(fs.existsSync(lock)).toBe(false);
  });

  /**
   * #332 review M1 — the regression NO case in the original suite could catch.
   *
   * The first `openSync` on the lock is stalled past the 500 ms budget, as WSL
   * /mnt/c 9P latency (named in CLAUDE.md) or a suspend/resume clock jump does.
   * With the deadline checked BEFORE the stale branch, the breaker became
   * unreachable — and it is the only code anywhere that removes this lockfile,
   * so a lock left by a killed hook wedged every later hook into permanent
   * unsynchronized operation, silently reinstating the lost-update bug. The
   * one-shot `brokeStale` guard restores recovery while staying bounded.
   */
  it("still breaks a stale lock when the first open blows the whole budget", () => {
    const root = makeRoot();
    const lock = plantStaleLock(root);
    const preload = `import fs from 'node:fs';
const real = fs.openSync;
let stalled = false;
fs.openSync = (p, ...a) => {
  if (!stalled && String(p).endsWith('hooks-state.json.lock')) {
    stalled = true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
  }
  return real(p, ...a);
};
`;
    if (lane === "core") {
      const result = run(lane, root, { preload });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim(), "stale-lock recovery was skipped once the deadline passed").toBe(lock);
    } else {
      expectOneCleanFire(lane, root, { preload });
    }
    expect(fs.existsSync(lock), "the stale lock survived — no code will ever remove it").toBe(false);
  });

  it("gives up bounded on a stale lock it cannot unlink", () => {
    const root = makeRoot();
    plantStaleLock(root);
    const log = faultLog(root);
    const preload = fsFault("hooks-state.json.lock", { unlinkSync: "EACCES", openSync: "EEXIST" });
    const env = { DP_FAULT_LOG: log };
    if (lane === "core") {
      const result = run(lane, root, { preload, env });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.stdout.trim()).toBe("null");
    } else {
      expectOneCleanFire(lane, root, { preload, env });
    }
    // The unlink must actually have been attempted: the whole point of the
    // one-shot brokeStale guard is that the breaker RUNS here and then stops.
    expect(fs.readFileSync(log, "utf8")).toContain("unlinkSync:EACCES");
  });
});

describe.each(HOOK_LANES)("%s — non-Error throws", (lane) => {
  const target = lane === "generated checkpoint" ? "existsSync" : "readdirSync";
  it.each([
    ["a real Error", "new Error('read denied')", "error: read denied"],
    ["a bare string", "'read denied'", "error: read denied"],
    // #333 review (LOW): `instanceof Error` recorded "[object Object]" here.
    ["a duck-typed object", "({message: 'duck-typed error', code: 'EDUCK'})", "error: duck-typed error"],
  ])("records %s structurally", (_name, thrown, expected) => {
    const root = makeRoot();
    const preload = `import fs from 'node:fs';
const real = fs.${target};
fs.${target} = (p, ...a) => {
  if (String(p).includes('sessions')) throw ${thrown};
  return real(p, ...a);
};
`;
    expect(expectOneCleanFire(lane, root, { preload })).toBe(expected);
  });
});

describe.each(HOOK_LANES)("%s — paths with spaces and non-ASCII", (lane) => {
  it("resolves a project root containing spaces", () => {
    const root = makeRoot("dp contract spaces & ünïcode ");
    expect(expectOneCleanFire(lane, root)).toBeTruthy();
  });

  it("handles an edited file path containing spaces", () => {
    const root = makeRoot("dp contract spaces ");
    const reason = expectOneCleanFire(lane, root, {
      input: JSON.stringify({
        tool_name: "Edit",
        session_id: "s-a",
        tool_input: { file_path: "src/my components/Card büttön.tsx" },
      }),
    });
    if (lane === "generated checkpoint") expect(reason).toContain("Card büttön.tsx");
  });
});

describe.each(HOOK_LANES)("%s — contention", (lane) => {
  it(
    "keeps every concurrent fire (no lost updates)",
    async () => {
      const root = makeRoot();
      const N = 8;
      const script =
        lane === "bundled stop"
          ? bundled["bundled stop"]!
          : path.join(root, ".deeppairing/hooks", lane === "generated stop" ? "stop.mjs" : "checkpoint.mjs");
      const codes = await Promise.all(
        Array.from({ length: N }, () =>
          new Promise<number | null>((resolve, reject) => {
            const child = spawn(process.execPath, [script], {
              cwd: root,
              env: { ...process.env, CLAUDE_PROJECT_DIR: root, DEEPPAIRING_PROJECT_ROOT: root },
              stdio: ["pipe", "ignore", "ignore"],
              timeout: TIMEOUT,
            });
            child.stdin.end(defaultInput(lane));
            child.on("error", reject);
            child.on("exit", resolve);
          }),
        ),
      );
      expect(codes).toEqual(Array.from({ length: N }, () => 0));
      // The lock exists so that 8 read-modify-writes do not collapse into 4.
      expect(fires(root).length).toBe(N);
      expect(fs.existsSync(statePath(root) + ".lock")).toBe(false);
    },
    TIMEOUT * 3,
  );
});
