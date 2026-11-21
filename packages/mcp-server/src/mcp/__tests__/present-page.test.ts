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
