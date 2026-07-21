/**
 * #171 — changeset HTTP routes:
 *  - per-file review-state persistence (review PROGRESS on the artifact
 *    content — NOT a decision record), incl. clearing + honest 400s.
 *  - rejecting a changeset records exactly ONE framing entry (no per-file
 *    fan-out — the #195 over-block class), keyed on the changeset title.
 *  - demo isolation: a demo session's changeset rejection NEVER reaches the
 *    cross-project ledger (inherited via recordRejectedApproach).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHttpRoutes } from "../routes.js";
import { FileStore } from "../../store/file-store.js";
import { setGlobalStoreForTests, getGlobalStore } from "../../store/global-store.js";
import { projectHashOf } from "../../project-root.js";

let tmpDir: string;
let store: FileStore;
let app: ReturnType<typeof createHttpRoutes>;
let broadcasts: any[];

function buildApp(sessionId: string): void {
  store = new FileStore(tmpDir, sessionId);
  broadcasts = [];
  const bare = createHttpRoutes(store, tmpDir, (e) => broadcasts.push(e));
  const projectHash = projectHashOf(tmpDir);
  const orig = bare.request.bind(bare);
  (bare as any).request = (url: any, init?: any) => {
    const headers = new Headers(init?.headers || {});
    if (!headers.has("X-Project-Hash")) headers.set("X-Project-Hash", projectHash);
    return orig(url, { ...(init || {}), headers });
  };
  app = bare;
}

const FILES = [
  { path: "auth/middleware.ts", changeType: "modified", hunks: [{ lines: [{ kind: "add", content: "x", newLine: 26 }] }] },
  { path: "auth/session.ts", changeType: "modified", hunks: [{ lines: [{ kind: "add", content: "y", newLine: 12 }] }] },
];

async function createChangeset(id = "art_cs1", title = "Move TTL refresh into middleware"): Promise<string> {
  const art = await store.createArtifact({
    id, type: "changeset", title,
    content: { files: FILES, risks: ["touches auth"] },
  } as any);
  return art.id;
}

const review = (artifactId: string, body: unknown) =>
  app.request(`/api/artifacts/${artifactId}/changeset-review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const reject = (artifactId: string, feedback: string, concept?: string) =>
  app.request(`/api/artifacts/${artifactId}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "rejected", feedback, ...(concept ? { concept } : {}) }),
  });

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-cs-"));
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
  buildApp("test_session");
});

afterEach(() => {
  store.forceFlush();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  setGlobalStoreForTests(null);
});

describe("#171 per-file review-state persistence", () => {
  it("marks a file reviewed on the artifact content and broadcasts the full artifact", async () => {
    const id = await createChangeset();
    const res = await review(id, { filePath: "auth/middleware.ts", state: "reviewed" });
    expect(res.status).toBe(200);

    const art = (await store.getArtifacts()).find((a) => a.id === id)!;
    expect((art.content as any).reviewState).toEqual({ "auth/middleware.ts": "reviewed" });

    // Full-artifact patch (review state lives in content), like plan progress.
    const evt = broadcasts.find((b) => b.type === "changeset_review_updated");
    expect(evt).toBeDefined();
    expect(evt.artifact.id).toBe(id);
    expect((evt.artifact.content as any).reviewState["auth/middleware.ts"]).toBe("reviewed");
  });

  it("supports skip and clearing a file's state with state=null", async () => {
    const id = await createChangeset();
    await review(id, { filePath: "auth/session.ts", state: "skipped" });
    let art = (await store.getArtifacts()).find((a) => a.id === id)!;
    expect((art.content as any).reviewState).toEqual({ "auth/session.ts": "skipped" });

    const res = await review(id, { filePath: "auth/session.ts", state: null });
    expect(res.status).toBe(200);
    art = (await store.getArtifacts()).find((a) => a.id === id)!;
    expect((art.content as any).reviewState).toEqual({});
  });

  it("400s on a file that isn't part of the changeset", async () => {
    const id = await createChangeset();
    const res = await review(id, { filePath: "not/in/changeset.ts", state: "reviewed" });
    expect(res.status).toBe(400);
  });

  it("400s when the artifact is not a changeset", async () => {
    await store.createArtifact({ id: "art_plain", type: "code_change", title: "x", content: { filePath: "a.ts", changeType: "modify", before: "", after: "y", reasoning: "z" } } as any);
    const res = await review("art_plain", { filePath: "a.ts", state: "reviewed" });
    expect(res.status).toBe(400);
  });

  it("404s (cross-session guard) for an artifact this store doesn't own", async () => {
    const res = await review("art_missing", { filePath: "a.ts", state: "reviewed" });
    expect(res.status).toBe(404);
  });
});

describe("#171 rejecting a changeset records ONE framing entry", () => {
  it("records exactly ONE entry keyed on the changeset title (no per-file fan-out)", async () => {
    const id = await createChangeset("art_cs2", "TTL refresh in the routes");
    const res = await reject(id, "keep TTL out of the routes");
    expect(res.status).toBe(200);

    const rejected = store.getSessionMemory().rejectedApproaches;
    expect(rejected).toHaveLength(1);
    expect(rejected[0].description).toBe("TTL refresh in the routes");
    // No human concept → falls back to the changeset title (#171).
    expect(rejected[0].concept).toBe("TTL refresh in the routes");
    expect(rejected[0].reason).toContain("keep TTL out of the routes");
    // Explicitly NOT one entry per file.
    expect(rejected.map((r) => r.description)).not.toContain("auth/middleware.ts");
    expect(rejected.map((r) => r.description)).not.toContain("auth/session.ts");

    const writes = broadcasts.filter((b) => b.type === "ledger_write" && b.kind === "rejected");
    expect(writes).toHaveLength(1);
  });

  it("honors the human-named concept as the ledger key", async () => {
    const id = await createChangeset("art_cs3");
    await reject(id, "premature abstraction", "middleware-owned session TTL");
    const rejected = store.getSessionMemory().rejectedApproaches;
    expect(rejected).toHaveLength(1);
    expect(rejected[0].concept).toBe("middleware-owned session TTL");
  });
});

describe("#171 demo isolation", () => {
  it("a demo session's changeset rejection never reaches the cross-project ledger", async () => {
    // Demo session (demo_ prefix) with global publish ON — the belt gate must
    // still keep it out of the shared ledger.
    buildApp("demo_run1");
    store.setGlobalLedgerPublish(true);
    const id = await createChangeset("art_demo_cs", "demo changeset approach");
    await reject(id, "not this");
    // Session-scoped memory still records (that's project-local, expected)…
    expect(store.getSessionMemory().rejectedApproaches).toHaveLength(1);
    // …but the cross-project ledger stays empty.
    expect(getGlobalStore().query({ limit: 100 })).toHaveLength(0);
  });

  it("a NON-demo session with publish ON DOES reach the cross-project ledger (control)", async () => {
    store.setGlobalLedgerPublish(true);
    const id = await createChangeset("art_real_cs", "real changeset approach");
    await reject(id, "not this");
    const entries = getGlobalStore().query({ limit: 100 });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => e.concept === "real changeset approach")).toBe(true);
  });
});
