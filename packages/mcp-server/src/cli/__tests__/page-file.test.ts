/**
 * #679 — the bounded reader behind `deeppairing present page --file`.
 * Real files, a real FIFO and real symlinks on a temp dir; no mocks.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBoundedPageFile } from "../page-file.js";

const CAP = 64;
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-page-file-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("readBoundedPageFile", () => {
  it("reads a file at exactly the cap and refuses one byte more", () => {
    const at = path.join(dir, "at.html");
    fs.writeFileSync(at, "x".repeat(CAP));
    const ok = readBoundedPageFile(at, CAP);
    expect(ok).toMatchObject({ ok: true });
    expect(ok.ok && ok.bytes.length).toBe(CAP);
    const over = path.join(dir, "over.html");
    fs.writeFileSync(over, "x".repeat(CAP + 1));
    expect(readBoundedPageFile(over, CAP)).toEqual({ ok: false, tooLarge: true, size: CAP + 1 });
  });

  it("refuses a directory and a missing file", () => {
    expect(() => readBoundedPageFile(dir, CAP)).toThrow(/not a regular file|Cannot open/);
    expect(() => readBoundedPageFile(path.join(dir, "missing.html"), CAP)).toThrow(/Cannot open the page file/);
  });

  it("refuses a FIFO without hanging", () => {
    const fifo = path.join(dir, "pipe.html");
    try {
      execFileSync("mkfifo", [fifo]);
    } catch {
      return; // no mkfifo on this host (Windows): nothing to check
    }
    expect(() => readBoundedPageFile(fifo, CAP)).toThrow(/not a regular file/);
  });

  it("follows a symlink to a file anywhere (inline --file is not project-contained)", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dp-page-file-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "p.html"), "<p>elsewhere</p>");
      const link = path.join(dir, "link.html");
      try { fs.symlinkSync(path.join(outside, "p.html"), link); } catch { return; }
      const read = readBoundedPageFile(link, CAP);
      expect(read.ok && read.bytes.toString("utf8")).toBe("<p>elsewhere</p>");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
