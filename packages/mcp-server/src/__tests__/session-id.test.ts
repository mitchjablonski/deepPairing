/**
 * sessionId derivation.
 *
 * U0.6 — the base id must be deterministic per projectRoot. Field bug: a user
 * saw THREE sessions for one project because standalone.ts minted
 * `session_${Date.now()}_${random}` on every spawn, so a Claude restart created
 * a fresh session invisible to the previous one. The fix derives the id from
 * sha256(projectRoot) so all wrappers for a project collapse onto one store.
 *
 * PER-CLAUDE-SESSION SPLIT — the wrapper now ALSO appends a sanitized
 * CLAUDE_CODE_SESSION_ID when Claude Code provides it, so each concurrent
 * conversation gets its own artifact bucket. The env-absent path must stay
 * byte-identical to the U0.6 base, and a hostile env value must never escape
 * `sessions/`.
 *
 * The derivation now lives in a real, importable function (`deriveSessionId`),
 * so these tests exercise the SAME code the wrapper runs — no inline mirror to
 * drift out of sync.
 */
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import path from "node:path";
import { deriveSessionId } from "../session-id.js";

/** The EXACT pre-split expression, recomputed independently, as the byte-for-byte oracle. */
function legacySessionId(projectRoot: string): string {
  const projectName = path.basename(projectRoot);
  const safeProjectName = projectName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32);
  const projectHash = crypto.createHash("sha256").update(projectRoot).digest("hex").slice(0, 8);
  return `session_${safeProjectName}_${projectHash}`;
}

const PROJECT = "/home/dev/projects/deepPairing";

describe("sessionId derivation (U0.6 base — env absent)", () => {
  const id = (root: string) => deriveSessionId(root).sessionId;

  it("produces the same id for the same projectRoot across calls", () => {
    expect(id(PROJECT)).toBe(id(PROJECT));
  });

  it("produces different ids for different projectRoots", () => {
    expect(id("/home/user/projects/a")).not.toBe(id("/home/user/projects/b"));
  });

  it("encodes the project basename so `ls .deeppairing/sessions` is human-readable", () => {
    const got = id("/home/user/projects/imageMovement");
    expect(got).toContain("imageMovement");
    expect(got.startsWith("session_imageMovement_")).toBe(true);
  });

  it("sanitizes basenames that would break a directory name", () => {
    const got = id("/tmp/my project!/has spaces & symbols");
    expect(got).toMatch(/^session_[a-zA-Z0-9_-]+_[0-9a-f]{8}$/);
    expect(got).not.toContain(" ");
    expect(got).not.toContain("&");
    expect(got).not.toContain("!");
  });

  it("caps a very long basename so the id stays a sane length", () => {
    const got = id(`/tmp/${"a".repeat(200)}`);
    expect(got.length).toBeLessThanOrEqual("session_".length + 32 + 1 + 8);
  });

  it("hash is exactly 8 hex chars", () => {
    const got = id("/home/user/projects/imageMovement");
    expect(got.match(/_([0-9a-f]+)$/)?.[1]).toHaveLength(8);
  });
});

describe("deriveSessionId — fallback byte-identity", () => {
  it("env ABSENT → exactly the pre-split per-project id (byte-identical)", () => {
    const r = deriveSessionId(PROJECT, undefined);
    expect(r.mode).toBe("fallback");
    expect(r.sessionId).toBe(legacySessionId(PROJECT));
    expect(r.claudeSessionId).toBeUndefined();
  });

  it("env EMPTY string → fallback, byte-identical", () => {
    const r = deriveSessionId(PROJECT, "");
    expect(r.mode).toBe("fallback");
    expect(r.sessionId).toBe(legacySessionId(PROJECT));
  });

  it("matches a hardcoded literal so a future refactor of the format is caught", () => {
    const expectedHash = crypto.createHash("sha256").update(PROJECT).digest("hex").slice(0, 8);
    expect(deriveSessionId(PROJECT).sessionId).toBe(`session_deepPairing_${expectedHash}`);
  });
});

describe("deriveSessionId — split mode", () => {
  it("env PRESENT → per-session id = base + sanitized sid, split mode", () => {
    const sid = "0f9c1a2b-3d4e-5f60-8a1b-2c3d4e5f6071";
    const r = deriveSessionId(PROJECT, sid);
    expect(r.mode).toBe("split");
    expect(r.claudeSessionId).toBe(sid); // UUID survives sanitization untouched
    expect(r.sessionId).toBe(`${legacySessionId(PROJECT)}_${sid}`);
  });

  it("distinct-per-session: two sids under one project → two different buckets", () => {
    const a = deriveSessionId(PROJECT, "11111111-1111-1111-1111-111111111111");
    const b = deriveSessionId(PROJECT, "22222222-2222-2222-2222-222222222222");
    expect(a.sessionId).not.toBe(b.sessionId);
    // Both share the same per-project base (moat stays projectRoot-keyed).
    expect(a.sessionId.startsWith(legacySessionId(PROJECT))).toBe(true);
    expect(b.sessionId.startsWith(legacySessionId(PROJECT))).toBe(true);
  });

  it("resume reattach: same sid → same sessionId (no orphan bucket)", () => {
    const sid = "abcabcab-1234-4321-9999-000000000000";
    expect(deriveSessionId(PROJECT, sid).sessionId).toBe(deriveSessionId(PROJECT, sid).sessionId);
  });
});

describe("deriveSessionId — path-safety against hostile env values", () => {
  const sessionsSegment = (id: string) => path.join("/root/.deeppairing/sessions", id);

  it.each([
    ["../../etc", "traversal via dots+slashes"],
    ["a/b", "embedded slash"],
    ["..\\..\\win", "backslash traversal"],
    ["  ../.. ", "padded traversal"],
    ["x".repeat(5000), "huge value"],
  ])("hostile %s (%s): never escapes sessions/, never crashes", (raw) => {
    const r = deriveSessionId(PROJECT, raw);
    expect(r.sessionId).not.toMatch(/[/\\]/);
    expect(r.sessionId.includes("..")).toBe(false);
    // The store's own guard (file-store.ts:152) also rejects / \ .. — assert the
    // derived id resolves to a path INSIDE sessions/ so a bucket can be created.
    const resolved = path.resolve(sessionsSegment(r.sessionId));
    expect(resolved.startsWith(path.resolve("/root/.deeppairing/sessions/"))).toBe(true);
  });

  it("value that sanitizes to empty (`..`, `///`) → byte-identical fallback", () => {
    expect(deriveSessionId(PROJECT, "..").sessionId).toBe(legacySessionId(PROJECT));
    expect(deriveSessionId(PROJECT, "..").mode).toBe("fallback");
    expect(deriveSessionId(PROJECT, "///").sessionId).toBe(legacySessionId(PROJECT));
  });

  it("huge value is capped to 64 sanitized chars", () => {
    const r = deriveSessionId(PROJECT, "a".repeat(5000));
    expect(r.mode).toBe("split");
    expect(r.claudeSessionId).toHaveLength(64);
  });

  it("mixed hostile+valid keeps only the safe chars", () => {
    const r = deriveSessionId(PROJECT, "../ab-CD/../12");
    expect(r.claudeSessionId).toBe("ab-CD12"); // dots + slashes stripped, hex + hyphen kept
    expect(r.sessionId).toBe(`${legacySessionId(PROJECT)}_ab-CD12`);
  });
});
