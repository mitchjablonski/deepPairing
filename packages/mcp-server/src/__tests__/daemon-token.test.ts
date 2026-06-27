/**
 * III9 — bearer-token placement on non-POSIX filesystems (WSL /mnt/c v9fs,
 * NFS, SMB). Pure-function routing is asserted directly; the sidecar IO is
 * exercised against a real temp dir (no mocks) with XDG_RUNTIME_DIR pointed
 * at it so the runtime location is hermetic.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fsHonorsPosixMode,
  tokenPlacement,
  tokenSidecarPath,
  writeTokenSidecar,
  readTokenSidecar,
  unlinkTokenSidecar,
} from "../daemon-token.js";
import { projectHashOf } from "../project-root.js";

describe("tokenPlacement (pure routing)", () => {
  it("keeps the token in-repo on Windows regardless of mode support", () => {
    expect(tokenPlacement({ platform: "win32", dirHonorsMode: false })).toBe("in-repo");
    expect(tokenPlacement({ platform: "win32", dirHonorsMode: true })).toBe("in-repo");
  });

  it("keeps the token in-repo on POSIX when the dir honors 0600", () => {
    expect(tokenPlacement({ platform: "linux", dirHonorsMode: true })).toBe("in-repo");
    expect(tokenPlacement({ platform: "darwin", dirHonorsMode: true })).toBe("in-repo");
  });

  it("relocates to a sidecar on POSIX when the dir cannot hold 0600 (the v9fs case)", () => {
    expect(tokenPlacement({ platform: "linux", dirHonorsMode: false })).toBe("sidecar");
    expect(tokenPlacement({ platform: "darwin", dirHonorsMode: false })).toBe("sidecar");
  });
});

describe("fsHonorsPosixMode", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-mode-probe-"));
  });
  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("reports true on the OS temp filesystem (which honors mode bits)", () => {
    // os.tmpdir() is a local POSIX fs on the platforms CI runs on.
    expect(fsHonorsPosixMode(tmpDir)).toBe(true);
  });

  it("leaves no probe file behind", () => {
    fsHonorsPosixMode(tmpDir);
    const leftovers = fs.readdirSync(tmpDir).filter((f) => f.startsWith(".dp-mode-probe-"));
    expect(leftovers).toEqual([]);
  });

  it("returns false for a path that cannot be created/probed", () => {
    // A path under a file (not a dir) can't be mkdir'd — probe fails closed.
    const filePath = path.join(tmpDir, "iam-a-file");
    fs.writeFileSync(filePath, "x");
    expect(fsHonorsPosixMode(path.join(filePath, "nested"))).toBe(false);
  });
});

describe("token sidecar IO", () => {
  let runtimeDir: string;
  let prevXdg: string | undefined;
  const projectRoot = "/mnt/c/Users/someone/project";

  beforeEach(() => {
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-xdg-"));
    prevXdg = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = runtimeDir;
  });
  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = prevXdg;
    try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch {}
  });

  it("keys the sidecar path by projectHash under $XDG_RUNTIME_DIR/deeppairing", () => {
    const p = tokenSidecarPath(projectRoot);
    expect(p).toBe(path.join(runtimeDir, "deeppairing", `${projectHashOf(projectRoot)}.json`));
  });

  it("writes a 0600 sidecar and reads the token back", () => {
    const res = writeTokenSidecar(projectRoot, { authToken: "secret-abc", pid: 4242, port: 3847 });
    expect(res.honored).toBe(true);
    expect(res.mode & 0o077).toBe(0);

    const back = readTokenSidecar(projectRoot);
    expect(back?.authToken).toBe("secret-abc");
    expect(back?.pid).toBe(4242);
    expect(back?.port).toBe(3847);
    expect(back?.projectRoot).toBe(projectRoot);
  });

  it("returns null when no sidecar exists", () => {
    expect(readTokenSidecar("/some/other/never-written")).toBeNull();
  });

  // S1 — symlink/foreign-owned defense is POSIX-only (no symlinks / O_NOFOLLOW on win32).
  (process.platform === "win32" ? it.skip : it)(
    "S1 — refuses to write the token through a pre-placed symlink at the sidecar path (fail-closed)",
    () => {
      const sidecar = tokenSidecarPath(projectRoot);
      const captured = path.join(runtimeDir, "captured-by-attacker.json");
      fs.mkdirSync(path.dirname(sidecar), { recursive: true, mode: 0o700 });
      // A different-uid attacker pre-creates the sidecar path as a symlink to a
      // file they can read, hoping the daemon writes the token through it.
      fs.symlinkSync(captured, sidecar);

      const res = writeTokenSidecar(projectRoot, { authToken: "secret-xyz", pid: 1, port: 3847 });

      expect(res.refused).toBe(true);
      expect(res.honored).toBe(false);
      // the token was NOT written through the symlink to the attacker's target
      expect(fs.existsSync(captured)).toBe(false);
    },
  );

  it("isolates projects — one project's sidecar is invisible to another", () => {
    writeTokenSidecar(projectRoot, { authToken: "proj-a", pid: 1, port: 3847 });
    const other = "/mnt/c/Users/someone/other-project";
    expect(readTokenSidecar(other)).toBeNull();
    expect(readTokenSidecar(projectRoot)?.authToken).toBe("proj-a");
  });

  it("unlinkTokenSidecar removes the file and is a no-op when already gone", () => {
    writeTokenSidecar(projectRoot, { authToken: "x", pid: 1, port: 3847 });
    expect(readTokenSidecar(projectRoot)).not.toBeNull();
    unlinkTokenSidecar(projectRoot);
    expect(readTokenSidecar(projectRoot)).toBeNull();
    expect(() => unlinkTokenSidecar(projectRoot)).not.toThrow();
  });

  it("falls back to os.tmpdir() when XDG_RUNTIME_DIR is unset", () => {
    delete process.env.XDG_RUNTIME_DIR;
    const p = tokenSidecarPath(projectRoot);
    expect(p).toBe(path.join(os.tmpdir(), "deeppairing", `${projectHashOf(projectRoot)}.json`));
  });
});
