/**
 * Single source of truth for the deepPairing server version.
 *
 * BOTH the MCP `serverInfo` (mcp/server.ts) and the check_feedback payload
 * (mcp/tools/check-feedback.ts) read this constant so they can never drift —
 * an agent that reads `serverVersion` off check_feedback is reading the exact
 * version the MCP handshake advertised. The install-health ping
 * (daemon/index.ts) reads it too, so all three report one number.
 *
 * Keep this in lockstep with packages/mcp-server/package.json "version" on
 * every release bump. (A literal, not a package.json import, so the bundled
 * plugin build has no runtime JSON-resolution dependency.)
 */
export const SERVER_VERSION = "0.1.4";
