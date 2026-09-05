/**
 * deepPairing Stop hook — THE Stop entrypoint (I6, #342).
 *
 * esbuild bundles this file into both hook lanes, from the same source:
 *   - `claude-plugin/server/stop.mjs`, which the plugin's hooks/hooks.json
 *     invokes as `node "${CLAUDE_PLUGIN_ROOT}/server/stop.mjs"` — so a
 *     marketplace / `--plugin-dir` install gets the enforcement layer with no
 *     init and no session restart;
 *   - the text `ensureStopHook` writes to `.deeppairing/hooks/stop.mjs` (via
 *     `scripts/generate-hook-scripts.mjs` → `hook-scripts.generated.ts`).
 *
 * Before #342 the second lane was a hand-maintained template literal in
 * setup-tasks.ts and the two could — and did — drift. They are now one file.
 *
 * Self-contained by construction: `runStopHook` and everything it reaches use
 * Node builtins only, so esbuild emits a zero-dependency script that runs under
 * plain `node` with no project-local node_modules.
 */
import { runStopHook } from "../hooks/stop-hook.js";

runStopHook();
