// #472 — GET /api/sessions/:sessionId/annotations must be side-effect free
// for a nonexistent session: no directory creation, and a 404 that matches
// the sibling GET /api/sessions/:sessionId read route's "Session not found"
// shape, rather than a 200 with a manufactured empty result.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { FileStore } from "../../store/file-store.js";
import { createRoutesTestContext, destroyRoutesTestContext, type RoutesApp } from "./routes.harness.js";

let tmpDir: string;
let store: FileStore;
let app: RoutesApp;

beforeEach(() => {
  ({ tmpDir, store, app } = createRoutesTestContext());
});

afterEach(() => {
  destroyRoutesTestContext({ tmpDir, store });
});

function sessionsDir(root: string): string {
  return path.join(root, ".deeppairing", "sessions");
}

function snapshotTree(root: string): string[] {
  const dir = sessionsDir(root);
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string, prefix: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      out.push(rel);
      if (entry.isDirectory()) walk(path.join(d, entry.name), rel);
    }
  };
  walk(dir, "");
  return out;
}

describe("GET /api/sessions/:sessionId/annotations — #472 no-create read", () => {
  it("a nonexistent session creates no files or directories and 404s", async () => {
    const before = snapshotTree(tmpDir);
    const nonexistent = "ghost_session_does_not_exist";
    expect(fs.existsSync(path.join(sessionsDir(tmpDir), nonexistent))).toBe(false);

    const res = await app.request(`/api/sessions/${nonexistent}/annotations`);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Session not found");

    // No directory was created as a side effect of the read.
    expect(fs.existsSync(path.join(sessionsDir(tmpDir), nonexistent))).toBe(false);
    const after = snapshotTree(tmpDir);
    expect(after).toEqual(before);
  });

  it("existing session data is unchanged by a GET for a different, nonexistent session", async () => {
    store.addAnnotation({ targetEventId: "evt_1", note: "keep me" });
    const before = snapshotTree(tmpDir);
    const beforeAnnotations = store.getAnnotations();

    const res = await app.request(`/api/sessions/some_other_ghost/annotations`);
    expect(res.status).toBe(404);

    const after = snapshotTree(tmpDir);
    expect(after).toEqual(before);
    expect(store.getAnnotations()).toEqual(beforeAnnotations);
  });

  it("a valid session with no annotations yet still returns 200 with an empty list (legacy behavior)", async () => {
    // test_session exists (created by the harness) but has never been annotated.
    const res = await app.request(`/api/sessions/test_session/annotations`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.annotations).toEqual([]);
  });

  it("a valid session with annotations returns them", async () => {
    const a = store.addAnnotation({ targetEventId: "evt_2", note: "hello" });
    const res = await app.request(`/api/sessions/test_session/annotations`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.annotations).toHaveLength(1);
    expect(body.annotations[0].id).toBe(a.id);
  });

  it("reports a real read failure honestly instead of an empty success", async () => {
    // Corrupt the sidecar file directly (bypassing addAnnotation's atomic write).
    const annotationsPath = path.join(sessionsDir(tmpDir), "test_session", "annotations.json");
    fs.writeFileSync(annotationsPath, "{ not an array", "utf-8");

    const res = await app.request(`/api/sessions/test_session/annotations`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(body.annotations).toBeUndefined();
  });

  it("rejects an invalid session ID with 400 before touching disk", async () => {
    const before = snapshotTree(tmpDir);
    const res = await app.request(`/api/sessions/${encodeURIComponent("bad id!")}/annotations`);
    expect(res.status).toBe(400);
    expect(snapshotTree(tmpDir)).toEqual(before);
  });
});
