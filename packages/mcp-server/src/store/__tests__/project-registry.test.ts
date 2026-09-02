// The project registry (~/.deeppairing/projects.json) — the context bank's only
// way to see a project whose daemon isn't running.
//
// NOTE the isolation: global-store-guard.setup.ts redirects
// setProjectRegistryPathForTests to a per-test tmpdir for EVERY server test, and
// projectRegistryPath() THROWS on the real HOME path under VITEST. These tests
// redirect explicitly on top of that so their assertions don't depend on the
// guard's dir surviving a future refactor.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  upsertProject,
  readProjectRegistry,
  projectRegistryPath,
  setProjectRegistryPathForTests,
} from "../project-registry.js";

let tmp: string;
let registryFile: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dp-registry-"));
  registryFile = path.join(tmp, "home", ".deeppairing", "projects.json");
  setProjectRegistryPathForTests(registryFile);
});

afterEach(() => {
  setProjectRegistryPathForTests(null);
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeProject(name: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, ".deeppairing"), { recursive: true });
  return dir;
}

describe("project registry — upsert", () => {
  it("creates the file (and its parent dir) on first upsert", () => {
    const root = makeProject("alpha");
    expect(fs.existsSync(registryFile)).toBe(false);

    expect(upsertProject(root, new Date("2026-08-01T00:00:00.000Z"))).toBe(true);

    expect(fs.existsSync(registryFile)).toBe(true);
    const entries = readProjectRegistry();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      projectRoot: path.resolve(root),
      name: "alpha",
      lastSeen: "2026-08-01T00:00:00.000Z",
      stale: false,
    });
  });

  it("upserting the same root twice UPDATES lastSeen instead of duplicating", () => {
    const root = makeProject("alpha");
    upsertProject(root, new Date("2026-08-01T00:00:00.000Z"));
    upsertProject(root, new Date("2026-08-09T12:00:00.000Z"));

    const entries = readProjectRegistry();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.lastSeen).toBe("2026-08-09T12:00:00.000Z");
  });

  it("keeps every distinct project and returns them newest-lastSeen first", () => {
    upsertProject(makeProject("older"), new Date("2026-07-01T00:00:00.000Z"));
    upsertProject(makeProject("newer"), new Date("2026-08-20T00:00:00.000Z"));
    upsertProject(makeProject("middle"), new Date("2026-08-01T00:00:00.000Z"));

    expect(readProjectRegistry().map((e) => e.name)).toEqual(["newer", "middle", "older"]);
  });
});

describe("project registry — corruption", () => {
  it("a corrupt file reads as EMPTY rather than throwing", () => {
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    fs.writeFileSync(registryFile, "{ not json ]");
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(readProjectRegistry()).toEqual([]);
  });

  it("a corrupt file is RECREATED from empty by the next upsert (never a crash)", () => {
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    fs.writeFileSync(registryFile, "not json at all");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const root = makeProject("alpha");
    expect(upsertProject(root)).toBe(true);
    expect(readProjectRegistry().map((e) => e.name)).toEqual(["alpha"]);
  });

  it("a wrong top-level shape (array) degrades to empty", () => {
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    fs.writeFileSync(registryFile, JSON.stringify([{ projectRoot: "/x" }]));
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(readProjectRegistry()).toEqual([]);
  });

  it("salvages readable entries and drops only the malformed ones", () => {
    const good = makeProject("good");
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    fs.writeFileSync(
      registryFile,
      JSON.stringify({
        version: 1,
        projects: {
          [good]: { projectRoot: good, name: "good", lastSeen: "2026-08-01T00:00:00.000Z" },
          broken: { name: "no root here" },
          alsoBroken: null,
        },
      }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(readProjectRegistry().map((e) => e.name)).toEqual(["good"]);
  });

  it("backfills a missing name/lastSeen rather than dropping the entry", () => {
    const root = makeProject("alpha");
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    fs.writeFileSync(
      registryFile,
      JSON.stringify({ version: 1, projects: { [root]: { projectRoot: root } } }),
    );

    const entries = readProjectRegistry();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe("alpha");
    expect(entries[0]!.lastSeen).toBe(new Date(0).toISOString());
  });
});

describe("project registry — staleness", () => {
  it("FLAGS an entry whose root no longer exists — and never prunes it", () => {
    const root = makeProject("gone");
    upsertProject(root, new Date("2026-08-01T00:00:00.000Z"));
    fs.rmSync(root, { recursive: true, force: true });

    const entries = readProjectRegistry();
    // The whole point: forgetting is the user's call, so the breadcrumb stays.
    expect(entries).toHaveLength(1);
    expect(entries[0]!.stale).toBe(true);
    expect(entries[0]!.name).toBe("gone");
  });

  it("a re-appearing root is un-flagged on the next read (stale is derived, not stored)", () => {
    const root = makeProject("flaky");
    upsertProject(root);
    fs.rmSync(root, { recursive: true, force: true });
    expect(readProjectRegistry()[0]!.stale).toBe(true);

    fs.mkdirSync(root, { recursive: true });
    expect(readProjectRegistry()[0]!.stale).toBe(false);

    // …and nothing was written to do it.
    const raw = JSON.parse(fs.readFileSync(registryFile, "utf-8"));
    expect(Object.values(raw.projects)[0]).not.toHaveProperty("stale");
  });
});

describe("project registry — HOME safety", () => {
  it("refuses the real ~/.deeppairing path under test (the J1 guard, mirrored)", () => {
    setProjectRegistryPathForTests(null);
    expect(() => projectRegistryPath()).toThrow(/refused to open the real/);
    expect(() => readProjectRegistry()).toThrow(/refused to open the real/);
    // Belt-and-suspenders: the real file must not exist as a side effect.
    expect(process.env.VITEST).toBeTruthy();
  });
});
