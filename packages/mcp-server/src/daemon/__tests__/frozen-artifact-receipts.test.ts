/**
 * #338 (F1) — the false success receipt, over a REAL listening socket with a
 * REAL WebSocket subscriber. Pre-fix, `POST /artifacts` on a frozen session
 * returned `200 {artifact}` and fanned out `artifact_created` for a record the
 * frozen artifact lane then discarded. This pins the wire contract end to end:
 * a typed 409, NO success frame on the session's WS stream, nothing new on
 * disk, and the parent of a refused revision untouched — while an independent
 * comment still lands and still broadcasts (proving the stream was live and in
 * order, so the missing `artifact_created` is an absence, not a dropped socket).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { createDaemon, type Daemon } from "../create-daemon.js";
import { FileStore } from "../../store/file-store.js";
import { projectHashOf } from "../../project-root.js";
import { ERROR_CODES } from "../../error-codes.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";

let fx: GlobalStoreFixture;
let tmpDir: string;
let daemon: Daemon;
let server: ReturnType<typeof serve>;
let base = "";
let hash = "";
const SID = "frozen";

beforeAll(async () => {
  fx = withGlobalStore("dp-frozen-receipts-");
  tmpDir = fx.dir;
  hash = projectHashOf(tmpDir);
  daemon = createDaemon({
    projectRoot: tmpDir,
    authToken: "test-token",
    log: () => {},
    exitProcess: () => {},
    releaseListenSocket: () => {},
    env: {},
  });
  server = serve({ fetch: daemon.app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => {
    const s = server as unknown as { address(): AddressInfo | null; once(ev: string, cb: () => void): void };
    if (s.address()) return resolve();
    s.once("listening", () => resolve());
  });
  const port = ((server as unknown as { address(): AddressInfo }).address()).port;
  base = `http://127.0.0.1:${port}`;
  daemon.attachUpgradeHandler(server as unknown as Parameters<Daemon["attachUpgradeHandler"]>[0]);
});

afterAll(() => {
  daemon.dispose();
  try { server.close(); } catch { /* already closed */ }
  fx.dispose();
});

const post = (p: string, body: unknown) => fetch(`${base}${p}`, {
  method: "POST",
  headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const checkpointPath = (relFile: string) => path.join(
  tmpDir, ".deeppairing", "sessions", SID, "code-checkpoints",
  crypto.createHash("sha256").update(path.resolve(tmpDir, relFile)).digest("hex") + ".json",
);

/** A real subscriber on the session stream; frames accumulate in arrival order. */
function subscribe(): Promise<{ frames: Array<{ type?: string }>; waitFor: (type: string) => Promise<void>; close: () => void }> {
  return new Promise((resolve, reject) => {
    const frames: Array<{ type?: string }> = [];
    const waiters: Array<{ type: string; done: () => void }> = [];
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws?sessionId=${SID}&projectHash=${hash}`);
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data)) as { type?: string };
      if (frame.type === "connected") {
        resolve({
          frames,
          waitFor: (type) => new Promise<void>((done, fail) => {
            if (frames.some((f) => f.type === type)) return done();
            const t = setTimeout(() => fail(new Error(`no ${type} frame within 5s`)), 5000);
            waiters.push({ type, done: () => { clearTimeout(t); done(); } });
          }),
          close: () => ws.close(),
        });
        return;
      }
      frames.push(frame);
      for (const w of waiters.splice(0)) {
        if (w.type === frame.type) w.done(); else waiters.push(w);
      }
    });
    ws.on("error", reject);
  });
}

describe("#338 (F1) — frozen session over a real socket", () => {
  it("409s the create, emits no success frame, persists nothing, leaves the parent untouched", async () => {
    const local = daemon.createSession(SID);
    local.createArtifact({
      id: "parent", type: "code_change", title: "Swap the cache",
      content: { filePath: "src/app.ts", diff: "-a\n+b" },
    });
    local.forceFlush();
    // Subscribe BEFORE the freeze — `connected` carries getFullState().
    const sub = await subscribe();

    const external = fx.track(new FileStore(tmpDir, SID));
    const changed = external.getArtifacts()[0]!;
    changed.content = { filePath: "src/app.ts", diff: "-a\n+REWRITTEN" };
    changed.version = 2;
    external.renameArtifact("parent", changed.title);
    external.forceFlush();
    local.updateArtifactStatus("parent", "approved", "ui_approve_button");
    expect(() => local.forceFlush()).toThrow(/changed content.*review verdict|review verdict.*changed content/i);

    const artifactsPath = path.join(tmpDir, ".deeppairing", "sessions", SID, "artifacts.json");
    const before = fs.readFileSync(artifactsPath, "utf8");

    // present_* after the freeze: the create route.
    const created = await post(`/api/internal/sessions/${SID}/artifacts`, {
      id: "after", type: "code_change", title: "Another change",
      content: { filePath: "src/new.ts", diff: "+x" },
    });
    expect(created.status).toBe(409);
    expect(await created.json()).toMatchObject({ code: ERROR_CODES.session_review_conflict });

    // revise_artifact after the freeze: v2 create, then the parent flip.
    const v2 = await post(`/api/internal/sessions/${SID}/artifacts`, {
      id: "v2", type: "code_change", title: "Swap the cache", parentId: "parent", version: 3,
      content: { filePath: "src/app.ts", diff: "-a\n+c" },
    });
    expect(v2.status).toBe(409);
    const flip = await post(`/api/internal/sessions/${SID}/artifacts/parent/status`,
      { status: "superseded", reason: "agent_supersede" });
    expect(flip.status).toBe(409);
    expect(await flip.json()).toMatchObject({ code: ERROR_CODES.session_review_conflict });

    // An independent comment still lands AND still broadcasts — the ordered
    // stream proves no success frame preceded it.
    const comment = await post(`/api/internal/sessions/${SID}/comments`,
      { id: "c-after", artifactId: "parent", content: "Still heard", author: "human" });
    expect(comment.status).toBe(200);
    await sub.waitFor("comment_added");
    const types = sub.frames.map((f) => f.type);
    expect(types).not.toContain("artifact_created");
    expect(types).not.toContain("artifact_updated");
    expect(types).toContain("comment_added");
    sub.close();

    // A forced flush still refuses (typed), but the comment lane writes through.
    const flushed = await fetch(`${base}/api/internal/sessions/${SID}/flush`, {
      method: "POST", headers: { Authorization: "Bearer test-token" },
    });
    expect(flushed.status).toBe(409);
    expect(await flushed.json()).toMatchObject({ code: ERROR_CODES.session_review_conflict });

    // Disk: no new artifact, no receipt for the refused file, parent's receipt intact.
    expect(fs.readFileSync(artifactsPath, "utf8")).toBe(before);
    expect(fs.existsSync(checkpointPath("src/new.ts"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(checkpointPath("src/app.ts"), "utf8"))).toMatchObject({ artifactId: "parent" });
    const recovered = fx.track(new FileStore(tmpDir, SID));
    expect(recovered.getArtifacts()).toHaveLength(1);
    expect(recovered.getArtifacts()[0]).toMatchObject({ id: "parent", status: "draft", version: 2 });
    expect(recovered.getCommentsForArtifact("parent").map((c) => c.id)).toContain("c-after");
  });
});
