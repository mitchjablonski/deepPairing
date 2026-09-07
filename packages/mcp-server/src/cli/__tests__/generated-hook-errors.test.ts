import { beforeEach, afterEach, describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { ensureStopHook, ensureCheckpointHook } from "../setup-tasks.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dp-hook-errors-"));
  ensureStopHook(root);
  ensureCheckpointHook(root);
  fs.mkdirSync(path.join(root, ".deeppairing/sessions"), { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function run(name: "checkpoint" | "stop", input: string, throwValue?: string) {
  const script = path.join(root, `.deeppairing/hooks/${name}.mjs`);
  const args = throwValue ? ["--input-type=module", "-e", `
    import fs from 'node:fs';
    fs.readdirSync = () => { throw ${throwValue}; };
    await import(${JSON.stringify(pathToFileURL(script).href)});
  `] : [script];
  const result = spawnSync(process.execPath, args, {
    cwd: root, input, encoding: "utf8", timeout: 5000,
    env: {...process.env, CLAUDE_PROJECT_DIR: root},
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).not.toContain("ReferenceError");
  const state = JSON.parse(fs.readFileSync(path.join(root, ".deeppairing/hooks-state.json"), "utf8"));
  expect(state.fires).toHaveLength(1);
  expect(state.fires[0]).toMatchObject({hook: name, exitCode: 0});
  return state.fires[0].reason as string;
}

describe("standalone generated hook error handlers", () => {
  it.each(["{bad", "null"])("checkpoint records malformed input %s and exits cleanly", input => {
    expect(run("checkpoint", input)).toMatch(/^error: /);
  });
  it.each(["new Error('read denied')", "'read denied'"])("Stop records thrown %s and exits cleanly", value => {
    expect(run("stop", "", value)).toBe("error: read denied");
  });
  /**
   * #342 — the two Stop lanes DISAGREED here and consolidation had to pick one.
   * The generated template read `x.status` (TypeError on a null entry, taking
   * the whole hook to the error path); the plugin-bundled entry read
   * `x?.status`, as does the shared `sessionOwesDebrief` predicate. The
   * tolerant reading wins: it is what marketplace installs already ship, and
   * one corrupt entry in one session's artifacts.json must not stop the hook
   * from checking the OTHER sessions. What #333 actually pinned — exit 0, one
   * fire record, no ReferenceError, no second throw out of the handler — is
   * asserted by `run()` for every case here and still holds.
   */
  it("Stop skips malformed artifact entries and keeps scanning", () => {
    const bad = path.join(root, ".deeppairing/sessions/bad");
    fs.mkdirSync(bad);
    fs.writeFileSync(path.join(bad, "artifacts.json"), "[null]");
    expect(run("stop", "")).toBe("pass: no blocking drafts");
  });

  it("Stop still reaches a blocking draft in another session past a malformed one", () => {
    const bad = path.join(root, ".deeppairing/sessions/aaa-bad");
    fs.mkdirSync(bad);
    fs.writeFileSync(path.join(bad, "artifacts.json"), "[null]");
    const good = path.join(root, ".deeppairing/sessions/zzz-good");
    fs.mkdirSync(good);
    fs.writeFileSync(
      path.join(good, "artifacts.json"),
      JSON.stringify([{ id: "a1", type: "plan", status: "draft", createdAt: new Date().toISOString() }]),
    );
    expect(run("stop", "")).toBe("pending artifacts in zzz-good");
  });

  /** A genuinely fatal fault must still take the error path — the #333 fix. */
  it("Stop records a filesystem fault as an error", () => {
    expect(run("stop", "", "Object.assign(new Error('injected'), {code: 'EACCES'})")).toBe("error: injected");
  });

  /**
   * #333 review (LOW) — `err instanceof Error ? err.message : String(err)` was
   * narrower than the `errorMessage` it replaced: a duck-typed `{message}`
   * throw recorded "[object Object]". `hookErrorMessage` reads `.message`
   * structurally, restoring parity. This is the single case where the two
   * implementations disagreed.
   */
  it("Stop records a duck-typed thrown object's message", () => {
    expect(run("stop", "", "({message: 'duck-typed error', code: 'EDUCK'})")).toBe("error: duck-typed error");
  });
  it("checkpoint still records a normal reminder", () => {
    expect(run("checkpoint", JSON.stringify({tool_name: "Edit", tool_input: {file_path: "src/app.ts"}})))
      .toMatch(/^nag: Edit on src\/app.ts/);
  });
});
