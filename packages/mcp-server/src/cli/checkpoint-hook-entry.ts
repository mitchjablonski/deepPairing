/**
 * deepPairing PostToolUse checkpoint hook — THE checkpoint entrypoint (#342).
 *
 * esbuild bundles this file into the text `ensureCheckpointHook` writes to
 * `.deeppairing/hooks/checkpoint.mjs` (via
 * `scripts/generate-hook-scripts.mjs` → `hook-scripts.generated.ts`). Before
 * #342 that script was a template literal in setup-tasks.ts carrying its own
 * copy of the hooks-state lock, its own error formatter, and a hand-mirrored
 * `deriveSessionId`.
 *
 * There is deliberately no plugin-bundled checkpoint lane: the plugin's
 * hooks/hooks.json declares Stop and PreToolUse only, and adding a third is a
 * policy change #342 keeps out of scope.
 */
import { runCheckpointHook } from "../hooks/checkpoint-hook.js";

let stdin = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (c) => {
  stdin += c;
});
process.stdin.on("end", () => {
  runCheckpointHook(stdin);
});
