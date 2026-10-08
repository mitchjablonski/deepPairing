/**
 * #471 — `node <plugin>/server/demo.mjs`: the no-build demo, shipped in the
 * plugin bundle. Runs the bundled daemon (daemon.js, beside this file) in an
 * isolated sandbox — see isolated-demo.ts for exactly what is isolated.
 * Prerequisite: Node 20.11+. No clone build, no pnpm, no Claude Code needed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runIsolatedDemo } from "./isolated-demo.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// Bundled layout: claude-plugin/server/{demo.mjs,daemon.js}. Source/dist
// layout (tsx src/cli/demo-entry.ts, dist/cli/demo-entry.js): ../daemon/index.
const daemonScript = [path.join(here, "daemon.js"), path.join(here, "../daemon/index.js")].find((p) => fs.existsSync(p));

if (!daemonScript) {
  process.stderr.write(`deepPairing demo: could not find the daemon next to ${here} (expected daemon.js). Re-install the plugin.\n`);
  process.exit(1);
} else {
  const code = await runIsolatedDemo({ daemonScript });
  process.exit(code);
}
