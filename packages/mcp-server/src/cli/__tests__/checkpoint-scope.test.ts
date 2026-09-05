import { beforeEach, afterEach, describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { ensureCheckpointHook } from "../setup-tasks.js";
import { deriveSessionId } from "../../session-id.js";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";

let fx: GlobalStoreFixture;
let root: string;
let store: FileStore;
let nextId: number;
beforeEach(() => {
  fx = withGlobalStore("dp-checkpoint-scope-");
  root = fx.dir;
  nextId = 0;
  store = fx.track(new FileStore(root, deriveSessionId(root, "session-a").sessionId));
  ensureCheckpointHook(root);
});
afterEach(() => fx.dispose());

function present(filePath = "src/a.ts", target = store) {
  return target.createArtifact({id: `change-${++nextId}`, type: "code_change", title: "edit",
    content: {filePath, changeType: "modify", before: "old", after: "new", reasoning: "why"}});
}
function env() {
  const result = {...process.env, CLAUDE_PROJECT_DIR: root};
  delete result.CLAUDE_CODE_SESSION_ID;
  return result;
}
function event(filePath: string, session: string | undefined = "session-a") {
  return JSON.stringify({tool_name: "Edit", session_id: session, tool_input: {file_path: filePath}});
}
function hook(filePath = "src/a.ts", session: string | undefined = "session-a") {
  const r = spawnSync(process.execPath, [path.join(root, ".deeppairing/hooks/checkpoint.mjs")], {
    input: event(filePath, session), encoding: "utf8", timeout: 5000, cwd: root, env: env(),
  });
  expect(r.error).toBeUndefined();
  expect(r.status, r.stderr).toBe(0);
  return r.stderr;
}
function marker(file = "src/a.ts", session = "session-a") {
  const key = crypto.createHash("sha256").update(path.resolve(root, file)).digest("hex");
  return path.join(root, ".deeppairing/sessions", deriveSessionId(root, session).sessionId, "code-checkpoints", key + ".json");
}

describe("file/session checkpoint receipts", () => {
  it("matches relative presentation to absolute edit and consumes the receipt once", () => {
    present();
    expect(hook(path.join(root, "src/a.ts"))).toBe("");
    expect(hook()).toContain("present_code_change");
  });
  it("normalizes dot segments in paths", () => {
    present("src/../src/a.ts");
    expect(hook("./src/a.ts")).toBe("");
  });
  it("does not let file A cover B, and preserves A's receipt", () => {
    present();
    expect(hook("src/b.ts")).toContain("present_code_change");
    expect(hook()).toBe("");
  });
  it("retains independently presented files", () => {
    present(); present("src/b.ts");
    expect(hook()).toBe("");
    expect(hook("src/b.ts")).toBe("");
  });
  it("does not let session A cover session B", () => {
    present();
    expect(hook("src/a.ts", "session-b")).toContain("present_code_change");
    expect(hook()).toBe("");
  });
  it("keeps concurrent sessions' receipts independent even for the same file", () => {
    const other = fx.track(new FileStore(root, deriveSessionId(root, "session-b").sessionId));
    present(); present("src/a.ts", other);
    expect(hook()).toBe("");
    expect(hook("src/a.ts", "session-b")).toBe("");
  });
  it("ignores legacy project-wide timestamps", () => {
    fs.writeFileSync(path.join(root, ".deeppairing/last-code-change.json"), JSON.stringify({at: new Date().toISOString()}));
    expect(hook()).toContain("present_code_change");
  });
  it("treats corrupt receipts as missing and clears the claimed file", () => {
    present();
    fs.writeFileSync(marker(), "{bad");
    expect(hook()).toContain("present_code_change");
    expect(fs.readdirSync(path.dirname(marker()))).toHaveLength(0);
  });
  it("does not break artifact creation when the receipt directory cannot be written", () => {
    fs.writeFileSync(path.dirname(marker()), "not a directory");
    expect(() => present()).not.toThrow();
    expect(store.getArtifacts()).toHaveLength(1);
    expect(hook()).toContain("present_code_change");
  });
  it.each([-120_000, 120_000, NaN])("rejects expired, future or invalid timestamps (%s)", offset => {
    present();
    const p = marker();
    const m = JSON.parse(fs.readFileSync(p, "utf8"));
    m.at = Number.isNaN(offset) ? "invalid" : new Date(Date.now() + offset).toISOString();
    fs.writeFileSync(p, JSON.stringify(m));
    expect(hook()).toContain("present_code_change");
  });
  it.each(["filePath", "sessionId", "artifactId", "version"])("rejects malformed receipt metadata: %s", key => {
    present();
    const p = marker();
    const m = JSON.parse(fs.readFileSync(p, "utf8"));
    m[key] = null;
    fs.writeFileSync(p, JSON.stringify(m));
    expect(hook()).toContain("present_code_change");
  });
  it.each(["rejected", "revised", "superseded", "retracted", "obsolete"] as const)("revokes %s artifacts", status => {
    const a = present();
    store.updateArtifactStatus(a.id, status);
    expect(hook()).toContain("present_code_change");
  });
  it("superseding an older artifact preserves the newer presentation", () => {
    const old = present(); present();
    store.updateArtifactStatus(old.id, "superseded");
    expect(hook()).toBe("");
  });
  it("approval does not turn one receipt into reusable coverage", () => {
    const a = present();
    expect(hook()).toBe("");
    store.updateArtifactStatus(a.id, "approved");
    expect(hook()).toContain("present_code_change");
  });
  it("supports each file of a presented changeset", () => {
    store.createArtifact({id: "set", type: "changeset", title: "two files",
      content: {files: [{filePath: "src/a.ts"}, {filePath: "src/b.ts"}]}});
    expect(hook()).toBe("");
    expect(hook("src/b.ts")).toBe("");
    expect(hook()).toContain("present_code_change");
  });
  it("external PR review does not count as presenting code to apply", () => {
    store.createArtifact({id: "external", type: "changeset", title: "review",
      content: {reviewIntent: "external", files: [{filePath: "src/a.ts"}]}});
    expect(hook()).toContain("present_code_change");
  });
  it("uses the same sanitized session ID as the wrapper", () => {
    const raw = "a/b_" + "c".repeat(100);
    const other = fx.track(new FileStore(root, deriveSessionId(root, raw).sessionId));
    present("src/a.ts", other);
    expect(hook("src/a.ts", raw)).toBe("");
  });
  it("uses the event session instead of a stale inherited session identity", () => {
    present();
    const r = spawnSync(process.execPath, [path.join(root, ".deeppairing/hooks/checkpoint.mjs")], {
      cwd: root, input: event("src/a.ts"), encoding: "utf8", timeout: 5000,
      env: {...env(), CLAUDE_CODE_SESSION_ID: "session-b"},
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    expect(fs.existsSync(marker())).toBe(false);
  });
  it("uses the environment session when the event omits its identity", () => {
    present();
    const r = spawnSync(process.execPath, [path.join(root, ".deeppairing/hooks/checkpoint.mjs")], {
      cwd: root, input: JSON.stringify({tool_name: "Edit", tool_input: {file_path: "src/a.ts"}}),
      encoding: "utf8", timeout: 5000, env: {...env(), CLAUDE_CODE_SESSION_ID: "session-a"},
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    expect(fs.existsSync(marker())).toBe(false);
  });
  it("uses event cwd for both coverage and fire logging when root env is absent", () => {
    present();
    const childRoot = path.join(root, "other-working-directory");
    fs.mkdirSync(childRoot);
    const childEnv = {...process.env};
    delete childEnv.CLAUDE_PROJECT_DIR;
    delete childEnv.DEEPPAIRING_PROJECT_ROOT;
    delete childEnv.CLAUDE_CODE_SESSION_ID;
    const r = spawnSync(process.execPath, [path.join(root, ".deeppairing/hooks/checkpoint.mjs")], {
      cwd: childRoot, input: JSON.stringify({...JSON.parse(event("src/a.ts")), cwd: root}),
      encoding: "utf8", timeout: 5000, env: childEnv,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    expect(fs.existsSync(path.join(childRoot, ".deeppairing"))).toBe(false);
    const state = JSON.parse(fs.readFileSync(path.join(root, ".deeppairing/hooks-state.json"), "utf8"));
    expect(state.fires.at(-1).reason).toMatch(/^pass:/);
  });
  it("supports legacy clients with no session identity without consulting other sessions", () => {
    const legacy = fx.track(new FileStore(root, deriveSessionId(root).sessionId));
    present("src/a.ts", legacy);
    // Empty identity selects the wrapper's per-project fallback.
    expect(hook("src/a.ts", "")).toBe("");
    present();
    expect(hook("src/a.ts", "")).toContain("present_code_change");
  });
  it("does not map a malformed nonempty identity into the fallback session", () => {
    const legacy = fx.track(new FileStore(root, deriveSessionId(root).sessionId));
    present("src/a.ts", legacy);
    expect(hook("src/a.ts", "../")).toContain("present_code_change");
    expect(hook("src/a.ts", "")).toBe("");
  });
  it("lets only one concurrent hook claim a receipt", async () => {
    present();
    const run = () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, ".deeppairing/hooks/checkpoint.mjs")], {
        cwd: root, env: env(), stdio: ["pipe", "pipe", "pipe"], timeout: 5000,
      });
      let stderr = "";
      child.stderr.on("data", d => { stderr += d; });
      child.on("error", reject);
      child.on("close", code => code === 0 ? resolve(stderr) : reject(new Error(stderr)));
      child.stdin.end(event("src/a.ts"));
    });
    const results = await Promise.all([run(), run()]);
    expect(results.filter(s => s === "")).toHaveLength(1);
    expect(results.filter(s => s.includes("present_code_change"))).toHaveLength(1);
  });
});
