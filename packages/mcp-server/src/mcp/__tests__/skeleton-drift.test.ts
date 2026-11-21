/**
 * #686 P1b (warn mode) — exterior drift: the approved fenced file minus its
 * fence bodies, compared with the live file minus its fence bodies.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PlanVisual } from "@deeppairing/shared";
import { formatExteriorDrift, isSkeletonDriftBaseline, skeletonExteriorDigest, skeletonExteriorDrift } from "../skeleton-drift.js";
import { buildSkeletonSnapshot, checkSkeletonExteriorDrift, SKELETON_SNAPSHOT_LIMITS } from "../skeleton-snapshot.js";

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

  it("CRLF approved code stored the way the snapshot stores it (trailing \\r left) is not drift", () => {
    const crlf = `${SRC.replace(/\n/g, "\r\n")}\r\n`;
    const stored = crlf.replace(/\n$/, ""); // buildSkeletonSnapshot's own trim
    expect(stored.endsWith("\r")).toBe(true);
    expect(drift(crlf, stored).changed).toEqual([]);
    expect(drift(`${SRC}\n`, stored).changed).toEqual([]);
  });

  it("a leading BOM and trailing whitespace on a line are not drift", () => {
    expect(drift(`\uFEFF${SRC.replace("export function wire(): void {", "export function wire(): void {   ")}`).changed).toEqual([]);
  });

  it("partly stripped markers: the stripped fence's former body is not drift, an exterior edit is", () => {
    const partial = SRC.replace("  // SKEL[1] drop duplicates\n", "").replace("  // /SKEL[1]\n", "").replace('throw new Error("SKEL_TODO");', "const a = 1;\n  return [a];");
    expect(drift(partial).changed).toEqual([]);
    const d = drift(partial.replace("export function wire(): void {", "export function wire(x: number): void {"));
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0]!.note).toContain("markers of SKEL[1] stripped");
  });

  it("the diff cap falls back to an approximate, capped line list", () => {
    const big = (tag: string) => Array.from({ length: 2100 }, (_, i) => `const ${tag}${i} = ${i};`).join("\n");
    const code = `${big("a")}\n// SKEL[1] x\nthrow new Error("SKEL_TODO");\n// /SKEL[1]`;
    const d = drift(code.replace(big("a"), big("b")), code);
    expect(d.changed[0]!.approximate).toBe(true);
    expect(d.changed[0]!.more).toBe(20);
    expect(formatExteriorDrift(d)).toContain("(+20+ more) (approximate");
  });

  it("a withheld or truncated file with an approved exterior digest is compared by digest (no lines)", () => {
    const digest = skeletonExteriorDigest(SRC, "w.ts");
    const visuals = [approved(undefined, { withheld: "possible secret detected", exterior: digest }, "w.ts"), approved(SRC, { truncated: { shownLines: 3, totalLines: 13 }, exterior: digest }, "t.ts")];
    const filled = SRC.replace('throw new Error("SKEL_TODO");', "return [];");
    expect(skeletonExteriorDrift(visuals, { "w.ts": { text: filled }, "t.ts": { text: `${filled}\r\n` } }).changed).toEqual([]);
    const d = skeletonExteriorDrift(visuals, { "w.ts": { text: `// hdr\n${SRC}` }, "t.ts": { text: SRC } });
    expect(d.changed).toEqual([{ file: "w.ts", lines: [], more: 0, note: "changed — withheld from the approved snapshot, so no line numbers" }]);
  });

  it("a digest-only file: full strip is not checked, a partial strip or renamed id is changed, filled with markers kept is quiet", () => {
    const digest = skeletonExteriorDigest(SRC, "w.ts");
    expect(digest.fenceIds).toEqual(["1", "2"]);
    const visuals = [approved(undefined, { withheld: "possible secret detected", exterior: digest }, "w.ts")];
    const filled = SRC.replace(/throw new Error\("SKEL_TODO"\);/g, "return 1;");
    expect(skeletonExteriorDrift(visuals, { "w.ts": { text: filled } })).toEqual({ changed: [], deleted: [], notChecked: [] });
    const stripped = filled.split("\n").filter((l) => !l.includes("SKEL[")).join("\n");
    const d = skeletonExteriorDrift(visuals, { "w.ts": { text: stripped } });
    expect(d.changed).toEqual([]);
    expect(d.notChecked).toEqual([{ file: "w.ts", reason: "markers stripped; withheld from the approved snapshot, so only a digest was kept" }]);
    // Some markers remain but the fence set moved: changed, not "not checked".
    const partial = filled.replace("  // SKEL[1] drop duplicates\n", "").replace("  // /SKEL[1]\n", "");
    const renamedId = filled.replace(/SKEL\[2\]/g, "SKEL[9]");
    for (const text of [partial, renamedId]) {
      const r = skeletonExteriorDrift(visuals, { "w.ts": { text } });
      expect(r.notChecked).toEqual([]);
      expect(r.changed).toEqual([{ file: "w.ts", lines: [], more: 0, note: "fence set differs from approval — withheld from the approved snapshot, so no line numbers" }]);
    }
  });

  it("files past the snapshot cap get a digest at present time and are checked by it", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dp-skeldrift-cap-")));
    try {
      const other = SRC.replace(/SKEL\[1\]/g, "SKEL[3]").replace(/SKEL\[2\]/g, "SKEL[4]");
      fs.writeFileSync(path.join(root, "a.ts"), SRC);
      fs.writeFileSync(path.join(root, "b.ts"), other);
      const steps = ["1", "3"].map((skelId, i) => ({ description: "s", skelId, files: [i ? "b.ts" : "a.ts"] }));
      const limits = { ...SKELETON_SNAPSHOT_LIMITS, maxFiles: 1 };
      // The progress re-read records no digests.
      const plain = buildSkeletonSnapshot({ steps, root, limits });
      expect(plain.visuals[0]!.skeleton!.exterior).toBeUndefined();
      expect(plain.visuals[0]!.skeleton!.omitted).toBeUndefined();
      const snap = buildSkeletonSnapshot({ steps, root, limits, recordExterior: true });
      expect(snap.visuals.map((v) => v.id)).toEqual(["skelcode:a.ts"]);
      const omitted = snap.visuals[0]!.skeleton!.omitted!;
      expect(omitted.map((o) => o.path)).toEqual(["b.ts"]);
      expect(JSON.stringify(omitted)).not.toContain("smooth"); // no content
      const content = { steps, visuals: snap.visuals };
      expect(checkSkeletonExteriorDrift(content, { root }).changed).toEqual([]);
      fs.writeFileSync(path.join(root, "b.ts"), other.replace("raw: number[]", "raw: readonly number[]"));
      const d = checkSkeletonExteriorDrift(content, { root });
      expect(d.changed).toEqual([{ file: "b.ts", lines: [], more: 0, note: "changed — past the snapshot cap, so no line numbers" }]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a deleted file whose fences moved to a sibling is flagged as a possible rename", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dp-skeldrift-mv-")));
    try {
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(path.join(root, "src", "a.ts"), SRC);
      const steps = [{ description: "s", skelId: "1", files: ["src/a.ts"] }];
      const content = { steps, visuals: buildSkeletonSnapshot({ steps, root }).visuals };
      // A sibling holding only one of the two fence ids is not a rename.
      fs.writeFileSync(path.join(root, "src", "c.ts"), "// SKEL[1] drop duplicates\nx\n// /SKEL[1]\n");
      fs.renameSync(path.join(root, "src", "a.ts"), path.join(root, "src", "b.ts"));
      const d = checkSkeletonExteriorDrift(content, { root });
      expect(d.deleted).toEqual(["src/a.ts"]);
      expect(d.renamed).toEqual([{ from: "src/a.ts", to: "src/b.ts" }]);
      expect(formatExteriorDrift(d)).toContain("src/a.ts (deleted; its fences are now in src/b.ts — renamed?)");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("isSkeletonDriftBaseline: live approved, or approved-then-superseded with every newer version rejected", () => {
    const v1 = { id: "v1", type: "plan", status: "superseded", statusHistory: [{ status: "draft" }, { status: "approved" }, { status: "superseded" }] };
    const v2 = { id: "v2", type: "plan", status: "rejected", parentId: "v1" };
    expect(isSkeletonDriftBaseline(v1, [v1, v2])).toBe(true);
    expect(isSkeletonDriftBaseline(v1, [v1, { ...v2, status: "draft" }])).toBe(false);
    expect(isSkeletonDriftBaseline({ ...v1, statusHistory: [{ status: "draft" }, { status: "superseded" }] }, [v1, v2])).toBe(false);
    expect(isSkeletonDriftBaseline({ id: "x", type: "plan", status: "approved" }, [])).toBe(true);
    expect(isSkeletonDriftBaseline(v2, [v1, v2])).toBe(false);
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
