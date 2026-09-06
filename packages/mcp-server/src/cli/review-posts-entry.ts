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
 * recovery. This entry reaches `cli/review-posts.ts`, whose remote read comes
 * from `github/read-review.ts` rather than `github/post-review.ts`, so the
 * bundle carries no way to submit a review (asserted against the shipped file
 * in `__tests__/plugin-operator-entry.test.ts`).
 *
 * It carries the WHOLE operator surface, `reconcile` included. Shipping the
 * five offline verbs alone would have left an operator who found the review on
 * the PR with only two shipped moves — accept duplicate risk, or install the
 * source tree — which is the distribution gap this entry exists to close, one
 * verb further down (Astra's review of #383).
 *
 * Equally deliberately NOT an MCP or daemon route: these verbs accept duplicate
 * risk on a human's assertion. They stay a thing a person runs, with the agent
 * out of the loop.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProjectRoot } from "../project-root.js";
import { reconcileReviewPostCommand, reviewPostsCommand } from "./review-posts.js";
import { readSessionDirectories } from "./session-selection.js";

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
    "It names that project on stderr and refuses a session id it cannot find there,",
    "rather than answering a typo with an empty list. A session whose artifacts are",
    "damaged is still reachable — only the directory has to exist.",
    "",
    "Offline — these never open a network connection:",
    "  <session-id> [list]                     list durable operations (JSON; no tokens, no review text)",
    "  <session-id> inspect                    redacted file/claim metadata, readable even when history is not",
    "  <session-id> cancel-reserved <op-id>    fence a reserved operation that never authorized a send",
    "  <session-id> release-claim <digest> --all-writers-stopped",
    "  <session-id> acknowledge-unknown <op-id> <digest> --all-writers-stopped --accept-duplicate-risk",
    "",
    "Read-only GitHub — needs `gh` installed and authenticated:",
    "  <session-id> reconcile <op-id> <remote-review-id>",
    "                                          verify the review YOU identified on the PR and",
    "                                          record it locally. GET only; it cannot send a review",
    "                                          and cannot turn missing evidence into a retry.",
    "",
    "Examples:",
    run("s_1a2b3c"),
    run("s_1a2b3c inspect"),
    run("s_1a2b3c cancel-reserved 8c1f…"),
    run("s_1a2b3c reconcile 8c1f… 2145678"),
    "",
    "Digests come from the `operationDigest` field of `list` and the `claim.digest`",
    "field of `inspect`. Both assertion flags are your statement, not a check this",
    "can make: stop every writer (Claude Code sessions and the daemon) first.",
    "An acknowledgement records that you accept duplicate risk — it is not evidence",
    "the uncertain review was absent, and reconciling later is strictly better",
    "information: find the review on the PR first if you can.",
    "",
    "Nothing here can submit a review. `reconcile` reads the review id you give it,",
    "checks the correlation marker, destination, verdict, reviewed commit, body and",
    "every inline comment, and refuses on any mismatch — leaving the operation",
    "blocked rather than guessing.",
  ].join("\n");
}

/** Exported for tests; `main()` runs only when this file is the entry point. */
export async function main(argv: string[], entryPath: string): Promise<number> {
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

  // ...and the banner alone does not close that silence. An unknown session id
  // — a typo, or the right id in the wrong project — otherwise answered `[]`
  // and exit 0, which reads exactly like "this session posted nothing".
  //
  // The check is DIRECTORY EXISTENCE, never session readability. Gating on
  // `FileStore.listSessions` (as the posting door does) would make a session
  // whose artifacts are corrupt unrecoverable through the one tool that exists
  // to recover it — the opposite of the point. A session with no directory has
  // no journal, no claim and no protocol marker, so nothing is reachable there
  // and refusing costs an operator nothing.
  const sessionId = argv[0]?.trim();
  const directories = readSessionDirectories(resolved.projectRoot);
  if (sessionId && !directories.includes(sessionId)) {
    console.error(`No session "${sessionId}" in this project — nothing was created.`);
    console.error(directories.length > 0
      ? `Sessions here: ${directories.slice(0, 20).join(", ")}${directories.length > 20 ? `, and ${directories.length - 20} more` : ""}.`
      : "This project has no sessions at all. Check that you are in the right directory.");
    return 1;
  }

  try {
    // `reconcile` is the one verb that reads GitHub, and the one that is async.
    // Same dispatch shape the full CLI uses, one positional earlier (there,
    // argv[0] is the `review-posts` subcommand name).
    console.log(argv[1] === "reconcile"
      ? await reconcileReviewPostCommand(resolved.projectRoot, argv)
      : reviewPostsCommand(resolved.projectRoot, argv));
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
  void main(process.argv.slice(2), entry).then((code) => { process.exitCode = code; });
}
