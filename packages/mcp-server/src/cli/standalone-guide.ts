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
import { PAGE_HTML_MAX_BYTES } from "@deeppairing/shared";
import { cliInvocation } from "../cli-invocation.js";
import { SERVER_VERSION } from "../version.js";

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
] as const;

/** Read-decision outcomes the guide teaches, in the order it lists them. */
export const GUIDE_DECISION_STATES = ["pending", "resolved", "closed", "timed_out"] as const;

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
and carry on. Every command prints one JSON object on stdout.

In the commands below, \`deeppairing\` means:
  ${invocation}

WHEN TO PRESENT
- Present options when there is a real fork the human would want to weigh
  before you build: two or more viable approaches, a data-model or
  architecture choice, anything costly to undo, anything touching migrations,
  CI, secrets, auth or infrastructure.
- Present a page when the human should read or annotate something richer than
  a sentence: a plan, a design, a report, a diagram. Write it as HTML.
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
  --path  names a file inside the project. While it is under review the file
          is watched, and each save records a new version the human sees.
  --file  sends any readable file once, inline; it is not watched.
  Use exactly one of them. Pages are capped at ${pageCapMiB} MiB.
    -> {"sessionId","requestId","artifactId","companionUrl",...}
  The human annotates the page in the companion. A rejection there becomes
  rejection memory and is enforced when you next present (see REFUSALS).

4. READ THE DECISION
  deeppairing read-decision --session-id <sessionId> --decision-id <decisionId> [--wait-ms 30000]
  Without --wait-ms it answers at once. With it, it waits up to that many
  milliseconds (1 to 30000) for the human's choice. Reading consumes nothing,
  so repeat reads are safe.
  - pending:   no selectedOptionId yet. Read again later, or wait.
  - resolved:  selectedOptionId and selectedTitle are set, with the human's
               reasoning when they gave one. Proceed with that option.
  - closed:    artifactStatus is closed (for example superseded or withdrawn).
               This card will not get an answer; stop waiting on it.
  - timed_out: with --wait-ms only, the wait ended with no choice. Run the
               same command again.
  With --wait-ms the result carries waitStatus "resolved", "closed" or
  "timed_out". recordedRejections lists the approaches the human rejected from
  this card, each with their reason. Don't propose those again.

5. REQUEST IDS
  Every present needs --request-id, a UUID you generate (for example
  \`node -e "console.log(crypto.randomUUID())"\`).
  - Retrying unchanged input (a timeout, a crash, output you never saw): reuse
    the SAME UUID. You get the original artifact back with "replayed": true,
    never a duplicate card.
  - Changed anything (the file's content, a flag): use a NEW UUID. Reusing a
    UUID with different input is refused with standalone_operation_conflict.

6. REFUSALS
  A refused present prints {"isError":true,"code":"...","message":"..."} and
  exits 1.
  - "code":"rejected_approach_blocked" comes with "reason": the human already
    rejected this approach, in their own words. Do NOT retry the same approach,
    reworded or not. Change the approach so it answers the reason, then present
    the changed proposal with a new UUID. If you believe the block is a false
    positive, tell the human why; only they can allow it once, from the block
    card in the companion. Never try to grant it yourself.
  - Any other code: fix what the message says. Use a new UUID if you change
    the input.

THE LOOP
  open (or resume) -> present -> give the human the companionUrl ->
  read-decision --wait-ms 30000, repeated while timed_out -> act on the choice,
  or change the approach after a rejection and present again.

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
    decisionStates: [...GUIDE_DECISION_STATES],
    refusalCode: "rejected_approach_blocked",
    optionsExample: OPTIONS_EXAMPLE,
    guide: renderStandaloneGuide(invocation),
  };
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text.split("\n").map((line) => pad + line).join("\n");
}
