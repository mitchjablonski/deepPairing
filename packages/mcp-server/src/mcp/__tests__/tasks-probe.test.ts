/**
 * S6 — MCP Tasks capability probe.
 *
 * The probe is intentionally inert today: MCP_TASKS_ENABLED is false until the
 * @modelcontextprotocol/sdk ships the Tasks primitive (SEP-1686). These tests
 * pin two contracts the future implementer needs to keep:
 *
 *   1. The flag is `false` and the helper is a no-op (no exception, no SDK calls).
 *   2. The helper signature accepts (server, artifact, store) so the call sites
 *      in present_* tools don't need to change shape when Tasks lights up.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileStore } from "../../store/file-store.js";
import { setGlobalStoreForTests } from "../../store/global-store.js";
import { MCP_TASKS_ENABLED, maybeEmitTaskHandle, maybeUpdateTaskStatus } from "../tasks-probe.js";

let tmpDir: string;
let store: FileStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-tasks-probe-"));
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
  store = new FileStore(tmpDir, "tasks_probe_session");
});

afterEach(() => {
  store.forceFlush();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  setGlobalStoreForTests(null);
});

describe("MCP Tasks capability probe", () => {
  it("MCP_TASKS_ENABLED is false until the SDK ships Tasks", () => {
    // When the SDK adds the Tasks primitive, flip this constant and update
    // maybeEmitTaskHandle's body. This test will then fail and the failure
    // is the prompt to also wire status updates from the artifact-mutation
    // routes (approve/reject/revise) into server.updateTask(...).
    expect(MCP_TASKS_ENABLED).toBe(false);
  });

  it("maybeEmitTaskHandle is a no-op today (no SDK call, no throw)", async () => {
    const artifact = store.createArtifact({
      id: "art_probe_1",
      type: "research",
      title: "noop",
      content: { summary: "x", findings: [] },
    });
    // A bare object stands in for Server — proves the helper doesn't reach
    // for any methods on it while MCP_TASKS_ENABLED is false.
    const fakeServer = {} as any;
    await expect(maybeEmitTaskHandle(fakeServer, artifact, store)).resolves.toBeUndefined();
  });

  // X6 — status-update seam. Mirrors the creation-seam contract.
  it("maybeUpdateTaskStatus is a no-op today (no SDK call, no throw)", async () => {
    store.createArtifact({
      id: "art_probe_status",
      type: "research",
      title: "noop",
      content: { summary: "x", findings: [] },
    });
    const fakeServer = {} as any;
    await expect(
      maybeUpdateTaskStatus(fakeServer, "art_probe_status", store),
    ).resolves.toBeUndefined();
  });

  it("maybeUpdateTaskStatus accepts null server for HTTP-side mutations", async () => {
    // routes.ts passes null because the daemon process owns the MCP server,
    // not the routes module. The seam must accept null without throwing so
    // the future Tasks impl can route via the daemon broadcast channel.
    store.createArtifact({
      id: "art_http",
      type: "plan",
      title: "noop",
      content: { steps: [] },
    });
    await expect(
      maybeUpdateTaskStatus(null, "art_http", store),
    ).resolves.toBeUndefined();
  });

  it("maybeUpdateTaskStatus tolerates a missing artifact id (caller may race deletion)", async () => {
    await expect(
      maybeUpdateTaskStatus(null, "art_does_not_exist", store),
    ).resolves.toBeUndefined();
  });
});
