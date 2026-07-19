/**
 * Single source of truth for the deepPairing server version.
 *
 * BOTH the MCP `serverInfo` (mcp/server.ts) and the check_feedback payload
 * (mcp/tools/check-feedback.ts) read this constant so they can never drift —
 * an agent that reads `serverVersion` off check_feedback is reading the exact
 * version the MCP handshake advertised. The install-health ping
 * (daemon/index.ts) reads it too, so all three report one number.
 *
 * A literal, not a package.json import, so the bundled plugin build has no
 * runtime JSON-resolution dependency. Lockstep with the two package.json
 * "version" fields and claude-plugin/.claude-plugin/plugin.json is no longer a
 * remembered ritual (it silently desynced three times when it was) — it is
 * enforced by src/__tests__/version-lockstep.test.ts, which fails a release
 * bump that updates this literal without the manifests (or vice-versa).
 */
export const SERVER_VERSION = "0.1.12";

/**
 * Parse a semver-ish version string into [major, minor, patch]. Returns null
 * when the string doesn't start with the expected `N.N.N` shape (so callers can
 * treat "unparseable" distinctly from "older/newer"). Prerelease / build
 * metadata after the patch number is ignored — SERVER_VERSION is always plain
 * `N.N.N`, and this comparison is only ever used to answer "is the RUNNING
 * daemon strictly older than THIS process's build?", where the numeric core is
 * sufficient.
 */
export function parseSemver(v: string): [number, number, number] | null {
  const m = /^\s*(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Compare two version strings. Returns <0 when a<b, 0 when equal (on the
 * numeric core), >0 when a>b, and NaN when EITHER string is unparseable — the
 * caller must handle NaN explicitly (never treat an unknown version as "equal"
 * or "older" implicitly). Stale-daemon detection (daemon/lifecycle.ts) leans on
 * the NaN case to fail loud rather than silently adopt.
 */
export function compareServerVersions(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return NaN;
  const [aMaj, aMin, aPatch] = pa;
  const [bMaj, bMin, bPatch] = pb;
  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  return aPatch - bPatch;
}
