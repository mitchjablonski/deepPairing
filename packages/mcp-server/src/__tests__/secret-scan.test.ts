/**
 * V4 — secret-shape scan unit tests. Pins the patterns we DO catch and
 * the false-positive shapes we deliberately DON'T catch (so a future
 * "make the regex catch more" PR has to actively re-think the noise
 * trade-off, not silently expand it).
 */
import { describe, it, expect } from "vitest";
import { scanForSecrets, scanManyForSecrets } from "../secret-scan.js";

describe("V4 — secret-shape scan", () => {
  describe("patterns that should match (vendor-prefixed, deterministic shape)", () => {
    it("OpenAI / Anthropic-shape sk- key", () => {
      const m = scanForSecrets("api_key = sk-abc123XYZ789def456ghi");
      expect(m.map((x) => x.pattern)).toContain("sk-");
    });

    it("AWS AKIA access key id", () => {
      const m = scanForSecrets("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE");
      expect(m.map((x) => x.pattern)).toContain("AKIA");
    });

    it("GitHub PAT (ghp_) and OAuth token (gho_)", () => {
      const pat = scanForSecrets("token: ghp_abcdefghijklmnopqrst1234");
      expect(pat.map((x) => x.pattern)).toContain("ghp_");
      const oauth = scanForSecrets("Authorization: Bearer gho_abcdefghijklmnopqrst1234");
      expect(oauth.map((x) => x.pattern)).toContain("gho_");
    });

    it("GitLab PAT (glpat-)", () => {
      const m = scanForSecrets("PRIVATE-TOKEN: glpat-abcdefghij1234567890");
      expect(m.map((x) => x.pattern)).toContain("glpat-");
    });

    it("Google OAuth access token (ya29.)", () => {
      const m = scanForSecrets("access_token=ya29.abcdefghij1234567890");
      expect(m.map((x) => x.pattern)).toContain("ya29.");
    });

    it("PEM private key header", () => {
      const m = scanForSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----");
      expect(m.map((x) => x.pattern)).toContain("PEM");
    });
  });

  describe("patterns that should NOT match (deliberate false-positive avoidance)", () => {
    it("plain `password=foo` (too noisy — code reviews legitimately quote these)", () => {
      expect(scanForSecrets("default config: password=hunter2")).toEqual([]);
    });

    it("a finding that quotes the word 'secret' or 'token' in prose", () => {
      expect(scanForSecrets("The auth flow uses a JWT-shaped token in the cookie.")).toEqual([]);
    });

    it("a short string that happens to start with sk- in a sentence (length minimum)", () => {
      // The regex requires {16,} chars after `sk-`. `sk-abc` is a
      // legitimate variable name in some code, not a key.
      expect(scanForSecrets("renamed sk-abc to sessionKeyAbc")).toEqual([]);
    });

    it("empty / null / undefined input", () => {
      expect(scanForSecrets("")).toEqual([]);
      expect(scanForSecrets(undefined)).toEqual([]);
      expect(scanForSecrets(null)).toEqual([]);
    });
  });

  describe("scanManyForSecrets dedupes across blobs", () => {
    it("collapses multiple matches of the same pattern into one entry", () => {
      const blobs = [
        "key1: sk-abcdefghijklmnopqrstuv",
        "key2: sk-zyxwvutsrqponmlkjihgfe",
        "AWS: AKIAIOSFODNN7EXAMPLE",
      ];
      const m = scanManyForSecrets(blobs);
      const patterns = m.map((x) => x.pattern);
      expect(patterns).toEqual(["sk-", "AKIA"]);
    });

    it("returns [] when no blob contains a secret shape", () => {
      expect(scanManyForSecrets(["hello", "world", null, undefined, ""])).toEqual([]);
    });
  });
});
