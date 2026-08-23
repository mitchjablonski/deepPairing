import { describe, it, expect } from "vitest";
import {
  EvidenceSchema,
  EvidenceInputSchema,
  EvidenceLocatorSchema,
  ResearchContentSchema,
  PlanVisualSchema,
} from "../../index.js";
import { coerceResearchContent, coercePlanContent } from "../coerce-content.js";

/**
 * U2 (round-15 generalization) — the Evidence relaxation + the doc_map visual
 * kind, at the schema/coerce layer. Two obligations:
 *
 *   1. BACK-COMPAT (the hard gate): every existing CODE evidence
 *      validates + coerces BYTE-IDENTICAL — a relaxed constraint must never
 *      change a valid code finding.
 *   2. NEW: a doc-anchored evidence (a `locator`, no line grain) validates and
 *      round-trips through coerce with the locator INTACT (a dropped field = the
 *      flagship comment-on-the-passage silently gone), and a doc_map visual
 *      validates + coerces.
 */

// A canonical, fully-populated CODE evidence — the shape that shipped before U2.
const CODE_EVIDENCE = {
  filePath: "/src/routes/auth.ts",
  lineStart: 20,
  lineEnd: 24,
  snippet: "const hash = bcrypt.hash(pw, 4);",
  context: "function login(...) { ... }",
  language: "ts",
  explanation: "Weak cost factor.",
  relatedPaths: ["/src/auth/hash.ts"],
} as const;

describe("U2 — Evidence relaxation (back-compat is the gate)", () => {
  it("a full CODE evidence still validates, BYTE-IDENTICAL (parsed === input)", () => {
    const parsed = EvidenceSchema.parse(CODE_EVIDENCE);
    expect(parsed).toEqual(CODE_EVIDENCE);
  });

  it("line grain is still constrained to a POSITIVE INT when present", () => {
    expect(EvidenceSchema.safeParse({ ...CODE_EVIDENCE, lineStart: 0 }).success).toBe(false);
    expect(EvidenceSchema.safeParse({ ...CODE_EVIDENCE, lineStart: -3 }).success).toBe(false);
    expect(EvidenceSchema.safeParse({ ...CODE_EVIDENCE, lineStart: 1.5 }).success).toBe(false);
  });

  it("a DOC passage validates with a locator and NO file:line", () => {
    const doc = {
      snippet: "the burst cap is undefined",
      explanation: "The clause leaves the ceiling open.",
      locator: { kind: "heading" as const, value: "§5 ¶3" },
    };
    const parsed = EvidenceSchema.parse(doc);
    expect(parsed.filePath).toBeUndefined();
    expect(parsed.lineStart).toBeUndefined();
    expect(parsed.locator).toEqual({ kind: "heading", value: "§5 ¶3" });
    // it is a legal EvidenceInput (the union the finding evidence array accepts).
    expect(EvidenceInputSchema.safeParse(doc).success).toBe(true);
  });

  it("every locator kind + optional extras validate", () => {
    expect(EvidenceLocatorSchema.safeParse({ kind: "quote", value: "…" }).success).toBe(true);
    expect(EvidenceLocatorSchema.safeParse({ kind: "charRange", value: "10-42", charStart: 10, charEnd: 42 }).success).toBe(true);
    expect(EvidenceLocatorSchema.safeParse({ kind: "url", value: "the terms", href: "https://x/terms#5" }).success).toBe(true);
  });

  it("a MALFORMED locator is rejected (no silent drop): bad kind, empty value", () => {
    expect(EvidenceLocatorSchema.safeParse({ kind: "paragraph", value: "x" }).success).toBe(false);
    expect(EvidenceLocatorSchema.safeParse({ kind: "quote", value: "" }).success).toBe(false);
  });
});

describe("U2 — coerce preserves the locator + code evidence (round-trip)", () => {
  it("a code finding coerces with its evidence UNCHANGED (never-drop-data)", () => {
    const raw = {
      summary: "audit",
      findings: [{ category: "security", detail: "weak hash", significance: "high", evidence: [CODE_EVIDENCE] }],
    };
    const out = coerceResearchContent(raw);
    expect(out.findings[0]!.evidence).toEqual([CODE_EVIDENCE]);
  });

  it("a doc-anchored finding coerces with the locator INTACT (dropped = feature gone)", () => {
    const docEv = {
      snippet: "the burst cap is undefined",
      explanation: "open ceiling",
      locator: { kind: "quote", value: "the burst cap is undefined", href: undefined },
    };
    const out = coerceResearchContent({
      summary: "contract read",
      findings: [{ category: "risk", detail: "undefined cap", significance: "high", evidence: [docEv] }],
    });
    const ev = out.findings[0]!.evidence as Array<Record<string, unknown>>;
    expect(ev[0]!.locator).toMatchObject({ kind: "quote", value: "the burst cap is undefined" });
  });

  it("the whole thing round-trips through the strict ResearchContentSchema too", () => {
    const doc = {
      summary: "contract read",
      findings: [
        {
          category: "risk",
          detail: "undefined cap",
          significance: "high" as const,
          evidence: [{ snippet: "cap undefined", explanation: "open", locator: { kind: "heading" as const, value: "§5" } }],
        },
      ],
    };
    expect(ResearchContentSchema.safeParse(doc).success).toBe(true);
  });
});

describe("U2 — doc_map visual kind", () => {
  it("PlanVisualSchema accepts a doc_map with sections + risk chips", () => {
    const v = {
      id: "dm",
      kind: "doc_map" as const,
      title: "The contract",
      sections: [
        { label: "§5 — Burst limits", risk: "high" as const, note: "undefined burst cap" },
        { label: "§2 — Definitions" },
      ],
    };
    expect(PlanVisualSchema.safeParse(v).success).toBe(true);
  });

  it("coerceVisual keeps doc_map + sections, drops empty-label rows and bad risk", () => {
    const p = coercePlanContent({
      visuals: [
        {
          id: "dm",
          kind: "doc_map",
          sections: [
            { label: "§5", risk: "high", note: "cap" },
            { label: "", risk: "high" }, // dropped (empty label)
            { label: "§9", risk: "bogus" }, // kept, risk dropped
            "junk", // dropped (non-object)
          ],
        },
      ],
    });
    expect(p.visuals![0]!.kind).toBe("doc_map");
    expect(p.visuals![0]!.sections).toEqual([{ label: "§5", risk: "high", note: "cap" }, { label: "§9" }]);
  });

  it("a doc_map with no id but content gets a CONTENT-stable id (not positional)", () => {
    const only = coercePlanContent({ visuals: [{ kind: "doc_map", sections: [{ label: "§5" }] }] }).visuals![0]!;
    expect(only.id).not.toBe("visual_0");
    // same content → same id regardless of position (reorder stability).
    const reordered = coercePlanContent({
      visuals: [{ kind: "diagram", source: "graph TD; A-->B" }, { kind: "doc_map", sections: [{ label: "§5" }] }],
    }).visuals!;
    expect(reordered.find((v) => v.kind === "doc_map")!.id).toBe(only.id);
  });
});
