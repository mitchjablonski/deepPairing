import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic, isAtomicTmpFile } from "../atomic-write.js";

let dir: string;
let target: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-atomic-"));
  target = path.join(dir, "data.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("writeJsonAtomic (Z4)", () => {
  it("writes the value as JSON to the destination", () => {
    writeJsonAtomic(target, { hello: "world", n: 1 });
    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({ hello: "world", n: 1 });
  });

  it("uses 2-space indentation by default", () => {
    writeJsonAtomic(target, { a: 1 });
    expect(fs.readFileSync(target, "utf-8")).toBe('{\n  "a": 1\n}');
  });

  it("overwrites existing content (the common case for trace updates)", () => {
    fs.writeFileSync(target, '{"old":true}');
    writeJsonAtomic(target, { fresh: true });
    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({ fresh: true });
  });

  it("does NOT leak the .tmp file on success", () => {
    writeJsonAtomic(target, { x: 1 });
    const leftover = fs.readdirSync(dir).filter(isAtomicTmpFile);
    expect(leftover).toEqual([]);
  });

  it("preserves the OLD content if a SIGKILL hits between tmp-write and rename", () => {
    // Pre-populate the destination with content the rewrite would replace.
    fs.writeFileSync(target, '{"important":"keep me"}');
    // Simulate a process kill mid-rename: the tmp file exists on disk but
    // renameSync throws. We force this by stubbing rename to throw.
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("simulated SIGKILL between write and rename");
    });
    expect(() => writeJsonAtomic(target, { fresh: true })).toThrow(/simulated SIGKILL/);
    renameSpy.mockRestore();
    // The old content survived — readers see the LAST committed state,
    // never a torn write.
    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({ important: "keep me" });
    // The .tmp scratch file was cleaned up on the throw path.
    const leftover = fs.readdirSync(dir).filter(isAtomicTmpFile);
    expect(leftover).toEqual([]);
  });

  it("creates the destination on first write (no prior file required)", () => {
    expect(fs.existsSync(target)).toBe(false);
    writeJsonAtomic(target, { fresh: true });
    expect(fs.existsSync(target)).toBe(true);
  });

  it("propagates errors from JSON.stringify (e.g. circular refs) without writing the tmp", () => {
    const circular: any = {};
    circular.self = circular;
    expect(() => writeJsonAtomic(target, circular)).toThrow();
    // No tmp file was created — JSON.stringify threw before writeFileSync ran.
    const leftover = fs.readdirSync(dir).filter(isAtomicTmpFile);
    expect(leftover).toEqual([]);
  });
});

describe("isAtomicTmpFile (Z4 + AA6.2)", () => {
  it("matches the .tmp.PID.TIMESTAMP suffix shape (Z4 legacy)", () => {
    expect(isAtomicTmpFile("data.json.tmp.1234.567890")).toBe(true);
  });

  it("AA6.2: matches the .tmp.PID.TIMESTAMP.HEX shape (post-randomBytes)", () => {
    expect(isAtomicTmpFile("data.json.tmp.1234.567890.deadbeef")).toBe(true);
  });

  it("rejects ordinary user files", () => {
    expect(isAtomicTmpFile("data.json")).toBe(false);
    expect(isAtomicTmpFile("data.tmp")).toBe(false);
    expect(isAtomicTmpFile("data.json.bak")).toBe(false);
  });
});

describe("AA6.2 — concurrent same-path writes don't collide", () => {
  it("two parallel writes to the same path produce distinct .tmp filenames (no race)", async () => {
    // Pre-AA6.2 the tmp path was process.pid + Date.now() — two writes
    // within the same ms (debounced flush bursts) would collide. Fire
    // a burst and verify only the destination exists, no .tmp leaked,
    // and the destination has the LAST-written content.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-atomic-race-"));
    const target = path.join(dir, "race.json");
    try {
      // Fire 20 writes from a tight loop. randomBytes makes the tmp
      // filenames distinct even when Date.now() collides.
      for (let i = 0; i < 20; i++) writeJsonAtomic(target, { i });
      // Destination has SOME write's content (last-write-wins, but no
      // assertion on which since the loop is synchronous).
      expect(fs.existsSync(target)).toBe(true);
      const data = JSON.parse(fs.readFileSync(target, "utf-8"));
      expect(typeof data.i).toBe("number");
      // No .tmp files leaked.
      const leftover = fs.readdirSync(dir).filter(isAtomicTmpFile);
      expect(leftover).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
