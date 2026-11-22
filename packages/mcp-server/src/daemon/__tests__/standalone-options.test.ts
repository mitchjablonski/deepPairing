import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withGlobalStore } from "../../__tests__/global-store-fixture.js";
import { ARTIFACT_CREATE_MAX_BODY_BYTES } from "../../http/guards.js";
import { projectHashOf } from "../../project-root.js";
import { createStandaloneSessionId } from "../../standalone-session-id.js";
import { createDaemon, type Daemon } from "../create-daemon.js";

const args = {
  context: "Choose the storage backend for event replay.",
  options: [
    { id: "redis", title: "Redis Streams", description: "Use Redis Streams", concept: { name: "Redis Streams" },
      pros: [], cons: [], effort: "medium", risk: "medium" },
    { id: "local", title: "Local file", description: "Keep a local replay file", pros: [], cons: [], effort: "low", risk: "low" },
  ],
};

function fixture() {
  const fx = withGlobalStore("dp-cli-options-");
  const root = fx.dir;
  const sessionId = createStandaloneSessionId(root);
  const sessionUrl = `http://localhost/api/internal/sessions/${sessionId}`;
  const daemons: Daemon[] = [];
  const start = () => {
    const daemon = createDaemon({
      projectRoot: root, authToken: "test-token", log: () => {},
      exitProcess: () => {}, releaseListenSocket: () => {}, env: {},
    });
    daemons.push(daemon);
    return daemon;
  };
  const request = (daemon: Daemon, route: string, body: object, authenticated = true) =>
    daemon.app.request(`${sessionUrl}/${route}`, {
      method: "POST",
      headers: {
        Host: "localhost", "Content-Type": "application/json", "X-Project-Hash": projectHashOf(root),
        ...(authenticated ? { Authorization: "Bearer test-token" } : {}),
      },
      body: JSON.stringify({ expectedProjectRoot: root, ...body }),
    });
  const present = (daemon: Daemon, operationId: string, input = args) =>
    request(daemon, "present-options", { operationId, args: input });
  return {
    root, sessionId, start, request, present,
    dispose: () => {
      for (const daemon of daemons) {
        for (const store of daemon.sessions.values()) store.dispose();
        daemon.dispose();
      }
      fx.dispose();
    },
  };
}

describe("authenticated standalone options", () => {
  it("shares the measured 512 KiB artifact limit, with auth and the ordinary control-route limit intact", async () => {
    const f = fixture();
    try {
      const daemon = f.start();
      expect((await f.request(daemon, "open-review", { mode: "open" })).status).toBe(200);
      const operationId = randomUUID();
      const withCode = (code: string) => ({
        ...args,
        options: args.options.map((option, index) => index === 0
          ? { ...option, visuals: [{ id: "sample", kind: "annotated_code", code }] }
          : option),
      });
      const envelopeBytes = Buffer.byteLength(JSON.stringify({ expectedProjectRoot: f.root, operationId, args: withCode("") }));
      const code = "x".repeat(ARTIFACT_CREATE_MAX_BODY_BYTES - envelopeBytes);
      const tooBig = await f.present(daemon, operationId, withCode(code + "x"));
      expect(tooBig.status).toBe(413);
      expect(await tooBig.json()).toMatchObject({
        code: "body_too_large",
        error: expect.stringContaining("Shorten the options or their visuals"),
      });
      expect((await f.request(daemon, "present-options", { operationId, args: withCode(code) }, false)).status).toBe(401);
      expect((await f.request(daemon, "open-review", { mode: "resume", padding: "x".repeat(64 * 1024) })).status).toBe(413);
      expect(daemon.sessions.get(f.sessionId)!.getArtifacts()).toHaveLength(0);
      const result = await f.present(daemon, operationId, withCode(code));
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({ structuredContent: { artifactId: expect.stringMatching(/^art_/) } });
      expect(daemon.sessions.get(f.sessionId)!.getArtifacts()).toHaveLength(1);
    } finally {
      f.dispose();
    }
  });

  it("completes a prepared receipt after both records survived and the artifact was renamed", async () => {
    const f = fixture();
    try {
      const first = f.start();
      expect((await f.request(first, "open-review", { mode: "open" })).status).toBe(200);
      const op = randomUUID();
      const rename = fs.renameSync;
      let interrupted = false;
      const fault = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (path.basename(String(to)) === `present-options-${op}.json` &&
            JSON.parse(fs.readFileSync(from, "utf8")).committed === true) {
          interrupted = true;
          throw new Error("Interrupted while completing the receipt");
        }
        rename(from, to);
      });
      try {
        expect((await f.present(first, op)).status).toBe(500);
        expect(interrupted).toBe(true);
      } finally {
        fault.mockRestore();
      }
      first.sessions.get(f.sessionId)!.dispose();
      first.dispose();

      const second = f.start();
      expect((await f.request(second, "open-review", { mode: "resume" })).status).toBe(200);
      const store = second.sessions.get(f.sessionId)!;
      const [artifact] = store.getArtifacts();
      const [decision] = store.getPendingDecisions();
      expect(decision).toMatchObject({ artifactId: artifact!.id });
      store.renameArtifact(artifact!.id, "Renamed after restart");
      store.forceFlush();

      const retry = await f.present(second, op);
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({
        structuredContent: { artifactId: artifact!.id, decisionId: decision!.decisionId, replayed: true },
      });
      expect(store.getArtifacts()).toMatchObject([{ id: artifact!.id, title: "Renamed after restart" }]);
      expect(store.getPendingDecisions()).toHaveLength(1);
    } finally {
      f.dispose();
    }
  });

  it("replays a committed operation after a saved rename and withdrawal", async () => {
    const f = fixture();
    try {
      const daemon = f.start();
      expect((await f.request(daemon, "open-review", { mode: "open" })).status).toBe(200);
      const op = randomUUID();
      const response = await f.present(daemon, op);
      expect(response.status).toBe(200);
      const { artifactId, decisionId } = (await response.json()).structuredContent;
      const store = daemon.sessions.get(f.sessionId)!;
      const expected = { structuredContent: { artifactId, decisionId, replayed: true } };

      store.renameArtifact(artifactId, "Reviewed storage options");
      store.forceFlush();
      expect(await (await f.present(daemon, op)).json()).toMatchObject(expected);
      expect(store.getArtifacts()).toMatchObject([{ id: artifactId, title: "Reviewed storage options" }]);

      expect(store.retireArtifact({
        artifactId, expectedVersion: 1, expectedStatus: "draft",
        door: "withdraw", mode: "retract", reason: "The capacity decision changed.",
      }).kind).toBe("committed");
      expect(await (await f.present(daemon, op)).json()).toMatchObject(expected);
      expect(store.getArtifacts()).toMatchObject([{ id: artifactId, status: "retracted", content: { retractReason: "The capacity decision changed." } }]);
      expect(store.getDecision(decisionId)?.artifactId).toBe(artifactId);
      expect(store.getPendingDecisions()).toHaveLength(0);
    } finally {
      f.dispose();
    }
  });

  it("repairs a persisted artifact after a lost decision write without replacing a later response", async () => {
    const f = fixture();
    try {
      const first = f.start();
      expect((await f.request(first, "open-review", { mode: "open" })).status).toBe(200);
      const store = first.sessions.get(f.sessionId)!;
      store.addComment({ id: "waiting", artifactId: "", author: "human", content: "Keep this feedback available." });
      const op = randomUUID();
      vi.spyOn(store, "recordDecisionRequest").mockImplementationOnce(() => {
        store.forceFlush(); // The artifact reached disk. The decision did not.
        throw new Error("Interrupted after artifact write");
      });
      expect((await f.present(first, op)).status).toBe(500);
      const [artifact] = store.getArtifacts();
      expect(artifact).toBeDefined();
      expect(store.getPendingDecisions()).toHaveLength(0);
      store.dispose();
      first.dispose();

      const second = f.start();
      const retried = await f.present(second, op);
      expect(retried.status).toBe(200);
      const replay = await retried.json();
      expect(replay).toMatchObject({ structuredContent: { artifactId: artifact!.id, replayed: true } });
      const recovered = second.sessions.get(f.sessionId)!;
      expect(recovered.getArtifacts()).toHaveLength(1);
      const [decision] = recovered.getPendingDecisions();
      expect(decision).toMatchObject({ artifactId: artifact!.id });
      expect(recovered.getUnacknowledgedComments()).toHaveLength(1);
      recovered.resolveDecision(decision!.decisionId, "local", "Simple to maintain");
      recovered.forceFlush();
      expect(await (await f.present(second, op)).json()).toEqual(replay);
      expect(recovered.getDecision(decision!.decisionId)?.response?.reasoning).toBe("Simple to maintain");
      expect(second.activeSessions.size).toBe(0);
    } finally {
      f.dispose();
    }
  });

  it("deduplicates concurrent retries but rejects a new operation through shared preflight", async () => {
    const f = fixture();
    try {
      const daemon = f.start();
      const op = randomUUID();
      expect((await f.request(daemon, "present-options", { operationId: op, args }, false)).status).toBe(401);
      expect((await f.present(daemon, op)).status).toBe(404);
      expect((await f.request(daemon, "open-review", { mode: "open" })).status).toBe(200);
      const results = await Promise.all([f.present(daemon, op), f.present(daemon, op)]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      const [one, two] = await Promise.all(results.map((r) => r.json()));
      expect(one.structuredContent.artifactId).toBe(two.structuredContent.artifactId);
      expect([one, two].filter((r) => r.structuredContent.replayed)).toHaveLength(1);
      expect(await (await f.present(daemon, op, { ...args, context: "Changed input" })).json()).toMatchObject({
        isError: true, structuredContent: { code: "standalone_operation_conflict" },
      });
      const store = daemon.sessions.get(f.sessionId)!;
      store.recordRejectedApproach({ description: "Redis Streams", concept: "Redis Streams", reason: "No operators for this dependency." });
      const result = await f.present(daemon, randomUUID());
      expect(await result.json()).toMatchObject({
        isError: true, structuredContent: { code: "rejected_approach_blocked", reason: "No operators for this dependency." },
      });
      expect(store.getArtifacts()).toHaveLength(1);
      expect(store.getPendingDecisions()).toHaveLength(1);
    } finally {
      f.dispose();
    }
  });
});
