/**
 * Companion web UI static handler — serves the built SPA (index.html + assets)
 * and injects the daemon's bootstrap globals into the HTML document.
 *
 * Extracted from daemon.ts so the bootstrap-injection contract can be tested
 * in isolation (the daemon module starts a server at import time). This is the
 * seam where the II2.2 and II2.3 bugs lived: both were invisible to unit tests
 * because nothing asserted *what bytes the daemon actually serves on GET /*.
 */
import fs from "node:fs";
import path from "node:path";
import type { Hono } from "hono";

export interface StaticUiOptions {
  /** Directory holding the built SPA (index.html + assets/*). */
  webDistPath: string;
  /** Daemon bearer token injected as `window.__deepPairingToken` (III5). */
  authToken: string | undefined;
  /** Daemon projectHash injected as `window.__dpProjectHash` (II2.2/II2.3). */
  projectHash: string | undefined;
  /** Optional logger for the pathological "index.html has no <head>" case. */
  log?: (msg: string) => void;
}

const MIME_TYPES: Record<string, string> = {
  html: "text/html", js: "application/javascript", css: "text/css",
  json: "application/json", svg: "image/svg+xml", woff2: "font/woff2", png: "image/png",
};

/**
 * Register the static UI catch-all on `app`. Call this AFTER the `/api/*`
 * routes so they win the match; the handler yields to them via `next()`.
 * No-op when `webDistPath` doesn't exist (e.g. a dev run before a web build).
 *
 * III5 + II2.2/II2.3 — index.html is served with the daemon's bearer token
 * (`window.__deepPairingToken`) AND projectHash (`window.__dpProjectHash`)
 * injected just before `</head>`, so the SPA learns both BEFORE its first WS
 * connect / mutation fetch. The first WS upgrade then carries projectHash
 * (→ 101) and the first ledger fetch carries X-Project-Hash + Bearer (→ 200).
 * Without it the store hash starts null → the hashless first WS upgrade hits
 * the fail-closed gate (→ 403, "disconnected, reconnecting") and the ledger
 * fetch 403s ("could not load the ledger").
 *
 * The token already travels in daemon.json (file-system gate) and via
 * /api/internal/* calls; the hash is derived from projectRoot (not a secret)
 * and is already public on /api/daemon-info — so injecting either into the
 * HTML leaks nothing new.
 *
 * II2.3 — the injection MUST run for the document the browser loads on a
 * top-level navigation. `GET /` maps to `/index.html`, which exists on disk,
 * so II2.2 (which placed the injection only in the SPA-fallback branch) served
 * `/` RAW and never injected. Both the file-exists branch (`/` → /index.html)
 * and the SPA fallback now route index.html through one helper.
 */
export function mountStaticUi(app: Hono, opts: StaticUiOptions): void {
  const { webDistPath, authToken, projectHash, log } = opts;
  if (!fs.existsSync(webDistPath)) return;

  const serveInjectedIndex = (indexPath: string): Response => {
    const html = fs.readFileSync(indexPath, "utf-8");
    const tokenJson = JSON.stringify(authToken);
    const hashJson = JSON.stringify(projectHash);
    const injection = `<script>window.__deepPairingToken = ${tokenJson}; window.__dpProjectHash = ${hashJson};</script>`;
    // IV4 — ordering matters. Prefer `</head>` injection (every Vite build
    // emits one); else after `<head>`; else after `<html>` so a leading
    // `<!doctype html>` stays first (a prepend would force quirks mode). Last
    // resort: serve raw so the page at least renders un-authed.
    let injected: string;
    if (html.includes("</head>")) {
      injected = html.replace("</head>", `${injection}</head>`);
    } else if (/<head\b[^>]*>/i.test(html)) {
      injected = html.replace(/(<head\b[^>]*>)/i, `$1${injection}`);
    } else if (/<html\b[^>]*>/i.test(html)) {
      injected = html.replace(/(<html\b[^>]*>)/i, `$1${injection}`);
    } else {
      log?.(`[token-inject] no <head>/<html> in index.html; serving without token. Bearer routes will 401 until UI is rebuilt.`);
      injected = html;
    }
    // E5 — index.html must never be served stale: a cached index references
    // old hashed chunks, and the first re-hashed lazy import in that tab
    // fails (the field-confirmed skew crash). Hashed assets stay heuristic-
    // cacheable — their names change when content does.
    return new Response(injected, {
      headers: { "Content-Type": "text/html", "Cache-Control": "no-cache" },
    });
  };

  app.get("/*", async (c, next) => {
    if (c.req.path.startsWith("/api/")) return next();
    const filePath = c.req.path === "/" ? "/index.html" : c.req.path;
    const fullPath = path.join(webDistPath, filePath);
    const resolvedPath = path.resolve(fullPath);
    const resolvedBase = path.resolve(webDistPath);
    if (!resolvedPath.startsWith(resolvedBase + path.sep) && resolvedPath !== resolvedBase) {
      return c.notFound();
    }
    if (fs.existsSync(fullPath)) {
      const ext = path.extname(filePath).slice(1);
      // II2.3 — any HTML document we serve (only index.html in a Vite SPA
      // build) MUST carry the injection, including the top-level `/` →
      // /index.html navigation that lands here because the file exists.
      if (ext === "html") return serveInjectedIndex(fullPath);
      const content = fs.readFileSync(fullPath);
      return new Response(content, {
        headers: { "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream" },
      });
    }
    // SPA fallback — deep links with no matching file render index.html (injected).
    const indexPath = path.join(webDistPath, "index.html");
    if (fs.existsSync(indexPath)) {
      return serveInjectedIndex(indexPath);
    }
    return c.notFound();
  });
}
