/**
 * III9 follow-up — daemonAuthHeaders() must let a caller authenticate against
 * the AA4-gated `/api/state` (and the III5 Bearer routes). It always sends the
 * X-Project-Hash the middleware checks, and adds the bearer token when it can
 * read one — whether the token lives in the in-repo daemon.json (POSIX fs) or
 * the relocated runtime sidecar (the WSL /mnt/c v9fs case). A stale sidecar
 * from a dead daemon (pid mismatch) must NOT contribute a token.
 *
 * Real temp dirs, no mocks; XDG_RUNTIME_DIR is pointed at a temp dir so the
 * sidecar location is hermetic.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { daemonAuthHeaders } from "../daemon-lifecycle.js";
import { writeTokenSidecar } from "../daemon-token.js";
import { projectHashOf } from "../project-root.js";

function writeDaemonJson(projectRoot: string, obj: Record<string, unknown>): void {
  const dpDir = path.join(projectRoot, ".deeppairing");
  fs.mkdirSync(dpDir, { recursive: true });
  fs.writeFileSync(path.join(dpDir, "daemon.json"), JSON.stringify(obj, null, 2));
}

describe("daemonAuthHeaders", () => {
  let projectRoot: string;
  let runtimeDir: string;
  let prevXdg: string | undefined;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-auth-hdr-"));
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-auth-xdg-"));
    prevXdg = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = runtimeDir;
  });
  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = prevXdg;
    for (const d of [projectRoot, runtimeDir]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });

  it("always sends X-Project-Hash matching the projectRoot, even with no daemon.json", () => {
    const headers = daemonAuthHeaders(projectRoot);
    expect(headers["X-Project-Hash"]).toBe(projectHashOf(projectRoot));
    expect(headers.Authorization).toBeUndefined();
  });

  it("adds the bearer token when daemon.json carries it (in-repo / POSIX fs)", () => {
    writeDaemonJson(projectRoot, { pid: 4242, port: 3847, authToken: "in-repo-token" });
    const headers = daemonAuthHeaders(projectRoot);
    expect(headers["X-Project-Hash"]).toBe(projectHashOf(projectRoot));
    expect(headers.Authorization).toBe("Bearer in-repo-token");
  });

  it("recovers the bearer token from the runtime sidecar when daemon.json is token-less (v9fs case)", () => {
    writeDaemonJson(projectRoot, { pid: 4242, port: 3847 }); // discovery only — no token
    writeTokenSidecar(projectRoot, { authToken: "sidecar-token", pid: 4242, port: 3847 });
    const headers = daemonAuthHeaders(projectRoot);
    expect(headers.Authorization).toBe("Bearer sidecar-token");
  });

  it("ignores a stale sidecar whose pid does not match the live daemon.json", () => {
    writeDaemonJson(projectRoot, { pid: 4242, port: 3847 }); // current daemon
    writeTokenSidecar(projectRoot, { authToken: "stale-token", pid: 9999, port: 3847 }); // dead daemon
    const headers = daemonAuthHeaders(projectRoot);
    expect(headers.Authorization).toBeUndefined();
  });
});
