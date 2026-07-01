import { describe, it, expect, beforeAll } from "vitest";
import { repairMermaidSource } from "../MermaidDiagram";

/**
 * Validates repairMermaidSource against the REAL Mermaid parser (no mock — the
 * MermaidDiagram.test.tsx suite mocks mermaid, so it can't check that the
 * repaired output actually parses). Runs in the web test env's DOM; mermaid.parse
 * is syntax-only and needs no layout, so it works headless.
 *
 * The core guarantee under test: the repair either produces PARSEABLE Mermaid or
 * leaves it unparseable (→ the component's source fallback). It must never turn a
 * failing diagram into a wrong-but-parseable one (the shape-flatten regression).
 */
let mermaid: typeof import("mermaid").default;

// Importing the full mermaid bundle in the test env is slow and, under a loaded
// parallel run, the one-time load can spike well past 45s (observed a flake), so
// give it a very generous timeout. The parse() calls themselves are fast.
beforeAll(async () => {
  mermaid = (await import("mermaid")).default;
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
}, 120000);

const parses = async (src: string): Promise<boolean> => {
  try {
    await mermaid.parse(src);
    return true;
  } catch {
    return false;
  }
};

describe("repairMermaidSource — against the real Mermaid parser", () => {
  it("repairs the reported diagram (unquoted punctuation labels + \\n) into parseable Mermaid", async () => {
    const src =
      "flowchart TD\n" +
      "  C[Curse: Weak + Vulnerable\\n(existing statuses, #79 seeds)] -->|enemy hits softer,\\nyour hits land harder| S[Drain strike]\n" +
      "  E[Enemy] -.tanky, drain-worthy\\n(new Act).-> S";
    expect(await parses(src)).toBe(false); // raw fails — matches the field report
    expect(await parses(repairMermaidSource(src))).toBe(true); // repaired renders
  });

  it("does NOT flatten a cylinder/parallelogram/trapezoid into a wrong-but-parseable rectangle", async () => {
    for (const src of [
      "flowchart TD\n  A[(store (x))] --> B", // cylinder
      "flowchart TD\n  A[/proc (x)/] --> B", // parallelogram
      "flowchart TD\n  A[/proc (x)\\] --> B", // trapezoid
    ]) {
      expect(await parses(src)).toBe(false); // raw fails
      // The guarded repair must leave these UNparseable → source fallback, never
      // a confidently-wrong rectangle.
      expect(await parses(repairMermaidSource(src))).toBe(false);
    }
  });

  it("still repairs plain rectangles, rhombus, subroutine, and hexagon shapes correctly", async () => {
    for (const src of [
      "flowchart TD\n  A[label (x): #1] --> B", // rectangle
      "flowchart TD\n  A{decision (y)?} --> B", // rhombus
      "flowchart TD\n  A[[call (x)]] --> B", // subroutine (shape preserved)
      "flowchart TD\n  A{{hex (x)}} --> B", // hexagon (shape preserved)
    ]) {
      expect(await parses(src)).toBe(false); // raw fails on the unquoted punctuation
      expect(await parses(repairMermaidSource(src))).toBe(true); // repaired parses
    }
  });

  it("is a no-op on an already-valid diagram (repair only fires post-failure)", async () => {
    const valid = "flowchart TD\n  A[Start] --> B{OK}\n  B -->|yes| C[Done]";
    expect(await parses(valid)).toBe(true);
    expect(repairMermaidSource(valid)).toBe(valid);
  });
});
