/**
 * #680 slice 1 — present_page: an agent-authored HTML page presented for
 * review. Covers storing from inline `html` and from a project `path`, the
 * path-escape refusals, the size cap, and — the moat — the SAME rejection gate
 * the other present_* tools run, fed the page's visible text.
 *
 * Fakes, not mocks: a real in-memory MCP client↔server pair over a real
 * FileStore on a temp dir (server-test-harness), plus the real HTTP routes for
 * the reject → re-present loop.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FileStore } from "../../store/file-store.js";
import { setupServerTest, makeCallTool } from "./server-test-harness.js";
import { createHttpRoutes } from "../../http/routes.js";
import { withHash } from "../../http/__tests__/routes.harness.js";

const ctx = setupServerTest();
const callTool = makeCallTool(ctx);
let store: FileStore;
let root: string;
let outside: string;
let prevProjectDir: string | undefined;

beforeEach(() => {
  store = ctx.store;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dp-page-root-")));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dp-page-outside-")));
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
});
afterEach(() => {
  if (prevProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = prevProjectDir;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const pages = () => store.getArtifacts().filter((a) => a.type === "page");

describe("present_page — storing the page", () => {
  it("stores a draft page artifact from inline html", async () => {
    const res = await callTool("present_page", {
      title: "Cache invalidation options",
      summary: "Which strategy should I build?",
      html: "<h1>Options</h1><p>Three strategies compared in one table.</p>",
    });
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain("presented for review");
    const [page] = pages();
    expect(page).toBeDefined();
    expect(page!.status).toBe("draft");
    expect(page!.title).toBe("Cache invalidation options");
    const content = page!.content as Record<string, unknown>;
    expect(content.html).toBe("<h1>Options</h1><p>Three strategies compared in one table.</p>");
    expect(content.summary).toBe("Which strategy should I build?");
    expect(content.sourcePath).toBeUndefined();
    expect(ctx.broadcasts.some((b) => b.type === "artifact_created" && b.artifact.id === page!.id)).toBe(true);
  });

  it("stores a page read from a file inside the project, with a relative sourcePath", async () => {
    fs.writeFileSync(path.join(root, "docs", "options.html"), "<h1>From disk</h1><p>Read once at present time.</p>");
    const res = await callTool("present_page", { title: "Options from disk", path: "docs/options.html" });
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain("from docs/options.html");
    const content = pages()[0]!.content as Record<string, unknown>;
    expect(content.html).toBe("<h1>From disk</h1><p>Read once at present time.</p>");
    expect(content.sourcePath).toBe("docs/options.html");
  });

  it("accepts an absolute path that is inside the project root", async () => {
    const abs = path.join(root, "docs", "abs.html");
    fs.writeFileSync(abs, "<p>absolute but inside</p>");
    const res = await callTool("present_page", { title: "Absolute inside", path: abs });
    expect(res.isError).toBeFalsy();
    expect((pages()[0]!.content as Record<string, unknown>).sourcePath).toBe("docs/abs.html");
  });

  it("normalizes a bare-string concept to the shared { name } shape", async () => {
    await callTool("present_page", { title: "Purge page", html: "<p>x y z</p>", concept: "write-through purge" });
    expect((pages()[0]!.content as Record<string, unknown>).concept).toEqual({ name: "write-through purge" });
  });

  it("refuses when both html and path are given, or neither", async () => {
    fs.writeFileSync(path.join(root, "docs", "a.html"), "<p>a</p>");
    const both = await callTool("present_page", { title: "Both", html: "<p>a</p>", path: "docs/a.html" });
    expect(both.isError).toBe(true);
    expect(both.text).toContain("exactly one of `html`");
    const neither = await callTool("present_page", { title: "Neither" });
    expect(neither.isError).toBe(true);
    expect(pages()).toHaveLength(0);
  });

  it("refuses html over the 2 MB cap", async () => {
    const huge = "<p>" + "x".repeat(2 * 1024 * 1024) + "</p>";
    const res = await callTool("present_page", { title: "Huge", html: huge });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("PAYLOAD_TOO_LARGE");
    expect(pages()).toHaveLength(0);
  });

  it("refuses a file over the 2 MB cap", async () => {
    fs.writeFileSync(path.join(root, "docs", "huge.html"), "x".repeat(2 * 1024 * 1024 + 1));
    const res = await callTool("present_page", { title: "Huge file", path: "docs/huge.html" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("PAYLOAD_TOO_LARGE");
    expect(pages()).toHaveLength(0);
  });

  it("refuses a missing file and a directory", async () => {
    const missing = await callTool("present_page", { title: "Missing", path: "docs/nope.html" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("no file at");
    const dir = await callTool("present_page", { title: "Dir", path: "docs" });
    expect(dir.isError).toBe(true);
    expect(dir.text).toContain("not a regular file");
    expect(pages()).toHaveLength(0);
  });
});

describe("present_page — path escapes are refused", () => {
  it("refuses a ../ path that escapes the project root", async () => {
    fs.writeFileSync(path.join(outside, "secret.html"), "<p>outside</p>");
    const rel = path.relative(root, path.join(outside, "secret.html"));
    expect(rel.startsWith("..")).toBe(true);
    const res = await callTool("present_page", { title: "Escape", path: rel });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("outside the project root");
    expect(pages()).toHaveLength(0);
  });

  it("refuses an absolute path outside the project root", async () => {
    const abs = path.join(outside, "secret.html");
    fs.writeFileSync(abs, "<p>outside</p>");
    const res = await callTool("present_page", { title: "Escape abs", path: abs });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("outside the project root");
    expect(pages()).toHaveLength(0);
  });

  it("refuses a symlink inside the project that points outside it", async () => {
    const target = path.join(outside, "secret.html");
    fs.writeFileSync(target, "<p>outside via link</p>");
    const link = path.join(root, "docs", "link.html");
    try {
      fs.symlinkSync(target, link);
    } catch {
      return; // symlinks unavailable on this host: nothing to check
    }
    const res = await callTool("present_page", { title: "Escape link", path: "docs/link.html" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("outside the project root");
    expect(pages()).toHaveLength(0);
  });
});

describe("present_page — .deeppairing/ and dot-dot names", () => {
  it("refuses a path inside .deeppairing/ (the daemon's state dir), directly or through a symlink", async () => {
    fs.mkdirSync(path.join(root, ".deeppairing"), { recursive: true });
    fs.writeFileSync(path.join(root, ".deeppairing", "daemon.json"), '{"authToken":"secret"}');
    fs.writeFileSync(path.join(root, ".deeppairing", "page.html"), "<p>state</p>");
    for (const p of [".deeppairing/page.html", "docs/../.deeppairing/daemon.json", path.join(root, ".DeepPairing", "page.html")]) {
      const res = await callTool("present_page", { title: "State", path: p });
      expect(res.isError, p).toBe(true);
      expect(res.text, p).toContain(".deeppairing/");
    }
    try {
      fs.symlinkSync(path.join(root, ".deeppairing", "daemon.json"), path.join(root, "docs", "token.html"));
    } catch {
      return; // symlinks unavailable on this host
    }
    const viaLink = await callTool("present_page", { title: "State link", path: "docs/token.html" });
    expect(viaLink.isError).toBe(true);
    expect(viaLink.text).toContain(".deeppairing/");
    expect(pages()).toHaveLength(0);
  });

  it("accepts an in-root name that merely starts with '..'", async () => {
    fs.writeFileSync(path.join(root, "..notes.html"), "<p>dot-dot name</p>");
    fs.mkdirSync(path.join(root, "..drafts"));
    fs.writeFileSync(path.join(root, "..drafts", "p.html"), "<p>dot-dot dir</p>");
    const file = await callTool("present_page", { title: "Dot dot file", path: "..notes.html" });
    expect(file.isError).toBeFalsy();
    const dir = await callTool("present_page", { title: "Dot dot dir", path: "..drafts/p.html" });
    expect(dir.isError).toBeFalsy();
    expect(pages().map((p) => (p.content as { sourcePath?: string }).sourcePath).sort()).toEqual(["..drafts/p.html", "..notes.html"]);
  });
});

describe("present_page — the rejection gate", () => {
  it("refuses a page whose visible text matches a stored rejection, and returns its reason", async () => {
    store.recordRejectedApproach({ description: "Deploy: Railway", reason: "too expensive for our scale" });
    const res = await callTool("present_page", {
      title: "Hosting proposal",
      html: "<h1>Hosting</h1><section><p>We should move the API to Railway for simpler deploys.</p></section>",
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("REJECTED_APPROACH_BLOCKED");
    expect(res.text).toContain("Railway");
    expect(res.text).toContain("too expensive for our scale");
    expect(pages()).toHaveLength(0);
    const block = ctx.broadcasts.find((b) => b.type === "preflight_blocked");
    expect(block?.toolName).toBe("present_page");
  });

  it("refuses on the summary and on the declared concept, too", async () => {
    store.recordRejectedApproach({ description: "global mutable state", reason: "untestable", concept: "global mutable state" });
    const viaSummary = await callTool("present_page", {
      title: "State plan",
      summary: "This keeps a global mutable state object for the session.",
      html: "<p>Nothing relevant in the body text here.</p>",
    });
    expect(viaSummary.isError).toBe(true);
    expect(viaSummary.text).toContain("untestable");
    const viaConcept = await callTool("present_page", {
      title: "Another state plan",
      html: "<p>Nothing relevant in the body text here.</p>",
      concept: "global mutable state",
    });
    expect(viaConcept.isError).toBe(true);
    expect(pages()).toHaveLength(0);
  });

  it("reads a file-backed page's text through the gate", async () => {
    store.recordRejectedApproach({ description: "Deploy: Railway", reason: "too expensive for our scale" });
    fs.writeFileSync(path.join(root, "docs", "hosting.html"), "<p>Plan: deploy everything on Railway next week.</p>");
    const res = await callTool("present_page", { title: "Hosting from disk", path: "docs/hosting.html" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("too expensive for our scale");
    expect(pages()).toHaveLength(0);
  });

  it("refuses a comparison table whose single-word cell names the rejected option (review P2)", async () => {
    store.recordRejectedApproach({ description: "Deploy: Railway", reason: "too expensive for our scale", concept: "Railway" });
    const res = await callTool("present_page", {
      title: "Hosting comparison",
      html: "<table><tr><th>Railway</th><th>Fly.io</th></tr><tr><td>$20</td><td>$15</td></tr></table>",
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("REJECTED_APPROACH_BLOCKED");
    expect(res.text).toContain("too expensive for our scale");
    expect(pages()).toHaveLength(0);
  });

  it("a page TITLE keeps the normal reverse lane, like every present_* tool (review)", async () => {
    store.recordRejectedApproach({ description: "Use Redis for the session cache", reason: "no new services" });
    const res = await callTool("present_page", { title: "Redis", html: "<p>Nothing else relevant here.</p>" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("no new services");
    expect(pages()).toHaveLength(0);
  });

  it("the same single word as a BODY cell does not match backwards (raw-text rule)", async () => {
    store.recordRejectedApproach({ description: "Use Redis for the session cache", reason: "no new services" });
    const res = await callTool("present_page", { title: "Cache backends", html: "<table><tr><td>Redis</td><td>12 ms</td></tr></table>" });
    expect(res.isError).toBeFalsy();
    expect(pages()).toHaveLength(1);
  });

  it("text inside <xmp> and after <plaintext> reaches the gate (review N2)", async () => {
    store.recordRejectedApproach({ description: "Deploy: Railway", reason: "too expensive for our scale" });
    const xmp = await callTool("present_page", { title: "Hosting A", html: "<xmp><!--</xmp><p>Deploy on Railway</p>-->" });
    expect(xmp.isError).toBe(true);
    const plain = await callTool("present_page", { title: "Hosting B", html: "<plaintext><!-- Deploy on Railway -->" });
    expect(plain.isError).toBe(true);
    expect(plain.text).toContain("too expensive for our scale");
    expect(pages()).toHaveLength(0);
  });

  it("a lone generic cell does not match backwards inside an unrelated stance", async () => {
    store.recordRejectedApproach({ description: "Overview of the auth rewrite", reason: "out of scope" });
    const res = await callTool("present_page", {
      title: "Cache options",
      html: "<h2>Overview</h2><table><tr><td>None</td><td>Up to 60s</td></tr></table>",
    });
    expect(res.isError).toBeFalsy();
    expect(pages()).toHaveLength(1);
  });

  it("body text after an unclosed <head> reaches the gate (review P1)", async () => {
    store.recordRejectedApproach({ description: "Deploy: Railway", reason: "too expensive for our scale" });
    const res = await callTool("present_page", {
      title: "Hosting proposal",
      html: "<html><head><title>x</title><body><p>Deploy everything on Railway next week.</p>",
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("too expensive for our scale");
    expect(pages()).toHaveLength(0);
  });

  it("ignores script, style and comment text (only VISIBLE text is a proposal)", async () => {
    store.recordRejectedApproach({ description: "Deploy: Railway", reason: "too expensive for our scale" });
    const res = await callTool("present_page", {
      title: "Hosting proposal",
      html:
        "<style>.railway { color: red }</style>" +
        "<script>const target = 'Railway';</script>" +
        "<!-- maybe Railway later -->" +
        "<p>We deploy on Fly.io with two regions.</p>",
    });
    expect(res.isError).toBeFalsy();
    expect(pages()).toHaveLength(1);
  });

  it("a page rejected in the companion with a reason blocks the next attempt with that reason", async () => {
    const first = await callTool("present_page", {
      title: "Write-through cache purge",
      html: "<p>Purge the session cache on every write, synchronously.</p>",
    });
    expect(first.isError).toBeFalsy();
    const page = pages()[0]!;
    const app = withHash(createHttpRoutes(store, ctx.tmpDir, () => {}), ctx.tmpDir);
    const rejected = await app.request(`/api/artifacts/${page.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "rejected", feedback: "doubles write latency on the hot path" }),
    });
    expect(rejected.status).toBe(200);
    expect(store.getSessionMemory().rejectedApproaches.some((r) => r.description === "Write-through cache purge")).toBe(true);

    const retry = await callTool("present_page", {
      title: "Session cache, take two",
      html: "<h2>Approach</h2><p>Keep the write-through cache purge but batch it per request.</p>",
    });
    expect(retry.isError).toBe(true);
    expect(retry.text).toContain("REJECTED_APPROACH_BLOCKED");
    expect(retry.text).toContain("doubles write latency on the hot path");
    expect(pages()).toHaveLength(1);
  });
});

describe("present_page — non-blocking authoring lint (#714 gap 6)", () => {
  it("returns warnings in the text and structuredContent, and still stores the page", async () => {
    const res = await callTool("present_page", {
      title: "CDN page",
      html: '<p>Diagram below</p><script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>',
    });
    expect(res.isError).toBeFalsy();
    expect(pages()).toHaveLength(1);
    expect(res.text).toContain("Page warnings (non-blocking; the page was presented)");
    expect(res.text).toContain("script src x1");
    expect(res.text).not.toContain("cdn.jsdelivr.net");
    expect(JSON.stringify(res.structuredContent)).not.toContain("cdn.jsdelivr.net");
    const codes = (res.structuredContent?.warnings as Array<{ code: string }>).map((w) => w.code);
    expect(codes).toEqual(["external_asset", "no_headings"]);
  });

  it("a clean page gets no warnings block and no structured warnings", async () => {
    const res = await callTool("present_page", {
      title: "Clean page",
      html: '<h1>Plan</h1><section id="a"><h2>A</h2><p>See <a href="https://example.com/docs">the docs</a>.</p></section>',
    });
    expect(res.isError).toBeFalsy();
    expect(res.text).not.toContain("Page warnings");
    expect(res.structuredContent?.warnings).toBeUndefined();
  });

  it("a page revise_artifact gets the same non-blocking warnings; a clean revision gets none", async () => {
    await callTool("present_page", { title: "Plan", html: "<h1>Plan</h1><p>v1</p>" });
    const v1 = pages()[0]!.id;
    const res = await callTool("revise_artifact", {
      artifactId: v1, mode: "supersede", reason: "add a chart",
      content: { html: '<p>v2</p><script src="https://cdn.example.com/chart.js"></script>' },
    });
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain("Superseded");
    expect(res.text).toContain("Page warnings (non-blocking; the page was presented)");
    expect((res.structuredContent?.warnings as Array<{ code: string }>).map((w) => w.code)).toEqual(["external_asset", "no_headings"]);
    const v2 = pages().find((p) => p.status === "draft")!.id;
    const clean = await callTool("revise_artifact", { artifactId: v2, mode: "supersede", reason: "inline it", content: { html: "<h1>Plan</h1><p>v3</p>" } });
    expect(clean.isError).toBeFalsy();
    expect(clean.text).not.toContain("Page warnings");
    expect(clean.structuredContent?.warnings).toBeUndefined();
  });

  it("the lint never changes the gate: a page with warnings is still refused on a rejected approach", async () => {
    store.recordRejectedApproach({ description: "Deploy: Railway", reason: "too expensive for our scale" });
    const res = await callTool("present_page", {
      title: "Hosting proposal",
      html: '<p>We should move the API to Railway.</p><img src="https://x.test/a.png">',
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("too expensive for our scale");
    expect(res.text).not.toContain("Page warnings");
    expect(res.structuredContent?.warnings).toBeUndefined();
    expect(pages()).toHaveLength(0);
  });
});

