/**
 * #680 slice 1 — the `page` artifact type: agent-authored HTML presented for
 * review. The schema is the single source of truth; the coercer stays lenient
 * so a partial page still renders.
 */
import { describe, it, expect } from "vitest";
import type { Artifact } from "../artifact.js";
import { ArtifactSchema, ArtifactTypeSchema, parseArtifactContent } from "../artifact.js";
import { PageContentSchema, PAGE_HTML_MAX_BYTES } from "../content-types.js";
import { coercePageContent, coerceArtifactContent } from "../coerce-content.js";
import { pageArtifact } from "../../__fixtures__/artifacts.js";

describe("PageContentSchema (#680)", () => {
  it("`page` is a member of the artifact type enum", () => {
    expect(ArtifactTypeSchema.options).toContain("page");
  });

  it("accepts the minimal page (title + html)", () => {
    const r = PageContentSchema.safeParse({ title: "Options", html: "<p>hi</p>" });
    expect(r.success).toBe(true);
  });

  it("accepts every optional field", () => {
    const r = PageContentSchema.safeParse({
      title: "Options",
      summary: "Pick one.",
      html: "<p>hi</p>",
      sourcePath: "docs/options.html",
      concept: { name: "write-through purge", oneLineExplanation: "invalidate on write" },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.sourcePath).toBe("docs/options.html");
      expect(r.data.concept?.name).toBe("write-through purge");
    }
  });

  it("rejects a page with no html", () => {
    expect(PageContentSchema.safeParse({ title: "Options" }).success).toBe(false);
  });

  it("rejects an EMPTY html or title (.min(1))", () => {
    expect(PageContentSchema.safeParse({ title: "Options", html: "" }).success).toBe(false);
    expect(PageContentSchema.safeParse({ title: "", html: "<p>x</p>" }).success).toBe(false);
  });

  it("rejects a non-string html and an empty concept name", () => {
    expect(PageContentSchema.safeParse({ title: "T", html: 42 }).success).toBe(false);
    expect(PageContentSchema.safeParse({ title: "T", html: "<p>x</p>", concept: { name: "" } }).success).toBe(false);
  });

  it("exports a 2 MB html cap", () => {
    expect(PAGE_HTML_MAX_BYTES).toBe(2 * 1024 * 1024);
  });

  it("the page fixture parses as an Artifact and through parseArtifactContent", () => {
    const parsed = ArtifactSchema.parse(pageArtifact);
    expect(parsed.type).toBe("page");
    const r = parseArtifactContent(parsed as Artifact);
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as { html: string }).html).toContain("<table>");
  });

  it("parseArtifactContent fails a page whose html is missing", () => {
    const r = parseArtifactContent({ ...pageArtifact, content: { title: "T" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues[0]!.path.join(".")).toBe("html");
  });
});

describe("coercePageContent (#680)", () => {
  it("defaults missing fields instead of throwing", () => {
    expect(coercePageContent(undefined)).toEqual({ title: "", html: "" });
    expect(coercePageContent({ title: 3, html: null, summary: 7 })).toEqual({ title: "", html: "" });
  });

  it("keeps summary, sourcePath and a named concept", () => {
    const out = coercePageContent({
      title: "T", html: "<p>x</p>", summary: "s", sourcePath: "a.html", concept: { name: "c", oneLineExplanation: "why" },
    });
    expect(out).toEqual({ title: "T", html: "<p>x</p>", summary: "s", sourcePath: "a.html", concept: { name: "c", oneLineExplanation: "why" } });
  });

  it("drops a concept with no name", () => {
    expect(coercePageContent({ title: "T", html: "x", concept: { name: "  " } }).concept).toBeUndefined();
  });

  it("coerceArtifactContent dispatches `page`", () => {
    const out = coerceArtifactContent(pageArtifact) as { title: string };
    expect(out.title).toBe(pageArtifact.title);
  });
});
