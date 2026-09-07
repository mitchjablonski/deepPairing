import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FileStore } from "../file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";

const SESSION = "cross-process";
const CHILD_TIMEOUT_MS = 10_000;

let fx: GlobalStoreFixture;

beforeEach(() => {
  fx = withGlobalStore("dp-writer-process-");
  if (!fs.existsSync(path.resolve("dist/store/file-store.js"))) {
    throw new Error("Run pnpm build before cross-process persistence tests (the children exercise the shipped runtime).");
  }
});

afterEach(() => {
  fx.dispose();
});

const childProgram = String.raw`
  import { FileStore } from ${JSON.stringify(pathToFileURL(path.resolve("dist/store/file-store.js")).href)};
  const [root, role] = process.argv.slice(1);
  const store = new FileStore(root, ${JSON.stringify(SESSION)});
  const fs = await import("node:fs");
  const path = await import("node:path");
  fs.writeFileSync(path.join(root, ".ready-" + role), "ready");
  const deadline = Date.now() + ${CHILD_TIMEOUT_MS};
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(path.join(root, ".go"))) {
    if (Date.now() >= deadline) process.exit(4);
    Atomics.wait(waiter, 0, 0, 10);
  }
    if (role === "A") {
      store.updateArtifactStatus("artifact-a", "approved", "ui_approve_button");
    } else {
      store.createArtifact({ id: "artifact-b", type: "research", title: "Writer B", content: {} });
      store.addComment({ id: "comment-b", artifactId: "artifact-a", content: "independent feedback", author: "human" });
    }
    store.forceFlush();
    store.dispose();
`;

const lockHolderProgram = String.raw`
  import { withSessionFlushLock } from ${JSON.stringify(pathToFileURL(path.resolve("dist/store/session-records.js")).href)};
  const [root] = process.argv.slice(1);
  const fs = await import("node:fs");
  const path = await import("node:path");
  const sessionDir = path.join(root, ".deeppairing", "sessions", ${JSON.stringify(SESSION)});
  withSessionFlushLock(path.join(sessionDir, ".flush.lock"), () => {
    fs.writeFileSync(path.join(root, ".lock-ready"), "ready");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  });
`;

function startWriter(role: "A" | "B"): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [
    "--input-type=module", "--eval", childProgram,
    fx.dir, role,
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    // Preserve VITEST/NODE_ENV: global-store.ts then fails closed if this
    // scenario unexpectedly reaches for the user's real philosophy ledger.
    env: { ...process.env },
  });
}

function startLockHolder(): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [
    "--input-type=module", "--eval", lockHolderProgram, fx.dir,
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => finish(new Error(`child timeout; stderr=${stderr}`)), CHILD_TIMEOUT_MS);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.stderr.off("data", onErr);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onErr = (chunk: Buffer) => { stderr += chunk.toString(); };
    const onExit = (code: number | null) => {
      if (code === 0) finish();
      else finish(new Error(`child exited ${code}; stderr=${stderr}`));
    };
    const onError = (error: Error) => finish(error);
    child.stderr.on("data", onErr);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function waitForFiles(files: string[], failure: () => unknown): Promise<void> {
  const deadline = Date.now() + CHILD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (failure()) throw failure();
    if (files.every((file) => fs.existsSync(file))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`children did not reach baseline barrier: ${files.join(", ")}`);
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const hardTimer = setTimeout(resolve, 2_000);
    const killTimer = setTimeout(() => { child.kill("SIGKILL"); }, 1_000);
    child.once("exit", () => { clearTimeout(killTimer); clearTimeout(hardTimer); resolve(); });
  });
}

describe("FileStore cooperative cross-process writers", () => {
  it("preserves independent changes when both writers loaded the same baseline", async () => {
    const seed = fx.track(new FileStore(fx.dir, SESSION));
    seed.createArtifact({ id: "artifact-a", type: "research", title: "Baseline A", content: {} });
    seed.forceFlush();

    const a = startWriter("A");
    const b = startWriter("B");
    let childFailure: unknown;
    // Attach error/exit listeners immediately, before the readiness barrier.
    // Consume early rejections so startup failures cannot become unhandled errors.
    const finished = Promise.all([waitForExit(a), waitForExit(b)]).catch((err: unknown) => { childFailure = err; });
    try {
      await waitForFiles([path.join(fx.dir, ".ready-A"), path.join(fx.dir, ".ready-B")], () => childFailure);
      fs.writeFileSync(path.join(fx.dir, ".go"), "go");
      await finished;
      if (childFailure) throw childFailure;

      const sessionDir = path.join(fx.dir, ".deeppairing", "sessions", SESSION);
      const artifacts = JSON.parse(fs.readFileSync(path.join(sessionDir, "artifacts.json"), "utf8"));
      const comments = JSON.parse(fs.readFileSync(path.join(sessionDir, "comments.json"), "utf8"));
      expect(artifacts.map((artifact: { id: string }) => artifact.id).sort()).toEqual(["artifact-a", "artifact-b"]);
      expect(artifacts.find((artifact: { id: string }) => artifact.id === "artifact-a").status).toBe("approved");
      expect(comments.map((comment: { id: string }) => comment.id)).toContain("comment-b");
      expect(fs.existsSync(path.join(sessionDir, ".flush.lock"))).toBe(false);
    } finally {
      await Promise.all([stopChild(a), stopChild(b)]);
      await finished;
    }
  });

  it("fails closed after a lock owner dies until an operator removes the orphaned claim", async () => {
    const seed = fx.track(new FileStore(fx.dir, SESSION));
    seed.createArtifact({ id: "artifact-a", type: "research", title: "Baseline", content: {} });
    seed.forceFlush();

    const holder = startLockHolder();
    try {
      await waitForFiles([path.join(fx.dir, ".lock-ready")], () => undefined);
      await stopChild(holder);

      const claim = path.join(fx.dir, ".deeppairing", "sessions", SESSION, ".flush.lock");
      expect(fs.existsSync(claim)).toBe(true);
      seed.renameArtifact("artifact-a", "Pending recovery");
      expect(() => seed.forceFlush()).toThrow(/flush lock busy/i);
      expect(fs.existsSync(claim)).toBe(true);

      // Explicit recovery is safe only now that the owning process is gone.
      fs.unlinkSync(claim);
      seed.forceFlush();
      expect(fx.track(new FileStore(fx.dir, SESSION)).getArtifacts()[0]?.title).toBe("Pending recovery");
    } finally {
      await stopChild(holder);
    }
  });
});
