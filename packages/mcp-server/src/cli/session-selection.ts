/**
 * #344 (Fable's #375 review, M1) — validate `--session-id` for the CLI posting
 * door BEFORE anything constructs a store.
 *
 * The durable posting protocol's per-session scope is the reason the CLI
 * refuses to guess a session for an external write. But the replacement guard
 * was `if (!sessionId?.trim())` and nothing more, so the id was free text: a
 * typo constructed a `FileStore` on a path that did not exist, which CREATED
 * the session directory and, with it, a fresh unguarded journal. Two failure
 * shapes followed. A near-miss that names another REAL session (per-session
 * artifact buckets since v0.1.44 make near-misses the normal case) posts
 * against a different journal with no duplicate blocking — the same double post
 * the scope fix removed, now human-initiated. A near-miss that names nothing
 * litters a session directory the companion UI then lists.
 *
 * Membership, deliberately, not deduplication: naming another existing session
 * stays an explicit operator choice. This only establishes that the id the
 * human typed is a session that already exists here.
 *
 * Pure over its inputs — the disk read is `readSessionDirectories` below — so
 * every branch is unit-testable, and so the check cannot itself create or
 * touch anything.
 */
import fs from "node:fs";
import path from "node:path";

/** How many ids to name before summarising; a project accrues sessions fast. */
const MAX_LISTED = 10;

export type SessionSelection =
  | { ok: true; sessionId: string }
  | { ok: false; message: string };

export function selectPostingSession(args: {
  /** The raw `--session-id` value, if the flag was given at all. */
  requested: string | undefined;
  /** Session ids with readable artifacts — `FileStore.listSessions`, most recent first. */
  readable: string[];
  /** Every directory under `.deeppairing/sessions/`, readable or not. */
  directories: string[];
}): SessionSelection {
  const requested = args.requested?.trim();
  if (!requested) {
    return {
      ok: false,
      message: "Posting requires --session-id ID. Use the exact session reviewed in the companion UI; the CLI never guesses a session for an external write.",
    };
  }
  if (args.readable.includes(requested)) return { ok: true, sessionId: requested };

  // A directory with no readable artifacts cannot be the reviewed session, and
  // saying so is more useful than "no such session" — it tells the operator the
  // id was right and the session is damaged, not that they mistyped.
  const exists = args.directories.includes(requested);
  const head = exists
    ? `Session "${requested}" exists in this project but has no readable artifacts, so it cannot be the session you reviewed.`
    : `No session "${requested}" in this project. Nothing was created; check the id in the companion UI.`;
  if (args.readable.length === 0) {
    return { ok: false, message: `${head} This project has no sessions with reviewable artifacts yet.` };
  }
  const shown = args.readable.slice(0, MAX_LISTED);
  const more = args.readable.length - shown.length;
  return {
    ok: false,
    message: `${head} Sessions in this project (most recent first): ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}.`,
  };
}

/**
 * Directory names under `.deeppairing/sessions/`. Read-only, and it never joins
 * the requested id onto a path — the caller compares strings, so a `../` id
 * cannot probe outside the project or reach a `statSync` at all.
 */
export function readSessionDirectories(projectRoot: string): string[] {
  try {
    return fs
      .readdirSync(path.join(projectRoot, ".deeppairing", "sessions"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
