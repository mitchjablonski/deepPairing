// #680 slice 4 — the stance phrase a page "Rule this out" records, and its body.
import { describe, it, expect } from "vitest";
import { PAGE_RULE_OUT_KEY_MAX, PAGE_RULE_OUT_MESSAGES, PageRuleOutBodySchema, checkPageRuleOut, pageRuleOutKey } from "../page-rule-out.js";

describe("pageRuleOutKey", () => {
  it("collapses whitespace and trims", () => {
    expect(pageRuleOutKey("  Up to\n\t60s  ")).toBe("Up to 60s");
  });

  it("refuses no text (no_text) and too-short phrases (too_short)", () => {
    expect(checkPageRuleOut("")).toEqual({ ok: false, reason: "no_text" });
    expect(checkPageRuleOut("   ")).toEqual({ ok: false, reason: "no_text" });
    expect(checkPageRuleOut("— !")).toEqual({ ok: false, reason: "no_text" });
    for (const q of ["ok", "Bob", "60s", "Redis", "a b c", "x 1 y", "Bob."]) {
      expect(checkPageRuleOut(q), q).toEqual({ ok: false, reason: "too_short" });
      expect(pageRuleOutKey(q)).toBeNull();
    }
  });

  it("accepts two words of 2+ letters/digits, or 8+ letters/digits in total", () => {
    expect(pageRuleOutKey("Up to")).toBe("Up to");
    expect(pageRuleOutKey("Up to 60s")).toBe("Up to 60s");
    expect(pageRuleOutKey("Postgres")).toBe("Postgres"); // 8 characters
    expect(pageRuleOutKey("Postgre")).toBeNull(); // 7, one word
    expect(pageRuleOutKey("write-through")).toBe("write-through"); // two words
  });

  it("has one message per refusal, shared by the companion and the server", () => {
    expect(Object.keys(PAGE_RULE_OUT_MESSAGES).sort()).toEqual(["no_text", "too_short"]);
  });

  it("keeps the longest colon-free part (the gate reads 'a: b' as category + noun)", () => {
    expect(pageRuleOutKey("Owner: Bob Smith-Jones")).toBe("Bob Smith-Jones");
    expect(pageRuleOutKey("Recommendation: shard the purge queue by tenant id")).toBe("shard the purge queue by tenant id");
    expect(checkPageRuleOut("a: b")).toEqual({ ok: false, reason: "too_short" });
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
