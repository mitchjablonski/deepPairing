// Split from routes.test.ts (G9): the security surfaces — II2.2 bootstrap
// gate exemption, C-4 /api/files security, SP1 bearer-token mutations,
// AA4 X-Project-Hash binding, and CORS.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHttpRoutes } from "../routes.js";
import { FileStore } from "../../store/file-store.js";
import { projectHashOf } from "../../project-root.js";
import fs from "node:fs";
import path from "node:path";
import { createRoutesTestContext, destroyRoutesTestContext, withHash, type RoutesApp } from "./routes.harness.js";

let tmpDir: string;
let store: FileStore;
let app: RoutesApp;

beforeEach(() => {
  ({ tmpDir, store, app } = createRoutesTestContext());
});

afterEach(() => {
  destroyRoutesTestContext({ tmpDir, store });
});

describe("HTTP Routes", () => {
  // II2.2 — the global X-Project-Hash gate must NOT block the browser's
  // bootstrap surface (the document/asset GETs and /api/daemon-info, loaded
  // via plain navigation with no custom headers), while still gating session
  // state + mutations. Uses UNWRAPPED apps so no X-Project-Hash is injected.
  describe("II2.2 — bootstrap-surface gate exemption", () => {
    it("403s a hashless GET /api/state (session route stays gated)", async () => {
      const bare = createHttpRoutes(store, tmpDir, () => {});
      const res = await bare.request("/api/state");
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("project_hash_mismatch");
    });

    it("does NOT 403 a hashless GET /api/daemon-info (discovery endpoint is exempt)", async () => {
      const bare = createHttpRoutes(store, tmpDir, () => {});
      const res = await bare.request("/api/daemon-info");
      // createHttpRoutes doesn't define /api/daemon-info (the daemon mounts it
      // top-level), so a 404 — not a 403 — proves the gate let it through.
      expect(res.status).not.toBe(403);
      expect(res.status).toBe(404);
    });

    it("does NOT 403 a hashless non-/api GET (SPA document + /assets/*)", async () => {
      const bare = createHttpRoutes(store, tmpDir, () => {});
      for (const p of ["/", "/assets/index-abc123.js", "/favicon.ico"]) {
        const res = await bare.request(p);
        expect(res.status, `path ${p} should not be gate-blocked`).not.toBe(403);
      }
    });

    it("still 403s a hashless POST mutation (mutations stay gated)", async () => {
      const bare = createHttpRoutes(store, tmpDir, () => {});
      const res = await bare.request("/api/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ artifactId: "a", content: "hi" }),
      });
      expect(res.status).toBe(403);
    });

    it("does NOT 403 a hashless POST /api/demo/run (FD-2 — cold-clone demo entry point)", async () => {
      const bare = createHttpRoutes(store, tmpDir, () => {});
      const res = await bare.request("/api/demo/run", { method: "POST" });
      // createHttpRoutes doesn't define /api/demo/run (the daemon mounts it
      // top-level), so a 404 — not a 403 — proves the gate let it through.
      // Before the FD-2 exemption this hashless POST fail-closed 403'd, which is
      // exactly why `init demo` died on a fresh clone.
      expect(res.status).not.toBe(403);
      expect(res.status).toBe(404);
    });

    it("serves GET /api/state when the correct X-Project-Hash is present", async () => {
      const bare = createHttpRoutes(store, tmpDir, () => {});
      const res = await bare.request("/api/state", {
        headers: { "X-Project-Hash": projectHashOf(tmpDir) },
      });
      expect(res.status).toBe(200);
    });
  });

  describe("C-4 — /api/files security", () => {
    it("Host allowlist: a non-loopback Host is rejected with forbidden_host (DNS-rebinding guard)", async () => {
      const res = await app.request("/api/state", { headers: { host: "evil.example.com" } });
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("forbidden_host");
    });

    it("Host allowlist: a loopback Host (localhost:PORT) passes the guard", async () => {
      const res = await app.request("/api/state", { headers: { host: "localhost:3847" } });
      expect(res.status).not.toBe(403);
      expect(res.status).toBe(200);
    });

    it("Bearer gate: /api/files 401s without the daemon token when one is configured", async () => {
      const authed = withHash(createHttpRoutes(store, tmpDir, () => {}, undefined, "tok-files"), tmpDir);
      const res = await authed.request("/api/files?path=hello.txt");
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe("daemon_auth_required");
    });

    it("Bearer gate: /api/files serves the file when the correct token is present", async () => {
      fs.writeFileSync(path.join(tmpDir, "hello.txt"), "hi there\n");
      const authed = withHash(createHttpRoutes(store, tmpDir, () => {}, undefined, "tok-files"), tmpDir);
      const res = await authed.request("/api/files?path=hello.txt", {
        headers: { Authorization: "Bearer tok-files" },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).content).toBe("hi there\n");
    });

    it("S2 — a file over the size cap is rejected with 413, not buffered into memory", async () => {
      // 6 MiB > the 5 MiB ceiling
      fs.writeFileSync(path.join(tmpDir, "huge.txt"), Buffer.alloc(6 * 1024 * 1024, "x"));
      const authed = withHash(createHttpRoutes(store, tmpDir, () => {}, undefined, "tok-files"), tmpDir);
      const res = await authed.request("/api/files?path=huge.txt", {
        headers: { Authorization: "Bearer tok-files" },
      });
      expect(res.status).toBe(413);
      expect((await res.json()).code).toBe("body_too_large");
    });
  });

  describe("SP1 — public mutation routes require the bearer token", () => {
    const authed = () => withHash(createHttpRoutes(store, tmpDir, () => {}, undefined, "tok-mut"), tmpDir);

    it("401s a status mutation with NO Authorization (the forge-an-approval vector)", async () => {
      const res = await authed().request("/api/artifacts/a1/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      });
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe("daemon_auth_required");
    });

    it("401s a ledger seed with NO Authorization (the poison-the-ledger vector)", async () => {
      const res = await authed().request("/api/philosophy/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept: "anything", verdict: "rejected" }),
      });
      expect(res.status).toBe(401);
    });

    it("allows the mutation WITH the correct bearer token", async () => {
      store.createArtifact({ id: "a1", type: "research", title: "t", content: {} });
      const res = await authed().request("/api/artifacts/a1/status", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tok-mut" },
        body: JSON.stringify({ status: "approved" }),
      });
      expect(res.status).not.toBe(401);
    });

    it("does NOT gate reads — GET /api/state works without the bearer (still hash-gated)", async () => {
      const res = await authed().request("/api/state");
      expect(res.status).toBe(200);
    });

    it("gates non-POST mutating verbs too (DELETE annotations 401s without the bearer)", async () => {
      const res = await authed().request("/api/sessions/s1/annotations/an1", { method: "DELETE" });
      expect(res.status).toBe(401);
    });

    it("leaves /api/demo/run exempt (no 401 even under authToken)", async () => {
      // demo/run lives on the root app, not here, so it 404s — the point is the
      // SP1 middleware does NOT 401 it (the cold-clone entry stays open).
      const res = await authed().request("/api/demo/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(res.status).not.toBe(401);
    });
  });

  describe("AA4 — X-Project-Hash binding (browser stale-tab guard)", () => {
    // The threat: daemon-A on :3847 idle-shuts; daemon-B (different
    // projectRoot, different hash) claims :3847; user's tab still has
    // daemon-A's sessionId AND projectHash cached. When the tab fires a
    // mutation, X-Project-Hash mismatches daemon-B's hash → 403, instead
    // of silently routing into daemon-B's first arbitrary session via
    // the old getDefaultStoreOrNull fallback.
    function appWithProject(root: string) {
      // Use the same default store the outer harness uses; the hash
      // check fires before any store dispatch so the store doesn't matter.
      return createHttpRoutes(store, root, () => {});
    }

    it("403s with code project_hash_mismatch when X-Project-Hash differs from daemon's", async () => {
      const a = appWithProject("/projects/A");
      const res = await a.request("/api/state", {
        headers: { "X-Project-Hash": "deadbeef", "X-Session-Id": "any" },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe("project_hash_mismatch");
      expect(typeof body.expected).toBe("string");
    });

    it("accepts requests when X-Project-Hash matches the daemon's", async () => {
      const a = appWithProject("/projects/A");
      // Compute the same hash the daemon would (via the exported helper).
      const { projectHashOf } = await import("../../project-root.js");
      const hash = projectHashOf("/projects/A");
      const res = await a.request("/api/state", {
        headers: { "X-Project-Hash": hash },
      });
      expect(res.status).toBe(200);
    });

    it("II2 — 403s when X-Project-Hash header is absent (was back-compat-permissive pre-II2)", async () => {
      // Pre-II2 the guard was additive: missing header fell through.
      // Every shipped client now sends the hash (HH1/HH4/HH5), so
      // absence is now treated as the same failure mode as mismatch.
      const a = appWithProject("/projects/A");
      const res = await a.request("/api/state");
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe("project_hash_mismatch");
    });

    it("short-circuits when projectRoot is undefined (test-fixture back-compat)", async () => {
      // The outer harness creates routes WITHOUT a projectRoot; this is
      // what every existing route test relies on. The hash check should
      // silently allow whatever the client sends in that case.
      const noRootApp = createHttpRoutes(store, undefined, () => {});
      const res = await noRootApp.request("/api/state", {
        headers: { "X-Project-Hash": "anything" },
      });
      expect(res.status).toBe(200);
    });
  });

  describe("CORS (D5 — webview-only cross-origin)", () => {
    it("REJECTS loopback web origins — any local dev server was the verified attacker class", async () => {
      for (const origin of ["http://localhost:3847", "http://localhost:3000", "http://127.0.0.1:8080"]) {
        const res = await app.request("/api/state", { headers: { Origin: origin } });
        expect(res.headers.get("Access-Control-Allow-Origin"), origin).toBeNull();
      }
    });

    it("allows the VS Code webview origin (the one legitimate cross-origin consumer)", async () => {
      const res = await app.request("/api/state", {
        headers: { Origin: "vscode-webview://1a2b3c" },
      });
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("vscode-webview://1a2b3c");
    });

    it("rejects non-localhost origins", async () => {
      const res = await app.request("/api/state", {
        headers: { Origin: "http://evil.com" },
      });
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });
  });
});
