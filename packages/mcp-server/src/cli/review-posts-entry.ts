#!/usr/bin/env node
/**
 * Operator-only, OFFLINE review-post recovery — the entry point the plugin
 * bundle ships (`claude-plugin/server/review-posts.mjs`).
 *
 * Why this file exists (#344, Fable's #375 review, HIGH-1). The recovery verbs
 * `list` / `inspect` / `cancel-reserved` / `release-claim` /
 * `acknowledge-unknown` had exactly one caller — `deeppairing review-posts`,
 * i.e. `dist/cli/init.js` — and `scripts/bundle-plugin.mjs` does not emit the
 * CLI. On a marketplace install that binary does not exist, so every drain the
 * durable posting protocol depends on was documented but unreachable. That is
 * a MISSING ENTRY, not a stale bundle: the journal schema already rides along
 * in the daemon, so a plugin-installed daemon can *write* states only the
 * absent CLI could clear.
 *
 * Deliberately a launcher, not the CLI. Bundling `cli/init.ts` would ship
 * `init` / `doctor` / `demo` / `post-pr-review` — daemon spawns, hook
 * installation, and the review POST itself — into a file whose whole purpose is
 * offline recovery. This entry reaches only `review-posts-offline.ts`, which
 * imports the journal and nothing else, so the bundle provably contains no
 * posting path (asserted in `__tests__/plugin-operator-entry.test.ts`).
 *
 * Equally deliberately NOT an MCP or daemon route: these verbs accept duplicate
 * risk on a human's assertion. They stay a thing a person runs, with the agent
 * out of the loop.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProjectRoot } from "../project-root.js";
import { reviewPostsCommand } from "./review-posts-offline.js";

/**
 * Deliberately not `errorMessage` from `@deeppairing/shared`: that specifier is
 * the package barrel, so importing it for one small helper pulled every
 * artifact schema and fixture into this bundle (measured: 648,454 → 575,145
 * bytes without it; the remainder is zod, which the journal's own validation
 * needs). A recovery tool an operator runs while a session is wedged should
 * carry the journal and nothing else.
 */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * How to run THIS file, rendered from its own resolved location.
 *
 * Install layouts put this entry in different places (a marketplace plugin
 * directory, a source checkout's `claude-plugin/server/`, an npm package), and
 * `CLAUDE_PLUGIN_ROOT` is set for hooks and commands — not for the human's
 * shell. Printing the absolute path the process actually loaded makes every
 * example in `--help` true wherever it was launched from, so an operator has to
 * locate the file once and never again.
 */
export function operatorInvocation(entryPath: string, suffix = ""): string {
  return `node "${entryPath}"${suffix ? ` ${suffix}` : ""}`;
}

export function helpText(entryPath: string): string {
  const run = (suffix: string) => `  ${operatorInvocation(entryPath, suffix)}`;
  return [
    "deepPairing review-post recovery — offline operator commands.",
    "",
    "Acts on the project rooted at CLAUDE_PROJECT_DIR, else DEEPPAIRING_PROJECT_ROOT,",
    "else the current directory. Run it from the project whose review you are recovering.",
    "",
    "  <session-id> [list]                     list durable operations (JSON; no tokens, no review text)",
    "  <session-id> inspect                    redacted file/claim metadata, readable even when history is not",
    "  <session-id> cancel-reserved <op-id>    fence a reserved operation that never authorized a send",
    "  <session-id> release-claim <digest> --all-writers-stopped",
    "  <session-id> acknowledge-unknown <op-id> <digest> --all-writers-stopped --accept-duplicate-risk",
    "",
    "Examples:",
    run("s_1a2b3c"),
    run("s_1a2b3c inspect"),
    run("s_1a2b3c cancel-reserved 8c1f…"),
    "",
    "Digests come from the `operationDigest` field of `list` and the `claim.digest`",
    "field of `inspect`. Both assertion flags are your statement, not a check this",
    "can make: stop every writer (Claude Code sessions and the daemon) first.",
    "An acknowledgement records that you accept duplicate risk — it is not evidence",
    "the uncertain review was absent.",
    "",
    "This entry never contacts GitHub and never sends a review. Reconciling an",
    "operation against a review you found on the PR is a read-only GitHub GET and",
    "lives in the full CLI: `deeppairing review-posts <session-id> reconcile",
    "<op-id> <remote-review-id>` (source checkout or npm install).",
  ].join("\n");
}

/** Exported for tests; `main()` runs only when this file is the entry point. */
export function main(argv: string[], entryPath: string): number {
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    console.log(helpText(entryPath));
    return 0;
  }
  if (argv.length === 0) {
    console.error(helpText(entryPath));
    return 1;
  }
  const resolved = resolveProjectRoot();
  // stderr, so `list`/`inspect` stdout stays parseable JSON while the operator
  // still sees WHICH project answered — a recovery run in the wrong directory
  // reads as an empty journal, which is the most dangerous possible silence.
  console.error(`deepPairing project: ${resolved.projectRoot} (${resolved.source})`);
  try {
    console.log(reviewPostsCommand(resolved.projectRoot, argv));
    return 0;
  } catch (err) {
    console.error(`review-posts failed: ${describeError(err)}`);
    return 1;
  }
}

// `process.argv[1]` is the launched script; compare resolved paths so a symlink
// or a `./` prefix doesn't turn the entry into a silent no-op import.
const entry = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === entry) {
  process.exitCode = main(process.argv.slice(2), entry);
}
