/** #511 — bounded real subprocesses: a synchronous lock loop cannot be
 * interrupted by the test worker's timeout. Civil time can move backwards;
 * elapsed time must still expire in all shipped/generated hook lanes. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureCheckpointHook, ensurePreflightHook, ensureStopHook } from "../setup-tasks.js";

let parent: string;
let source: string;
let pluginCheckpoint: string;
const plugin = fileURLToPath(new URL("../../../../../claude-plugin/server/", import.meta.url));
const lanes = ["source", "generated stop", "generated checkpoint", "generated preflight", "plugin stop", "plugin-embedded checkpoint", "plugin preflight"] as const;
type Lane = (typeof lanes)[number];
type Clock = "normal" | "frozen" | "backward";
type Boundary = "real" | "disappeared" | "stat-denied" | "open-denied";

beforeAll(() => {
  parent = fs.mkdtempSync(path.join(os.tmpdir(), "dp-hook-clock-"));
  source = path.join(parent, "source.mjs");
  buildSync({ entryPoints: [fileURLToPath(new URL("../../hooks/hook-state.ts", import.meta.url))],
    outfile: source, bundle: true, platform: "node", format: "esm", target: "node20" });
  // The plugin has no standalone checkpoint.mjs: its daemon embeds the script
  // installed in projects. Decode the actual shipped literal, never rebuild it
  // from current source or evaluate arbitrary bundle code in the test process.
  const daemon = ts.createSourceFile("daemon.js", fs.readFileSync(path.join(plugin, "daemon.js"), "utf8"), ts.ScriptTarget.ESNext, false, ts.ScriptKind.JS);
  let checkpoint: string | undefined;
  for (const statement of daemon.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === "CHECKPOINT_HOOK_SCRIPT" &&
          declaration.initializer && ts.isStringLiteralLike(declaration.initializer)) checkpoint = declaration.initializer.text;
    }
  }
  if (checkpoint === undefined) throw new Error("Shipped daemon has no CHECKPOINT_HOOK_SCRIPT literal; update this provenance check for the new layout.");
  pluginCheckpoint = path.join(parent, "plugin-checkpoint.mjs");
  fs.writeFileSync(pluginCheckpoint, checkpoint);
});
afterAll(() => fs.rmSync(parent, { recursive: true, force: true }));

function probe(lane: Lane, clock: Clock, age: "fresh" | "future" | "stale", boundary: Boundary, legacyNow?: number) {
  const dir = fs.mkdtempSync(path.join(parent, "case-"));
  try {
    const project = path.join(dir, "project");
    const home = path.join(dir, "home");
    const dp = path.join(project, ".deeppairing");
    fs.mkdirSync(dp, { recursive: true });
    fs.mkdirSync(path.join(dp, "sessions"));
    fs.mkdirSync(home);
    const state = path.join(dp, "hooks-state.json");
    const lock = state + ".lock";
    fs.writeFileSync(lock, "owned-by-another-hook");
    const wall = Date.now();
    const mtime = new Date(wall + (age === "stale" ? -12000 : age === "future" ? 60000 : 0));
    fs.utimesSync(lock, mtime, mtime);
    const preload = path.join(dir, "clock.mjs");
    // Limit fs faults to this lock; all fire reads/writes are real. Change the
    // clock only AFTER the first open: every lane has already set its deadline.
    fs.writeFileSync(preload, `import fs from 'node:fs';
      const wall = Date.now(), start = process.hrtime.bigint();
      const ms = () => Number(process.hrtime.bigint() - start) / 1e6;
      let opened;
      Date.now = () => wall + (opened === undefined || ${JSON.stringify(clock)} === 'normal' ? ms()
        : ${JSON.stringify(clock)} === 'frozen' ? opened : ms() - 6800);
      const open = fs.openSync, stat = fs.statSync;
      const target = ${JSON.stringify(lock)};
      // Seed mtime in the child's own wall-clock frame; don't conflate an
      // uncontrolled parent/child clock adjustment with this deliberate fault.
      const mtime = new Date(wall + ${age === "stale" ? -12000 : age === "future" ? 60000 : 0});
      fs.utimesSync(target, mtime, mtime);
      fs.openSync = (p, ...args) => {
        if (String(p) === target) {
          opened ??= ms();
          if (${JSON.stringify(boundary)} === 'open-denied') throw {code:'EACCES'};
          if (${JSON.stringify(boundary)} === 'disappeared') throw {code:'EEXIST'};
        }
        return open(p, ...args);
      };
      fs.statSync = (p, ...args) => {
        if (String(p) === target && ${JSON.stringify(boundary)} === 'disappeared') throw {code:'ENOENT'};
        if (String(p) === target && ${JSON.stringify(boundary)} === 'stat-denied') throw {code:'EACCES'};
        return stat(p, ...args);
      };
      const exit = process.exit;
      process.exit = code => {
        process.stderr.write(JSON.stringify({lockWaitMs: opened === undefined ? null : ms()-opened}) + String.fromCharCode(10));
        exit(code);
      };`);
    const args = ["--import", pathToFileURL(preload).href];
    if (lane === "source") {
      args.push("--input-type=module", "-e", `import {acquireHookStateLock,releaseHookStateLock} from ${JSON.stringify(pathToFileURL(source).href)};
        const result = acquireHookStateLock(${JSON.stringify(state)}${legacyNow === undefined ? "" : `,${legacyNow}`});
        console.log(JSON.stringify({result})); releaseHookStateLock(result); process.exit(0);`);
    } else if (lane.startsWith("generated")) {
      expect(ensureStopHook(project).ok).toBe(true);
      expect(ensureCheckpointHook(project).ok).toBe(true);
      expect(ensurePreflightHook(project).ok).toBe(true);
      const name = lane.split(" ")[1]!;
      args.push(path.join(dp, "hooks", `${name}.mjs`));
    } else {
      args.push(lane === "plugin-embedded checkpoint" ? pluginCheckpoint : path.join(plugin, `${lane.split(" ")[1]!}.mjs`));
    }
    const child = spawnSync(process.execPath, args, {
      cwd: project, encoding: "utf8", timeout: 2000, killSignal: "SIGKILL",
      env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: project,
        DEEPPAIRING_PROJECT_ROOT: project, DEEPPAIRING_GUARDRAIL_BACKSTOP: "", DEEPPAIRING_NO_OPEN: "1" },
      input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: ".github/workflows/test.yml", content: "x" } }),
    });
    expect(child.error, JSON.stringify({ lane, clock, boundary, error: child.error?.message, stderr: child.stderr })).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const diagnostic = child.stderr.trim().split("\n").at(-1)!;
    const { lockWaitMs } = JSON.parse(diagnostic) as { lockWaitMs: number | null };
    expect(lockWaitMs, child.stderr).not.toBeNull();
    expect(lockWaitMs!).toBeLessThan(1200); // filesystem/scheduler overhead, never a longer child deadline
    if (age !== "stale" && boundary !== "stat-denied" && boundary !== "open-denied") {
      expect(lockWaitMs!).toBeGreaterThanOrEqual(450);
    }
    if (age === "stale") expect(fs.existsSync(lock)).toBe(false);
    else expect(fs.readFileSync(lock, "utf8")).toBe("owned-by-another-hook");
    if (lane === "source") {
      const result = JSON.parse(child.stdout) as { result: string | null };
      expect(result.result).toBe(age === "stale" ? lock : null);
    } else {
      const recorded = JSON.parse(fs.readFileSync(state, "utf8")) as { fires: Array<{ hook: string }> };
      expect(recorded.fires).toHaveLength(1); // degraded still writes, never drops the fire
      expect(recorded.fires[0]!.hook).toBe(lane.split(" ")[1]);
      if (lane.endsWith("preflight")) {
        expect(JSON.parse(child.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

describe.each(lanes)("%s monotonic lock budget", (lane) => {
  it.each([
    ["normal fresh", "normal", "fresh", "real"],
    ["normal future", "normal", "future", "real"],
    ["frozen fresh", "frozen", "fresh", "real"],
    ["backward future", "backward", "future", "real"],
    ["frozen repeated disappearance", "frozen", "fresh", "disappeared"],
    ["frozen stale recovery", "frozen", "stale", "real"],
    ["frozen stat EACCES", "frozen", "fresh", "stat-denied"],
    ["frozen open EACCES", "frozen", "fresh", "open-denied"],
  ] as const)("%s", (_label, clock, age, boundary) => probe(lane, clock, age, boundary));
});

it("legacy optional wall-clock seed cannot extend the elapsed budget", () => {
  probe("source", "normal", "future", "real", Date.now() + 86400000);
});
