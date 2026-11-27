/**
 * #714 gap 2 — the page version diff: blocks read from inert parsed documents,
 * classified added / changed / moved / removed under their headings, tolerant
 * of reordering and whitespace/entity noise, honest when nothing a block
 * caught changed, and bounded on a 2 MiB page.
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

const MARKUP_ONLY = "No change found in the compared text (attributes, styling and live form state aren't compared).";
const blocksOf = (html: string) => extractPageBlocks(parsePageHtml(html)!).blocks;
const diffOf = (a: string, b: string) => diffPageBlocks(blocksOf(a), blocksOf(b));
/** The summary line the reviewer reads for this pair. */
const lineFor = (a: string, b: string) => formatPageDiffSummary(summarizePageDiff(computePageVersionDiff(a, b)!));

const V1 =
  "<h1>Plan</h1><p>Intro text.</p>" +
  "<h2>Storage</h2><p>We store rows in Postgres.</p><p>Backups nightly.</p>" +
  "<h2>Costs</h2><p>About $40 a month.</p><p>Plus egress.</p><p>Plus support.</p>" +
  "<h2>Rollout</h2><ul><li>Canary 5%</li><li>Then 50%</li></ul>";

describe("extractPageBlocks", () => {
  it("reads block elements with their own text, keyed under the nearest heading", () => {
    const blocks = blocksOf(
      "<h2>A</h2><p>one <b>bold</b></p><ul><li>x<ul><li>nested</li></ul></li></ul>" +
        "<table><caption>Prices</caption><tr><td>c1</td><td>c2</td></tr></table><div>leaf card</div><div><p>inner</p></div>",
    );
    expect(blocks.map((b) => [b.tag, b.text, b.section])).toEqual([
      ["h2", "A", "A"],
      ["p", "one bold", "A"],
      ["li", "x", "A"],
      ["li", "nested", "A"],
      ["caption", "Prices", "A"],
      ["tr", "c1 | c2", "A"],
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

  it("gives loose text a synthetic block, placed where the text is", () => {
    const blocks = blocksOf("<h2>Cards</h2><div><h3>Card</h3>Ship <b>on</b> Monday</div>Loose body text");
    expect(blocks.map((b) => [b.tag, b.text, b.section, !!b.synthetic])).toEqual([
      ["h2", "Cards", "Cards", false],
      ["h3", "Card", "Card", false],
      ["div", "Ship on Monday", "Card", true],
      ["body", "Loose body text", "Card", true],
    ]);
  });

  it("reads an image-only figure by its alt text", () => {
    expect(blocksOf("<figure><img src=a.png alt=\"Latency chart\"></figure>").map((b) => b.text)).toEqual(["Latency chart"]);
  });

  it("does not skip authored data-dp-annotator content (only our own layer element)", () => {
    expect(blocksOf("<p data-dp-annotator>Authored</p>").map((b) => b.text)).toEqual(["Authored"]);
  });
});

describe("the reviewer is never told 'nothing changed' when text did (probe cases)", () => {
  const probes: Array<[string, string, string, RegExp]> = [
    ["card text after its heading", "<div><h3>Card</h3>Ship on Monday</div>", "<div><h3>Card</h3>Ship on Friday</div>", /^Changed: Card$/],
    ["a <summary> label", "<details><summary>Show cost</summary><p>x</p></details>", "<details><summary>Show price</summary><p>x</p></details>", /^Changed: Top of page$/],
    ["a <button> label beside a <p>", "<div><p>Body</p><button>Approve</button></div>", "<div><p>Body</p><button>Reject</button></div>", /^Changed:/],
    ["a table <caption>", "<table><caption>2025 prices</caption><tr><td>a</td></tr></table>", "<table><caption>2026 prices</caption><tr><td>a</td></tr></table>", /^Changed:/],
    ["loose body text", "<h2>Intro</h2>Hello there", "<h2>Intro</h2>Hello world", /^Changed: Intro$/],
    ["a value moving between adjacent cells", "<table><tr><td>40</td><td></td></tr></table>", "<table><tr><td></td><td>40</td></tr></table>", /^Changed:/],
    ["<br> versus no space", "<p>Ship<br>Monday</p>", "<p>ShipMonday</p>", /^Changed:/],
    ["a label and a legend", "<fieldset><legend>Region</legend><label>EU</label></fieldset>", "<fieldset><legend>Zone</legend><label>US</label></fieldset>", /^Changed:/],
  ];
  for (const [name, a, b, want] of probes) {
    it(name, () => {
      const line = lineFor(a, b);
      expect(line).toMatch(want);
      expect(line).not.toMatch(/markup or styling|unchanged/i);
    });
  }

  it("says the page is unchanged only when the HTML is byte-identical", () => {
    expect(lineFor(V1, V1)).toBe("Page content unchanged.");
  });

  it("says 'markup or styling only' when the HTML differs but no text does", () => {
    expect(lineFor("<p>Hi</p>", "<p class=\"big\" style=\"color:red\">Hi</p>")).toBe(MARKUP_ONLY);
  });

  it("backstop: blocks equal but the visible text differs → 'Text changed outside recognised blocks'", () => {
    // Loose-text runs make this hard to reach from markup (that is the point);
    // the summary still never falls back to "unchanged" when the flag is set.
    const s = summarizePageDiff({ changes: [], removed: [], moved: 0, identical: false, textChangedOutsideBlocks: true });
    expect(formatPageDiffSummary(s)).toBe("Text changed outside recognised blocks.");
    // Loose text moving across a paragraph is now a real (run) change.
    expect(lineFor("X<p>para</p>Y", "XY<p>para</p>")).toMatch(/^Changed:/);
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

  it("tolerates reordering: moved sections are not flagged, but the move is disclosed", () => {
    const v2 =
      "<h1>Plan</h1><p>Intro text.</p>" +
      "<h2>Rollout</h2><ul><li>Canary 5%</li><li>Then 50%</li></ul>" +
      "<h2>Costs</h2><p>About $40 a month.</p><p>Plus egress.</p><p>Plus support.</p>" +
      "<h2>Storage</h2><p>We store rows in Postgres.</p><p>Backups nightly.</p>";
    const d = diffOf(V1, v2);
    expect(d.changes).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.moved).toBeGreaterThan(0);
    expect(formatPageDiffSummary(summarizePageDiff(d))).toBe(`${d.moved} blocks moved`);
  });

  it("a block moved into another section is a change under its new section", () => {
    const a = "<h2>Approved</h2><ul><li>Add index</li><li>Drop table users</li></ul><h2>Rejected</h2><ul><li>Rewrite in Rust</li></ul>";
    const b = "<h2>Approved</h2><ul><li>Add index</li></ul><h2>Rejected</h2><ul><li>Rewrite in Rust</li><li>Drop table users</li></ul>";
    const d = diffOf(a, b);
    expect(d.changes.map((c) => [c.kind, c.block.text, c.block.section, c.previous?.section])).toEqual([
      ["moved", "Drop table users", "Rejected", "Approved"],
    ]);
    expect(lineFor(a, b)).toBe("Changed: Rejected; Moved: “Drop table users” from Approved to Rejected");
    expect(computePageVersionDiff(a, b)!.marks).toEqual([{ kind: "moved", tag: "li", text: "Drop table users", occurrence: 0 }]);
  });

  it("normalizes whitespace and entities: reformatted markup is no text change", () => {
    const v2 = V1.replace("<p>Intro text.</p>", "<p>\n   Intro&#32;\n text&period;\n</p>").replace("About $40", "About&nbsp;$40");
    const d = diffOf(V1, v2);
    expect(d.changes).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(lineFor(V1, v2)).toBe(MARKUP_ONLY);
  });

  it("a removed section lists its heading AND its paragraphs", () => {
    const v2 = V1.replace(/<h2>Costs<\/h2>.*?(?=<h2>Rollout)/, "");
    const s = summarizePageDiff(diffOf(V1, v2));
    expect(s.removedSections).toEqual([
      { section: "Costs", sectionId: 5, texts: ["About $40 a month.", "Plus egress.", "Plus support."], noun: "paragraphs" },
    ]);
    expect(s.removed).toEqual([]);
    expect(formatPageDiffSummary(s)).toBe("Removed: section Costs (3 paragraphs)");
  });

  it("groups removals by section identity, not name (two sections called Notes)", () => {
    const a = "<h2>Notes</h2><p>first a</p><p>first b</p><h2>Other</h2><p>o</p><h2>Notes</h2><p>second a</p><p>second b</p>";
    const b = "<h2>Notes</h2><p>first a</p><h2>Other</h2><p>o</p><h2>Notes</h2><p>second a</p>";
    const s = summarizePageDiff(diffOf(a, b));
    expect(s.removed.map((g) => [g.section, g.texts])).toEqual([
      ["Notes", ["first b"]],
      ["Notes", ["second b"]],
    ]);
  });

  it("stays fast on a 2 MiB page with scattered edits (no quadratic blowup)", () => {
    const mk = (n: number, edit: (i: number) => string | null) => {
      const out: PageBlock[] = [];
      for (let i = 0; i < n; i++) {
        const t = edit(i);
        const h = i - (i % 50);
        if (t !== null) out.push({ tag: i % 50 === 0 ? "h2" : "p", text: t, section: `S${h}`, sectionId: h, heading: i % 50 === 0 });
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

    // Adversarial: no unique anchors at all (every block the same text in
    // shuffled tags) — must take the bounded greedy path.
    const same = (n: number, off: number): PageBlock[] =>
      Array.from({ length: n }, (_, i) => ({ tag: (i + off) % 3 === 0 ? "li" : "p", text: "same", section: "", sectionId: -1, heading: false }));
    t0 = performance.now();
    diffPageBlocks(same(N, 0), same(N, 1));
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it("alignKeys returns increasing pairs, exact on small inputs", () => {
    expect(alignKeys(["a", "b", "c", "d"], ["a", "x", "c", "d", "e"])).toEqual([[0, 0], [2, 2], [3, 3]]);
  });
});

describe("computePageVersionDiff — frame locators and counts", () => {
  it("emits tag + clipped text + occurrence for changes, and honours data-dp-changed hints", () => {
    const v1 = "<p>Same</p><p>Same</p><p>Old tail</p><p>Static</p>";
    const v2 = "<p>Same</p><p>Same</p><p>New tail</p><p data-dp-changed>Static</p><p>Same</p>";
    const d = computePageVersionDiff(v1, v2)!;
    expect(d.marks).toEqual([
      { kind: "changed", tag: "p", text: "New tail", occurrence: 0 },
      { kind: "added", tag: "p", text: "Same", occurrence: 2 },
      { kind: "hinted", tag: "p", text: "Static", occurrence: 0 },
    ]);
    expect([d.changeMarksTotal, d.hintMarksTotal]).toEqual([2, 1]);
  });

  it("locates an image-only figure by its alt, and a card by its whole text", () => {
    const d = computePageVersionDiff(
      "<figure><img alt=\"Old chart\"></figure><div><h3>Card</h3>Ship Monday</div>",
      "<figure><img alt=\"New chart\"></figure><div><h3>Card</h3>Ship Friday</div>",
    )!;
    expect(d.marks).toEqual([
      { kind: "changed", tag: "figure", text: "New chart", occurrence: 0 },
      { kind: "changed", tag: "div", text: "CardShip Friday", occurrence: 0 },
    ]);
  });

  it("caps the marks at 300 and reports the true total", () => {
    const many = (w: string) => Array.from({ length: 400 }, (_, i) => `<p>${w} ${i}</p>`).join("");
    const d = computePageVersionDiff(many("old"), many("new"))!;
    expect(d.marks).toHaveLength(300);
    expect(d.changeMarksTotal).toBe(400);
  });
});

describe("#718 round 3 — loose-text runs, section identity, control values", () => {
  const MD = (b: string) => `<h2>Alpha</h2>text A<h2>Beta</h2>${b}`;
  for (const [where, wrap] of [
    ["body", (x: string) => x],
    ["<main>", (x: string) => `<main>${x}</main>`],
    ["a wrapper div", (x: string) => `<div class="doc">${x}</div>`],
  ] as Array<[string, (x: string) => string]>) {
    it(`Markdown-style loose text in ${where}: an edit under Beta is credited to Beta, and not outlined`, () => {
      const d = computePageVersionDiff(wrap(MD("text B")), wrap(MD("text B edited")))!;
      expect(formatPageDiffSummary(summarizePageDiff(d))).toBe("Changed: Beta");
      expect(d.marks).toEqual([]);
      expect(d.unhighlightable).toBe(1);
    });
  }

  it("each run of loose text is its own block, positioned where it occurs", () => {
    expect(blocksOf(MD("text B")).map((b) => [b.tag, b.text, b.section])).toEqual([
      ["h2", "Alpha", "Alpha"],
      ["body", "text A", "Alpha"],
      ["h2", "Beta", "Beta"],
      ["body", "text B", "Beta"],
    ]);
  });

  it("two same-text items moving together across a heading are both flagged", () => {
    const a = "<h2>Approved</h2><ul><li>Add index</li><li>Retry</li><li>Retry</li></ul><h2>Rejected</h2><ul><li>Rewrite</li></ul>";
    const b = "<h2>Approved</h2><ul><li>Add index</li></ul><h2>Rejected</h2><ul><li>Rewrite</li><li>Retry</li><li>Retry</li></ul>";
    const d = diffOf(a, b);
    expect(d.changes.map((c) => [c.kind, c.block.text, c.block.section])).toEqual([
      ["moved", "Retry", "Rejected"],
      ["moved", "Retry", "Rejected"],
    ]);
  });

  it("a move between two sections that share a name is located and labelled by path", () => {
    const a = "<h2>Option A</h2><h3>Pros</h3><ul><li>Fast</li><li>Cheap</li></ul><h2>Option B</h2><h3>Pros</h3><ul><li>Safe</li></ul>";
    const b = "<h2>Option A</h2><h3>Pros</h3><ul><li>Cheap</li></ul><h2>Option B</h2><h3>Pros</h3><ul><li>Safe</li><li>Fast</li></ul>";
    const d = computePageVersionDiff(a, b)!;
    expect(d.marks).toEqual([{ kind: "moved", tag: "li", text: "Fast", occurrence: 0 }]);
    expect(formatPageDiffSummary(summarizePageDiff(d))).toBe("Changed: Pros; Moved: “Fast” from Option A › Pros to Option B › Pros");
  });

  it("a submit button's value is visible text", () => {
    expect(lineFor("<form><input type=submit value=\"Approve\"></form>", "<form><input type=submit value=\"Reject\"></form>")).toMatch(/^Changed:/);
    expect(lineFor("<p><input type=submit></p>", "<p><input type=reset></p>")).toMatch(/^Changed:/);
  });

  it("a text input's value attribute is visible text", () => {
    expect(lineFor("<p>Budget <input value=\"40\"></p>", "<p>Budget <input value=\"80\"></p>")).toMatch(/^Changed:/);
    // A hidden field is not visible text.
    expect(lineFor("<p>x<input type=hidden value=1></p>", "<p>x<input type=hidden value=2></p>")).toBe(MARKUP_ONLY);
  });

  it("leading empty cells keep their separators", () => {
    expect(blocksOf("<table><tr><td></td><td></td><td>40</td></tr></table>").map((b) => b.text)).toEqual(["| | 40"]);
    expect(lineFor("<table><tr><td></td><td>40</td><td></td></tr></table>", "<table><tr><td></td><td></td><td>40</td></tr></table>")).toMatch(/^Changed:/);
  });
});

describe("#727 — a heading's level change is one quiet change, not a remove + add", () => {
  it("h2 → h3 with the same text: one changed heading, nothing removed or moved", () => {
    const v2 = V1.replace("<h2>Costs</h2>", "<h3>Costs</h3>");
    const d = diffOf(V1, v2);
    expect(d.changes.map((c) => [c.kind, c.block.tag, c.block.text, c.previous?.tag, c.levelChanged])).toEqual([
      ["changed", "h3", "Costs", "h2", true],
    ]);
    expect(d.removed).toEqual([]);
    expect(d.moved).toBe(0);
    expect(lineFor(V1, v2)).toBe("Changed: Costs");
    expect(computePageVersionDiff(V1, v2)!.marks).toEqual([{ kind: "changed", tag: "h3", text: "Costs", occurrence: 0 }]);
  });

  it("sibling sections stay untouched, and an edit in the same section joins the one change", () => {
    const v2 = V1.replace("<h2>Storage</h2>", "<h4>Storage</h4>").replace("Backups nightly.", "Backups hourly.");
    const d = diffOf(V1, v2);
    expect(d.changes.map((c) => [c.kind, c.block.text, c.block.section])).toEqual([
      ["changed", "Storage", "Storage"],
      ["changed", "Backups hourly.", "Storage"],
    ]);
    expect(d.removed).toEqual([]);
    expect(summarizePageDiff(d).changedSections).toEqual(["Storage"]);
    expect(lineFor(V1, v2)).toBe("Changed: Storage");
  });

  it("several level changes (a section demoted under its neighbour) don't cascade", () => {
    const v2 = V1.replace("<h2>Costs</h2>", "<h3>Costs</h3>").replace("<h2>Rollout</h2>", "<h3>Rollout</h3>");
    const d = diffOf(V1, v2);
    expect(d.changes.map((c) => [c.kind, c.block.text, c.levelChanged])).toEqual([
      ["changed", "Costs", true],
      ["changed", "Rollout", true],
    ]);
    expect(d.removed).toEqual([]);
    expect(d.moved).toBe(0);
    expect(lineFor(V1, v2)).toBe("Changed: Costs, Rollout");
  });

  it("a reworded heading is still a plain change (not a level change)", () => {
    const d = diffOf(V1, V1.replace("<h2>Costs</h2>", "<h2>Budget</h2>"));
    expect(d.changes.map((c) => [c.kind, c.block.text, c.previous?.text, c.levelChanged])).toEqual([
      ["changed", "Budget", "Costs", undefined],
    ]);
  });
});
