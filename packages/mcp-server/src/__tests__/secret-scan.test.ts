/**
 * V4 — secret-shape scan unit tests. Pins the patterns we DO catch and
 * the false-positive shapes we deliberately DON'T catch (so a future
 * "make the regex catch more" PR has to actively re-think the noise
 * trade-off, not silently expand it).
 *
 * #160 — every pattern added by the conservative expansion ships as a
 * PAIR: a should-match fixture (obviously fake) and a should-NOT-match
 * near-miss pinning the exact noise case the V4 trade-off worried
 * about. A pattern that can't get a clean near-miss doesn't ship —
 * a false-positive banner teaches users to ignore the real one.
 *
 * All fixture "secrets" are documented example values / EXAMPLE-padded
 * fakes — never real credentials. Assertions are on labels, patterns,
 * and locations ONLY; no assertion message ever echoes a matched value.
 */
import { describe, it, expect } from "vitest";
import { scanForSecrets, scanManyForSecrets, scanContentForSecrets } from "../secret-scan.js";

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

  // #160 — the conservative expansion. One match + one near-miss per pattern;
  // the near-miss is the noise case that would train users to ignore the banner.
  describe("#160 — expanded pattern set (match + near-miss pairs)", () => {
    it("Stripe live secret key (sk_live_) — matches a key-length fake", () => {
      const m = scanForSecrets("STRIPE_KEY=sk_live_EXAMPLEabcdef1234567890");
      expect(m.map((x) => x.label)).toContain("Stripe live secret key");
    });

    it("Stripe near-miss — a docs placeholder / bare prefix never matches", () => {
      // Underscored placeholder words break the base62 run; prose prefix has
      // no payload at all. Both are what Stripe's own docs print.
      expect(scanForSecrets("set STRIPE_KEY to sk_live_YOUR_KEY_HERE")).toEqual([]);
      expect(scanForSecrets("live keys start with the sk_live_ prefix")).toEqual([]);
    });

    it("Slack token (xoxb-/xoxp-/xoxa-/xoxr-/xoxs-) — matches a token-length fake", () => {
      const m = scanForSecrets("SLACK_BOT_TOKEN=xoxb-0000000000-EXAMPLE0000");
      expect(m.map((x) => x.label)).toContain("Slack token");
      expect(scanForSecrets("xoxp-1111111111-fakeFAKEfake").map((x) => x.pattern)).toContain("xox");
    });

    it("Slack near-miss — prose naming the prefix or a short fragment never matches", () => {
      expect(scanForSecrets("bot tokens start with xoxb- in Slack")).toEqual([]);
      expect(scanForSecrets("grep for xoxb-test in the fixtures")).toEqual([]);
    });

    it("npm access token (npm_) — matches a token-length fake", () => {
      const m = scanForSecrets("//registry.npmjs.org/:_authToken=npm_EXAMPLEabcdefghij1234567890FAKE00");
      expect(m.map((x) => x.label)).toContain("npm access token");
    });

    it("npm near-miss — npm_config_* / npm_package_* lifecycle env vars never match", () => {
      // These appear in every npm lifecycle script's environment; the
      // underscores that make them readable are exactly what real npm
      // tokens (pure base62) never contain.
      expect(scanForSecrets("npm_config_registry=https://registry.npmjs.org")).toEqual([]);
      expect(scanForSecrets("echo $npm_package_name and $npm_package_json_something_long")).toEqual([]);
    });

    it("GitHub fine-grained PAT (github_pat_) — matches the 22+_+long shape", () => {
      const m = scanForSecrets(
        "GH_TOKEN=github_pat_11AAAAAAA0EXAMPLEFAKE0_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789EXAMPLE",
      );
      expect(m.map((x) => x.label)).toContain("GitHub fine-grained personal access token");
    });

    it("GitHub fine-grained near-miss — a prose placeholder never matches", () => {
      // The real shape is github_pat_ + EXACTLY 22 base62 + "_" + 59 base62;
      // readable placeholders break the 22-char first segment.
      expect(scanForSecrets("export GH_TOKEN=github_pat_your_token_here")).toEqual([]);
      expect(scanForSecrets("fine-grained tokens use the github_pat_ prefix")).toEqual([]);
    });

    it('GCP service-account key — matches the "private_key" field with a PEM value', () => {
      const m = scanForSecrets('{ "type": "service_account", "private_key": "-----BEGIN PRIVATE KEY-----\\nFAKE" }');
      expect(m.map((x) => x.label)).toContain("GCP service-account key (JSON)");
    });

    it("GCP near-miss — private_key_id / a redacted private_key never matches", () => {
      // private_key_id is the sibling NON-secret hex field in the same JSON;
      // a redacted value has no PEM opener.
      expect(scanForSecrets('{ "private_key_id": "abc123def456" }')).toEqual([]);
      expect(scanForSecrets('{ "private_key": "[REDACTED]" }')).toEqual([]);
    });

    it("JWT — matches only when header AND payload carry the eyJ marker", () => {
      const m = scanForSecrets(
        "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.FAKESIGNATUREFAKESIGNATURE",
      );
      expect(m.map((x) => x.label)).toContain("JWT (signed)");
    });

    it("JWT near-miss — the collision cases the eyJ+eyJ requirement exists for", () => {
      // Payload segment without the eyJ JSON-object marker (any dotted
      // base64ish triple, e.g. a minified-module path or a version string).
      expect(scanForSecrets("eyJhbGciOiJIUzI1NiJ9.notAJsonObjectPayload.FAKESIGNATUREFAKESIGNATURE")).toEqual([]);
      // Unsigned / two-segment example (jwt.io prints these in docs).
      expect(scanForSecrets("eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjM0In0.")).toEqual([]);
      // Dotted prose that merely contains eyJ once.
      expect(scanForSecrets("the header decodes from eyJhbGciOiJIUzI1NiJ9 alone")).toEqual([]);
    });
  });

  // #160 — match locations. Line is derived from the match INDEX only; the
  // matched value / surrounding text is never captured.
  describe("#160 — location capture (line within blob, field within content)", () => {
    it("records the 1-based line of the first match in a multi-line blob", () => {
      const text = "line one\nline two\nline three\nAWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nline five";
      expect(scanForSecrets(text)).toEqual([
        { pattern: "AKIA", label: "AWS access key id", line: 4 },
      ]);
    });

    it("records the field path + line for structured content", () => {
      const content = {
        steps: [
          { description: "clean", reasoning: "clean" },
          { description: "clean", reasoning: "clean" },
          { description: "seed env", preview: "# env\nA=1\nB=2\nAWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE" },
        ],
      };
      expect(scanContentForSecrets(content)).toEqual([
        { pattern: "AKIA", label: "AWS access key id", field: "steps[2].preview", line: 4 },
      ]);
    });

    it("first field to hit a pattern wins (per-pattern dedupe keeps its location)", () => {
      const content = {
        before: "key: AKIAIOSFODNN7EXAMPLE",
        after: "\n\nkey: AKIAIOSFODNN7EXAMPLE",
      };
      expect(scanContentForSecrets(content)).toEqual([
        { pattern: "AKIA", label: "AWS access key id", field: "before", line: 1 },
      ]);
    });

    it("a bare-string scan carries line but no field", () => {
      const [m] = scanContentForSecrets("x\nAKIAIOSFODNN7EXAMPLE");
      expect(m).toEqual({ pattern: "AKIA", label: "AWS access key id", line: 2 });
      expect(m && "field" in m).toBe(false);
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

  // #158 — generic string-leaf walk used by revise_artifact's supersede
  // re-scan; #160 promoted it to the scan for all present_* tools (it knows
  // each leaf's field path, which the flat blob lists never could).
  describe("scanContentForSecrets walks nested content", () => {
    it("finds a secret in a nested evidence snippet", () => {
      const content = {
        summary: "clean",
        findings: [
          { title: "t", evidence: [{ snippet: "key: AKIAIOSFODNN7EXAMPLE" }] },
        ],
      };
      expect(scanContentForSecrets(content)).toEqual([
        { pattern: "AKIA", label: "AWS access key id", field: "findings[0].evidence[0].snippet", line: 1 },
      ]);
    });

    it("returns [] for clean content and tolerates nulls / non-objects", () => {
      expect(scanContentForSecrets({ a: 1, b: null, c: ["x", { d: "y" }] })).toEqual([]);
      expect(scanContentForSecrets(null)).toEqual([]);
      expect(scanContentForSecrets("AKIAIOSFODNN7EXAMPLE")).toEqual([
        { pattern: "AKIA", label: "AWS access key id", line: 1 },
      ]);
    });

    it("stops at the depth bound instead of recursing forever", () => {
      // Self-referential object: without the bound this would blow the stack.
      const cyclic: Record<string, unknown> = { note: "AKIAIOSFODNN7EXAMPLE" };
      cyclic.self = cyclic;
      expect(scanContentForSecrets(cyclic)).toEqual([
        { pattern: "AKIA", label: "AWS access key id", field: "note", line: 1 },
      ]);
    });
  });
});
