// #680 slice 4 — the stance phrase a page "Rule this out" records, and its body.
import { describe, it, expect } from "vitest";
import { PAGE_RULE_OUT_KEY_MAX, PageRuleOutBodySchema, pageRuleOutKey } from "../page-rule-out.js";

describe("pageRuleOutKey", () => {
  it("collapses whitespace and trims", () => {
    expect(pageRuleOutKey("  Up to\n\t60s  ")).toBe("Up to 60s");
  });

  it("returns null for no text or too few letters/digits", () => {
    expect(pageRuleOutKey("")).toBeNull();
    expect(pageRuleOutKey("   ")).toBeNull();
    expect(pageRuleOutKey("ok")).toBeNull();
    expect(pageRuleOutKey("— !")).toBeNull();
    expect(pageRuleOutKey("60s")).toBe("60s");
  });

  it("keeps the longest colon-free part (the gate reads 'a: b' as category + noun)", () => {
    expect(pageRuleOutKey("Owner: Bob Smith-Jones")).toBe("Bob Smith-Jones");
    expect(pageRuleOutKey("Recommendation: shard the purge queue by tenant id")).toBe("shard the purge queue by tenant id");
    expect(pageRuleOutKey("a: b")).toBeNull();
  });

  it("caps at a word boundary without an ellipsis, as a literal prefix", () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const key = pageRuleOutKey(words)!;
    expect(key.length).toBeLessThanOrEqual(PAGE_RULE_OUT_KEY_MAX);
    expect(words.startsWith(key)).toBe(true);
    expect(words.charAt(key.length)).toBe(" ");
    expect(key.endsWith("…")).toBe(false);
  });

  it("hard-cuts a single unbroken token longer than the cap", () => {
    expect(pageRuleOutKey("x".repeat(200))).toBe("x".repeat(PAGE_RULE_OUT_KEY_MAX));
  });
});

describe("PageRuleOutBodySchema", () => {
  const htmlAnchor = { kind: "text", locator: "p", quote: "Up to 60s" };
  it("requires a non-blank reason", () => {
    expect(PageRuleOutBodySchema.safeParse({ htmlAnchor, reason: "too stale" }).success).toBe(true);
    expect(PageRuleOutBodySchema.safeParse({ htmlAnchor, reason: "  " }).success).toBe(false);
    expect(PageRuleOutBodySchema.safeParse({ htmlAnchor }).success).toBe(false);
  });
  it("checks the anchor as strictly as a comment's", () => {
    expect(PageRuleOutBodySchema.safeParse({ htmlAnchor: { ...htmlAnchor, quote: "q".repeat(281) }, reason: "x" }).success).toBe(false);
    expect(PageRuleOutBodySchema.safeParse({ htmlAnchor: { kind: "text", locator: "p", quote: " " }, reason: "x" }).success).toBe(false);
  });
});
