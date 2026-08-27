import { describe, it, expect } from "vitest";
import { artifactHumanLabel } from "../tools/check-feedback-delivery.js";

/**
 * X4 — the human-facing artifact label. Wherever the tooling hands the agent an
 * artifact reference to echo back to its pair, it must lead with what the
 * artifact IS (type + title), NEVER the raw `art_…` id the human never sees.
 */
describe("X4 — artifactHumanLabel", () => {
  it("labels a titled artifact as '<noun> “<title>”'", () => {
    expect(artifactHumanLabel({ type: "changeset", title: "Add token caching" })).toBe(
      "changeset “Add token caching”",
    );
    expect(artifactHumanLabel({ type: "decision", title: "Cache TTL" })).toBe(
      "decision “Cache TTL”",
    );
  });

  it("maps the type enum to a human noun (research → findings, code_change → code change)", () => {
    expect(artifactHumanLabel({ type: "research", title: "Auth findings" })).toBe(
      "findings “Auth findings”",
    );
    expect(artifactHumanLabel({ type: "code_change", title: "" })).toBe("the code change");
  });

  it("falls back to the bare type noun when there is no usable title", () => {
    expect(artifactHumanLabel({ type: "plan", title: "" })).toBe("the plan");
    expect(artifactHumanLabel({ type: "plan", title: "   " })).toBe("the plan");
    expect(artifactHumanLabel({ type: "spec", title: undefined as unknown as string })).toBe(
      "the spec",
    );
  });

  it("handles a missing artifact without throwing", () => {
    expect(artifactHumanLabel(undefined)).toBe("an artifact");
    expect(artifactHumanLabel(null)).toBe("an artifact");
  });

  it("NEVER emits a bare art_ id in the human-facing string", () => {
    for (const type of [
      "research",
      "plan",
      "decision",
      "code_change",
      "reasoning",
      "spec",
      "changeset",
      "debrief",
      "explainer",
    ]) {
      const withTitle = artifactHumanLabel({ type, title: "art_9f2beef sneaky title" });
      const noTitle = artifactHumanLabel({ type, title: "" });
      // The label itself never fabricates or leads with an id token; even a
      // title containing "art_" is the human's own words, but the label shape
      // never PRODUCES an id — the id lives at the call site, in brackets.
      expect(noTitle.startsWith("art_")).toBe(false);
      expect(noTitle).not.toMatch(/^art_/);
      // A title the human wrote is echoed verbatim, but the NOUN prefix is not an id.
      expect(withTitle.split(" ")[0]).not.toMatch(/^art_/);
    }
  });
});
