import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildProposals,
  readRejectedApproaches,
  readTeamPreferences,
  evaluatePreflightHook,
} from "../preflight-hook-core.js";

let dir: string;
const dp = () => path.join(dir, ".deeppairing");
const writePrefs = (obj: unknown) => {
  fs.mkdirSync(dp(), { recursive: true });
  fs.writeFileSync(path.join(dp(), "preferences.json"), JSON.stringify(obj));
};
const writeTeam = (raw: string) => {
  fs.mkdirSync(dp(), { recursive: true });
  fs.writeFileSync(path.join(dp(), "team.json"), raw);
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-pfhook-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("buildProposals — pulls matchable text from a PreToolUse tool_input", () => {
  it("Write → content + path", () => {
    const r = buildProposals("Write", { file_path: "/a/b.ts", content: "let x = 1" });
    expect(r.strings).toEqual(["/a/b.ts", "let x = 1"]);
    expect(r.paths).toEqual(["/a/b.ts"]);
  });
  it("Edit → new_string + path (NOT old_string)", () => {
    const r = buildProposals("Edit", { file_path: "/a/b.ts", old_string: "OLD", new_string: "NEW code" });
    expect(r.strings).toEqual(["/a/b.ts", "NEW code"]);
    expect(r.strings).not.toContain("OLD");
  });
  it("MultiEdit → each edit's new_string", () => {
    const r = buildProposals("MultiEdit", { file_path: "/a/b.ts", edits: [{ new_string: "first" }, { new_string: "second" }] });
    expect(r.strings).toEqual(["/a/b.ts", "first", "second"]);
  });
});

describe("readRejectedApproaches", () => {
  it("returns [] when preferences.json is absent", () => {
    expect(readRejectedApproaches(dir)).toEqual([]);
  });
  it("normalizes legacy bare-string entries + drops empties", () => {
    writePrefs({ rejectedApproaches: ["use redis", { description: "" }, { description: "service layer", concept: "service layer pattern" }] });
    const r = readRejectedApproaches(dir);
    expect(r.map((x) => x.description)).toEqual(["use redis", "service layer"]);
  });
  it("returns [] on malformed JSON (never throws)", () => {
    writeTeam("{ not json"); // wrong file but proves try/catch; also test prefs
    fs.writeFileSync(path.join(dp(), "preferences.json"), "{ broken");
    expect(readRejectedApproaches(dir)).toEqual([]);
  });
});

describe("readTeamPreferences — JSONC", () => {
  it("strips // comments + validates version/preferences", () => {
    writeTeam(`// team rules\n{ "version": 1, "preferences": [ { "id": "t1", "kind": "avoid", "concept": "inline styles", "rationale": "use tokens" } ] }`);
    const r = readTeamPreferences(dir);
    expect(r).toHaveLength(1);
    expect(r[0].concept).toBe("inline styles");
  });
  it("returns [] on wrong version", () => {
    writeTeam(`{ "version": 99, "preferences": [] }`);
    expect(readTeamPreferences(dir)).toEqual([]);
  });
  it("returns [] on broken JSON (never throws)", () => {
    writeTeam("{ not json at all");
    expect(readTeamPreferences(dir)).toEqual([]);
  });
  it("is all-or-nothing — one malformed entry drops the whole file (matches the MCP loader)", () => {
    writeTeam(`{ "version": 1, "preferences": [ { "id": "ok", "kind": "avoid", "concept": "inline styles", "rationale": "r" }, { "kind": "avoid" } ] }`);
    // the MCP side returns [] (zod safeParse fails) and doesn't enforce; so must we
    expect(readTeamPreferences(dir)).toEqual([]);
  });
});

describe("evaluatePreflightHook — the platform-level gate", () => {
  it("DENIES an Edit whose new content matches a rejected approach (concept), with the LLM-facing reason", () => {
    writePrefs({ rejectedApproaches: [{ description: "global mutable config", concept: "global mutable state", reason: "caused test flakes" }] });
    const d = evaluatePreflightHook({
      toolName: "Edit",
      toolInput: { file_path: "/src/config.ts", new_string: "export let cfg = {}; // global mutable state singleton" },
      projectRoot: dir,
    });
    expect(d.deny).toBe(true);
    expect(d.source).toBe("session");
    expect(d.reason).toMatch(/REJECTED_APPROACH_BLOCKED/);
  });

  it("ALLOWS an unrelated edit", () => {
    writePrefs({ rejectedApproaches: [{ description: "global mutable config", concept: "global mutable state" }] });
    const d = evaluatePreflightHook({
      toolName: "Edit",
      toolInput: { file_path: "/src/util.ts", new_string: "export const add = (a, b) => a + b;" },
      projectRoot: dir,
    });
    expect(d.deny).toBe(false);
  });

  it("DENIES on a team 'avoid' rule (source: team)", () => {
    writeTeam(`{ "version": 1, "preferences": [ { "id": "t1", "kind": "avoid", "concept": "inline styles", "rationale": "use design tokens" } ] }`);
    const d = evaluatePreflightHook({
      toolName: "Write",
      toolInput: { file_path: "/src/Box.tsx", content: "<div style={{}}>uses inline styles here</div>" },
      projectRoot: dir,
    });
    expect(d.deny).toBe(true);
    expect(d.source).toBe("team");
  });

  it("fails open (deny:false) with no ledgers at all", () => {
    const d = evaluatePreflightHook({ toolName: "Edit", toolInput: { file_path: "/x.ts", new_string: "anything" }, projectRoot: dir });
    expect(d.deny).toBe(false);
  });

  it("deny:false when the tool_input has no matchable content", () => {
    writePrefs({ rejectedApproaches: [{ description: "x", concept: "global mutable state" }] });
    const d = evaluatePreflightHook({ toolName: "Edit", toolInput: {}, projectRoot: dir });
    expect(d.deny).toBe(false);
  });
});

// The hot hook is LOCAL-ONLY: cross-project stances are advisory-first and must
// NEVER hard-block a direct Edit/Write. readRejectedApproaches reads ONLY this
// project's ledger; a stale materialized cross-project digest (if any exists on
// disk from an older build) must be ignored.
describe("readRejectedApproaches — local-only (no cross-project reach)", () => {
  it("returns only this project's rejections (no global overlay)", () => {
    writePrefs({ rejectedApproaches: [{ description: "local reject", concept: "local concept" }] });
    const r = readRejectedApproaches(dir);
    expect(r.map((x) => x.concept)).toEqual(["local concept"]);
  });

  it("does NOT hard-deny an edit that only matches a cross-project stance (advisory belongs to the present_* path)", () => {
    // Simulate a leftover cross-project digest on disk — the hook must ignore it.
    fs.mkdirSync(path.join(dp(), "hooks"), { recursive: true });
    fs.writeFileSync(
      path.join(dp(), "hooks", "ledger-digest.json"),
      JSON.stringify({ version: 1, avoidConcepts: ["global mutable state"] }),
    );
    const d = evaluatePreflightHook({
      toolName: "Edit",
      toolInput: { file_path: "/src/x.ts", new_string: "introduce global mutable state here" },
      projectRoot: dir,
    });
    expect(d.deny).toBe(false);
  });
});
