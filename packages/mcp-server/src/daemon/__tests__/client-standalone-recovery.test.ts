import { afterEach, describe, expect, it, vi } from "vitest";
import { projectHashOf } from "../../project-root.js";
import { createStandaloneSessionId } from "../../standalone-session-id.js";
import { DaemonClient } from "../client.js";
import { ensureDaemon } from "../lifecycle.js";

vi.mock("../lifecycle.js", () => ({ ensureDaemon: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(ensureDaemon).mockReset();
});

describe("DaemonClient standalone recovery", () => {
  const root = process.cwd();
  const json = (body: object, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });

  it("retries at a newly adopted port with the new token and no wrapper registration", async () => {
    const sessionId = createStandaloneSessionId(root);
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError("socket closed"))
      .mockResolvedValueOnce(json({ artifacts: [] }));
    vi.stubGlobal("fetch", fetch);
    vi.mocked(ensureDaemon).mockResolvedValue({
      port: 4882, pid: 123, startedAt: "2026-01-02T00:00:00.000Z", authToken: "new-token", projectRoot: root,
    });
    const client = new DaemonClient(4881, sessionId, root, "old-token");

    await expect(client.getArtifacts()).resolves.toEqual([]);
    expect(ensureDaemon).toHaveBeenCalledExactlyOnceWith(root);
    expect(fetch.mock.calls.map(([url, init]) => ({
      url, authorization: new Headers(init?.headers).get("Authorization"),
      project: new Headers(init?.headers).get("X-Project-Hash"),
    }))).toEqual([
      { url: `http://localhost:4881/api/internal/sessions/${sessionId}/artifacts`, authorization: "Bearer old-token", project: projectHashOf(root) },
      { url: `http://localhost:4882/api/internal/sessions/${sessionId}/artifacts`, authorization: "Bearer new-token", project: projectHashOf(root) },
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
    expect(ensureDaemon).not.toHaveBeenCalled();
  });
});

