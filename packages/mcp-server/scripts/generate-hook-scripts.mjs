#!/usr/bin/env node
/**
 * #342 — generate the init-lane standalone hook scripts from tested source.
 *
 * `deeppairing init` writes `.deeppairing/hooks/{stop,checkpoint}.mjs` into an
 * arbitrary user project. Those files run under plain `node` with no
 * project-local node_modules and no path back into a deepPairing checkout, so
 * they must be fully self-contained — which is why they used to be
 * hand-written template literals in setup-tasks.ts.
 *
 * They are now esbuild output of `src/cli/{stop,checkpoint}-hook-entry.ts`,
 * embedded as string constants in `src/cli/hook-scripts.generated.ts`.
 *
 * Why a committed string rather than a file read at install time:
 * `ensureStopHook` runs from three layouts — `tsx src/standalone.ts` in a dev
 * checkout, `dist/cli/init.js` from npm, and the single-file `daemon.js` bundle
 * in a marketplace install. A string constant is present in all three by
 * construction; a sibling-file lookup has to degrade when it isn't (see
 * `resolvePreflightCoreUrl`, which returns `{url, exists}` for exactly that
 * reason).
 *
 * Bundle success IS the containment proof: esbuild fails at build time on any
 * unresolvable specifier, so a workspace-only import cannot slip into a script
 * that has to run without one. That is also what makes #333's bug class
 * unwritable — an identifier undefined in the emitted file is now a build
 * error, not a ReferenceError inside the hook's own error handler.
 *
 *   pnpm --filter @deeppairing/mcp-server gen:hooks
 *
 * The output is COMMITTED and byte-reproducible.
 * `src/hooks/__tests__/hook-scripts-drift.test.ts` regenerates into a tmpdir
 * and byte-compares, so a source edit without a regeneration fails `pnpm test`.
 */
import { buildSync } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");

export const HOOK_SCRIPTS = [
  {
    constName: "STOP_HOOK_SCRIPT",
    entry: "src/cli/stop-hook-entry.ts",
    emitted: ".deeppairing/hooks/stop.mjs",
    title: "deepPairing Stop hook — installed by ensureStopHook (X7 / X9).",
  },
  {
    constName: "CHECKPOINT_HOOK_SCRIPT",
    entry: "src/cli/checkpoint-hook-entry.ts",
    emitted: ".deeppairing/hooks/checkpoint.mjs",
    title: "deepPairing checkpoint hook (V2) — installed by ensureCheckpointHook.",
  },
];

export const GENERATED_PATH = resolve(pkgRoot, "src/cli/hook-scripts.generated.ts");

/** esbuild one entry into a self-contained ESM script. Deterministic. */
function bundleHook(entry, title) {
  const result = buildSync({
    entryPoints: [resolve(pkgRoot, entry)],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node20",
    sourcemap: false,
    // No minify: a user can open .deeppairing/hooks/stop.mjs and read it, which
    // is why X9 converted these from `node -e "..."` to real files.
    legalComments: "none",
    logLevel: "warning",
  });
  const text = result.outputFiles[0].text;
  // Shebang first — these are chmod 0755 and may be run directly.
  return (
    `#!/usr/bin/env node\n` +
    `// ${title}\n` +
    `// GENERATED — do not edit. Source: packages/mcp-server/${entry}\n` +
    `// Regenerate: pnpm --filter @deeppairing/mcp-server gen:hooks\n` +
    text
  );
}

/** The full text of src/cli/hook-scripts.generated.ts. */
export function renderGeneratedModule() {
  const banner =
    `/**\n` +
    ` * GENERATED — do not edit. #342.\n` +
    ` *\n` +
    ` * esbuild output of the hook entrypoints, embedded so \`ensureStopHook\` /\n` +
    ` * \`ensureCheckpointHook\` can write a self-contained script into any project\n` +
    ` * from any install layout.\n` +
    ` *\n` +
    ` * Regenerate: pnpm --filter @deeppairing/mcp-server gen:hooks\n` +
    ` * Guarded by: src/hooks/__tests__/hook-scripts-drift.test.ts\n` +
    ` */\n\n`;
  const parts = HOOK_SCRIPTS.map(
    ({ constName, entry, emitted, title }) =>
      `/** ${emitted} — bundled from ${entry}. */\nexport const ${constName}: string = ${JSON.stringify(bundleHook(entry, title))};\n`,
  );
  return banner + parts.join("\n");
}

/** Returns true when the committed module already matches a fresh render. */
export function generatedModuleIsCurrent() {
  let committed;
  try {
    committed = readFileSync(GENERATED_PATH, "utf8");
  } catch {
    return false;
  }
  return committed === renderGeneratedModule();
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  writeFileSync(GENERATED_PATH, renderGeneratedModule());
  console.log(`[gen-hook-scripts] ✓ ${GENERATED_PATH}`);
}
