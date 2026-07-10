import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FileStore } from "../../store/file-store.js";
import { createRoutesTestContext, destroyRoutesTestContext, type RoutesApp } from "./routes.harness.js";

/**
 * H2-2 (#145) — public routes with `safeParse(await c.req.json())`.
 *
 * NB: unlike the daemon internal routes (no onError net → a thrown parse WAS a
 * 500), the public app has a global `app.onError(SyntaxError → 400)`, so a
 * malformed body was ALREADY a 400 here — but an OPAQUE one (`{error:"Invalid
 * JSON"}`, no `code`/`issues`), distinct from the structured field-level 400 a
 * valid-but-wrong-shape body gets. Guarding the parse with `.catch(() => null)`
 * routes the malformed case through the SAME `formatZodIssues` path, so it now
 * carries `code:"validation_error"` — consistent with, yet still distinguishable
 * from, a field-level error. This test pins that structured shape (it fails
 * pre-fix: onError returns no `code`).
 */
let tmpDir: string;
let store: FileStore;
let app: RoutesApp;

beforeEach(() => {
  ({ tmpDir, store, app } = createRoutesTestContext());
});

afterEach(() => {
  destroyRoutesTestContext({ tmpDir, store });
});

const jsonHeaders = { "Content-Type": "application/json" } as const;

describe("H2-2 — malformed body → structured 400 (validation_error) on safeParse routes", () => {
  it("POST /api/comments non-JSON → 400 with code validation_error", async () => {
    const res = await app.request("/api/comments", { method: "POST", headers: jsonHeaders, body: "{ not json" });
    expect(res.status).toBe(400);
    // Pre-fix this went through app.onError → {error:"Invalid JSON"} (no code).
    expect((await res.json()).code).toBe("validation_error");
  });

  it("POST /api/preferences non-JSON → 400 with code validation_error", async () => {
    const res = await app.request("/api/preferences", { method: "POST", headers: jsonHeaders, body: "]]]" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation_error");
  });

  it("preserves field-level Zod errors: wrong-shape 400 names the offending field", async () => {
    store.createArtifact({ id: "art_1", type: "research", title: "t", content: {} });

    const nonJson = await app.request("/api/comments", { method: "POST", headers: jsonHeaders, body: "{ not json" });
    const nonJsonBody = JSON.stringify(await nonJson.json());

    // Valid JSON, wrong shape (content must be a string) → field-level Zod 400.
    const wrongShape = await app.request("/api/comments", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ artifactId: "art_1", content: 12345 }),
    });
    expect(wrongShape.status).toBe(400);
    const wrongShapeBody = JSON.stringify(await wrongShape.json());

    // The wrong-shape error still names `content` and is NOT collapsed into the
    // generic malformed-body message.
    expect(wrongShapeBody.toLowerCase()).toContain("content");
    expect(wrongShapeBody).not.toBe(nonJsonBody);
  });
});
