/**
 * Q5 — GET /api/export.html (the ExportMenu's "Share as page"). A separate
 * route from /api/export on purpose: different content type, a download
 * disposition, and its own option (includeCode). The markdown route must stay
 * exactly as it was.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { FileStore } from "../../store/file-store.js";
import { createRoutesTestContext, destroyRoutesTestContext, type RoutesApp } from "./routes.harness.js";
import { readGuardrailFires, htmlExportFileName } from "../../export/html-export.js";

let tmpDir: string;
let store: FileStore;
let app: RoutesApp;

beforeEach(() => {
  ({ tmpDir, store, app } = createRoutesTestContext());
  store.createArtifact({
    id: "art_1",
    type: "research",
    title: "Queue audit",
    content: { summary: "The queue drains too slowly.", findings: [] },
  });
  store.forceFlush();
});

afterEach(() => {
  destroyRoutesTestContext({ tmpDir, store });
});

describe("GET /api/export.html", () => {
  it("returns a self-contained page as a download", async () => {
    const res = await app.request("/api/export.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Content-Disposition")).toMatch(/attachment; filename="session-test_session-\d{4}-\d{2}-\d{2}\.html"/);
    const html = await res.text();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("Queue audit");
    expect(html).not.toMatch(/<script/i);
  });

  it("respects includeCode=0", async () => {
    store.createArtifact({
      id: "art_2",
      type: "code_change",
      title: "Drain faster",
      content: { filePath: "src/queue.ts", changeType: "modify", before: "", after: "const batchSize = 500;", reasoning: "Bigger batches." },
    });
    store.forceFlush();

    const withCode = await (await app.request("/api/export.html")).text();
    expect(withCode).toContain("const batchSize = 500;");

    const without = await (await app.request("/api/export.html?includeCode=0")).text();
    expect(without).not.toContain("const batchSize = 500;");
    expect(without).toContain("Code omitted from this export");
    expect(without).toContain("src/queue.ts");
  });

  it("leaves GET /api/export (markdown) unchanged", async () => {
    const res = await app.request("/api/export?format=full");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/markdown");
    expect(await res.text()).toContain("# deepPairing Session Report");
  });
});

describe("readGuardrailFires", () => {
  it("reads the hook fire log when it exists", () => {
    const dir = path.join(tmpDir, ".deeppairing");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "hooks-state.json"),
      JSON.stringify({ version: 1, fires: [{ at: "2026-08-19T10:00:00.000Z", hook: "preflight", reason: "guardrail:migrations" }] }),
    );
    expect(readGuardrailFires(tmpDir)).toEqual([
      { at: "2026-08-19T10:00:00.000Z", hook: "preflight", reason: "guardrail:migrations" },
    ]);
  });

  it("returns nothing — never a fabricated fire — when the file is missing or corrupt", () => {
    expect(readGuardrailFires(tmpDir)).toEqual([]);
    expect(readGuardrailFires(undefined)).toEqual([]);
    const dir = path.join(tmpDir, ".deeppairing");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "hooks-state.json"), "{not json");
    expect(readGuardrailFires(tmpDir)).toEqual([]);
  });

  it("drops entries with no timestamp (they can't be placed honestly)", () => {
    const dir = path.join(tmpDir, ".deeppairing");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "hooks-state.json"), JSON.stringify({ fires: [{ hook: "preflight" }, "junk", null] }));
    expect(readGuardrailFires(tmpDir)).toEqual([]);
  });
});

describe("htmlExportFileName", () => {
  it("is stable per session per day and filesystem-safe", () => {
    expect(htmlExportFileName("s_1", "2026-08-19T12:00:00.000Z")).toBe("session-s_1-2026-08-19.html");
    expect(htmlExportFileName("a/../b", "2026-08-19T12:00:00.000Z")).toBe("session-a____b-2026-08-19.html");
  });
});
