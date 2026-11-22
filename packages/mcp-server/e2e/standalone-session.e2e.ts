import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DaemonClient } from "../src/daemon/client.js";
import { daemonAuthHeaders, evictDaemon, probeDaemonIdentity, readDaemonInfo, waitForPortRelease } from "../src/daemon/lifecycle.js";
import { expect, test } from "./test.js";

const exec = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
type SessionReceipt = { sessionId: string; companionUrl: string };

async function stopProjectDaemon(projectRoot: string): Promise<void> {
  const info = readDaemonInfo(projectRoot);
  if (!info) return;
  const identity = await probeDaemonIdentity(info.port);
  if (identity) {
    expect(identity).toMatchObject({ pid: info.pid, projectRoot });
    expect(await evictDaemon(info.port, info.pid)).toBe("evicted");
  }
  await waitForPortRelease(info.port, info.pid, { expectedProjectRoot: projectRoot });
}

test("standalone CLI opens and resumes the exact session across processes and daemon restart", async ({ page }) => {
  test.setTimeout(60_000);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dp-cli-review-")));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const otherProject = path.join(root, "other-project");
  await Promise.all([home, project, otherProject].map((dir) => fs.mkdir(dir)));
  const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")) as {
    bin: { deeppairing: string };
  };
  const entry = path.resolve(packageRoot, manifest.bin.deeppairing);
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, USERPROFILE: home, DEEPPAIRING_NO_OPEN: "1", CLAUDE_CONFIG_DIR: home,
  };
  delete env.NODE_OPTIONS;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.DEEPPAIRING_PING;
  delete env.DEEPPAIRING_PING_URL;
  delete env.XDG_CONFIG_HOME;
  delete env.XDG_DATA_HOME;
  delete env.XDG_STATE_HOME;
  delete env.XDG_CACHE_HOME;
  const run = (projectRoot: string, ...args: string[]) =>
    exec(process.execPath, [entry, ...args], {
      cwd: projectRoot,
      env: { ...env, DEEPPAIRING_PROJECT_ROOT: projectRoot },
      timeout: 25_000,
    });
  const receipt = async (...args: string[]): Promise<SessionReceipt> =>
    JSON.parse((await run(project, ...args)).stdout);
  const sessionDirs = path.join(project, ".deeppairing", "sessions");

  try {
    const opened = await receipt("open");
    const url = new URL(opened.companionUrl);
    expect(url.searchParams.get("session")).toBe(opened.sessionId);
    expect(await fs.readdir(sessionDirs)).toEqual([opened.sessionId]);
    expect(await fs.readdir(project)).not.toContain(".mcp.json");

    await stopProjectDaemon(project);
    const resumed = await receipt("resume", opened.sessionId);
    expect(resumed.sessionId).toBe(opened.sessionId);
    expect(await fs.readdir(sessionDirs)).toEqual([opened.sessionId]);
    const second = await receipt("open");
    expect(second.sessionId).not.toBe(opened.sessionId);
    await expect(run(otherProject, "resume", opened.sessionId)).rejects.toMatchObject({ code: 1, stdout: "" });
    expect(await fs.readdir(otherProject)).toEqual([]);
    await expect(run(project, "resume", "../other")).rejects.toMatchObject({ code: 1, stdout: "" });
    const unknown = opened.sessionId.slice(0, -36) + randomUUID();
    await expect(run(project, "resume", unknown)).rejects.toMatchObject({ code: 1, stdout: "" });
    const legacy = "session_project_legacy";
    await fs.mkdir(path.join(sessionDirs, legacy));
    await expect(run(project, "resume", legacy)).rejects.toMatchObject({ code: 1, stdout: "" });
    expect((await fs.readdir(sessionDirs)).sort()).toEqual([opened.sessionId, second.sessionId, legacy].sort());

    const info = readDaemonInfo(project);
    if (!info?.authToken) throw new Error("Test daemon did not publish its authentication token");
    const sibling = new DaemonClient(info.port, resumed.sessionId, project, info.authToken);
    const activeSessions = new URL("/api/active-sessions", resumed.companionUrl);
    const readCatalog = async () => {
      const response = await fetch(activeSessions, {
        headers: daemonAuthHeaders(project), signal: AbortSignal.timeout(5_000),
      });
      expect(response.ok).toBe(true);
      return response.json();
    };
    await sibling.register({ expectedProjectRoot: project, project: "Example project" });
    try {
      await sibling.renameSession("Renamed review");
      const concurrent = await Promise.all([receipt("resume", resumed.sessionId), receipt("resume", resumed.sessionId)]);
      expect(concurrent).toEqual([resumed, resumed]);
      expect(await readCatalog()).toMatchObject({
        sessions: expect.arrayContaining([expect.objectContaining({
          sessionId: resumed.sessionId, live: true, title: "Renamed review", project: "Example project", artifactCount: 0,
        })]),
      });
    } finally {
      await sibling.unregister();
    }
    expect(await readCatalog()).toMatchObject({
      sessions: expect.arrayContaining([expect.objectContaining({ sessionId: resumed.sessionId, live: false })]),
    });

    await page.goto(resumed.companionUrl);
    await expect.poll(() => page.evaluate(() => {
      const store = (window as Window & { __dpConnectionStore?: {
        getState(): { sessionId: string; hydrated: boolean };
      } }).__dpConnectionStore;
      const state = store?.getState();
      return state?.hydrated ? state.sessionId : null;
    })).toBe(resumed.sessionId);
  } finally {
    await page.close();
    await stopProjectDaemon(project);
    await stopProjectDaemon(otherProject);
    await fs.rm(root, { recursive: true, force: true });
  }
});
