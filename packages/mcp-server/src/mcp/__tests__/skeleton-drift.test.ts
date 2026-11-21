/**
 * #686 P1b (warn mode) — exterior drift: the approved fenced file minus its
 * fence bodies, compared with the live file minus its fence bodies.
 */
import { describe, expect, it } from "vitest";
import type { PlanVisual } from "@deeppairing/shared";
import { formatExteriorDrift, skeletonExteriorDrift } from "../skeleton-drift.js";

const SRC = `import { canvas } from "./canvas";

export function smooth(raw: number[]): number[] {
  // SKEL[1] drop duplicates
  throw new Error("SKEL_TODO");
  // /SKEL[1]
}

export function wire(): void {
  // SKEL[2] connect the canvas
  throw new Error("SKEL_TODO");
  // /SKEL[2]
}`;

function approved(code: string | undefined, extra: Partial<NonNullable<PlanVisual["skeleton"]>> = {}, file = "a.ts"): PlanVisual {
  return {
    id: `skelcode:${file}`,
    kind: "annotated_code",
    title: file,
    filePath: file,
    lineStart: 1,
    ...(code !== undefined ? { code } : {}),
    skeleton: { fences: [], takenAt: "2026-11-20T00:00:00.000Z", ...extra },
  } as PlanVisual;
}

const drift = (live: string, code = SRC) => skeletonExteriorDrift([approved(code)], { "a.ts": { text: live } });

describe("skeletonExteriorDrift", () => {
  it("an unchanged exterior is no drift (the approved code had its trailing newline trimmed)", () => {
    expect(drift(`${SRC}\n`)).toEqual({ changed: [], deleted: [], notChecked: [] });
    expect(formatExteriorDrift(drift(SRC))).toBe("");
  });

  it("a fence body change (a fill) is NOT drift, even when it changes the line count", () => {
    const filled = SRC.replace('throw new Error("SKEL_TODO");', "const seen = new Set(raw);\n  return [...seen];");
    expect(drift(filled).changed).toEqual([]);
  });

  it("an edit outside a fence is drift, at the live line", () => {
    const filled = SRC.replace('throw new Error("SKEL_TODO");', "const a = 1;\n  const b = 2;\n  return [];");
    const live = filled.replace("export function wire(): void {", "export function wire(force: boolean): void {");
    const d = drift(live);
    expect(d.changed).toEqual([{ file: "a.ts", lines: [11], more: 0 }]);
    expect(formatExteriorDrift(d)).toContain("⚠ Exterior drift since approval: a.ts line 11.");
    expect(formatExteriorDrift(d)).toContain("skeleton changes");
  });

  it("an added helper and a removed import are both named", () => {
    const live = SRC.replace('import { canvas } from "./canvas";\n', "").concat("\n\nfunction helper() {}");
    const d = drift(live);
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0]!.lines).toEqual([1, 13, 14]);
  });

  it("a changed marker line is drift", () => {
    const d = drift(SRC.replace("// SKEL[2] connect the canvas", "// SKEL[2] connect the canvas and the toolbar"));
    expect(d.changed).toEqual([{ file: "a.ts", lines: [10], more: 0 }]);
  });

  it("broken markers are drift with a note, not a crash", () => {
    const d = drift(SRC.replace("  // /SKEL[2]\n", ""));
    expect(d.changed[0]!.note).toMatch(/markers no longer parse/);
  });

  it("lists the first five changed lines and counts the rest", () => {
    const live = `${SRC}\n${Array.from({ length: 8 }, (_, i) => `const x${i} = ${i};`).join("\n")}`;
    const d = drift(live);
    expect(d.changed[0]!.lines).toEqual([14, 15, 16, 17, 18]);
    expect(d.changed[0]!.more).toBe(3);
    expect(formatExteriorDrift(d)).toContain("a.ts lines 14, 15, 16, 17, 18 (+3 more)");
  });

  it("CRLF-only differences are not drift, on either side", () => {
    expect(drift(`${SRC.replace(/\n/g, "\r\n")}\r\n`).changed).toEqual([]);
    expect(drift(SRC, SRC.replace(/\n/g, "\r\n")).changed).toEqual([]);
  });

  it("a deleted declared file is reported as deleted", () => {
    const d = skeletonExteriorDrift([approved(SRC)], { "a.ts": { missing: true } });
    expect(d.deleted).toEqual(["a.ts"]);
    expect(formatExteriorDrift(d)).toContain("a.ts (deleted)");
  });

  it("withheld, truncated or unreadable files are not checked — never drift", () => {
    const d = skeletonExteriorDrift(
      [
        approved(undefined, { withheld: "possible secret detected" }, "w.ts"),
        approved(SRC, { truncated: { shownLines: 5, totalLines: 900 } }, "t.ts"),
        approved(SRC, {}, "u.ts"),
        approved(SRC, {}, "n.ts"),
      ],
      { "w.ts": { text: "anything" }, "t.ts": { text: "anything" }, "u.ts": { unchecked: "unreadable" } },
    );
    expect(d.changed).toEqual([]);
    expect(d.deleted).toEqual([]);
    expect(d.notChecked.map((n) => n.file)).toEqual(["w.ts", "t.ts", "u.ts", "n.ts"]);
    expect(formatExteriorDrift(d)).toBe("");
  });

  it("ignores live and agent visuals; only the approved skelcode: snapshot counts", () => {
    const live = { ...approved(SRC), id: "skelcode-live:a.ts" } as PlanVisual;
    const agent = { id: "x", kind: "annotated_code", filePath: "a.ts", code: "other" } as PlanVisual;
    expect(skeletonExteriorDrift([live, agent], { "a.ts": { text: "changed" } })).toEqual({ changed: [], deleted: [], notChecked: [] });
  });

  describe("markers stripped (the finalize state)", () => {
    const stripped = (src: string) =>
      src
        .split("\n")
        .filter((l) => !/SKEL\[/.test(l))
        .join("\n")
        .replace(/ {2}throw new Error\("SKEL_TODO"\);/g, "  return fill();");

    it("fills between the approved structure are not drift", () => {
      expect(drift(stripped(SRC)).changed).toEqual([]);
    });

    it("a changed exterior line is drift", () => {
      const live = stripped(SRC).replace("export function wire(): void {", "export function wire(x: number): void {");
      const d = drift(live);
      expect(d.changed).toHaveLength(1);
      expect(d.changed[0]!.lines).toEqual([7]);
      expect(d.changed[0]!.note).toMatch(/markers stripped/);
    });

    it("a changed first or last line is drift", () => {
      expect(drift(stripped(SRC).replace("./canvas", "./board")).changed[0]!.lines).toEqual([1]);
      expect(drift(`${stripped(SRC)}\nexport const extra = 1;`).changed[0]!.lines).toEqual([10]);
    });
  });
});
