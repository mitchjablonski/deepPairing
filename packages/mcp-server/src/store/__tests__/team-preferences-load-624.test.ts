import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTeamPreferences, readTeamPreferences } from "../project-signals.js";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-team-load-624-")); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });
const rule = { id: "r1", kind: "avoid", concept: "global mutable state", rationale: "explicit ownership" };
const write = (value: unknown) => fs.writeFileSync(path.join(dir, "team.json"), JSON.stringify(value));

describe("#624 — team rule load diagnostics preserve all-or-nothing fail-open", () => {
  it("distinguishes missing from valid empty without warnings", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(readTeamPreferences(dir)).toEqual({ status: "missing", preferences: [] });
    expect(loadTeamPreferences(dir)).toEqual([]);
    write({ version: 1, preferences: [] });
    expect(readTeamPreferences(dir)).toEqual({ status: "valid", preferences: [] });
    expect(loadTeamPreferences(dir)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("rejects the whole file for malformed JSON or an invalid addedAt alongside a valid rule", () => {
    fs.writeFileSync(path.join(dir, "team.json"), "{ private fixture detail");
    expect(readTeamPreferences(dir)).toEqual({ status: "invalid", preferences: [] });
    write({ version: 1, preferences: [rule, { ...rule, id: "bad", addedAt: "not-a-date" }] });
    expect(readTeamPreferences(dir)).toEqual({ status: "invalid", preferences: [] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadTeamPreferences(dir)).toEqual([]);
    expect(warn.mock.calls).toEqual([["[deepPairing] team.json invalid; ignoring team rules"]]);
  });

  it("classifies a real read failure without serializing the exception or path", () => {
    fs.mkdirSync(path.join(dir, "team.json"));
    expect(readTeamPreferences(dir)).toEqual({ status: "unreadable", preferences: [] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadTeamPreferences(dir)).toEqual([]);
    expect(warn.mock.calls).toEqual([["[deepPairing] team.json unreadable; ignoring team rules"]]);
  });

  it("fresh reads reflect repair and preserve JSONC/schema compatibility", () => {
    write({ version: 1, preferences: [{ ...rule, addedAt: "yesterday" }] });
    expect(readTeamPreferences(dir).status).toBe("invalid");
    fs.writeFileSync(path.join(dir, "team.json"), `// agreed rules\n${JSON.stringify({ version: 1, preferences: [rule] })}`);
    expect(readTeamPreferences(dir)).toEqual({ status: "valid", preferences: [rule] });
    expect(loadTeamPreferences(dir)).toEqual([rule]);
  });
});
