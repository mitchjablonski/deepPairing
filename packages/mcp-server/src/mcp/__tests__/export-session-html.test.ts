/**
 * Q5 — `export_session { format: "html" }` writes the shareable page and hands
 * back its PATH (a whole HTML page in the tool reply would burn the agent's
 * context for nothing), and the new `narrative` / `audience` / `includeCode`
 * params reach the renderer. Fake, not mock: a real FileStore on a temp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { handleExportSession } from "../tools/export-session.js";
import type { ToolContext } from "../tools/types.js";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";

let fx: GlobalStoreFixture;
let tmpDir: string;
let prevRoot: string | undefined;

beforeEach(() => {
  fx = withGlobalStore("dp-export-html-");
  tmpDir = fx.dir;
  // resolveProjectRoot() decides where the page lands; point it at the temp
  // project so no test ever writes into a real checkout.
  prevRoot = process.env.DEEPPAIRING_PROJECT_ROOT;
  process.env.DEEPPAIRING_PROJECT_ROOT = tmpDir;
});

afterEach(() => {
  if (prevRoot === undefined) delete process.env.DEEPPAIRING_PROJECT_ROOT;
  else process.env.DEEPPAIRING_PROJECT_ROOT = prevRoot;
  fx.dispose();
});

function makeCtx(store: FileStore): ToolContext {
  return {
    server: { notification: () => {} },
    store,
    broadcast: () => {},
    port: 4000,
    helpers: {} as ToolContext["helpers"],
    state: {
      checkFeedbackPollCount: 0,
      reportedRejectedVerdicts: new Set<string>(),
      reportedPlanVerdicts: new Set<string>(),
    },
  } as unknown as ToolContext;
}

function seed(store: FileStore) {
  store.createArtifact({
    id: "art_1",
    type: "research",
    title: "Cache audit",
    content: {
      summary: "The cache is the bottleneck.",
      findings: [{ category: "Performance", title: "Cold start", detail: "Every boot repopulates.", significance: "high" }],
    },
  });
  store.createArtifact({
    id: "art_2",
    type: "code_change",
    title: "Warm the cache on boot",
    content: {
      filePath: "src/cache.ts",
      changeType: "modify",
      before: "const cache = new Map();",
      after: "const cache = new Map();\nwarm(cache);",
      reasoning: "Amortize the cold start.",
    },
  });
}

function textOf(res: { content: Array<{ text: string }> }): string {
  return res.content.map((c) => c.text).join("\n");
}

describe("export_session format:html", () => {
  it("writes a self-contained page under .deeppairing/exports and returns its path", async () => {
    const store = fx.track(new FileStore(tmpDir, "s_html"));
    seed(store);

    const res = await handleExportSession(makeCtx(store), { format: "html" });
    const text = textOf(res as any);
    const match = text.match(/Path: (.+)/);
    expect(match).toBeTruthy();
    const file = match![1]!.trim();
    expect(file.startsWith(path.join(tmpDir, ".deeppairing", "exports"))).toBe(true);
    expect(fs.existsSync(file)).toBe(true);

    const html = fs.readFileSync(file, "utf-8");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("Cache audit");
    expect(html).toContain("Warm the cache on boot");
    expect(html).not.toMatch(/<script/i);
    // The reply itself stays SHORT — the page is the artifact, not the reply.
    expect(text.length).toBeLessThan(1200);
    expect(text).not.toContain("<!doctype html>");
  });

  it("places a supplied narrative and audience on the page", async () => {
    const store = fx.track(new FileStore(tmpDir, "s_html"));
    seed(store);

    const res = await handleExportSession(makeCtx(store), {
      format: "html",
      narrative: "## What we did\n\nWe found the **cold start** and warmed the cache on boot.",
      audience: "the platform team",
    });
    const file = textOf(res as any).match(/Path: (.+)/)![1]!.trim();
    const html = fs.readFileSync(file, "utf-8");
    expect(html).toContain("What we did");
    expect(html).toContain("<strong>cold start</strong>");
    expect(html).toContain("Written for the platform team.");
    expect(html).not.toContain("Auto-generated summary");
    expect(textOf(res as any)).toContain("Your narrative leads the page.");
  });

  it("nudges toward composing a narrative when none was supplied", async () => {
    const store = fx.track(new FileStore(tmpDir, "s_html"));
    seed(store);
    const res = await handleExportSession(makeCtx(store), { format: "html" });
    expect(textOf(res as any)).toContain("/deeppairing:share");
  });

  it("honors includeCode:false and says so", async () => {
    const store = fx.track(new FileStore(tmpDir, "s_html"));
    seed(store);

    const res = await handleExportSession(makeCtx(store), { format: "html", includeCode: false });
    const text = textOf(res as any);
    expect(text).toContain("Code bodies were omitted");
    const html = fs.readFileSync(text.match(/Path: (.+)/)![1]!.trim(), "utf-8");
    expect(html).not.toContain("warm(cache);");
    expect(html).toContain("Code omitted from this export");
    // The record itself survives the redaction.
    expect(html).toContain("src/cache.ts");
  });

  it("includes code by default", async () => {
    const store = fx.track(new FileStore(tmpDir, "s_html"));
    seed(store);
    const res = await handleExportSession(makeCtx(store), { format: "html" });
    const html = fs.readFileSync(textOf(res as any).match(/Path: (.+)/)![1]!.trim(), "utf-8");
    expect(html).toContain("warm(cache);");
  });

  it("leaves the six markdown formats untouched", async () => {
    const store = fx.track(new FileStore(tmpDir, "s_html"));
    seed(store);
    const res = await handleExportSession(makeCtx(store), { format: "full" });
    const text = textOf(res as any);
    expect(text).toContain("# deepPairing Session Report");
    expect(text).not.toContain("<!doctype html>");
  });
});
