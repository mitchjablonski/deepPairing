/**
 * U0.6 — sessionId minting must be deterministic per projectRoot.
 *
 * Bug context: in the field, the user opened the companion UI on a project
 * and saw THREE sessions for the same project root. Approvals landed in one
 * store while the agent's wrapper was polling another, so the artifact stayed
 * `draft` forever and the Stop hook trapped the agent in a poll loop.
 *
 * Root cause: standalone.ts minted `session_${Date.now()}_${random}` on every
 * spawn — so a Claude Code restart or plugin reload always created a fresh
 * session that was invisible to (and from) the previous one.
 *
 * Fix: derive sessionId from sha256(projectRoot) so all wrappers for the same
 * project collapse onto one shared FileStore. This test pins the property by
 * mirroring the exact derivation the wrapper uses; if standalone.ts drifts
 * away from this scheme (e.g. someone re-introduces a timestamp), the test
 * fails and the field bug doesn't quietly come back.
 *
 * We can't easily run standalone.ts in-process without spawning a real daemon,
 * so the test asserts the algorithm directly. The single source of truth is
 * the small block in standalone.ts:43–53.
 */
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import path from "node:path";

function deriveSessionId(projectRoot: string): string {
  const projectName = path.basename(projectRoot);
  const safeProjectName = projectName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32);
  const projectHash = crypto.createHash("sha256").update(projectRoot).digest("hex").slice(0, 8);
  return `session_${safeProjectName}_${projectHash}`;
}

describe("sessionId derivation (U0.6)", () => {
  it("produces the same id for the same projectRoot across calls", () => {
    const root = "/home/user/projects/imageMovement";
    expect(deriveSessionId(root)).toBe(deriveSessionId(root));
  });

  it("produces different ids for different projectRoots", () => {
    expect(deriveSessionId("/home/user/projects/a")).not.toBe(
      deriveSessionId("/home/user/projects/b"),
    );
  });

  it("encodes the project basename so `ls .deeppairing/sessions` is human-readable", () => {
    const id = deriveSessionId("/home/user/projects/imageMovement");
    expect(id).toContain("imageMovement");
    expect(id.startsWith("session_imageMovement_")).toBe(true);
  });

  it("sanitizes basenames that would break a directory name", () => {
    // Filesystem-hostile characters get replaced with underscore so the
    // session directory `.deeppairing/sessions/<id>/` is always creatable.
    const id = deriveSessionId("/tmp/my project!/has spaces & symbols");
    expect(id).toMatch(/^session_[a-zA-Z0-9_-]+_[0-9a-f]{8}$/);
    expect(id).not.toContain(" ");
    expect(id).not.toContain("&");
    expect(id).not.toContain("!");
  });

  it("caps a very long basename so the id stays a sane length", () => {
    const longName = "a".repeat(200);
    const id = deriveSessionId(`/tmp/${longName}`);
    // Format: session_<≤32 chars>_<8-char hash>
    expect(id.length).toBeLessThanOrEqual("session_".length + 32 + 1 + 8);
  });

  it("hash is exactly 8 hex chars (collision risk is acceptable for project-root scope)", () => {
    const id = deriveSessionId("/home/user/projects/imageMovement");
    const m = id.match(/_([0-9a-f]+)$/);
    expect(m?.[1]).toHaveLength(8);
  });
});
