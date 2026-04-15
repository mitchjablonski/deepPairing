/**
 * Post-build step: copies the companion web UI build into the extension bundle.
 * Run after `tsc` and after the web UI is built.
 */
import { cpSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDist = join(__dirname, "..", "mcp-server", "dist", "web");
const extDist = join(__dirname, "web-dist");

if (existsSync(webDist)) {
  mkdirSync(extDist, { recursive: true });
  cpSync(webDist, extDist, { recursive: true });
  console.log("Copied web UI build to extension bundle");
} else {
  console.warn("Web UI build not found at", webDist);
  console.warn("Run: cd packages/mcp-server/web && npx vite build");
}
