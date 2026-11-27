/**
 * #681 — the standalone (non-MCP) protocol for any shell-capable agent.
 *
 * THIS MODULE IS THE SINGLE SOURCE OF TRUTH for that protocol. `deeppairing
 * guide` prints it, the skill stub (skills/deeppairing/SKILL.md) and the
 * `setup-agent` instruction block only tell the agent to run `guide`, so the
 * text an agent follows always ships with the CLI it is driving and can't
 * drift from it. Edit the protocol here, nowhere else.
 *
 * Written in second person to the agent. Claude Code-only features appear in
 * one clearly marked note at the end.
 */
import { DECISION_NON_ANSWERABLE_STATUSES, PAGE_HTML_MAX_BYTES } from "@deeppairing/shared";
import { cliInvocation } from "../cli-invocation.js";
import { MAX_COMMENTS, MAX_RESPONSE_BYTES } from "../daemon/page-feedback.js";
import { SERVER_VERSION } from "../version.js";
import { PAGE_CONSTRAINT_RULES, PAGE_SKELETON_HTML, PAGE_STRUCTURE_RULES, renderPageAuthoringGuide } from "../page-authoring.js";
import { PAGE_WATCH_MIN_INTERVAL_MS, PAGE_WATCH_QUIET_MS } from "../page-watch-timing.js";

/**
 * Every CLI command the guide tells the agent to run. The guide test checks
 * each one against the init.ts dispatch, and checks that the rendered text
 * names no command outside this list.
 */
export const GUIDE_COMMANDS = [
  "guide",
  "open",
  "resume",
  "present options",
  "present page",
  "read-decision",
  "read-page-feedback",
  "revise-page",
] as const;

/** read-page-feedback bounds, from the daemon's own limits. */
export const PAGE_FEEDBACK_MAX_COMMENTS = MAX_COMMENTS;
export const PAGE_FEEDBACK_MAX_KIB = MAX_RESPONSE_BYTES / 1024;

/** The `waitStatus` values `read-decision --wait-ms` returns (decision-feedback.ts). */
export const GUIDE_WAIT_STATUSES = ["resolved", "closed", "timed_out"] as const;

const OPTIONS_EXAMPLE = {
  title: "Which cache layer?",
  context: "Reads of /profile take 400ms. We need a cache in front of the profile service.",
  stakes: "medium",
  options: [
    {
      id: "redis",
      title: "Redis",
      description: "A shared Redis instance in front of the service.",
      pros: ["shared across instances"],
      cons: ["another service to run"],
      effort: "medium",
      risk: "low",
      recommendation: true,
    },
    {
      id: "lru",
      title: "In-process LRU",
      description: "An LRU map inside each API instance.",
      pros: ["no new infrastructure"],
      cons: ["each instance warms its own copy"],
      effort: "low",
      risk: "medium",
    },
  ],
};

/**
 * Render the protocol. `invocation` is how the agent reaches the CLI in this
 * install (npx form for an installed package, the absolute `node …/init.js`
 * path for a source checkout); every command below is written as
 * `deeppairing <cmd>` against it.
 */
export function renderStandaloneGuide(invocation: string = cliInvocation()): string {
  const pageCapMiB = PAGE_HTML_MAX_BYTES / (1024 * 1024);
  return `deepPairing standalone protocol (v${SERVER_VERSION})

You are pairing with a human who reviews your proposals in a browser companion.
You present a decision or a page, the human decides there, you read the result
and carry on.

OUTPUT
  On success, and on a refusal, a command prints one JSON object on stdout.
  A refusal also has "isError": true and exits 1. A usage, connection or
  input error prints plain text ("deepPairing: ...") on stderr, nothing on
  stdout, and exits 1. So: exit 0 means parse stdout; exit 1 with JSON on
  stdout is a refusal (see REFUSALS); exit 1 with empty stdout means read
  stderr and fix the command.

In the commands below, \`deeppairing\` means:
  ${invocation}
From a source checkout the CLI is the built file
packages/mcp-server/dist/cli/init.js (run it with node). dist/standalone.js
next to it is the MCP server, not this CLI: never run it for these commands.

WHEN TO PRESENT
- Present options when there is a real fork the human would want to weigh
  before you build: two or more viable approaches, a data-model or
  architecture choice, anything costly to undo, anything touching migrations,
  CI, secrets, auth or infrastructure.
- Present a page when the human should read or annotate something richer than
  a sentence: a plan, a design, a report, a diagram. Write it as HTML
  that reads without scripts or network (see 3a).
- Otherwise just proceed. Routine work, obvious fixes and choices with one
  sensible answer don't need a review. Don't ask about what you can decide.

1. OPEN A SESSION (once per task)
  deeppairing open
    -> {"sessionId":"...","companionUrl":"http://localhost:PORT/?session=..."}
  Save the sessionId somewhere that outlives this process (a scratch file or
  your notes); every later command needs it. Give the human the companionUrl:
  they review there, not in your terminal.
  From a new process, or after a restart, reuse the same session:
  deeppairing resume <sessionId>
    -> the same sessionId with a fresh companionUrl.

2. PRESENT OPTIONS
  deeppairing present options --session-id <sessionId> --request-id <uuid> --file options.json
  options.json is one JSON object:
    context   (required) the background the human needs to choose
    title     (optional) a short question naming the fork, max 80 chars
    stakes    (optional) "low" | "medium" | "high"
    options   (required) 2 to 4 objects, each with:
                id, title, description, pros (string[]), cons (string[]),
                effort and risk ("low" | "medium" | "high"),
                recommendation (optional boolean: the one you'd pick)
  Minimal example:
${indent(JSON.stringify(OPTIONS_EXAMPLE, null, 2), 4)}
    -> {"sessionId","requestId","artifactId","decisionId","companionUrl"}
  Keep the decisionId: you read the human's choice with it.

3. PRESENT A PAGE
  deeppairing present page --session-id <sessionId> --request-id <uuid> --path page.html --title "Title" [--summary S] [--concept C]
  deeppairing present page --session-id <sessionId> --request-id <uuid> --file page.html --title "Title" [--summary S] [--concept C]
  Use exactly one of --path or --file. They start two different flows
  (step 5): --path names a file inside the project and the page is WATCHED;
  --file sends any readable file once, inline, and is not watched. Pages are
  capped at ${pageCapMiB} MiB.
    -> {"sessionId","requestId","artifactId","companionUrl",...,"warnings"?}
  Keep the artifactId: you read the human's comments with it. A rejection in
  the companion becomes rejection memory and is enforced when you next
  present (see REFUSALS). "warnings" lists authoring problems (step 3a);
  they never refuse the page, and appear on the first present only (a
  same-UUID replay returns the receipt without them).
  The receipt only confirms the page was created. Give the human the
  companionUrl and tell them the page is ready, then wait for them to
  review it. Don't read an empty read-page-feedback result as "no feedback"
  (see step 4).

3a. WRITE A REVIEWABLE PAGE
${renderPageAuthoringGuide()}

4. READ PAGE FEEDBACK
  deeppairing read-page-feedback --session-id <sessionId> --artifact-id <artifactId>
  After presenting a page, this reads the human's verdict and pending
  feedback on that exact page version, newest first. Reading is passive and
  never acknowledges anything. Pending comments and notes remain eligible for
  later reads while they remain unacknowledged. The command returns immediately.
    -> {"sessionId","artifact":{"id","version","status"},"successor"?,
        "verdict"?,"comments":[...],"omittedComments",
        "notes":[...],"omittedNotes"}
  - verdict: present when the human's latest action on this version was
    Request changes (status "revised") or Reject (status "rejected"), with
    "at". "reason" is their explanation, and "commentId" its id, when it can
    be verified. If "reason" is missing, read notes for the human's words.
    "reasonTruncated" means only the start of a very long reason fit. Act on the reason before anything else: change the approach
    after a Reject, and address it before revising after Request changes.
  - comments: anchored comments. Each has id, content (the human's words),
    parentCommentId (set on a reply), htmlAnchor (where it points: kind,
    locator, quote, and when present prefix, suffix, table, nodeId, href,
    version), and optionally intent ("comment" | "question" |
    "suggestion"), followUp and ruleOut.
    - ruleOut: the human ruled the anchored text out. Take it out of the
      page. The comment content is their reason.
  - notes: the human's pending notes with no anchor (same fields, no
    htmlAnchor). They apply to the page as a whole.
  - successor: the page has moved to a newer version. Read that version
    with its id (successor.id) as --artifact-id. A verdict belongs to the
    version it was given on, so read the version you revised from too
    before acting.
  An absent verdict means this payload contains no Request changes or
  Reject verdict. If comments and notes are empty, check both omission
  counts before deciding whether feedback is pending. The human may not
  have reviewed yet, may have approved (check artifact.status: "approved"),
  or you may have acknowledged everything already. Check artifact.status
  (draft or reviewing: no verdict yet) and successor, or wait for the human
  to tell you they are done.
  A read returns at most ${PAGE_FEEDBACK_MAX_COMMENTS} items and ${PAGE_FEEDBACK_MAX_KIB} KiB of JSON. The verdict claims space
  first. omittedComments counts anchored comments that didn't fit, and
  omittedNotes counts unanchored notes that didn't fit. Returned comments
  and notes stay whole. File-watch notices are not included.

5. REVISE A PAGE
  How you ship a new version depends on how you presented the page.

  5a. WATCHED PAGE (presented with --path)
  Edit the source file. Don't run revise-page on it. While the page is under
  review the daemon watches the file, and a save records a new version after
  about ${PAGE_WATCH_QUIET_MS / 1000}s of quiet, at most one per ${PAGE_WATCH_MIN_INTERVAL_MS / 1000}s. This is asynchronous and gated:
  a save that leaves the page unchanged records nothing, and a save whose
  text matches a rejected approach is refused and records nothing. To find
  the new version, read the ORIGINAL page:
  deeppairing read-page-feedback --session-id <sessionId> --artifact-id <artifactId>
  and follow successor.id once it appears. No successor yet means the save
  hasn't been recorded (or was unchanged or refused). A save the gate refuses
  writes a notice on the live version that read-page-feedback doesn't return
  yet, so if no successor appears after the quiet window, check the page in
  the companion. A watched save can't acknowledge comments by ID.

  5b. INLINE PAGE (presented with --file)
  deeppairing revise-page --session-id <sessionId> --artifact-id <artifactId> --request-id <uuid> --file page.html --reason "What changed" [--ack-comment-id <commentId> ...]
  Supply the replacement HTML for the current inline page. The revision goes
  through the page rejection checks and keeps the page metadata. A successful
  revision returns the saved successor and keeps human feedback pending by default.
    -> {"sessionId","requestId","parentArtifactId","artifactId","version","status",...}
  Optionally repeat --ack-comment-id for up to 50 ordinary anchored human
  comments you read on this page or a direct ancestor. Get each ID with
  read-page-feedback on its exact page version. Pass only ordinary IDs from
  comments to --ack-comment-id. Verdict reasons and unanchored notes stay on
  their original version. Read that exact version again after revising.
  The receipt lists the acknowledgedCommentIds once the revision and
  acknowledgements are saved.
  Including a comment that is already acknowledged is safe and records no
  additional change. Leave questions and suggestions out of --ack-comment-id.
  You can answer a question in the revised page. Its comment stays pending
  until handled. Use the separate suggestion review flow for suggestions.
  Acknowledging a Rule this out comment leaves the rule-out status unchanged.
  For a watched page, edit the source file. If the target moved, the refusal
  includes currentArtifactId. Read that version before deciding what to revise.

6. READ THE DECISION
  deeppairing read-decision --session-id <sessionId> --decision-id <decisionId> --wait-ms 30000
  This waits up to 30000 ms (any value from 1 to 30000) for the human's
  choice. Reading consumes nothing, so repeat reads are safe. Branch on
  waitStatus:
  - "resolved":  selectedOptionId and selectedTitle are set, with the human's
                 reasoning when they gave one. Proceed with that option.
  - "closed":    the card can no longer be answered. Stop waiting on it.
  - "timed_out": no choice yet. Run the same command again.
  recordedRejections lists the approaches the human rejected from this card,
  each with their reason. Don't propose those again.
  Without --wait-ms the read answers at once and has no waitStatus: no
  selectedOptionId means no choice yet, and an artifactStatus of
  ${DECISION_NON_ANSWERABLE_STATUSES.join(", ")} means the card can no longer
  be answered.

7. REQUEST IDS
  Every present or revision needs --request-id, a UUID you generate (for example
  \`node -e "console.log(crypto.randomUUID())"\`).
  - Retrying unchanged input (a timeout, a crash, output you never saw): reuse
    the SAME UUID. You get the original artifact back with "replayed": true,
    never a duplicate card.
  - Changed anything (a flag, or the bytes of a --file page or revision):
    use a NEW UUID. Reusing a UUID with different input is refused with
    standalone_operation_conflict. For a revision, changing the set of
    comment IDs counts as changed input.
  - A --path present binds the path, not the bytes: editing the watched file
    is not changed input. Replaying that present's UUID after an edit returns
    the original page, with currentArtifactId and currentVersion naming the
    newer version once the watch has recorded one.

8. REFUSALS
  A refused present or revision prints {"isError":true,"code":"...","message":"..."} and
  exits 1.
  - "code":"rejected_approach_blocked" comes with "reason": the human already
    rejected this approach, in their own words. Do NOT retry the same approach,
    reworded or not. Change the approach so it answers the reason, then present
    the changed proposal with a new UUID. If you believe the block is a false
    positive, tell the human why. When the companion offers Allow once, only
    the human can choose it. An inline revision cannot use an allowance.
  - Any other code: fix what the message says. Use a new UUID if you change
    the input.

THE LOOP
  open (or resume) -> present -> give the human the companionUrl and wait
  for their review -> read-decision --wait-ms 30000, repeated while
  timed_out (or read-page-feedback for a page, once they have reviewed) ->
  act on the choice or the comments, or change the approach after a
  rejection and present again.

NOTE, CLAUDE CODE ONLY (skip this unless you are Claude Code)
  The deepPairing Claude Code plugin adds MCP tools for the same loop and a
  PreToolUse prompt that asks the human before a Write or Edit touches a
  guardrail path. Other agents get no such prompt: for you, the enforcement
  point is the refusal at present time.
`;
}

/** Machine-readable form for `deeppairing guide --json`. */
export function standaloneGuideJson(invocation: string = cliInvocation()) {
  return {
    version: SERVER_VERSION,
    invocation,
    commands: [...GUIDE_COMMANDS],
    waitStatuses: [...GUIDE_WAIT_STATUSES],
    nonAnswerableStatuses: [...DECISION_NON_ANSWERABLE_STATUSES],
    refusalCode: "rejected_approach_blocked",
    optionsExample: OPTIONS_EXAMPLE,
    pageAuthoring: {
      structure: [...PAGE_STRUCTURE_RULES],
      constraints: [...PAGE_CONSTRAINT_RULES],
      skeleton: PAGE_SKELETON_HTML,
    },
    guide: renderStandaloneGuide(invocation),
  };
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text.split("\n").map((line) => pad + line).join("\n");
}
