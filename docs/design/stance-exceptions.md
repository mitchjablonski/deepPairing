# One-proposal stance exceptions (proposal, #470)

> **Status: PROPOSAL, revision 6 (design APPROVED by Astra at rev 5). No code is included.** It is written for
> Astra's scope and authority review, which must happen before any
> implementation starts.
>
> **Revision 6.** Astra APPROVED revision 5 at `043a0579`, with three
> implementation acceptance conditions; §13 turns them into a checklist.
> Fable's final design/style review asked for UX and placement changes, with
> no change to scope or authority:
> - the CLI diff preview (§3);
> - a human-facing "changed" state (§4, §7);
> - the interaction and accessibility of Allow-once and Retire (§3a);
> - fit with the #430 attention hierarchy (§4a).
>
> §12 maps every point.
>
> **Revision 5** answers Astra's re-review of `e4ec4c87`. Astra agreed with
> O1 and with keeping D5, and raised two P2s:
> - An allowance is now bound to the **effective proposal**: a resolved
>   snapshot plus its preconditions. The raw-call fingerprint is used only to
>   locate retries (§2).
> - **One authoritative daemon operation route** completes a partial revision
>   before any replay returns success (§6, §7).
>
> §12 maps both findings to sections.
>
> **Revision 4**
> - Fable APPROVED revision 3 at `6be03359` with implementation notes, and
>   recommended in-memory authority.
> - This revision resolves **O1 as in-memory only** (§4, §8, §11) and folds
>   in Fable's notes (§12).
>
> **Revision 3** answered Astra's and Fable's CHANGES verdicts on `f0bd817f`.
>
> **Revision 2** recorded Mitch's decisions of 2026-10-08.
>
> Refs #470. Source audited at `main` 842f4495 (v0.1.62).

## 0. The ask, in one paragraph

The rejection gate matches words, so it will sometimes refuse a proposal that
your stance was never meant to cover. A proposal to *remove* global mutable
state is refused by a stance against *global mutable state*, because every word
of the concept appears in it (README, "False positives and overrides"). Today
the only fix is **Retire this stance**. That deletes the whole stance from the
project (`FileStore.overrideRejectedApproach`) and, with publishing on, writes
an `approved` counter-instance to the cross-project ledger. You lose a stance
you still hold just to let one valid proposal through.

**Proposal:** add **Allow this proposal once**, next to Retire on the block
card and in the block log, plus a `deeppairing stance allow` CLI command.

- **Authority.** Only the human can grant an allowance. The daemon writes
  every grant and holds it **in memory only**. Each grant is bound to one
  stance, one live Claude session registration and one tool.
  - **What it covers:** the **effective proposal** the human saw. That is
    the resolved snapshot of exactly what would be created, plus the history
    and target state it depends on.
  - **How retries find it:** a raw-call fingerprint. The fingerprint only
    locates the grant; it never authorizes anything.
- **Lifetime.** It is single-use. An unused allowance ends with its session
  or after 72 hours, whichever comes first.
- **Admission.** It admits exactly one mutation, which creates the approved
  snapshot exactly. If anything the snapshot depends on has changed, the
  mutation is refused instead. A durable operation stamp on the artifact
  turns retries into replays. A replay finishes any follow-ups a crash
  interrupted.
- **Receipts.** These are written by the daemon on the block-log entry.
- **What stays the same.** The stance stays in force for every other
  proposal. Nothing reaches the cross-project ledger. Retire stays as a
  separate, clearly worded action.

## 1. What the gate does today (audited)

| Piece | Where | Behaviour that matters here |
|---|---|---|
| Proposal projection | `mcp/artifact-preflight.ts` `artifactProposal` | Picks the strings, paths and named concepts the gate reads, per type. It is **not** the whole proposal. For `code_change` it reads only `filePath`, `reasoning` and `concept.name` (lines 34–37), never `before` or `after`. Evidence snippets and option pros and cons are not read either. |
| Matcher | `mcp/preflight-validator.ts` `runPreflight` | The session lane runs first, then the team lane. It returns the **first** match only, and matching is lexical. |
| Refusal | `mcp/tool-helpers.ts` `preflightRejectedApproaches` | Broadcasts and persists the block (`store.recordPreflightBlock`). Returns `REJECTED_APPROACH_BLOCKED` with `retryable: false`. **No artifact is created, so there is no id.** `revise_artifact` re-gates under its own tool name (`revise-artifact.ts:118`). |
| Arg hashing | `tool-helpers.ts:724` `hashPresentArgs` | Takes a SHA-256 of a key-sorted stable stringify of the **raw** tool args. N2 calls it on raw `args`, for example `present-code-change.ts:50`. That happens before validation, and before `before` is reconstructed from history. N2's 30-second dedup window is in memory and not durable. |
| Transport | `daemon/client.ts:221–243`, `:411–413`; `daemon/routes.ts:517–519` | `DaemonClient` retries once, transparently, after a network failure. The daemon persists the artifact before it responds. **A lost response therefore means the artifact was committed while the tool saw an error, and the retry runs the create again.** |
| Block log | `store/preflight-block-log.ts` | `.deeppairing/preflight-blocks.json`. Project-scoped, newest 50 entries. Only the daemon writes it, and writes fail soft. It holds the matched phrase only. |
| Stance storage | `FileStore.recordRejectedApproach` | `preferences.json` holds `rejectedApproaches[]`, written under `mutatePreferences` (#408 on #416's lock). |
| Retire | `FileStore.overrideRejectedApproach`, `POST /api/philosophy/override`, `ToastLayer.tsx` | Deletes the stance. Team blocks are refused. |
| Session lifecycle | `standalone.ts:125–152`, `daemon/routes.ts:418–495`, `create-daemon.ts:214` | The wrapper calls `/register` when it starts. `/unregister` drops the session from the in-memory `activeSessions` **set of session ids**. All three exit paths fire `unregister()` without awaiting it, and `SIGINT` and `SIGTERM` exit immediately afterwards. **Whether the unregister lands is a race.** Nothing listens for stdin closing. |
| Hooks | `cli/setup-tasks.ts:465` (generated by `init`), `claude-plugin/hooks/hooks.json` (the plugin's native hooks) | Both register PreToolUse for `Write\|Edit\|MultiEdit` **only**. A match returns `ask`, never `deny`, and the hook fails open. The guardrail backstop (`guardrail-rules.ts:93–118`) asks only when no live pre-work ceremony exists, and only once per class per time window. |
| Mutation auth | `http/routes.ts` SP1, `daemon/token.ts`, `SECURITY.md` | Every public non-GET route needs the bearer token. The token sits in `daemon.json` or in an XDG-runtime sidecar (`tokenPlacement`, `readTokenSidecar`). Any same-uid process can read it. |

Two facts drive the design:

- **No artifact exists at block time**, so an allowance has to be keyed on
  content.
- **The agent runs as your own OS user.** It cannot be prevented from forging
  local state. It can only be kept off the sanctioned paths. The design
  therefore names those paths, closes the easy unsanctioned ones, and is exact
  about what detection can promise (§3).

## 2. Scope: what gets exempted

### Three identities, three jobs

Revision 5 separates *locating* a retry from *authorizing* a proposal (Astra
P2). Identical raw arguments can resolve to different stored content when the
session's history changes, so the raw-call identity is not enough to say what
the human allowed.

| | Matching projection | **Call fingerprint** | **Effective snapshot + digest** |
|---|---|---|---|
| Job | Decides *whether* a stance blocks | **Locates** an allowance or a committed operation for a retry. It never authorizes anything by itself. | **What the human allowed.** It is what consumption creates, byte for byte. |
| Input | `artifactProposal(type, title, content)` | The tool's **raw `arguments`**, as N2 hashes them (before validation and history reconstruction), minus transport metadata (below) | The **resolved proposal**: the exact `CreateArtifactParams` the tool would persist, after every server-side derivation, minus ids the server mints (`art_`, `dec_`, `cmt_`). It is taken together with its **preconditions** (below). |
| Function | Unchanged | `sha256(stableStringify({v: 1, toolName, type, args}))` | `effectiveDigest = sha256(stableStringify({v: 1, snapshot, preconditions}))` |
| Stable across a retry with identical args | n/a | **Yes**, by construction | Only if nothing the proposal depends on has changed. That is the point of it. |

**Server-side derivations the snapshot captures.** A resolution step
(`resolveProposal`) runs **before** preflight, as both tools already do. The
snapshot captures what it produced:

- **`present_code_change` with `before` omitted** (`present-code-change.ts:20–41`):
  - the reconstructed `before`, taken from the newest prior `code_change` for
    the same `filePath`;
  - the corrected `changeType` (`create` becomes `modify`).
- **`revise_artifact` supersede** (`revise-artifact.ts:61–170`):
  - the inherited `title` when it is omitted;
  - an external changeset's inherited `reviewIntent` and `source` display
    provenance (never `headSha`);
  - the dropped `reviewState`/`reviewReasons`;
  - a decision's inherited `stakes`;
  - the carried `relatedArtifactIds` and `featureId`;
  - `parentId`, and `version = old.version + 1`;
  - `agentReasoning` (the revise `reason`).
- **Every tool:** the title and content exactly as they would be persisted.

**Preconditions.** These are the facts the derivation read. The daemon checks
them again when the allowance is consumed.

| Tool | Precondition |
|---|---|
| `present_code_change`, `before` omitted | `{priorCodeChangeId \| null, priorAfterHash}`: which prior artifact supplied `before`, and a hash of its `after`. If there was no prior, `null`. |
| `present_code_change`, `before` supplied | None. |
| `revise_artifact` | `{targetId, targetVersion, targetStatus, inheritedHash}`. `targetStatus` must be live. `inheritedHash` covers every field the revision inherited (title, provenance, stakes, refs, feature). |
| Other `present_*` | None today. Any future server-side derivation **must** add its own precondition. A schema-driven test fails if a tool's resolution reads store state without declaring it. |

**How the three identities are used:**

1. **At the block.** The tool sends the call fingerprint, the snapshot, the
   preconditions and the `effectiveDigest` with the block event. The daemon
   **recomputes the digest itself** from the snapshot and preconditions. The
   preview renders the **snapshot**, so the diff, title and provenance shown
   are the ones that would be created.
2. **At the grant.** The daemon copies all of this from its own block record
   into the in-memory allowance.
3. **When an allowance is claimed** (§7). Candidates are found by call
   fingerprint. Then the daemon:
   - **re-resolves the preconditions from its own store**, using the same
     pure resolver functions the tools use (shared, not duplicated);
   - **refuses** with `stance_exception_dependencies_changed` if any
     precondition differs. Examples: a newer prior `code_change` for the
     file, a target revised by someone else, or a changed target title or
     provenance;
   - otherwise **creates exactly the approved snapshot**, minting only fresh
     ids. The content resolved by the client in that call is **not** used to
     create anything. It must hash equal to the snapshot, or the claim is
     refused with the same code.
4. **When a committed operation is replayed** (§7). The daemon returns the
   original result **without** re-checking authorization or preconditions.
   The allowance may be ended or expired by then, and the dependencies may
   have moved. A replay creates nothing new.

**What the call fingerprint excludes:** only transport metadata, which is the
MCP request's `params._meta` and a top-level `arguments._meta` key. Nothing
else is canonicalized: whitespace, case, Unicode form and array order all
count. The snapshot is the persisted form, so it has no transport metadata
at all.

### Binding: an allowance admits a call only if all of these match

| Binding | Value |
|---|---|
| Project | Implicit. The allowance lives in this project's daemon. It is never mirrored. |
| Stance | The blocking row's `{description, concept, rejectedAt}`, compared exactly. |
| Session | The block's `sessionId`, plus the `registrationId` resolved from the registration the daemon **issued** (§5). It is never read from a request body. |
| Tool and type | `toolName` and artifact type, which are also inside both digests. |
| Call | The call fingerprint. This only locates the allowance. |
| Effective proposal | The `effectiveDigest`, with **re-verified preconditions**. What gets created is the stored snapshot. |
| Lifetime | The registration is live, and the time is before `ceilingAt` (§5). |

### The preview shows what is covered

1. **"What matched"**: the projection, with the matched phrase highlighted.
2. **"What will be created (all of this is covered)"**: the **effective
   snapshot**, rendered in the shape of the artifact. That means the
   reconstructed diff, the inherited title and provenance, and every option
   with its pros and cons.
   - When a precondition exists, one line names it. For example: "`before`
     comes from *art_x* (your last change to this file)", or "Revises *art_y*
     v3".
   - The footer reads: "If the agent changes anything, or if *art_x* / *art_y*
     changes first, this allowance won't apply."

### Why not the other candidates

- **A normalized-token fingerprint.** `not` is a stopword.
- **A projection-only digest** (rev 1). It admits different code under the
  same reasoning.
- **A raw-args digest alone** (rev 4). It can admit a different effective
  proposal after history changes (Astra P2, rev 4 re-review).
- **An effective digest alone, with no fingerprint.** A retry made after a
  dependency moved could not even *find* its allowance in order to explain
  why it was refused. It also could not find a committed operation to
  replay.
- **An artifact id.** None exists yet.

### Why this does not open a paraphrase loophole

- A near-copy has a different call fingerprint, and the unchanged matcher
  checks it.
- An allowance lifts **only its own stance** (§6).
- It is single-use, never feeds `approvedPatterns`, the ledger or the
  advisory dedupe, and telemetry skips it.
- It admits the proposal to **review**, not to approval.

### Size and secrets

- **Size.** The block event carries the snapshot. Above 48 KiB the block is
  recorded but **not eligible**.
- **Secrets.** The snapshot goes through the scanner `createArtifact` uses. If
  the scan flags it, the snapshot is not persisted, and the block is not
  eligible.

## 3. Authority: who can grant

### Invariant A1: only the daemon creates a grant, and only on a request a human made

> No MCP tool, MCP tool argument, `IStore` or `DaemonClient` method,
> `/api/internal/*` route, hook output, or file on disk can create an
> allowance. The only creator is the daemon's in-memory allowance registry,
> reached through the bearer-gated public route
> `POST /api/preflight-blocks/:blockId/exception`. Two clients call that
> route:
> - the companion UI, after an explicit gesture;
> - `deeppairing stance allow <blockId>`. It reaches the route only after its
>   interactive checks, **and** after a Claude Code permission prompt when the
>   agent's Bash is the one running it.

How it is enforced:

1. **Structural absence, pinned by a test.** The registry exists only inside
   the daemon process. Nothing on `IStore`, `DaemonClient` or
   `/api/internal/*` reaches its grant function. An **authority-surface
   test** enumerates:
   - MCP tool schemas;
   - `IStore` and `DaemonClient` method names;
   - `/api/internal/*` routes;
   - CLI subcommands.
2. **No file can create authority.** Allowances are never read from disk
   (O1 resolved, §4). Writing `preferences.json`, the block log or session
   files cannot arm one. **This closes revision 3's "hand-written grant"
   residual.**
3. **The CLI writes through the daemon.**
   - `stance allow` finds the token through the same placement logic the
     wrapper uses (`daemon/token.ts`). That means the XDG-runtime sidecar
     when `tokenPlacement` chose it, and `daemon.json` otherwise.
   - It stamps `Authorization: Bearer …`, `X-Project-Hash` and
     `X-DeepPairing-Grant-Origin: cli`.
   - If the daemon is unreachable, the grant is refused.
4. **A block id, not a scope.** The body is `{reason}` only. The daemon
   copies stance, session, registration, tool, type, call fingerprint,
   snapshot and preconditions from its own block record. It computes the
   `effectiveDigest` itself. Extra fields get a 400, and
   an unknown block id gets a 404.
5. **What you see is what you allow.** The preview renders the snapshot, and
   the digest is computed from that same snapshot. Consumption creates **that
   snapshot**, or refuses if its preconditions changed (§2, §7).
6. **Shared guards.** The route refuses:
   - team blocks (D4);
   - `demo_` sessions;
   - a stance that has been retired;
   - a session that has ended (§5);
   - a block that is not eligible (§2).
7. **The origin is recorded.** `grantedVia` is `"ui"` or `"cli"`, taken from a
   **self-reported** header. It labels which door was used. It does not
   authenticate anyone.

### The CLI grant (D2), and the Bash prompt

`deeppairing stance allow <blockId>` runs these checks. Any failure exits
non-zero and writes nothing.

- **TTY.** It requires a TTY on both stdin and stdout.
- **Flags.** It refuses every non-interactive flag, including `--reason`.
- **Environment.** It refuses when `CLAUDECODE=1` or `CI` is set.
- **Preview.** This is never raw JSON. The CLI shows:
  1. the stance;
  2. the precondition line, such as "`before` comes from *art_x* (your last
     change to `src/config.ts`)" or "Revises *art_y* v3";
  3. the snapshot rendered for the terminal:
     - a `code_change` is shown as a **unified diff** of the effective
       `before`/`after`, with the file path as the header;
     - other types are shown as readable text: title, then each section,
       option (with pros and cons) or finding (with evidence).

  All of it goes through `$PAGER`, falling back to `less -R`. You have to
  page to the end before the reason prompt appears. With `NO_COLOR` set,
  the diff has no colour.
- **Typed input.** It requires a typed reason of 3–280 characters, then a
  typed `allow`.

These checks are one shell line away from the agent. Fable showed it:
`printf 'reason\nallow\n' | script -qc 'env -u CLAUDECODE deeppairing stance allow <id>' /dev/null`.
They are kept for casual misuse. The real protection is a channel the agent
cannot answer, a **narrow Bash PreToolUse matcher**:

- **Registered in both places.**
  - A second PreToolUse entry with `"matcher": "Bash"` goes into
    `claude-plugin/hooks/hooks.json`, the plugin's native hooks, which is the
    supported install path.
  - The same entry goes into the `init`-generated hooks
    (`cli/setup-tasks.ts`), so plugin and `init` installs behave the same.
  - The parity test that already covers the Write/Edit hooks covers the pair.
- **Written as a POSIX `sh` script from the start.** Starting `node` on every
  Bash call costs too much. The script reads the hook JSON from stdin and
  extracts `tool_input.command` with a JSON-aware decode, so an escaped
  `\t`, `\n` or `\"` becomes the real character before matching. Without the
  decode, `stance\tallow` would slip past a raw-text match.
- **One decision.** If the decoded command matches the extended regex
  `stance[[:space:]]+allow` **case-insensitively**, the script prints a hook
  response with `permissionDecision: "ask"`. Its reason reads "The agent is
  trying to grant a stance allowance from the shell. Only allow this if you
  asked for it."
- **Narrow by construction.** For **every other Bash command** it exits 0 with
  **no output**, so Claude Code behaves exactly as it does today. It does no
  other matching, no stance or guardrail logic on Bash, and no logging.
- **It must not be pre-empted by an allow rule.** A user may have
  `Bash(deeppairing:*)` in their permission allow list. The design requires
  that the hook's `ask` still produces a prompt. A test pins this (§10). If
  Claude Code ever lets an allow rule silence a hook `ask`, that test fails,
  and the docs have to say so.

**Honest limits.** The matcher is a substring check, not a shell parser. These
all get past it:

- splitting the words (`s=stance; deeppairing $s allow`);
- encoding the command (base64);
- writing a script to a file and running it;
- `curl` to the route.

Each of those is a deliberate evasion. The prompt closes the obvious path and
the one Fable published.

**Detection reaches the human.**

- **A grant raises a toast.** CLI grants get a stronger style.
- **Each admitted artifact keeps a badge on its card:** "Allowed once
  (UI/CLI)".
- **The debrief view lists every allowance used in the session.** This is a
  system section built from artifact stamps and block receipts. The agent
  does not write it.
- **`export_session` includes the same list.**

### Direct file edits

Allowances no longer live on disk, so editing a file cannot grant one. The
**`deeppairing-state` guardrail class is kept** anyway.

- **What it guards.** Its patterns match
  `(^|/)\.deeppairing/preferences\.json$` and
  `(^|/)\.deeppairing/team\.json$`. It **always** returns `ask`, ignoring the
  ceremony skip and the dedup window.
- **Why it is still needed.** The agent's Edit and Write tools could
  otherwise delete or rewrite stance rows in `preferences.json` (an
  unprompted, silent Retire) or edit the committed `team.json`.
- **What it does not cover.** Bash writes to these files are outside the
  narrow Bash matcher, on purpose.

### What the audit trail does and does not promise

- **Promised.** For the supported paths, every grant, consumption and
  revocation produces a block-log receipt, a broadcast and an origin badge.
  An admission also produces an artifact badge and a stamp. The supported
  paths are the UI route, the CLI through the daemon, and the daemon's claim
  during admission.
- **Not promised.** Receipts are **not tamper-evident** and authenticate no
  one. A same-user process can still:
  - edit or delete the block log, the session files or exports;
  - call the bearer route directly;
  - drive the CLI through a scripted pty.

  Nothing here guarantees that same-user tampering will be detected. The
  Bash `ask` and the guardrail `ask` make the agent's *direct* attempts
  visible as prompts. They are not a detection guarantee.
- **Docs wording (§9).** "Human-only by design. Receipts cover supported
  operations. Not tamper-evident against same-user processes."

### Surfaces

| Surface | Grant | List | Revoke |
|---|---|---|---|
| UI: block card and block log | **Yes** | Yes | Yes |
| UI: Ledger drawer, debrief view, artifact badge | No | Yes | Yes (Ledger) |
| CLI `stance allow <blockId>` (interactive, through the daemon, Bash prompt) | **Yes** | — | — |
| CLI `stance exceptions [revoke <id>]` (through the daemon) | No | Yes | Yes |
| MCP tools, `/api/internal/*` | **No** | No | No |

### 3a. Interaction and accessibility (rev 6)

**Today's hazard.** At 842f4495, **Retire this stance** in the hero toast
(`ToastLayer.tsx:157-163`) is a `text-2xs` muted text link. It retires the
stance permanently, on one click, with no confirmation. Revision 5 put
Allow-once beside it in the same `gap-3` row. That would make a destructive
misclick *more* likely, because the two actions would sit side by side and
look alike.

**Revision 6 placement.**

- **The hero toast** carries **Allow this proposal once** as its **primary
  button**. That means a filled, accent-coloured button with a hit target of
  at least **32×32 px**.
  - The toast has no Retire control. A secondary "More options" link opens
    the gate-log entry.
  - The toast's auto-dismiss pauses while the toast has hover or focus, and
    while the dialog is open.
- **The gate-log entry** (`PreflightBlockLog`) carries the same primary
  **Allow once** button, plus **Retire…** as a secondary 32 px button.
- **Retire is behind a one-step confirm.** **Retire…** opens an inline
  confirm: "Retire '*stance*'? This deletes the stance from this project. It
  stops blocking everywhere, not just here." The confirm has two buttons,
  **Cancel** and **Retire**. Initial focus is on **Cancel**, so pressing
  Enter does **not** retire.
- **The Ledger drawer** keeps its own Revoke and Retire controls, with the
  same confirm.

**The Allow-once dialog.**

- **Semantics.**
  - It has `role="dialog"` and `aria-modal="true"`.
  - It sets `aria-labelledby`, which points at a heading that names the
    stance: "Allow one proposal past '*stance*'".
  - It sets `aria-describedby`, which points at the scope sentence: "Allows
    this exact proposal, once, until this Claude session ends (at most 72
    hours). The stance stays on for everything else."
- **Focus.**
  - Focus is trapped inside the dialog while it is open.
  - **Initial focus goes to the heading** (`tabIndex=-1`). A screen reader
    therefore announces what is being allowed before the first Tab reaches
    the reason field.
  - Tab order: the preview region (which scrolls and can be focused), the
    reason field, **Allow once**, **Cancel**.
  - On close, focus returns to the button that opened the dialog.
- **Keys.**
  - Enter in the reason field **confirms only when the reason is valid** (3
    or more characters after trimming). Otherwise Enter does nothing and the
    inline hint is announced.
  - Esc cancels and writes nothing.
- **Errors.** On a 503 or 409 the dialog stays open, and the message appears
  in a `role="alert"` region.
- **Announcements.** These go through the existing `next-up-announcer` live
  region (`NextUpBar.tsx`, `role="status"`, polite). There is no second live
  region.
  - When a grant is made: "Allowed once: '*stance*'. Waiting for Claude to
    retry."
  - When the allowance changes from **allowed to used**: "Claude used your
    allowance: *artifact title*."
  - When the allowance changes to **changed**: "The proposal you allowed
    changed. A new block is waiting."

**Behaviour change to list in the docs.** Retire has always been a one-click
link on the toast. It now lives on the gate-log entry and in the Ledger
drawer, and it needs a confirmation. This change applies to every stance,
not only ones with allowances, and §9 lists it.

## 4. Recording and audit (O1 resolved: in-memory authority)

### Where

**Active authority lives only in the daemon's memory.** The registry is a map
from `registrationId` to that registration's allowances. Nothing about it is
written to `preferences.json`, and no stance-exception schema is added there.

Why this is enough, using the reasoning recorded with O1 (§11):

- **A daemon restart already ends a grant.** `registrationId` embeds the
  daemon's `instanceId` (§5), so keeping *active* authority durable buys
  nothing.
- **A used grant stays durable anyway.** The artifact carries an `admission`
  stamp, which is flushed before the daemon responds (§7).
- **Unused and revoked grants matter only within the session.** Their record
  is a **receipt on the block-log entry**, which only the daemon writes.
- **A crash between claim and create loses the grant.** The artifact stamp,
  if it exists, lets the retry replay. If it does not exist, the retry is
  blocked. Either way the result fails closed.

### What this removes

- The `preferences.json` schema, retention and migration.
- The cross-process lock path for allowances. Claims and grants are
  serialized by the daemon's per-session operation queue (§7). Stance rows are still read from
  the atomically replaced `preferences.json`.
- Most of revision 3's persisted `unknown` state and its reconciliation.
- Revision 3's §10.6 hand-written-grant residual.

### In-memory allowance (not persisted)

| Field | Notes |
|---|---|
| `id` | `sx_<random>`. |
| `state` | `active`, `consumed`, `changed` or `revoked`. "Ended" and "expired" are derived. |
| `stance`, `sessionId`, `registrationId`, `toolName`, `artifactType`, `callFingerprint`, `effectiveDigest`, `snapshot`, `preconditions` | The binding. The `snapshot` is what consumption creates. |
| `grantedAt`, `grantedVia` (`ui` or `cli`), `grantedBy?`, `reason` (3–280 characters), `ceilingAt` (`grantedAt` + 72 h) | `grantedBy` is a best-effort `git config user.name`. |
| `operation?` | `{id, artifactId}`, set when the allowance is claimed. |

### Durable receipt: the block-log entry's new optional `allowance` field

The daemon writes it on grant, consume and revoke:

- `{id, grantedVia, grantedAt, grantedBy?, reason, ceilingAt, state, artifactId?, revokedAt?, supersededByBlockId?}`.
- `state` is one of `allowed`, `used`, `changed`, `revoked`, `ended` or
  `expired`.
- The block entry also gains `supersedesAllowanceId?` and `seenAt?`. §4a
  explains `seenAt`.
- Because the receipt is the block entry, the block log's cap of 50 entries
  applies to receipts as well. A used allowance outlives that cap through
  its artifact stamp.

### Where you see it

- **The block card and gate log.** These show the origin badge and the
  state: allowed, used, **changed**, revoked, ended or expired.
  - **Changed** means a claim was refused with
    `stance_exception_dependencies_changed` (§7).
  - The old receipt becomes `changed`, with `supersededByBlockId`. The card
    reads, in words written to you: "The agent's proposal now depends on a
    newer *art_x*. Allow the new block if you still want it." The text "the
    new block" is a link to the entry for that block.
  - The new block entry carries `supersedesAllowanceId`, and shows "Replaces
    the proposal you allowed at *time*", with a link back.
  - A precondition about the revise target has its own wording: "*art_y*
    changed after you allowed this revision (*it was revised* / *you closed
    it*)."
  - The old allowance is no longer usable. It is marked `changed` in memory,
    so it cannot be claimed later even if the dependency moves back.
- **A toast** appears on every grant.
- **The artifact card** keeps a persistent "Allowed once (UI/CLI)" badge, and
  the trace carries an `exception` summary.
- **The Ledger drawer** shows the count per stance, the receipts, and Revoke.
- **The debrief view and the export** list every allowance used.
- **Broadcasts** keep open tabs live.

### Revocation

A revoke changes `active` to `revoked` in memory and updates the receipt. A
`consumed` allowance reports "already used by *artifact*".

## 4a. Fit with the attention hierarchy (#430)

The #430 design (`docs/design/attention-hierarchy.md`) sorts what needs you
into lanes. Its lane **F, "Held by your stance"**, is a **read-only record**.
Per that doc's §4.3, F never covers a pending decision, and the bar routes
you somewhere; it never acts. The design states this explicitly: "No Retire
control in the bar … Retire stays in the ⋯ gate log." Allowances fit that
model without any precedence change:

- **Where the action lives.** Allow-once is offered **only** on the hero
  toast and the gate-log entry (§3a). It never appears in the Held line or
  its [Why] disclosure, so Held stays read-only. The [Why] of a Held item
  links to its gate-log entry, where the action is.
- **A grant takes the hold out of the Held count.** Today the Held items come
  from `NextUpBar.tsx:186-188` (at 842f4495), which counts unread blocks
  newer than the single `lastSeenAt` timestamp.
  - A grant sets the block entry's new `seenAt`, written by the daemon, and
    updates its title state to "'*stance*' stopped: … · allowed once".
  - The holds filter also excludes entries that have `seenAt`, so the
    **Held count drops** as soon as you allow.
  - Revoke, end or expiry does **not** put the entry back into Held. Nothing
    new has been blocked. The gate log shows the new state.
- **A changed dependency raises Held honestly.** A refusal for a changed
  dependency records a **new** block entry (§7). The entry is unread, so
  **Held rises by one**. That is accurate: there is a new block you have not
  seen. The old entry stays seen and shows `changed`, with a link to the new
  one.
- **Decide.** The artifact that was admitted lands as an ordinary draft in
  the **Decide** lane. Its "Why" line reads "Admitted under your allowance
  (*UI/CLI*) for '*stance*': *reason*". It also keeps its card badge (§4).
  The admission changes **no** lane order or precedence.
- **Announcements.** Every allowance announcement goes through the bar's
  existing `next-up-announcer` (§3a), so #430's rule of a single live region
  holds.

## 5. Expiry: single-use, until the session ends, capped at 72 hours

**D1 (2026-10-08), with the revision 3 amendment, which only narrows it.** An
allowance is single-use. An unused one ends when its session ends, or 72 hours
after the grant, **whichever comes first**. The ceiling applies
unconditionally.

### Registrations are issued by the daemon

- **On `/register`,** the daemon mints `registrationId` (its `instanceId` plus
  a random part) **and** a per-registration secret, `registrationToken`. It
  returns both to the wrapper.
- **On every later request,** `DaemonClient` sends
  `X-DeepPairing-Registration: <registrationToken>`. These requests include
  `recordPreflightBlock`, the inspect, and the admitted create or revise.
- **Resolution.** The daemon resolves the token to the registration **it
  issued**, and takes `registrationId` from that registration. Any
  `registrationId` in a request body is ignored. A block's binding, and a
  claim's match, therefore always reflect the registration that actually made
  the request.
- **The live map.** It maps `registrationId` to
  `{sessionId, registeredAt, token}`. It sits **next to** today's
  `activeSessions` set and leaves idle-shutdown unchanged.

### "Ended" means the `registrationId` is absent from the live map

There is no pid probing. Absence from the map is the whole test.

| Event | Removes the entry? | Notes |
|---|---|---|
| `/unregister` from that wrapper | Yes | The implementation must **await** unregister in `SIGINT` and `SIGTERM`, with a 500 ms timeout, and must add a **stdin `end`/`close` listener** that unregisters. That is how Claude Code tears down a stdio MCP server. The `exit` handler cannot await, so it stays best-effort. |
| A newer `/register` for the same `sessionId` in split mode | Yes, the older entries | This covers `/mcp` reconnect and `--resume`. In fallback mode older entries are not evicted, because concurrent conversations share the id there. |
| The daemon restarts | Yes, all entries | The registry and the map are both in memory. |
| The wrapper crashes or is SIGKILLed | **No** | The **72-hour ceiling** ends the allowance. Until then, the entry cannot be claimed **through `DaemonClient`**, because only the dead wrapper's `DaemonClient` held that `registrationToken`. A same-user process that reads the wrapper's memory or intercepts the token is in the documented residual. |
| Decision close-out | No | That closes a decision, not a session. |

**A registration that is live and older than 72 hours** has expired allowances,
and the claim refuses them as "expired at *t*". §5 and §7 apply this one policy
throughout, and §10 tests it.

Rejected alternatives:

- **A fixed 24 hours.** Superseded by D1.
- **The session id alone.** It never ends in fallback mode, and it survives
  `--resume`.
- **Pid probing.** Dropped.
- **Reuse for N days.** That is a time-boxed Retire.
- **Permanent.** That is Retire.

## 6. Interaction with preflight, revisions, and the hook

### Admission: replay or complete first, then inspect, then consume atomically

0. **Replay or complete, before anything else** (Astra P2, rev 4
   re-review). The tool computes the call fingerprint and calls the daemon's
   **operation route** (§7) with `{operationId, callFingerprint}`.
   - **When it runs.** This happens before tool-level early returns, which
     includes N2's in-memory dedup. It also happens before `revise_artifact`'s
     closed-parent check. A half-finished revision has often already
     superseded its parent, and that check would wrongly refuse the retry.
   - **If a stamped operation exists** in this session for that
     `operationId` or `callFingerprint`, the daemon **completes any missing
     follow-ups** and returns the original result. The tool returns that
     result unchanged.
   - **If none exists,** the tool continues to step 1.
1. **Resolve.** Run `resolveProposal`, which produces the snapshot and its
   preconditions (§2). Run the gate. It blocks on session stance **S**.
2. **Inspect, which does not consume.** A read-only `GET` returns `active`
   allowances for the calling registration whose call fingerprint matches,
   and which have not ended or expired. If there are none, the tool returns
   the block.
3. **Re-gate.** Re-run `runPreflight` with the candidates' stances removed,
   for this call only. If anything else blocks, return **that** block and
   consume nothing. A proposal that matches two stances needs an allowance
   for each.
4. **Consume, together with the mutation.** Call the operation route with
   `{operationId, callFingerprint, exceptionIds[], snapshot, preconditions}`.
   In one daemon section, the route:
   - claims the allowances;
   - re-verifies the preconditions;
   - creates **the stored snapshot**;
   - runs the follow-ups.

   If the claim or the precondition check fails, the tool returns the normal
   block, with the reason.

### Revisions need a new allowance

`revise_artifact` re-gates under `revise_artifact` with the revised content.
**An allowance never carries along the artifact lineage.** A revision that no
longer matches passes anyway. One that still matches needs its own allowance.
The `operation.artifactId` link is kept for audit only.

### What the agent sees

- **On a block:**

  > If this is a false positive, ask your pair to choose **Allow this
  > proposal once** on the block card. Then retry this **identical** call
  > (every argument the same, not only the matched text). You cannot grant
  > this yourself.

- **On admission:**

  > Admitted once under an allowance your pair granted (*UI/CLI*) for stance
  > "*S*" (reason: "*…*"). It covered this exact version only. If you revise
  > this artifact and the revision still matches the stance, your pair must
  > allow it again. The stance still applies to everything else. A direct edit
  > carrying this content will still prompt your pair.

- **On a replay:**

  > Already admitted. Returning the original result for *art_x*. Nothing new
  > was created.

  Any follow-ups that were missing are finished first.
- **When the proposal changed underneath the allowance:** the usual block,
  plus this line.

  > The proposal your pair allowed depended on *art_x* / the state of
  > *art_y*, which changed. Ask your pair to allow the new version.

- **When an allowance is used, revoked, ended or expired:** the usual block,
  plus one line naming which.

### The direct-edit hook: unchanged in v1 (D5 open)

The Edit/Write/MultiEdit hook keeps asking. An allowance lifts a refusal. It
never removes a prompt. The new Bash matcher and the guardrail class only add
prompts.

## 7. Concurrency, write ordering and idempotency

### One authoritative operation route

Every admitted mutation, and every replay or completion of one, goes through
a single daemon route:
`POST /api/internal/sessions/:sid/operations/:operationId`. The same route
serves both tool shapes, **create** (`present_*`) and **revise**
(`revise_artifact` supersede). Its handler, `runOperation`, is also what the
daemon runs at session load to finish operations that a crash left
incomplete.

Each **tool invocation** mints one `operationId` before it sends anything.
The same id rides every transport attempt, including `DaemonClient`'s
transparent retry. The registry is in memory.

Single-threaded JavaScript does **not** serialize across awaited flushes
(Astra's acceptance condition 1). Every call to `runOperation`, and every
grant, revoke and startup reconciliation, therefore runs inside an explicit
**per-session operation queue**. The queue is held from the claim, through
the child's persistence and every follow-up, until the final response.

#### The operation record (durable, non-authorizing)

The child artifact carries `admission`, which is written **in the same
flush** as the child. It holds enough to rebuild every follow-up. It **never**
authorizes anything: a replay reads it to report and finish an operation, not
to create new authority.

| Field | Purpose |
|---|---|
| `operationId`, `callFingerprint`, `effectiveDigest` | Replay lookup by either retry shape. |
| `kind` | `create` or `revise`. |
| `exceptionIds`, `grantedVia` | Audit. |
| `followUps` | The planned steps, with ids minted **before** the child is written. See below. |
| `completedAt?` | Set, and flushed, only after every follow-up has been confirmed. |

`followUps` holds:

- `supersede: {parentId}` for a revise;
- `comment: {id: "cmt_op_<operationId>", artifactId: parentId, content}` for
  a revise;
- `decision: {decisionId, …record}` for a decision, on create or revise;
- `planReview: true` for a plan revise;
- `trace: true`, which persists the preflight trace;
- `taskStatus: {parentId}`, the MCP-side task notification. It is the only
  step that is not durable, and it is re-sent idempotently after a replay.

#### `runOperation(operationId, callFingerprint, request?)`

1. **Look up the operation.** Search this session for a child stamped with
   `admission.operationId === operationId`. If there is none, search for one
   stamped with `admission.callFingerprint === callFingerprint` (an
   agent-level retry, which has a new `operationId`).
   - **If found,** this is a replay. Go to step 4. **Authorization and
     preconditions are not re-checked,** and the parent's closed status is
     not checked either.
   - **If not found and the request carries no admission,** return "none".
     This is the step-0 probe, and the tool continues.
2. **Claim, in memory.** Every listed allowance must:
   - be `active`;
   - belong to the **issued** registration and to this session;
   - match the call fingerprint;
   - have an `effectiveDigest` equal to the stored one;
   - not be ended or expired;
   - still have its stance row in a fresh read of `preferences.json`.

   Then the daemon **re-resolves the preconditions** from its own store (§2).
   If any check fails, it refuses and nothing changes. Otherwise it marks the
   allowances `consumed`.
3. **Create the child** from the **stored snapshot**: fresh `art_` id,
   `followUps` ids minted now, and the `admission` stamp. **Flush before going
   on.** A throw before anything is persisted reverts the claim (release only
   on proof), and `createArtifact` must be all-or-nothing on a throw.
4. **Complete the follow-ups,** in a fixed order. Each step checks its own
   effect before acting, so running it twice is harmless.
   - **(a) Supersede the parent,** with reason `agent_supersede`, unless it
     is already `superseded`. If the parent was closed by a human in the
     meantime (`rejected` or `obsolete`), the daemon leaves it alone and
     records `followUps.supersede.skipped = <status>`. It still completes
     the rest, because the child exists and its lineage must be honest.
   - **(b) Add the comment** `cmt_op_<operationId>`, unless a comment with
     that id exists.
   - **(c) Record the decision request** `decisionId`, unless it is already
     recorded.
   - **(d) Record the plan review,** unless it is already recorded.
   - **(e) Persist the trace,** keyed by artifact id.
5. **Flush, then set `completedAt` and flush again.** Update the block-log
   receipt to `used`.
6. **Respond** with the original result: the child id, plus the decision id
   where there is one. The response includes `replayed: true` when step 1
   found the operation. The tool sends `taskStatus` after it gets the
   response; that step is idempotent.

**Startup reconciliation.** When the daemon loads a session, it runs steps
4–5 for every stamped child that has no `completedAt`. A crash at any point
after the child's flush is therefore completed even if the agent never
retries. A crash **before** the child's flush leaves no stamp and no
allowance, because the registry is in memory and a restart ends the
registration anyway. That outcome is fail-closed: the retry is blocked as
"ended", and the receipt shows "ended (not used)".

**When the response is lost.**

- **The transparent retry** has the same `operationId`, so step 1 completes
  any remaining follow-ups and replays.
- **An agent-level retry** has a new `operationId` but the same fingerprint.
  Step 0 of §6 completes the operation and replays it.
- **After a restart,** both cases still work: startup has already completed
  the operation, and the stamp is in the flushed `artifacts.json`.

**Release only on proof.** An allowance is reverted only for a throw inside
step 3, and only when **neither** of these has happened:

- bytes have been persisted;
- the child or its stamp is held in an in-memory or deferred write buffer
  that could still commit.

That is Astra's acceptance condition 2. A failed flush is **not** proof that
nothing happened. The MCP tool never releases anything.

### Races

- **Two identical calls.** Claims are serialized by the per-session operation
  queue, so only one sees `active`. A second call with the same
  `operationId`, or the same fingerprint after commit, replays the first.
- **Revoke or Retire against a claim.** These are also serialized, and either
  order is safe.
- **A dependency changes between grant and claim.** For example, a newer
  `code_change` lands for the file, or the target is revised. Step 2's
  re-resolution refuses with `stance_exception_dependencies_changed`. In the
  same queued operation, the daemon marks the allowance `changed`. The tool
  then returns a block for the **new** effective snapshot. That block is
  recorded with `supersedesAllowanceId`, and the old receipt gets
  `supersededByBlockId` (§4). You see "The agent's proposal now depends on a
  newer *art_x*. Allow the new block if you still want it." You can then allow
  the new block.
- **Lock-free readers** see atomic snapshots of `preferences.json`, and
  allowances are never written there.

## 8. Alternatives considered

| Alternative | Why it was rejected |
|---|---|
| **Retire, then re-reject** | Every session is unguarded on the stance in between. It records a global approval. Re-rejecting depends on memory. It records no reason. |
| **Edit the stance's wording** | That is a permanent policy change that can open paraphrase holes. It is a separate follow-up. |
| **Snooze the stance for a session** | This is the broad session bypass the issue rules out. |
| **A path-scoped exception** | Deferred, as the issue prefers. |
| **An MCP "request exception" tool** | The block card already is the request. Deferred. |
| **"Approved" stated in chat** | Chat is not authority. |
| **A projection-only, token-set or validated-content digest** | See §2. |
| **Carrying the allowance along the revise lineage** | See §6. It reuses authority across changed content. |
| **Persisting active allowances in `preferences.json` under `mutatePreferences`** (revisions 1–3) | **Superseded by O1.** Durability bought nothing, because a restart ends grants anyway. It added a schema, retention, migration and reconciliation of unknown states. It also left a file through which an edit could create authority. Its one advantage was a single locked transaction covering both the stance check and the grant check. The daemon's single thread already serializes a fresh stance read with the claim, so nothing is lost by dropping it. |

## 9. Migration, backward compatibility and docs impact

### Schema

Only new optional fields are added, per CLAUDE.md.

| Where | New optional fields |
|---|---|
| `Artifact` (shared) | `admission?: {operationId, callFingerprint, effectiveDigest, kind, exceptionIds, grantedVia, followUps, completedAt?}`. This is non-authorizing operation metadata (§7). |
| `PreflightTraceSchema` | `exception?` |
| `PreflightBlockEntry` | `callFingerprint?`, `effectiveDigest?`, `snapshot?`, `preconditions?`, `projectionPreview?`, `stance?`, `registrationId?`, `eligible?`, `allowance?` (the receipt) |
| `preflight_blocked` event | `callFingerprint?`, `snapshot?`, `preconditions?`, `rejectedAt?` |
| `/register` response | `registrationId?`, `registrationToken?` |

- **`preferences.json` is unchanged.** There is no migration.
- **Old wrappers** send no registration token, so they can never claim. That
  fails safe.
- **Downgrade.** An older daemon ignores the new block-log and artifact
  fields, and it holds no allowances.
- **Error codes:**
  - `stance_exception_block_not_found`;
  - `stance_exception_not_eligible`;
  - `stance_exception_reason_required`;
  - `stance_exception_interactive_required`;
  - `stance_exception_claim_refused`;
  - `stance_exception_dependencies_changed`.

### Docs: the guarantee wording DOES change

Implementation PRs must update the following (line numbers at 842f4495):

| File and lines | Change |
|---|---|
| README L33–35 (top summary: "One click on 'Retire this stance' clears it.") | Becomes: "One click on 'Allow this proposal once' lets that exact proposal through and keeps the stance. 'Retire this stance' deletes it." |
| README L45 (enforcement screenshot caption, which says "a one-click override", and `docs/assets/enforcement.png`) | Rewrite the caption to name both actions. Recapture the image with the new block card. |
| README L190–191 (`present_*` row) | Add: "unless you allowed that exact proposal once (UI or interactive CLI); the artifact then carries an 'Allowed once' badge." |
| README L197–199 (direct-edit row: "doesn't see `Bash`") | Becomes: "It doesn't check `Bash` against your stances; one narrow `Bash` check asks before the shell grants a stance allowance, and that is the only Bash command it looks at." |
| README L223–227 ("False positives and overrides") | Split into **Allow once** (exact proposal, until the session ends or 72 h, stance kept, held in memory, nothing mirrored) and **Retire** (delete). |
| FAQ L39–49 and L59–63 | Split Retire from Allow once. State that Allow once is **not** mirrored to the ledger and writes no approval. |
| `claude-plugin/skills/pairing-protocol/SKILL.md` L620–623 | Add the identical-retry exception: retry only after your pair says they allowed it once. Never try to grant it yourself, and expect a prompt if you try. |
| `SECURITY.md`, threat model | Add the residuals: human-only by design, not by enforcement. A same-user process can script a pty, evade the Bash substring check, or call the bearer route. Receipts are not tamper-evident. |
| `preflight-validator.ts` block message and hook reason text | Use the §6 wording. |
| **Retire behaviour change** (`ToastLayer.tsx:157-163`; README L33–35 and L223–227; FAQ L39–49 "one-click overridable" and L59–63 "one click from an override"; the L45 screenshot) | Retire is no longer a one-click link on the toast. It sits on the gate-log entry and in the Ledger drawer, behind a one-step confirm. Every "one click" wording about Retire changes, and the screenshot is recaptured showing **Allow once** as the primary button. |
| `docs/design/attention-hierarchy.md` F / §4.3 | Add a note: an allowance marks its hold seen, a dependency-changed refusal adds a new hold, and Decide's "Why" carries the allowance line. Held stays read-only. |

## 10. Test plan

Fakes, not mocks:

- a real `FileStore` on a temp dir;
- a real daemon, with real child processes for wrappers and the CLI;
- an injected clock;
- a fault-injecting fetch shim in front of `DaemonClient`.

### Unit

- **Call fingerprint.**
  - It is computed from **raw** args, and two identical raw calls produce
    the same fingerprint even if the history changed.
  - It is stable across key order.
  - Every argument changes it.
  - `params._meta` and `arguments._meta` do not change it.
  - Whitespace, case and NFC versus NFD change it.
- **Effective snapshot and preconditions.**
  - `resolveProposal` captures every derivation listed in §2: the
    reconstructed `before`, the corrected `changeType`, and for a revise, the
    inherited title, provenance (never `headSha`), stakes, refs, feature,
    `parentId`/`version`, and the dropped review state.
  - The `effectiveDigest` changes whenever any captured field or precondition
    changes.
  - A schema-driven test fails if any tool's resolution reads store state
    without declaring a precondition for it.
- **Matching is unchanged.** The projection, and therefore the matching
  behaviour, is identical to today.
- **Registry state.**
  - These transitions work: active, consumed, finalized; active, consumed,
    reverted (on a throw inside the section); active, revoked.
  - "Ended" is derived: an unregistered registration, a new daemon instance,
    and split-mode eviction (fallback mode does not evict) all count as
    ended.
  - At `ceilingAt` the allowance is **expired even when the registration is
    live**. One millisecond earlier it is still admitted.
- **Registration resolution.**
  - A request that carries a body `registrationId` for a *different*
    registration is bound to the caller's issued registration.
  - A missing or unknown `registrationToken` cannot claim.
- **Multiple stances.**
  - An allowance for A, on a proposal that also matches B, blocks on B, and
    A stays `active`.
  - Allowances for both A and B are consumed together in one claim.

### Adversarial

1. **Self-grant.**
   - The authority-surface test.
   - 401 without a bearer token. 400 for extra fields. 404 for an unknown
     block.
   - Team, demo and retired stances are refused.
   - Inspect never consumes: 100 inspects leave the allowance `active`.
2. **Changes to non-projected content.** Grant P (`present_code_change`).
   Then submit the same `filePath`, `reasoning` and `concept` with a changed
   `after`, then with a changed `before`, then with a changed
   `concept.description`. Each is **blocked**, and P stays `active`. Do the
   same for a decision's pros and for a research evidence snippet. The
   schema-generated equality test covers every input key of every tool.
3. **Paraphrase.** A one-character change, a reorder, an alias, a trailing
   clause, and a different tool are each blocked, and P stays `active`.
4. **Dropped response after commit.**
   - **Transparent retry.** One artifact, and the receipt says used.
   - **Both attempts fail.** The tool errors, the allowance stays `consumed`
     (not re-armed), and the agent's identical retry gets the **original**
     artifact back through digest replay. Exactly one artifact exists.
   - **Commit, drop, daemon restart, retry.** The stamp replays the original
     result. One artifact, nothing re-armed.
   - **Daemon killed between claim and create.** No artifact. After the
     restart the retry is blocked as "ended", and the receipt shows "ended
     (not used)".
   - **A throw inside the section.** The claim is reverted, and the retry is
     admitted.
   - **`revise_artifact`.** All of the cases above, plus: one new version, one
     supersede, and one carryover comment.
5a. **The effective proposal changes after the grant, with identical raw
    args** (Astra P2, rev 4 re-review). In every case below the allowance
    must **not** admit a different effective proposal. The claim is refused
    with `stance_exception_dependencies_changed`, the allowance stays
    `active`, and no artifact is created.
    - `present_code_change` with `before` omitted: after the grant, a newer
      `code_change` for the same file lands, so the reconstructed `before`
      would differ. Then try again with the prior's `after` edited instead.
    - `present_code_change` with `before` omitted and **no** prior at grant
      time: a prior appears before the claim, so `changeType` would flip from
      `create` to `modify`.
    - `revise_artifact` with the title omitted: the target's title changes
      after the grant.
    - `revise_artifact` of an external changeset: the target's `source`
      provenance changes after the grant.
    - `revise_artifact`: the target is revised (its version moves), or the
      target is closed by the human, after the grant.
    - **Control:** with no dependency changes, the created artifact is
      byte-equal to the snapshot shown in the preview, apart from minted ids.
    - **Created from the snapshot, not the client's content:** a fault shim
      alters the client-resolved content but keeps the fingerprint. The claim
      is refused because the hashes are not equal. Nothing the client
      resolved is persisted.
    - **Replay skips re-authorization:** commit, then change a dependency,
      then retry. The original result is returned with `replayed: true`, and
      no refusal is raised.
5b. **Crash or restart mid-revision** (Astra P2, rev 4 re-review). Kill the
    daemon at each point:
    - after the child's flush;
    - after the supersede;
    - after the comment;
    - after the decision record;
    - after the plan review;
    - before `completedAt`.

    At each point, check all three recovery paths:
    - the transparent retry, with the same `operationId`;
    - an agent-level retry, with a new `operationId`, the same fingerprint,
      and the parent already `superseded`. This proves step 0 runs
      **before** the closed-parent check and N2's dedup;
    - startup reconciliation, with no retry at all.

    Every successful replay must leave:
    - exactly **one** child;
    - exactly **one** `cmt_op_<operationId>` comment;
    - the parent `superseded`, or `skipped` with its human-closed status
      recorded;
    - exactly one decision record, where the type is a decision;
    - the plan review recorded, where the type is a plan;
    - the trace persisted;
    - `completedAt` set.

    Repeat the same for the `present_options` create path, which has a
    decision follow-up.
5. **CLI grant.**
   - **Refused input.** Non-TTY input, every non-interactive flag, a
     missing or short reason, and `CLAUDECODE=1` are each refused, with
     nothing changed.
   - **No daemon.** If the daemon is down, the grant is refused.
   - **Token discovery.**
     - With `XDG_RUNTIME_DIR` set and a sidecar written by `tokenPlacement`,
       the CLI finds the token and stamps `X-Project-Hash`.
     - With the sidecar absent, it falls back to `daemon.json`.
     - With the wrong hash, the request gets 403.
   - **Origin label.** Grants are labelled `cli`.
6. **The Bash hook.**
   - **Fable's one-liner returns `ask`.** Feed the hook
     `printf 'reason\nallow\n' | script -qc 'env -u CLAUDECODE deeppairing stance allow <id>' /dev/null`.
     The same goes for these variants:
     - the plain command;
     - a `bash -c` wrapper;
     - a `python -c` wrapper;
     - `STANCE ALLOW` and `Stance Allow` (case-insensitive);
     - `stance\tallow` and `stance\nallow` arriving JSON-escaped in
       `tool_input`. The test proves the hook decodes before matching.
   - **Both registrations exist and match.** The entry is present in
     `claude-plugin/hooks/hooks.json` **and** in `init`-generated settings,
     and the parity test pins them.
   - **An allow rule does not pre-empt it.** Run a real Claude Code headless
     session whose settings allow `Bash(deeppairing:*)`, and invoke
     `deeppairing stance allow x`. The run must surface the `ask`
     permission request, not run the command. This is flagged for the
     reviewer as a check against the live platform.
   - **Narrowness.** Over a corpus of 200 ordinary commands (including
     `grep -ri stance`, `echo allow`, and `deeppairing stance exceptions`),
     the hook produces no output and exits 0. The `sh` matcher stays within
     its latency budget.
   - **Documented residuals pass.** `s=stance; deeppairing $s allow` is not
     caught. A scripted pty with `CLAUDECODE` unset grants and is labelled
     `cli`.
7. **Direct file edits.**
   - Edit and Write to `.deeppairing/preferences.json` or `team.json` return
     `ask`, even with a live ceremony and inside the dedup window. Other paths
     are unaffected.
   - **Writing a fabricated allowance into `preferences.json`, the block log
     or a session file arms nothing.** The proposal stays blocked. This
     replaces revision 3's "consistent hand-written grant is admitted"
     residual test.
   - **A hand-written `admission` stamp is non-authorizing.** A forged stamp
     in `artifacts.json` can make a replay **return that existing
     artifact**. It never creates an artifact, never admits a new or changed
     proposal, and never consumes or arms an allowance.
8. **Session end and expiry.**
   - An awaited SIGTERM unregisters, so the retry is "ended".
   - Closing stdin unregisters, so the retry is "ended".
   - After a SIGKILL the registration lingers. The allowance is admitted
     until `ceilingAt` and expired at that moment.
   - `/mcp` reconnect and `--resume` evict in split mode.
   - A daemon restart ends the allowance.
   - In fallback mode, wrapper 2 cannot claim wrapper 1's allowance.
   - A live registration older than 72 hours has expired allowances.
9. **Revisions.**
   - An admitted proposal, revised so it still matches, is blocked.
   - A revision that no longer matches is admitted without an allowance.
10. **Detection reaches the human.**
    - A grant raises a toast, with the CLI styling for CLI grants.
    - The artifact card keeps its badge.
    - The debrief system section and the exports list the allowance.
    - An agent-written debrief cannot suppress that section.
11. **Idempotency and leakage.**
    - A double grant returns the same id.
    - Revoking a used allowance reports "already used".
    - With publishing on, there are no global-ledger writes, and
      `approvedPatterns` is unchanged.
    - A payload the secret scan flags is not persisted, and its block is not
      eligible.
12. **The Edit/Write hook is unchanged (D5 open).** It still returns `ask`.

### Web

- **Dialog semantics.** The dialog has `role="dialog"` and
  `aria-modal="true"`. `aria-labelledby` resolves to the heading that names
  the stance, and `aria-describedby` resolves to the scope sentence.
- **Focus.**
  - Initial focus is on the **heading**, not the reason field.
  - Tab and Shift-Tab cycle inside the dialog (the trap).
  - On close, focus returns to the button that opened the dialog.
- **Keys.**
  - Enter with a valid reason confirms. Enter with an empty reason, a
    two-character reason or a whitespace-only reason does nothing, and the
    hint is announced.
  - Esc cancels and sends no request.
- **Placement and targets.**
  - Allow-once is the primary button on the toast and on the gate-log
    entry.
  - The toast renders **no** Retire control.
  - Every action control has a computed hit target of at least 32×32 px.
  - The toast's auto-dismiss pauses on hover or focus and while the dialog
    is open.
- **The Retire confirm.**
  - **Retire…** opens the confirm, with initial focus on **Cancel**.
  - Pressing Enter immediately after opening it, and pressing Esc, both
    leave the stance intact and send no request.
  - Only activating **Retire** sends the request.
- **Announcements** go through `next-up-announcer`. A grant, the change from
  allowed to used, and the change to changed each produce the specified
  text. No second live region exists.
- **Errors.** On a 503 or a 409 the dialog stays open.
- **Preview.** The two-part preview renders a `code_change` diff, the
  "`before` reconstructed" note, and decision pros and cons.
- **States.** Every state renders: allowed, used, **changed**, revoked,
  ended, "ended (not used)", expired.
- **Changed.** Trigger a dependency-changed refusal. Then check that:
  - the old entry reads "The agent's proposal now depends on a newer
    *art_x*. Allow the new block if you still want it.";
  - the "new block" link focuses the new entry, and the new entry links
    back with "Replaces the proposal you allowed at …";
  - the old allowance cannot be claimed even after the dependency is
    restored.
- **Fit with #430.**
  - A grant drops the Held count by one.
  - A dependency-changed refusal raises it by one.
  - Revoke, end and expiry do not put the hold back.
  - Held and its [Why] render **no** Allow or Retire control.
  - The admitted artifact's Decide "Why" line reads "Admitted under your
    allowance …".

## 11. Decisions (recorded)

- **D1 (Mitch, 2026-10-08). Allowance lifetime: until the session ends.**
  "Ended" means the issued `registrationId` is absent from the daemon's live
  map (§5).
  - *Amendment (rev 3), which only narrows D1:* the 72-hour ceiling applies
    unconditionally.
- **D2 (Mitch, 2026-10-08). CLI grant: yes, from both the UI and the CLI.**
  - The CLI requires an interactive TTY, refuses non-interactive flags and
    agent-shaped environments, and needs a typed reason and a typed
    `allow`. `grantedVia` records `ui` or `cli`.
  - *Rev 3:* the CLI writes through the daemon's bearer route. A narrow Bash
    `ask` covers `stance allow`. Grants surface as a toast, a badge and
    debrief/export entries.
  - *Rev 4:* the token is found through `tokenPlacement` (XDG sidecar or
    `daemon.json`), and requests carry `X-Project-Hash`. The Bash matcher is
    a POSIX `sh` script that decodes JSON before matching and matches
    case-insensitively. It ships in `claude-plugin/hooks/hooks.json` and in
    `init`, and is tested against a `Bash(deeppairing:*)` allow rule.
- **D3 (Mitch, 2026-10-08). The forgery gap is documented, not closed.**
  - *Rev 3:* the claims were narrowed. Receipts cover supported operations
    only and are not tamper-evident.
  - *Rev 4:* in-memory authority means **no file can create an allowance**.
    The guardrail class still asks on agent edits to `preferences.json`
    (stance rows) and `team.json`.
- **D4 (Mitch, 2026-10-08). Own stances only.** Team-rule blocks are out of
  v1.
- **D5 (open). The Edit/Write hook still prompts once after an allowed
  proposal.** This is unchanged. No review has authorized removing it.
- **O1 (resolved in rev 4, Fable's recommendation, which the author
  shared): in-memory only.** Active allowances live only in the daemon's
  registry.
  - A restart already ends grants, because `registrationId` embeds
    `instanceId`, so durable active authority buys nothing.
  - Used grants stay durable through the artifact's `admission` stamp.
  - Unused and revoked grants matter only within the session. They are
    recorded as receipts on the block entry, which only the daemon writes.
  - A crash between claim and create loses the grant. The stamp replays a
    committed result, and the outcome is fail-closed.
  - Dropping persistence removes the schema, retention, migration and most of
    the reconciliation of unknown states. It also closes the hand-written-grant
    residual.

## 12. Review response map

### Rev 6: Astra APPROVE at `043a0579` (conditions); Fable final design/style review (CHANGES)

| Finding | Source | Addressed in |
|---|---|---|
| **LOW.** The CLI preview should be a paged unified diff plus the precondition line, never raw JSON | Fable | §3, the CLI grant "Preview" item |
| **MED.** The dependency-change refusal needs a human-facing "changed" state, written to the human, linked to the allowance it supersedes, and tested | Fable | §4 "Where you see it" and the receipt fields; §4 allowance `state`; §7 Races; §3a announcement; §10 web "States" and "Changed" |
| **MED.** Interaction and accessibility: Allow-once becomes the primary button and Retire moves behind a confirm, with 32 px targets. The dialog gets `role=dialog`, `aria-modal`, labelling by the stance, a focus trap, initial focus on the heading, and Enter with a reason confirms. "Used" is announced via `next-up-announcer`. The Retire behaviour change goes in the docs list | Fable | §3a; §9 docs table (Retire row); §10 web |
| **MED.** Fit with #430: the action lives on the toast and gate log, not in Held or Why. A grant marks the hold seen so Held drops, a changed dependency adds a new block, and the Decide "Why" line names the allowance. Cite `NextUpBar.tsx:186-188` and §4.3 | Fable | §4a; §9 docs table (attention-hierarchy row); §10 web "Fit with #430" |
| Astra's three implementation acceptance conditions | Astra | §13 checklist; §7 wording aligned (operation queue, release only on proof including buffers) |

### Rev 5: Astra re-review of `e4ec4c87` (agrees with O1 and D5; two P2s)

| Finding | Addressed in |
|---|---|
| **P2.** Bind the allowance to the **effective** proposal, not just the raw-call identity. Keep a stable raw fingerprint for locating retries. Snapshot the resolved proposal and its history and target preconditions at the block and grant. At claim, create exactly that snapshot or refuse if its dependencies changed. A replay returns the original result without re-checking authorization. | §2 "Three identities, three jobs", binding table and preview; §3 items 4–5; §4 allowance fields; §6 step 4; §7 `runOperation` steps 1–3 and Races; §9 schema and `stance_exception_dependencies_changed`; §10 unit "Effective snapshot" and adversarial 5a |
| **P2.** A revision replay must complete partial follow-ups before returning success. Use one authoritative daemon path for both operation-id and fingerprint retries, running before closed-parent validation and before any tool-level early return. Persist non-authorizing operation metadata to rebuild the follow-ups. Probe a crash after the child flush and between each follow-up. | §6 step 0; §7 "One authoritative operation route" (operation record, `runOperation` steps 1, 4 and 5, startup reconciliation); §9 `admission` fields; §10 adversarial 5b, plus a test that a forged stamp is non-authorizing (adversarial 7) |
| O1 stays in-memory, and D5 stays open | §4, §11 (unchanged) |

### Rev 4: Fable APPROVE on `6be03359`, with notes

| Note | Addressed in |
|---|---|
| Resolve O1 as in-memory, with the recorded reasoning | §4, §7, §8, §11 O1; §10 adversarial 4 and 7 |
| "Validated arguments" should be **raw args**, as at the N2 call site (`before` is reconstructed from history later) | §1 arg-hashing row; §2 two-digest table; §10 unit digest |
| Bash matcher: case-insensitive, decode JSON before matching, add the entry to `claude-plugin/hooks/hooks.json`, test against a `Bash(deeppairing:*)` allow rule, start with POSIX `sh` | §3 "The CLI grant, and the Bash prompt"; §10 adversarial 6 |
| CLI token may be in the XDG sidecar: use `tokenPlacement` and stamp `X-Project-Hash` | §3 enforcement item 3; §10 adversarial 5 |
| §5: say "through `DaemonClient`", and take the `registrationId` from the issued registration, not the request body | §5 "Registrations are issued by the daemon" and its table; §2 binding; §10 unit registration resolution |
| Two more docs items: README L33–35 and the L45 caption and image | §9 docs table |

### Rev 3: Astra and Fable CHANGES on `f0bd817f`

| Finding | Source | Addressed in |
|---|---|---|
| Idempotent admitted mutations: operation id, replay, release only on proof, create and revise | Astra P1 (Fable concurs) | §7; §10 adversarial 4 |
| Content binding beyond the projection | Astra P2, Fable HIGH | §2; §10 adversarial 2 |
| Audit visibility claim was too strong | Astra P2 | §3 "What the audit trail does and does not promise"; §11 D3 |
| Inspect versus consume | Astra | §6 |
| Single 72-hour policy | Astra | §5; §11 D1 |
| The TTY gate is one shell line away | Fable HIGH | §3; §10 adversarial 5 and 6 |
| Direct Edit to `preferences.json` | Fable MED, Astra P2 | §3 "Direct file edits" (closed by O1 in rev 4; guardrail kept) |
| Lifecycle overstated; pid probing | Fable MED, Astra | §1; §5 |
| Revisions | Fable MED | §6 |
| Docs wording changes | Fable MED | §9 |
| In-memory alternative | Fable LOW | §8; §11 O1 (resolved in rev 4) |
| D5 stays open | Astra, coordinator | §6; §11 |

## 13. Implementation acceptance checklist (Astra, APPROVE at `043a0579`)

Astra approved the **design** at revision 5. That is not sign-off on an
implementation. Each implementation PR must meet these conditions and
include their tests. It must be reviewed independently, and it must keep the
adversarial controls in §10.

- [ ] **1. Explicit per-session operation queue.** Single-threaded JavaScript
  does not serialize across awaited flushes. Hold one queue per
  session/store through the claim, child persistence, every follow-up and
  the final response. Grants, revokes and startup reconciliation go through
  it too.
  - *Tests:* overlapping identical and different requests on one session;
    startup reconciliation racing a live retry. Exactly one child, and
    exactly one of each follow-up.
- [ ] **2. A failed flush is not proof that nothing happened.** Never re-arm
  an allowance while an in-memory child or stamp, or a deferred write, could
  still commit. Release on proof covers pending buffers, not only the bytes
  on disk.
  - *Tests:*
    - real lock failures, then unlock and retry;
    - disk errors such as ENOSPC and EIO;
    - follow-ups happen exactly once;
    - notifications fire for the first successful commit only;
    - all of this **in addition to** the process-crash matrix in §10 (5b).
- [ ] **3. A completed-operation replay is read-only, except for missing
  idempotent effects.**
  - Never replay an old supersede over a terminal state a human set later
    (§7 step 4a skips it and records why).
  - Validate every durable follow-up target against the lineage recorded on
    the child: `parentId`, `version`, `decisionId`, and the comment id
    derived from `operationId`.
  - Receipts stay non-tamper-evident, and are never presented as an
    authenticated human identity.
  - *Tests:*
    - the human rejects the parent between the crash and the replay, and the
      replay leaves the parent rejected;
    - a follow-up target in the stamp is edited to point elsewhere, and the
      replay refuses;
    - the copy in the UI and the export never says "verified" or names an
      authenticated person.
