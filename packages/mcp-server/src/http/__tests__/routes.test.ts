import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHttpRoutes } from "../routes.js";
import { FileStore } from "../../store/file-store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;
let store: FileStore;
let app: ReturnType<typeof createHttpRoutes>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-route-test-"));
  store = new FileStore(tmpDir, "test_session");
  app = createHttpRoutes(store, tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("HTTP Routes", () => {
  it("GET /api/state returns session state", async () => {
    const res = await app.request("/api/state");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBe("test_session");
    expect(body.artifacts).toEqual([]);
  });

  it("POST /api/comments requires artifactId and content", async () => {
    const res = await app.request("/api/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artifactId: "", content: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/comments creates a comment", async () => {
    const res = await app.request("/api/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artifactId: "art_1", content: "Nice work" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.comment.content).toBe("Nice work");
    expect(body.comment.author).toBe("human");
  });

  it("POST /api/artifacts/:id/status rejects invalid status", async () => {
    const res = await app.request("/api/artifacts/art_1/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "invalid" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/decisions/:id requires optionId", async () => {
    const res = await app.request("/api/decisions/dec_1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/sessions/:sessionId rejects path traversal", async () => {
    // Hono normalizes `../` in URLs, so test with encoded dots and slashes
    const res = await app.request("/api/sessions/..%2F..%2Fetc");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid session ID");
  });

  it("GET /api/sessions/:sessionId accepts valid session IDs", async () => {
    // Create a session with data
    const s = new FileStore(tmpDir, "valid_session");
    s.createArtifact({ id: "a1", type: "research", title: "T", content: {} });
    s.forceFlush();

    const res = await app.request("/api/sessions/valid_session");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.artifacts).toHaveLength(1);
  });

  it("GET /api/export returns markdown", async () => {
    const res = await app.request("/api/export?format=full");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/markdown");
  });

  describe("CORS", () => {
    it("allows localhost origins", async () => {
      const res = await app.request("/api/state", {
        headers: { Origin: "http://localhost:3847" },
      });
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3847");
    });

    it("allows 127.0.0.1 origins", async () => {
      const res = await app.request("/api/state", {
        headers: { Origin: "http://127.0.0.1:3847" },
      });
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://127.0.0.1:3847");
    });

    it("rejects non-localhost origins", async () => {
      const res = await app.request("/api/state", {
        headers: { Origin: "http://evil.com" },
      });
      const corsHeader = res.headers.get("Access-Control-Allow-Origin");
      expect(corsHeader).not.toBe("http://evil.com");
    });
  });
});
