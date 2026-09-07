import { beforeAll, afterAll, describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { buildSync } from "esbuild";
import { ensureStopHook, ensureCheckpointHook } from "../setup-tasks.js";

// Exercise the emitted scripts and bundled entries in separate processes:
// Vitest cannot interrupt a synchronous infinite loop in its own worker.
let root: string;
const entries: Record<string, string> = {};
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dp-hook-retry-"));
  ensureStopHook(root);
  ensureCheckpointHook(root);
  entries["generated stop"] = path.join(root, ".deeppairing/hooks/stop.mjs");
  entries["generated checkpoint"] = path.join(root, ".deeppairing/hooks/checkpoint.mjs");
  for (const [name, entry] of [["bundled stop", "stop-hook-entry"], ["core", "preflight-hook-core"]]) {
    const outfile = path.join(root, `${entry}.mjs`);
    buildSync({
      entryPoints: [fileURLToPath(new URL(`../${entry}.ts`, import.meta.url))],
      outfile, bundle: true, platform: "node", format: "esm",
    });
    entries[name!] = outfile;
  }
}, 30_000);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** Fire-log length, or 0 before any hook has written one. */
function firesLength(): number {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(root, ".deeppairing/hooks-state.json"), "utf8"));
    return Array.isArray(state.fires) ? state.fires.length : 0;
  } catch {
    return 0;
  }
}

describe.each(["generated stop", "generated checkpoint", "bundled stop", "core"])("%s lock retries", lane => {
  it.each([false, true])("acquires and releases a real lock (stale=%s)", stale => {
    const statePath = path.join(root, ".deeppairing/hooks-state.json");
    const lock = statePath + ".lock";
    if (stale) {
      fs.writeFileSync(lock, "");
      const old = new Date(Date.now() - 10_000);
      fs.utimesSync(lock, old, old);
    }
    const args = lane === "core" ? ["--input-type=module", "-e",
      `import {acquireHookStateLock, releaseHookStateLock} from ${JSON.stringify(pathToFileURL(entries[lane]!).href)};
       const lock = acquireHookStateLock(${JSON.stringify(statePath)});
       console.log(lock); releaseHookStateLock(lock);`] : [entries[lane]!];
    const result = spawnSync(process.execPath, args, {
      cwd: root, encoding: "utf8", input: "{}", timeout: 5000,
      env: {...process.env, CLAUDE_PROJECT_DIR: root},
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    if (lane === "core") expect(result.stdout.trim()).toBe(lock);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it.each([
    ["open ENOENT", "ENOENT", "ENOENT", "", false],
    ["open EACCES", "EACCES", "ENOENT", "", false],
    ["open ENOSPC", "ENOSPC", "ENOENT", "", false],
    ["repeated disappearance", "EEXIST", "ENOENT", "", false],
    ["unreadable lock", "EEXIST", "EACCES", "", false],
    ["undeletable stale lock", "EEXIST", "", "EACCES", true],
    ["live contention", "EEXIST", "", "", false],
  ])("returns on %s", (_name, openError, statError, unlinkError, stale) => {
    const preload = path.join(root, "faults.mjs");
    // A fake filesystem boundary, limited to this hook's lock file. All
    // state reads and writes still use real temporary files.
    fs.writeFileSync(preload, `import fs from 'node:fs';
      const open = fs.openSync, stat = fs.statSync, unlink = fs.unlinkSync;
      const isLock = p => String(p).endsWith('hooks-state.json.lock');
      const fail = code => { throw Object.assign(new Error(code), {code}); };
      fs.openSync = (p, ...args) => isLock(p) ? fail(${JSON.stringify(openError)}) : open(p, ...args);
      fs.statSync = (p, ...args) => !isLock(p) ? stat(p, ...args) :
        ${statError ? `fail(${JSON.stringify(statError)})` : `{mtimeMs: Date.now() - ${stale ? 6000 : 0}}`};
      fs.unlinkSync = (p, ...args) => isLock(p) && ${JSON.stringify(unlinkError)} ? fail(${JSON.stringify(unlinkError)}) : unlink(p, ...args);
    `);
    const args = ["--import", pathToFileURL(preload).href];
    if (lane === "core") {
      args.push("--input-type=module", "-e", `import {acquireHookStateLock} from ${JSON.stringify(pathToFileURL(entries[lane]!).href)};
        console.log(acquireHookStateLock(${JSON.stringify(path.join(root, ".deeppairing/hooks-state.json"))}));`);
    } else {
      args.push(entries[lane]!);
    }
    // #332 review M2 — `root` is created once in beforeAll and the fire log is
    // never reset, so `fires.at(-1)` can be a record an EARLIER case wrote. Snapshot
    // the length and assert the delta, so the assertion is sensitive to the
    // thing it claims to check: that THIS hook recorded THIS fire.
    const before = firesLength();
    const result = spawnSync(process.execPath, args, {
      cwd: root, encoding: "utf8", input: "{}", timeout: 5000,
      env: {...process.env, CLAUDE_PROJECT_DIR: root, DEEPPAIRING_PROJECT_ROOT: root},
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    if (lane === "core") expect(result.stdout.trim()).toBe("null");
    else {
      const state = JSON.parse(fs.readFileSync(path.join(root, ".deeppairing/hooks-state.json"), "utf8"));
      expect(state.fires.length - before, "the hook recorded no fire of its own").toBe(1);
      expect(state.fires.at(-1).exitCode).toBe(0);
    }
  });
});
