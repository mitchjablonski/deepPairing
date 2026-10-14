/**
 * #170 — `init` must install the PreToolUse rejection-gate hook itself, not
 * leave it to the daemon's first-start setup. INSTALL.md advertises `init` as
 * installing the rejection-gate, and installing it at init time means the
 * concept-rejection gate is live from the very first Claude Code session.
 *
 * The behavioral contract of ensurePreflightHook (writes a canonical PreToolUse
 * entry, idempotent, own-the-row) is covered in setup-tasks.test.ts. This test
 * pins the *wiring* — that init's setup path actually calls it — in the same
 * source-shape style as doctor-discoverability.test.ts, so a future "tidy up
 * init" PR can't silently drop the gate and re-open the drift this fixed.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// __tests__/ → cli/
const initSrc = fs.readFileSync(path.join(here, "..", "init.ts"), "utf-8");

describe("init installs the PreToolUse rejection-gate hook (#170)", () => {
  it("imports ensurePreflightHook from setup-tasks", () => {
    expect(initSrc).toMatch(/import[\s\S]+?ensurePreflightHook[\s\S]+?from "\.\/setup-tasks\.js"/);
  });

  it("calls ensurePreflightHook(hookRoot, the session project dir, #538) in the setup path", () => {
    expect(initSrc).toMatch(/ensurePreflightHook\(hookRoot/);
  });

  it("wires it alongside the Stop + checkpoint hooks (not inside the doctor command)", () => {
    // All three ensure* calls should appear in main()'s setup sequence, in order.
    const stopIdx = initSrc.indexOf("ensureStopHook(hookRoot");
    const ckptIdx = initSrc.indexOf("ensureCheckpointHook(hookRoot");
    const preIdx = initSrc.indexOf("ensurePreflightHook(hookRoot");
    expect(stopIdx).toBeGreaterThan(-1);
    expect(ckptIdx).toBeGreaterThan(stopIdx);
    expect(preIdx).toBeGreaterThan(ckptIdx);
  });
});
