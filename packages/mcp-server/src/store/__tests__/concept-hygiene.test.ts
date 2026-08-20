import { describe, it, expect } from "vitest";
import {
  stripLeadingPathToken,
  capConceptLength,
  MAX_PUBLISHED_CONCEPT_CHARS,
} from "../concept-hygiene.js";
import { isCrossProjectAdvisoryHit } from "../../mcp/preflight-validator.js";

/**
 * Q2 review H2 — hygiene for a string that becomes a CROSS-PROJECT ledger key.
 *
 * The review executed a real publish and found a changeset-reject key of
 * "packages/api/src/auth/session-store.ts — swap Redis for an in-memory Map":
 * a source path, published verbatim, from a UI that had just promised no file
 * paths leave the project. The copy is the load-bearing fix (it now discloses
 * that a stance is the human's own wording); this is the best-effort half,
 * scoped to the one key nobody authors by hand.
 */
describe("stripLeadingPathToken", () => {
  it("strips the machine-generated path prefix from a changeset title (the executed repro)", () => {
    expect(
      stripLeadingPathToken("packages/api/src/auth/session-store.ts — swap Redis for an in-memory Map"),
    ).toBe("swap Redis for an in-memory Map");
  });

  it("handles the separators agents actually emit (em dash, en dash, colon, spaced hyphen)", () => {
    expect(stripLeadingPathToken("src/db/migrate.ts – drop the users table")).toBe("drop the users table");
    expect(stripLeadingPathToken("src/db/migrate.ts: drop the users table")).toBe("drop the users table");
    expect(stripLeadingPathToken("src/db/migrate.ts - drop the users table")).toBe("drop the users table");
    expect(stripLeadingPathToken("config.yaml — pin the image tag")).toBe("pin the image tag");
  });

  it("also strips a Windows-style path", () => {
    expect(stripLeadingPathToken("packages\\api\\auth.ts — use a Map")).toBe("use a Map");
  });

  it("LEAVES a real concept alone — a leading noun is not a path", () => {
    expect(stripLeadingPathToken("Redis: use a real cache")).toBe("Redis: use a real cache");
    expect(stripLeadingPathToken("global mutable state for config")).toBe("global mutable state for config");
    expect(stripLeadingPathToken("Deploy: Railway")).toBe("Deploy: Railway");
  });

  it("LEAVES prose that merely mentions a path (no separator ⇒ not a prefix)", () => {
    expect(stripLeadingPathToken("src/lib helpers are fine as they are")).toBe(
      "src/lib helpers are fine as they are",
    );
  });

  it("never returns empty — a title that is ONLY a path still has to identify something", () => {
    expect(stripLeadingPathToken("packages/api/src/auth/session-store.ts")).toBe(
      "packages/api/src/auth/session-store.ts",
    );
    expect(stripLeadingPathToken("src/a.ts — ")).toBe("src/a.ts — ");
    expect(stripLeadingPathToken("")).toBe("");
  });

  /**
   * The review's explicit caution was "do NOT lose ledger match fidelity".
   * This proves the opposite direction: the path-laden key could never have
   * matched another project's proposal, and the stripped one can. Stripping
   * strictly WIDENS recall.
   */
  it("PROVES stripping cannot cost recall — the path-laden key can't match, the stripped one can", () => {
    const raw = "packages/api/src/auth/session-store.ts — swap Redis for an in-memory Map";
    const stripped = stripLeadingPathToken(raw);
    const proposalInAnotherProject = [
      "let's swap Redis for an in-memory Map to keep the dev setup simple",
    ];
    expect(isCrossProjectAdvisoryHit(raw, proposalInAnotherProject, [])).toBe(false);
    expect(isCrossProjectAdvisoryHit(stripped, proposalInAnotherProject, [])).toBe(true);
  });
});

describe("capConceptLength", () => {
  it("leaves an ordinary concept untouched", () => {
    expect(capConceptLength("global mutable state for config")).toBe("global mutable state for config");
  });

  it("truncates a pathological key and marks it as cut", () => {
    const huge = "x".repeat(MAX_PUBLISHED_CONCEPT_CHARS + 200);
    const capped = capConceptLength(huge);
    expect(capped.length).toBe(MAX_PUBLISHED_CONCEPT_CHARS);
    expect(capped.endsWith("…")).toBe(true);
  });

  it("is deterministic, so every publish site buckets the same key", () => {
    const huge = "y".repeat(MAX_PUBLISHED_CONCEPT_CHARS + 1);
    expect(capConceptLength(huge)).toBe(capConceptLength(huge));
  });
});
