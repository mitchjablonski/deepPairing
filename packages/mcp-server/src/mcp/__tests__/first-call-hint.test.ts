/**
 * The first-call hint carries the ALWAYS-ON protocol preamble — the
 * orientation every agent gets on its first MCP call, even when the consuming
 * project wired only the MCP server (no pairing-protocol skill, no init). It is
 * therefore the one surface guaranteed to teach a capability.
 *
 * Regression pin: pre-this, the happy path walked recall → findings → options →
 * spec → plan → code_change but NEVER mentioned visuals, so an agent following
 * the preamble faithfully produced a wall of prose and never learned that
 * diagrams / file maps / annotated code / prototypes exist. These tests assert
 * the preamble names visuals and each kind so the capability can't fall out of
 * the guaranteed surface again.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildFirstCallHint } from "../first-call-hint.js";
import { FileStore } from "../../store/file-store.js";
import { setGlobalStoreForTests } from "../../store/global-store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;
let store: FileStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-first-call-hint-"));
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
  store = new FileStore(tmpDir, "hint_session");
});

afterEach(() => {
  store.forceFlush();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  setGlobalStoreForTests(null);
});

describe("first-call hint — always-on protocol preamble", () => {
  it("teaches the agent to attach visuals when planning, naming every kind", async () => {
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).toMatch(/visuals\[\]/);
    expect(hint).toMatch(/diagram/);
    expect(hint).toMatch(/file_map/);
    expect(hint).toMatch(/annotated_code/);
    expect(hint).toMatch(/prototype/);
  });

  it("still leads with the happy-path choreography (visuals augment, don't replace it)", async () => {
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).toMatch(/present_spec, then present_plan/);
    expect(hint).toMatch(/check_feedback/);
    expect(hint).toMatch(/present_code_change/);
  });
});
