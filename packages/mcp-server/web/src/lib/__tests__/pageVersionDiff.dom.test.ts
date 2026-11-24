/**
 * #714 gap 2 — the page version diff: blocks read from inert parsed documents,
 * classified added / changed / removed under their headings, tolerant of
 * reordering and whitespace/entity noise, and bounded on a 2 MiB page.
 */
import { describe, it, expect } from "vitest";
import {
  alignKeys,
  computePageVersionDiff,
  diffPageBlocks,
  extractPageBlocks,
  formatPageDiffSummary,
  parsePageHtml,
  summarizePageDiff,
  type PageBlock,
} from "../pageVersionDiff";

const blocksOf = (html: string) => extractPageBlocks(parsePageHtml(html)!).blocks;
const diffOf = (a: string, b: string) => diffPageBlocks(blocksOf(a), blocksOf(b));

const V1 =
  "<h1>Plan</h1><p>Intro text.</p>" +
  "<h2>Storage</h2><p>We store rows in Postgres.</p><p>Backups nightly.</p>" +
  "<h2>Costs</h2><p>About $40 a month.</p><p>Plus egress.</p><p>Plus support.</p>" +
  "<h2>Rollout</h2><ul><li>Canary 5%</li><li>Then 50%</li></ul>";

describe("extractPageBlocks", () => {
  it("reads block elements with their own text, keyed under the nearest heading", () => {
    const blocks = blocksOf("<h2>A</h2><p>one <b>bold</b></p><ul><li>x<ul><li>nested</li></ul></li></ul><table><tr><td>c1</td><td>c2</td></tr></table><div>leaf card</div><div><p>inner</p></div>");
    expect(blocks.map((b) => [b.tag, b.text, b.section])).toEqual([
      ["h2", "A", "A"],
      ["p", "one bold", "A"],
      ["li", "x", "A"],
      ["li", "nested", "A"],
      ["tr", "c1c2", "A"],
      ["div", "leaf card", "A"],
      ["p", "inner", "A"],
    ]);
  });

  it("never runs the page: scripts are inert and their text is not a block", () => {
    (globalThis as { __dpRan?: boolean }).__dpRan = false;
    const blocks = blocksOf("<p>hi</p><script>globalThis.__dpRan = true</script><img src=x onerror=\"globalThis.__dpRan = true\">");
    expect(blocks.map((b) => b.text)).toEqual(["hi"]);
    expect((globalThis as { __dpRan?: boolean }).__dpRan).toBe(false);
  });
});

describe("diffPageBlocks", () => {
  it("classifies changed, added and removed blocks under their headings", () => {
    const v2 =
      "<h1>Plan</h1><p>Intro text.</p>" +
      "<h2>Storage</h2><p>We store rows in SQLite.</p><p>Backups nightly.</p>" +
      "<h2>Costs</h2><p>About $40 a month.</p>" +
      "<h2>Rollout</h2><ul><li>Canary 5%</li><li>Then 50%</li><li>Then 100%</li></ul>" +
      "<h2>Risks</h2><p>Lock contention.</p>";
    const d = diffOf(V1, v2);
    expect(d.changes.map((c) => [c.kind, c.block.text, c.previous?.text])).toEqual([
      ["changed", "We store rows in SQLite.", "We store rows in Postgres."],
      ["added", "Then 100%", undefined],
      ["added", "Risks", undefined],
      ["added", "Lock contention.", undefined],
    ]);
    expect(d.removed.map((b) => [b.text, b.section])).toEqual([
      ["Plus egress.", "Costs"],
      ["Plus support.", "Costs"],
    ]);
    const s = summarizePageDiff(d);
    expect(s.changedSections).toEqual(["Storage", "Rollout"]);
    expect(s.addedSections).toEqual(["Risks"]);
    expect(formatPageDiffSummary(s)).toBe("Changed: Storage, Rollout; Added: Risks; Removed: 2 paragraphs under Costs");
  });

  it("tolerates reordering: moved sections are not flagged", () => {
    const v2 =
      "<h1>Plan</h1><p>Intro text.</p>" +
      "<h2>Rollout</h2><ul><li>Canary 5%</li><li>Then 50%</li></ul>" +
      "<h2>Costs</h2><p>About $40 a month.</p><p>Plus egress.</p><p>Plus support.</p>" +
      "<h2>Storage</h2><p>We store rows in Postgres.</p><p>Backups nightly.</p>";
    const d = diffOf(V1, v2);
    expect(d.changes).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.moved).toBeGreaterThan(0);
  });

  it("normalizes whitespace and entities: reformatted markup is no change", () => {
    const v2 = V1.replace("<p>Intro text.</p>", "<p>\n   Intro&#32;\n text&period;\n</p>").replace("About $40", "About&nbsp;$40");
    const d = diffOf(V1, v2);
    expect(d.changes).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(formatPageDiffSummary(summarizePageDiff(d))).toBe("");
  });

  it("a removed heading is reported as a removed section", () => {
    const v2 = V1.replace(/<h2>Costs<\/h2>.*?(?=<h2>Rollout)/, "");
    const s = summarizePageDiff(diffOf(V1, v2));
    expect(s.removedSections).toEqual(["Costs"]);
    expect(s.removed).toEqual([]);
    expect(formatPageDiffSummary(s)).toBe("Removed: section Costs");
  });

  it("stays fast on a 2 MiB page with scattered edits (no quadratic blowup)", () => {
    const mk = (n: number, edit: (i: number) => string | null) => {
      const out: PageBlock[] = [];
      for (let i = 0; i < n; i++) {
        const t = edit(i);
        if (t !== null) out.push({ tag: i % 50 === 0 ? "h2" : "p", text: t, section: `S${Math.floor(i / 50)}`, heading: i % 50 === 0 });
      }
      return out;
    };
    const N = 20000; // MAX_BLOCKS — ~100 bytes a block ≈ 2 MiB
    const base = (i: number) => `Paragraph ${i} ${"lorem ipsum dolor sit amet ".repeat(3)}`;
    const old = mk(N, base);
    const next = mk(N, (i) => (i % 97 === 0 ? `${base(i)} edited` : i % 211 === 0 ? null : base(i)));
    let t0 = performance.now();
    const d = diffPageBlocks(old, next);
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(d.changes.filter((c) => c.kind === "changed").length).toBeGreaterThan(150);

    // Adversarial: no unique anchors at all (every block identical text in
    // shuffled tags) — must take the bounded greedy path.
    const same = (n: number, off: number) =>
      Array.from({ length: n }, (_, i) => ({ tag: (i + off) % 3 === 0 ? "li" : "p", text: "same", section: "", heading: false }));
    t0 = performance.now();
    diffPageBlocks(same(N, 0), same(N, 1));
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it("alignKeys returns increasing pairs, exact on small inputs", () => {
    expect(alignKeys(["a", "b", "c", "d"], ["a", "x", "c", "d", "e"])).toEqual([[0, 0], [2, 2], [3, 3]]);
  });
});

describe("computePageVersionDiff — frame locators", () => {
  it("emits tag + clipped text + occurrence for changes, and honours data-dp-changed hints", () => {
    const v1 = "<p>Same</p><p>Same</p><p>Old tail</p><p>Static</p>";
    const v2 = "<p>Same</p><p>Same</p><p>New tail</p><p data-dp-changed>Static</p><p>Same</p>";
    const d = computePageVersionDiff(v1, v2)!;
    expect(d.marks).toEqual([
      { kind: "changed", tag: "p", text: "New tail", occurrence: 0 },
      { kind: "added", tag: "p", text: "Same", occurrence: 2 },
      { kind: "hinted", tag: "p", text: "Static", occurrence: 0 },
    ]);
  });
});
