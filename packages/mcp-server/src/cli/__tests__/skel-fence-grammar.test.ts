/**
 * #683 — skeleton-skills' fence grammar, vendored as data (see the fixture
 * header for the source commit), run through deepPairing's port.
 */
import { describe, expect, it } from "vitest";
import { bodyEscapesFence, scanSkeletonText } from "../../skeleton-scope.js";
import { ESCAPE_CASES, LEGACY_GRAMMAR, LONG_WHITESPACE_SPACES, MARKER_CASES } from "./fixtures/skel-fence-grammar.js";

const tuples = (text: string) =>
  scanSkeletonText(text, "<text>").map((f) => [f.id, f.title, f.openLine, f.closeLine, f.status]);

describe("skel fence grammar: markers", () => {
  it.each(MARKER_CASES.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    if (c.error) expect(() => scanSkeletonText(c.text, "<text>")).toThrow(c.error);
    else expect(tuples(c.text)).toEqual(c.fences);
  });

  it("keeps the legacy one-regex title grammar across comment styles, whitespace and terminators", () => {
    const { comments, chunks, terminators, id } = LEGACY_GRAMMAR;
    const COMMENT = String.raw`(?:\/\/|#|--|;|\/\*|<!--|\{\/\*)`;
    const ID = String.raw`([A-Za-z0-9][\w.-]*)`;
    const oldOpen = new RegExp(String.raw`^\s*${COMMENT}\s*SKEL\[${ID}\]\s*(.*?)\s*(?:\*\/\}?|-->)?\s*$`);
    const oldClose = new RegExp(String.raw`^\s*${COMMENT}\s*\/SKEL\[${ID}\]\s*(?:\*\/\}?|-->)?\s*$`);
    for (const comment of comments) {
      for (const a of chunks) for (const b of chunks) for (const c of terminators) {
        const line = ` \t${comment} SKEL[${id}]${a}${b}${c}`;
        const expected = oldOpen.exec(line);
        const text = `${line}\nbody\n// /SKEL[${id}]`;
        if (expected) expect(scanSkeletonText(text, "<text>")[0]?.title, JSON.stringify(line)).toBe(expected[2]);
        else expect(() => scanSkeletonText(text, "<text>"), JSON.stringify(line)).toThrow(/closes nothing/);
        const close = ` ${comment} /SKEL[${id}]${a}${b}${c}`;
        const parsed = (() => { try { return scanSkeletonText(`// SKEL[${id}]\n${close}`, "<text>").length === 1; } catch { return false; } })();
        expect(parsed, JSON.stringify(close)).toBe(oldClose.test(close));
      }
    }
  });

  it("parses long whitespace titles and rejected closes in linear time", () => {
    const spaces = " ".repeat(LONG_WHITESPACE_SPACES);
    const started = Date.now();
    expect(scanSkeletonText(`// SKEL[1] x${spaces}x\nbody\n// /SKEL[1]`, "<text>")[0]!.title).toBe(`x${spaces}x`);
    expect(scanSkeletonText(`// /SKEL[1]${spaces}x`, "<text>")).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("skel fence grammar: bodyEscapesFence", () => {
  it.each(ESCAPE_CASES.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const verdict = bodyEscapesFence(c.body, c.marker, c.file);
    if (c.expect === null) expect(verdict).toBeNull();
    else if (c.expect === "escape") expect(verdict).not.toBeNull();
    else expect(verdict).toMatch(c.expect);
  });
});
