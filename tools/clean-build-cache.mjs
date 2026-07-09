#!/usr/bin/env node
/**
 * Wipe every build/cache artifact that can make a WARM local build diverge
 * from a COLD CI build. Run by the root `build:clean` script before the full
 * turbo build so the committed `claude-plugin/server/` bundle is byte-identical
 * to what CI's cache-less `pnpm build` produces.
 *
 * Why this exists (release friction, task #137):
 *   - v0.1.2: turbo served a CACHE-HIT `dist/` and skipped the whole `build`
 *     script — so `bundle-plugin.mjs` never re-ran and `claude-plugin/server/`
 *     kept the OLD version stamp. The staleness gate failed.
 *   - v0.1.4: a warm vite dep-optimization cache (`node_modules/.vite`)
 *     produced a different module graph → different content-hashed
 *     `web/assets/*` filenames than a fresh CI build. The gate failed until
 *     the caches were wiped and a full root build re-run.
 *
 * Both classes vanish once the turbo + vite + tsc output caches are gone, so
 * we remove them here rather than trust incremental invalidation. The root
 * `build:clean` script then runs `turbo build --force`: `--force` re-executes
 * every task even on a cache hit, which is what guarantees `bundle-plugin.mjs`
 * runs — `claude-plugin/server/` is NOT a turbo `outputs` entry, so a cache-hit
 * `build` would restore `dist/` and skip the bundle step (the v0.1.2 trap).
 * Wiping `node_modules/.vite` is still required on top of `--force`: vite reads
 * that dep-optimization cache DURING execution, so a stale one re-hashes assets
 * even when the task re-runs (the v0.1.4 trap).
 *
 * Cross-platform: pure Node `fs` (no `rm -rf`), so it runs the same on
 * Linux / WSL / macOS / Windows. No dependency added — matches the repo's
 * existing `node -e "...rmSync..."` prebuild convention.
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const removed = [];
function rm(path) {
  if (!existsSync(path)) return;
  rmSync(path, { recursive: true, force: true });
  removed.push(path.slice(repoRoot.length + 1) || path);
}

/**
 * Recursively prune caches WITHOUT descending into the multi-hundred-MB
 * node_modules trees — we only reach in to delete their `.vite` (vite dep
 * pre-bundle) and `.cache` (generic tool cache) children directly.
 * Elsewhere we remove any `.turbo` (turbo task cache) or `dist` (tsc/vite
 * build output) directory.
 */
function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = join(dir, e.name);
    if (e.name === "node_modules") {
      rm(join(full, ".vite"));
      rm(join(full, ".cache"));
      continue; // never descend into node_modules
    }
    if (e.name === ".turbo" || e.name === "dist") {
      rm(full);
      continue;
    }
    // Skip other dotdirs (.git, .github, .claude, worktrees, …) — they hold
    // no build cache and walking them wastes time.
    if (e.name.startsWith(".")) continue;
    walk(full);
  }
}

walk(repoRoot);

if (removed.length === 0) {
  console.log("[clean-build-cache] nothing to remove (already cold)");
} else {
  console.log(`[clean-build-cache] removed ${removed.length} cache/output dir(s):`);
  for (const p of removed) console.log(`  - ${p}`);
}
