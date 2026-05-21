/**
 * III9 — bearer-token placement that survives non-POSIX filesystems.
 *
 * The daemon mints a bearer token (II1) and must place it in a file only the
 * same uid can read (mode 0600). Pre-III9 it always wrote the token into the
 * in-repo `.deeppairing/daemon.json` and *verified* the 0600 — throwing
 * fatally if group/other bits remained (III3). That assertion is correct on
 * ext4/APFS but FALSE on filesystems where `chmod` is silently ignored:
 * WSL2's `/mnt/c` Windows-drive mount (type **v9fs**), NFS, SMB, and some
 * FUSE mounts. The guard keyed on `process.platform !== "win32"`, but WSL
 * reports `"linux"` while sitting on a non-POSIX mount, so a fresh daemon
 * died on startup and the whole MCP server was dead on `/mnt/c`.
 *
 * Fix: *measure* whether the project dir honors mode bits. If it does, keep
 * the original behavior (token in daemon.json). If it doesn't, write only
 * non-sensitive discovery fields (pid/port) to the in-repo daemon.json (which
 * may be world-readable — there's no secret in it) and relocate the token to
 * a guaranteed-POSIX per-user runtime file, keyed by projectHash. Session
 * artifacts and the committable team.json stay in the repo; only the
 * security-sensitive token moves.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectHashOf } from "./project-root.js";

/**
 * Does this directory's filesystem actually honor POSIX mode bits? We
 * measure rather than guess from `process.platform` (which says "linux" on
 * WSL even when the mount is v9fs). Probe: create a temp file, `chmod 0600`,
 * read the mode back, and check that no group/other bits survived. Cleans up
 * the probe file regardless of outcome.
 */
export function fsHonorsPosixMode(dir: string): boolean {
  let probe: string | null = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    probe = path.join(dir, `.dp-mode-probe-${process.pid}-${Date.now()}`);
    const fd = fs.openSync(probe, "w", 0o600);
    fs.closeSync(fd);
    try {
      fs.chmodSync(probe, 0o600);
    } catch {
      return false; // chmod outright failed (e.g. NFS EPERM) — not honored.
    }
    const mode = fs.statSync(probe).mode & 0o777;
    return (mode & 0o077) === 0;
  } catch {
    // Can't even run the probe — be conservative and route the token to the
    // runtime dir rather than risk a leaked-mode in-repo write.
    return false;
  } finally {
    if (probe) {
      try {
        fs.unlinkSync(probe);
      } catch {}
    }
  }
}

/**
 * Where the token should live for a given project. Pure decision function so
 * the routing logic is unit-testable without a real v9fs mount:
 *   - Windows: in-repo. POSIX mode is advisory there; the file's ACL is the
 *     real boundary and chmod is a no-op, so we never moved or verified it.
 *   - POSIX + dir honors 0600: in-repo (the original, unchanged path).
 *   - POSIX + dir does NOT honor 0600: sidecar in a per-user runtime dir.
 */
export function tokenPlacement(opts: {
  platform: NodeJS.Platform;
  dirHonorsMode: boolean;
}): "in-repo" | "sidecar" {
  if (opts.platform === "win32") return "in-repo";
  return opts.dirHonorsMode ? "in-repo" : "sidecar";
}

/** Per-user runtime directory for token sidecars. Prefers $XDG_RUNTIME_DIR
 *  (tmpfs, mode 0700, per-user) and falls back to os.tmpdir(). */
function runtimeBaseDir(): string {
  const xdg = process.env.XDG_RUNTIME_DIR?.trim();
  if (xdg && path.isAbsolute(xdg)) {
    try {
      if (fs.statSync(xdg).isDirectory()) return path.join(xdg, "deeppairing");
    } catch {
      // fall through to tmpdir
    }
  }
  return path.join(os.tmpdir(), "deeppairing");
}

/** Absolute path of the token sidecar for a project. Keyed by projectHash so
 *  concurrent projects (each with its own daemon) never collide. */
export function tokenSidecarPath(projectRoot: string): string {
  return path.join(runtimeBaseDir(), `${projectHashOf(projectRoot)}.json`);
}

export interface SidecarWriteResult {
  path: string;
  mode: number;
  /** True when the sidecar landed at a real 0600 (no group/other bits). */
  honored: boolean;
}

/**
 * Write the token (plus identity, for staleness checks) to the runtime
 * sidecar at 0600. Returns honored:false if even the runtime dir won't hold
 * 0600 — the caller degrades with a warning rather than dying, since same-uid
 * is the trust boundary on a single-dev machine anyway.
 */
export function writeTokenSidecar(
  projectRoot: string,
  payload: { authToken: string; pid: number; port: number },
): SidecarWriteResult {
  const file = tokenSidecarPath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.dirname(file), 0o700);
  } catch {}
  const fd = fs.openSync(file, "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ ...payload, projectRoot }, null, 2));
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
  let mode = 0o777;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {}
  return { path: file, mode, honored: (mode & 0o077) === 0 };
}

export interface TokenSidecar {
  authToken?: string;
  pid?: number;
  port?: number;
  projectRoot?: string;
}

/** Read the token sidecar for a project, or null if absent/unreadable. */
export function readTokenSidecar(projectRoot: string): TokenSidecar | null {
  try {
    const file = tokenSidecarPath(projectRoot);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf-8")) as TokenSidecar;
  } catch {
    return null;
  }
}

/** Best-effort removal of the token sidecar (daemon cleanup path). */
export function unlinkTokenSidecar(projectRoot: string): void {
  try {
    fs.unlinkSync(tokenSidecarPath(projectRoot));
  } catch {}
}
