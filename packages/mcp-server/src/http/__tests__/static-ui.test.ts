import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mountStaticUi } from "../static-ui.js";

/**
 * II2.2/II2.3 regression guard. Both bugs lived in the seam "what bytes does
 * the daemon serve on GET /": II2.2 shipped the injection only in the
 * SPA-fallback branch, II2.3 confirmed `GET /` (which hits the file-exists
 * branch) therefore served index.html RAW — no window.__dpProjectHash → the
 * browser deadlocked (hashless WS → 403 "disconnected" + ledger 403). No unit
 * test caught it because none asserted the served HTML. This does.
 */
const TOKEN = "tok-abc";
const HASH = "hash123";
const INJECTION = `<script>window.__deepPairingToken = "${TOKEN}"; window.__dpProjectHash = "${HASH}";</script>`;

function buildApp(dir: string): Hono {
  const app = new Hono();
  // A representative gated API route, registered BEFORE the static catch-all,
  // so we can prove the catch-all yields to /api/* instead of swallowing it.
  app.get("/api/state", (c) => c.json({ ok: true }));
  mountStaticUi(app, { webDistPath: dir, authToken: TOKEN, projectHash: HASH });
  return app;
}

describe("mountStaticUi — bootstrap injection contract", () => {
  let dir: string;
  let app: Hono;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-static-"));
    fs.writeFileSync(
      path.join(dir, "index.html"),
      "<!doctype html><html><head><title>dp</title></head><body><div id=root></div></body></html>",
    );
    fs.mkdirSync(path.join(dir, "assets"));
    // Asset body deliberately CONTAINS the reader string `window.__dpProjectHash`
    // (the real bundle does too) to prove we assert on the <script> wrapper, not
    // a naive substring — assets must never be rewritten.
    fs.writeFileSync(
      path.join(dir, "assets", "app.js"),
      "const h = window.__dpProjectHash; console.log(h);",
    );
    app = buildApp(dir);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("GET / (top-level navigation) injects token + hash before </head> — the II2.3 regression", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain(INJECTION);
    expect(body).toContain(`${INJECTION}</head>`); // placed immediately before </head>
  });

  it("GET /index.html (explicit) injects", async () => {
    const body = await (await app.request("/index.html")).text();
    expect(body).toContain(INJECTION);
  });

  it("SPA deep-link fallback (no matching file) injects", async () => {
    const res = await app.request("/artifacts/xyz");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(INJECTION);
  });

  it("assets are served byte-identical with no injection wrapper", async () => {
    const res = await app.request("/assets/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/javascript");
    const body = await res.text();
    expect(body).not.toContain("<script>window.__deepPairingToken");
    expect(body).toBe(fs.readFileSync(path.join(dir, "assets", "app.js"), "utf-8"));
  });

  it("yields to /api/* routes instead of swallowing them", async () => {
    const res = await app.request("/api/state");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("is a no-op when webDistPath does not exist (dev before a web build)", async () => {
    const empty = new Hono();
    mountStaticUi(empty, { webDistPath: "/nonexistent/dp-dist", authToken: TOKEN, projectHash: HASH });
    // No static catch-all registered → unknown route 404s rather than serving.
    expect((await empty.request("/")).status).toBe(404);
  });
});

describe("mountStaticUi — IV4 injection-point cascade", () => {
  function serveRootWith(html: string): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-static-iv4-"));
    fs.writeFileSync(path.join(dir, "index.html"), html);
    const app = buildApp(dir);
    return app.request("/").then((r) => r.text()).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
  }

  it("injects after <head> when there is no </head>", async () => {
    const body = await serveRootWith("<html><head><body>x</body></html>");
    expect(body).toContain(`<head>${INJECTION}`);
  });

  it("injects after <html> when there is no <head> at all (keeps a leading doctype first)", async () => {
    const body = await serveRootWith("<!doctype html><html><body>x</body></html>");
    expect(body).toContain(`<html>${INJECTION}`);
    expect(body.indexOf("<!doctype html>")).toBe(0);
  });
});
