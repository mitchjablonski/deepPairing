import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectHashOf } from "../../project-root.js";
import { createStandaloneSessionId } from "../../standalone-session-id.js";
import { SERVER_VERSION } from "../../version.js";
import { DaemonClient } from "../client.js";
import { createDaemonRoutes } from "../routes.js";

describe("DaemonClient standalone recovery", () => {
  const oldOrigin = "http://localhost:4881";
  const newOrigin = "http://localhost:4882";
  let root: string;
  const json = (body: object, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dp-standalone-recovery-")));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(["warm", "cold"] as const)("re-adopts a %s daemon at a new port without registering", async (state) => {
    const sessionId = createStandaloneSessionId(root);
    const endpoint = `/api/internal/sessions/${sessionId}/artifacts`;
    const hash = projectHashOf(root);
    const dataDir = path.join(root, ".deeppairing");
    fs.mkdirSync(dataDir);
    // Exercise real ensureDaemon adoption without binding ports or spawning a
    // process: the matching version and successful /api/state probe adopt.
    fs.writeFileSync(path.join(dataDir, "daemon.json"), JSON.stringify({
      port: 4882, pid: process.pid, startedAt: "2026-01-02T00:00:00.000Z",
      authToken: "new-token", projectRoot: root, version: SERVER_VERSION,
    }));
    const createSession = () => { throw new Error("A standalone recovery cannot create a wrapper session"); };
    const newDaemon = createDaemonRoutes(new Map(), new Map(), createSession, () => {}, undefined, root, "new-token");
    const calls: Array<{ url: string; authorization: string | null; project: string | null }> = [];
    const transport: typeof globalThis.fetch = async (url, init) => {
      const req = new Request(url, init);
      calls.push({
        url: req.url, authorization: req.headers.get("Authorization"), project: req.headers.get("X-Project-Hash"),
      });
      if (req.url === oldOrigin + endpoint) throw new TypeError("socket closed");
      if (req.url === newOrigin + "/api/state") return json({});
      if (req.url === newOrigin + endpoint && state === "warm") return json({ artifacts: [] });
      return newDaemon.request(req);
    };
    vi.stubGlobal("fetch", transport);
    const client = new DaemonClient(4881, sessionId, root, "old-token");

    const read = client.getArtifacts();
    if (state === "warm") await expect(read).resolves.toEqual([]);
    else await expect(read).rejects.toMatchObject({
      status: 404, code: "session_not_registered", message: expect.stringContaining(`resume ${sessionId}`),
    });
    expect(calls).toEqual([
      { url: oldOrigin + endpoint, authorization: "Bearer old-token", project: hash },
      { url: newOrigin + "/api/state", authorization: "Bearer new-token", project: hash },
      { url: newOrigin + endpoint, authorization: "Bearer new-token", project: hash },
    ]);
    expect(client.getLivePort()).toBe(4882);
    expect(client.consumePortChangeNotice()).toEqual({ previousPort: 4881, newPort: 4882 });
  });

  it("surfaces the original standalone 404 without registering or recovering a wrapper", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({
      error: "Resume the standalone review", code: "session_not_registered",
    }, 404));
    vi.stubGlobal("fetch", fetch);
    const client = new DaemonClient(4881, createStandaloneSessionId(root), root, "token");

    await expect(client.getArtifacts()).rejects.toMatchObject({
      status: 404, code: "session_not_registered", message: "[deepPairing] Resume the standalone review",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("queries standalone lifecycle and only treats the legacy missing-route response as unsupported", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ state: "ended" }))
      .mockResolvedValueOnce(new Response("404 Not Found", { status: 404 }))
      .mockResolvedValueOnce(json({ code: "session_not_registered", error: "Missing review" }, 404));
    vi.stubGlobal("fetch", fetch);
    const id = createStandaloneSessionId(root);
    const standalone = new DaemonClient(4881, id, root, "token");
    const wrapper = new DaemonClient(4881, "wrapper", root, "token");

    await expect(wrapper.getStandaloneReviewState()).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    await expect(standalone.getStandaloneReviewState()).resolves.toBe("ended");
    await expect(standalone.getStandaloneReviewState()).resolves.toBeUndefined();
    await expect(standalone.getStandaloneReviewState()).rejects.toMatchObject({ status: 404, code: "session_not_registered" });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenCalledWith(`${oldOrigin}/api/internal/sessions/${id}/review-state`, expect.objectContaining({ method: "GET" }));
  });
});
