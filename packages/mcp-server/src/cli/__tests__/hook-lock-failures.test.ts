import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";

describe("hook lock failures", () => {
  it("returns on a persistent ENOENT instead of skipping the deadline forever", () => {
    // A subprocess bounds the regression: the old synchronous loop cannot
    // be interrupted by a Vitest timeout on the same event loop.
    const moduleUrl = new URL("../preflight-hook-core.ts", import.meta.url).href;
    const script = `import fs from 'node:fs';
      import { acquireHookStateLock } from ${JSON.stringify(moduleUrl)};
      fs.openSync = () => { throw Object.assign(new Error('missing'), {code:'ENOENT'}); };
      fs.statSync = () => { throw Object.assign(new Error('missing'), {code:'ENOENT'}); };
      console.log(acquireHookStateLock('/missing/state.json'));`;
    const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script], { timeout: 10_000, encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("null");
  });
});
