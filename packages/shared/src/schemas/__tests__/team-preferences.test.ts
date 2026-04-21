import { describe, it, expect } from "vitest";
import {
  TeamPreferenceSchema,
  TeamPreferencesFileSchema,
  parseTeamPreferencesFile,
} from "../../index.js";

describe("TeamPreferenceSchema", () => {
  it("accepts a minimal preference", () => {
    const parsed = TeamPreferenceSchema.parse({
      id: "use-argon2id",
      kind: "require",
      concept: "argon2id for password hashing",
      rationale: "bcrypt is brute-forceable with modern GPUs; argon2id is our standard",
    });
    expect(parsed.kind).toBe("require");
    expect(parsed.scope).toBeUndefined();
    expect(parsed.addedBy).toBeUndefined();
  });

  it("accepts a scoped preference with attribution", () => {
    const parsed = TeamPreferenceSchema.parse({
      id: "repo-layer-api",
      kind: "prefer",
      concept: "repository pattern",
      rationale: "keeps SQL out of route handlers",
      scope: { paths: ["packages/api/**"] },
      addedBy: "alex",
      addedAt: "2026-02-01T10:00:00.000Z",
    });
    expect(parsed.scope?.paths).toEqual(["packages/api/**"]);
    expect(parsed.addedBy).toBe("alex");
  });

  it("rejects empty concept / rationale (low-signal rows are worse than no row)", () => {
    expect(() => TeamPreferenceSchema.parse({
      id: "x", kind: "prefer", concept: "", rationale: "reason",
    })).toThrow();
    expect(() => TeamPreferenceSchema.parse({
      id: "x", kind: "prefer", concept: "something", rationale: "",
    })).toThrow();
  });

  it("rejects an unknown kind value", () => {
    expect(() => TeamPreferenceSchema.parse({
      id: "x", kind: "maybe", concept: "x", rationale: "y",
    })).toThrow();
  });

  it("rejects non-ISO addedAt (loader expects ISO 8601)", () => {
    expect(() => TeamPreferenceSchema.parse({
      id: "x", kind: "prefer", concept: "x", rationale: "y", addedAt: "yesterday",
    })).toThrow();
  });
});

describe("TeamPreferencesFileSchema", () => {
  it("parses a file with multiple preferences", () => {
    const parsed = TeamPreferencesFileSchema.parse({
      version: 1,
      preferences: [
        { id: "a", kind: "require", concept: "x", rationale: "y" },
        { id: "b", kind: "avoid", concept: "globals", rationale: "shared mutable state" },
      ],
    });
    expect(parsed.preferences).toHaveLength(2);
  });

  it("rejects an unknown major version", () => {
    expect(() => TeamPreferencesFileSchema.parse({
      version: 2, preferences: [],
    })).toThrow();
  });
});

describe("parseTeamPreferencesFile", () => {
  it("returns null for a malformed file instead of throwing", () => {
    expect(parseTeamPreferencesFile({ preferences: "nope" })).toBeNull();
    expect(parseTeamPreferencesFile(null)).toBeNull();
    expect(parseTeamPreferencesFile("string")).toBeNull();
  });

  it("returns the parsed object for a well-formed file", () => {
    const parsed = parseTeamPreferencesFile({
      version: 1,
      preferences: [{ id: "a", kind: "prefer", concept: "x", rationale: "y" }],
    });
    expect(parsed?.preferences[0].kind).toBe("prefer");
  });
});
