# One-proposal stance exceptions (proposal, #470)

> **Status: PROPOSAL, revision 2. No code is included.** It is written for
> Astra's scope and authority review, which must happen before any
> implementation starts.
> Revision 2 applies Mitch's decisions of 2026-10-08 (§11). An unused
> allowance now lasts until its Claude session ends, defined in §5, instead
> of 24 hours. Grants can come from the UI **and** an interactive CLI (§3).
> Revision 2 adds the session-end definition, the TTY-gated CLI grant, the
> `ui`/`cli` origin on every grant, and the matching adversarial tests.
> Team rules stay out, and the forgery gap stays documented. The hook
> question is still open.
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
card and in the block log. A matching `deeppairing stance allow` command
works only at an interactive terminal. The allowance is a single-use
exception for the human to grant. It is recorded in this project's
`preferences.json`. It is bound to one stance, one live Claude session, one
tool, and the **exact content** of the proposal the gate refused. The
stance stays in force for every other proposal. Nothing reaches the
cross-project ledger. Retire stays as a separate, clearly worded action.

## 1. What the gate does today (audited)

| Piece | Where | Behaviour that matters here |
|---|---|---|
| Proposal projection | `mcp/artifact-preflight.ts` `artifactProposal` | Per artifact type, picks the strings, paths and named concepts the gate reads (for example, a decision's context, option titles and descriptions, and option concept names). Debriefs and external changesets are `advisory`, so they are never refused. |
| Matcher | `mcp/preflight-validator.ts` `runPreflight` | The session lane runs first, then the team lane. It returns the **first** match only. The matching is lexical: a word-bounded phrase match, stemmed token containment (concepts need at least 2 distinct tokens) and a small alias table. The block message tells the agent to "ask the human to override this block". |
| Refusal | `mcp/tool-helpers.ts` `preflightRejectedApproaches` | When the gate blocks, it broadcasts, persists the block (`store.recordPreflightBlock`), records a metric, and returns `REJECTED_APPROACH_BLOCKED` with `retryable: false`. **The artifact is never created, so a blocked proposal has no artifact id.** `revise_artifact` runs the same path. |
| Block log | `store/preflight-block-log.ts` | `.deeppairing/preflight-blocks.json` is project-scoped and holds the newest 50 blocks. The daemon writes it from the broadcast fan-out (`create-daemon.ts`), and fails soft. Each entry has a server-minted `id`, `sessionId`, `toolName`, `concept`, the matched surface `proposal`, `reason` and `via`. It does **not** store the full proposal. |
| Stance storage | `FileStore.recordRejectedApproach` / `normalizeRejectedApproaches` | `preferences.json` `rejectedApproaches[]` rows hold `{description, reason?, rejectedAt?, sourceArtifactId?, concept?}`. Rows are deduped on the exact `description`. **A rewrite drops any unknown row field**, because `normalizeRejectedApproaches` rebuilds each row from the known fields. |
| Retire | `FileStore.overrideRejectedApproach`, `POST /api/philosophy/override`, `ToastLayer.tsx` "Retire this stance" | Deletes every local row that matches the description or concept. With publishing on, it also records a global `approved` instance. Team blocks are refused (400, "edit team.json"). An agent-reachable twin exists at `POST /api/internal/sessions/:sid/memory/override`, kept "for IStore symmetry". |
| Write path | `FileStore.mutatePreferences` (#408, on #416's `file-lock.ts`) | This is the only way to change `preferences.json`. It runs read → mutate → atomic replace under `preferences.json.lock`, which works across processes and is reentrant within one process. A busy lock throws `ELOCKED` and the routes map it to 503 `lock_busy`. Readers, including the hook, never take the lock. |
| Direct-edit hook | `cli/preflight-hook-core.ts` `evaluatePreflightHook` | Runs the same `runPreflight` on Edit, Write and MultiEdit (file path plus new text), using a lock-free read of `preferences.json` and `team.json`. A match returns `permissionDecision: "ask"` and never `deny`. The hook fails open. |
| Mutation auth | `http/routes.ts` SP1 middleware, `SECURITY.md` | Every public non-GET route needs `Authorization: Bearer <token>`. The browser gets the token from the served HTML. SECURITY.md is honest that any same-uid process can also get it. |
| Guarantee table | README "Your taste compounds", `docs/faq.md` (#432/#436) | `present_*` is **refused**, a direct edit is **asked**, other projects get a **nudge**. Matching is "a strong default, not a guarantee." Retire is documented as a delete. |

Two facts drive the whole design:

- **No artifact exists at block time.** An exception cannot be keyed on an
  artifact id or version. It has to be keyed on the content the gate refused.
- **Retire already sits on the same authority boundary** (a bearer-gated
  public route, plus an internal twin). An exception is strictly narrower than
  Retire, so it must never sit on a *weaker* boundary than Retire does, and
  this design puts it on a stronger one.

## 2. Scope: what gets exempted

### Recommendation: an exact-content fingerprint bound to five things

An exception admits **one proposal** if, and only if, all of the following
match the block the human allowed:

| Binding | Value | Why |
|---|---|---|
| Project | Implicit: the record lives in this project's `.deeppairing/preferences.json` | The issue requires that an exception is never mirrored as a global approval. |
| Stance | The blocking row's `{description, concept, rejectedAt}` (each compared exactly, absent equals absent) | No new stance id is needed. An id would be stripped by an older build's `normalizeRejectedApproaches` rewrite (see §9). Including `rejectedAt` means a stance that is retired and later re-rejected is a *new* stance and does not inherit old exceptions. |
| Session | The block's `sessionId` **and** its `registrationId`, which identifies the live wrapper registration that was refused (§5) | A different session must not reuse the authority, which is what the issue asks for. The registration id also gives "until the session ends" a precise meaning. It keeps fallback mode honest too: when several Claude sessions share one `sessionId`, each still has its own registration. |
| Tool and type | `toolName` and artifact type | The same text sent through a different tool projects differently and is a different proposal. |
| Content | `proposalDigest`: SHA-256 over a canonical serialization of the **full gate projection**, which is `{type, text[], paths[], concepts[]}` from `artifactProposal` | This covers exactly what the gate reads. The digest is computed by the **daemon** from the projection it stores, never taken from the client (see §3). |

Canonicalization is deliberately minimal: Unicode NFC, CRLF to LF, and
trimming each string. That is the same trim and drop-empty step
`artifactProposal` already applies. The order of arrays is kept. There is
**no** case folding, stemming, stopword removal or alias mapping.

### Why not the other two candidates

- **A normalized-token fingerprint (rejected).** The matcher's own
  normalization throws away word order and stopwords, and `not` is a stopword.
  *"Do not keep global mutable state"* and *"keep global mutable state"* reduce
  to the same token set. A fingerprint built in that space would admit the
  opposite proposal. Every step that makes matching broader makes an exception
  more reusable. The exception should be as narrow as the matcher is broad.
- **Artifact id or version (rejected).** No artifact exists when the gate
  refuses. Minting a "pending" artifact for blocked proposals would put a
  refused proposal on the review surface, which is the thing the gate exists
  to prevent.

### Why this closes the paraphrase loophole

- Any change to any gated string produces a different digest, so the next
  call is checked against every stance as usual. That includes one character,
  whitespace inside a string, letter case, order, an added option, or a
  different path. A near-copy does not "sneak through". It is *blocked* by the
  same lexical matcher as before. The exception never widens what the matcher
  admits. It only lifts one stance for one already-seen byte sequence.
- **The exception lifts only its own stance.** `runPreflight` returns the
  first match only, so the design re-runs the gate with the excepted row
  removed from `rejectedApproaches` for that call only. If another session
  stance or a team rule still matches, the proposal is blocked on that one and
  the exception is **not** consumed.
- **It is single-use** (§5). Even the identical content passes once.
- **It never feeds the matcher or the ledger.** It is not added to
  `approvedPatterns` and writes no global `recordInstance`. The cross-project
  advisory dedupe (`localKeys`) still sees the stance. Gate-escape telemetry
  and the near-miss residual counter skip traces admitted by an exception.
- **It admits a proposal to review, not to approval.** The artifact still
  lands as a draft in the companion UI for your verdict. The exception
  removes a false refusal. It does not approve anything.

Fields that are not projected, such as evidence snippets and option pros and
cons, are not covered by the digest. That is correct, because the gate never
reads them. Exempting the gated projection exactly is the same coverage the
gate has today, with nothing added.

### Size limit

The block event must carry the canonical projection so the daemon can store a
preview and compute the digest. Above 32 KiB of projection the block is still
recorded, but the card offers **no** allow-once button. Instead it says "This
proposal is too large to allow once. Retire the stance or ask for a smaller
proposal." This keeps `preferences.json` and the block log small.

## 3. Authority: who can grant

### Invariant A1: the agent has no sanctioned way to create an exception

> No MCP tool, MCP tool argument, `IStore` method, `DaemonClient` method,
> `/api/internal/*` route, hook output, or **non-interactive** CLI invocation
> can create a stance exception. Exactly two things can create one, and both
> call the same `FileStore` grant function:
> - the public route `POST /api/preflight-blocks/:blockId/exception`, which
>   the companion UI calls after an explicit human gesture;
> - `deeppairing stance allow <blockId>`, which refuses unless a person
>   confirms it at an interactive terminal (see "The CLI grant" below).

How it is enforced:

1. **Structural absence plus a test that pins it.** The grant function exists
   on `FileStore` only. It is *not* added to `IStore`, so `DaemonClient`
   (the agent-side store in the production plugin path) cannot call it, and
   no internal route exposes it. An **authority-surface test** enumerates:
   - every registered MCP tool's input schema, which must not grant;
   - `IStore` and `DaemonClient` method names, which must have no
     `grant*Exception`;
   - every `/api/internal/*` route, which must have no exception-creating route;
   - every CLI subcommand, where `stance allow` must be the only one that
     reaches the grant function, and it must sit behind the interactive
     guard.

   The test fails if any of these changes. This follows the
   `review-authorization.ts` lesson, "prose is not a gate": the check is in
   code, with one grant function, two callers, and no force flag.
2. **Both doors take a block id, not a scope.** The UI body is `{reason}`
   and nothing else. The CLI takes the block id as its only argument, and you
   type the reason at the prompt. The grant function looks up the
   server-minted block entry and copies the stance, session, registration,
   tool, type and projection from that **durable record**. It computes the
   digest itself. Neither caller can widen the scope, choose a stance, or name
   content. Any extra body fields or flags are rejected (400, or a CLI usage
   error). If the block id is unknown or has been pushed out of the log, the
   grant returns "not found: retry the proposal to get a fresh block".
3. **What you see is what you allow.** The block event is agent-side data: the
   MCP process posts it through `DaemonClient.recordPreflightBlock`. Suppose
   the event were forged. The grant still derives the digest from the *same*
   stored projection that the dialog or terminal prompt shows you. A forged
   event can therefore only get you to allow the exact text in front of you.
   It cannot get you to allow different content hidden behind a matching
   preview.
4. **Shared guards on both doors.**
   - The UI route also needs the SP1 bearer token and the project hash, like
     every mutation.
   - Both refuse `source: "team"` blocks (D4) and `demo_` sessions.
   - Both refuse a block whose stance row no longer exists ("stance already
     retired").
   - Both refuse a block whose session has already ended (§5). Granting
     something that could never be used would only be noise.
5. **Every grant records its origin.** `grantedVia` is `"ui"` or `"cli"` and
   is shown on every surface that shows a grant (§4).

### The CLI grant (decided 2026-10-08, D2)

`deeppairing stance allow <blockId>` follows these rules, checked in order.
Any refusal exits non-zero and writes nothing.

1. **It refuses unless both stdin and stdout are TTYs.** That means
   `!process.stdin.isTTY || !process.stdout.isTTY` refuses, with "Run this in
   your own terminal; it needs you to confirm by typing."
2. **It has no non-interactive flags.** `--yes`, `-y`, `--force`,
   `--non-interactive`, `--reason` and any other unknown flag are refused,
   not ignored. The reason cannot be passed as an argument; you type it at
   the prompt.
3. **It refuses an invocation that looks like the agent's.** That means
   `CLAUDECODE=1` (Claude Code sets this in the shells it spawns) or `CI` set
   in the environment. This is a heuristic, and it is documented as one: it
   catches the agent's own shell even in a future where that shell has a TTY.
   You can still run the command from any terminal you opened yourself.
4. **It shows exactly what you are allowing.** It prints the stance (its
   description, concept and your original reason), the session it is bound
   to, the tool and type, and the **full proposal preview**, the same
   projection the UI dialog shows. A preview longer than one screen goes
   through the pager and has to be viewed to the end.
5. **It asks you to type a reason** (3–280 characters after trimming, the
   same rule as the UI). An empty or too-short reason is asked for again, and
   the command gives up after three tries. Ctrl-C or EOF cancels and writes
   nothing.
6. **It asks you to type `allow` to confirm.** A bare Enter or `y` is not
   enough, so a reflexive keypress or a stray `yes`-style input stream does
   not confirm.
7. It then calls the grant function through its own `FileStore`, under
   `mutatePreferences`, with `grantedVia: "cli"`. This is the cross-process
   lock path tested in §10. It prints the exception id and the scope in plain
   words.

The CLI also offers `deeppairing stance exceptions` (list) and
`deeppairing stance exceptions revoke <id>`. Those stay non-interactive,
because listing exposes nothing new and revoking only narrows authority.

**What the TTY rule does and does not prevent, stated plainly:**

- It **does** stop the agent's normal path. Claude Code's Bash tool runs
  commands without a TTY today, and also sets `CLAUDECODE=1`, so an agent that
  runs `deeppairing stance allow …` gets a refusal telling it to ask you.
- It **does** stop piping, `yes |`, a heredoc, a `--yes` flag and CI.
- It does **not** stop a determined local process. Anything running as your
  user can make a pseudo-terminal (`script`, `expect`, Python `pty`,
  `node-pty`), read the prompt and type into it. It can also unset
  `CLAUDECODE`. A process that can do that can just as easily edit
  `preferences.json` or `curl` the bearer-gated UI route. The CLI adds no
  power that was not already there. It removes the one easy path.
- It does **not** prove a human typed the answers. deepPairing has no
  identity system. `grantedVia: "cli"` records which door was used, not who
  used it.

This sits alongside the forgery gap below. The response to both is the same:
the agent gets no sanctioned path, and any forged grant is visible.

### The honest residual: the forgery gap (decided 2026-10-08, D3)

The agent runs as your user and has `Bash`. A same-uid process can:

- read the bearer token and `curl` the grant route;
- drive the CLI through a scripted pseudo-terminal;
- edit `preferences.json` directly.

The same is true today for Retire, for verdict routes, and for decision picks
(`SECURITY.md`, the SP1 comment in `http/routes.ts`). This design does
**not** claim to close that hole, and the docs must not say
"cryptographically human-only". Their wording will be "human-only by design;
visible if forged". What the design does guarantee:

- **The agent has no sanctioned path.** Forging a grant means misusing the
  API, the CLI or the file out of band. Those are the same routes a forged
  Retire would use, and Retire does more damage.
- **A forged grant is visible.** Every grant is broadcast and persisted with
  `grantedVia`. It shows in the block log, the gate log and the Ledger
  drawer, with an origin badge (`UI` or `CLI`). Every admission by exception
  is stamped on the artifact's preflight trace and shown in its breadcrumb
  ("Admitted once by your exception (CLI): reason …"). A grant you did not
  make shows up next to an artifact you did not expect.

Optional speed bump, not a security claim: the UI route could also require
an `Origin` header of the daemon's own origin or `vscode-webview://`. A
browser sets this automatically, and curl has to spoof it on purpose. It is
cheap and keeps casual tooling off the route. Recommended, but it must be
documented as hygiene only.

### Surfaces

| Surface | Grant | List | Revoke | Why |
|---|---|---|---|---|
| Companion UI: the block card (hero toast) and the `PreflightBlockLog` entries | **Yes** | Yes | Yes | This is the place where you see the refused proposal in full. |
| Ledger drawer, on each stance | No (it shows the count and the receipts) | Yes | Yes | You review exceptions in the context of the stance. |
| CLI `deeppairing stance allow <blockId>` | **Yes, interactive TTY only** | — | — | Decided 2026-10-08 so you can grant from the terminal. It has the guards above. |
| CLI `deeppairing stance exceptions [revoke <id>]` | No | Yes | Yes | Revoking only narrows authority, so it is safe without a TTY. |
| MCP tools and `/api/internal/*` | **No** | No | No | Covered by Invariant A1. The agent may *claim* an exception (§6), but cannot create, list or revoke one. |

The UI dialog behind **Allow this proposal once**:

- It shows the stance, the reason you gave for it, and the **full proposal
  preview** (the projection, not just the matched phrase).
- It states the scope in plain words: "Allows this exact proposal, once,
  until this Claude session ends. The stance stays on for everything else."
- It requires a reason (§4).
- It is reachable by keyboard: focus starts on the reason field, Enter
  submits once a reason is present, and Esc cancels and writes nothing.
- On failure, the dialog stays open and shows why, for example "Your
  preferences are busy (another deepPairing process is writing). Try again."
  for 503 `lock_busy`.

**Retire this stance** stays as it is, with its current wording. The two
buttons are visually distinct. Allow-once is the primary action, because it
is the narrower one.

## 4. Recording and audit

### Where

The record goes in project-scoped `.deeppairing/preferences.json`, in a new
optional array `stanceExceptions[]`. It is written only through
`mutatePreferences`. It is **never** mirrored to `~/.deeppairing/philosophy`,
and grant, consume and revoke perform no `recordInstance`.

Why `preferences.json` and not a separate file: the stance rows live there.
Putting the exception there means one lock can check "the stance still
exists" and "the exception is active" together with the claim, in a single
transaction. It also keeps the exception under the #416 lock path the issue
requires.

### Shape (all fields are new; the container is optional)

| Field | Notes |
|---|---|
| `id` | Server-minted, `sx_<random>`. |
| `status` | `active`, `consumed` or `revoked`. "Ended" (the session ended, §5) and "expired" (the ceiling passed) are **derived** at read time, so expiry needs no write. Pruning records them as `expired` with an `endedBecause` note. |
| `stance` | `{description, concept?, rejectedAt?}`, copied from the blocking row. |
| `sessionId`, `registrationId`, `toolName`, `artifactType` | The binding (§2). `registrationId` is the wrapper registration whose lifetime bounds the grant (§5). |
| `proposalDigest` | `sha256:<hex>`, computed by the daemon. |
| `proposalPreview` | The canonical projection (at most 32 KiB). This is the receipt of what you allowed. |
| `blockId` | Links back to the block log entry. The block log keeps only 50 entries, so the preview here is the durable copy. |
| `grantedAt`, `grantedVia` (`"ui"` or `"cli"`), `grantedBy?` | `grantedVia` records which door was used and is **required** on every grant. `grantedBy` is a best-effort display name taken from `git config user.name` by whichever process grants, if available. deepPairing has no identity system, so neither field authenticates anyone. They label the grant. |
| `reason` | **Required** at both doors, 3–280 characters after trimming. The CLI requires it typed at the prompt. The dialog offers quick picks ("Wording overlap, not the approach I rejected", "Conditions changed for this case") that you can edit. A reason you have to type turns a click into a receipt, and it is what the agent reads back. |
| `ceilingAt` | `grantedAt` plus 72 hours. This is the bounded fallback from §5, and it is only reached when a session's end could not be observed. |
| `consumedAt?`, `consumedArtifactId?`, `claimToken?` | Set by the claim (§6). `claimToken` is internal and never shown. |
| `revokedAt?`, `revokedVia?` (`"ui"` or `"cli"`) | Set by revoke. |

Retention: all `active` records, plus the newest 100 terminal records
(consumed, revoked or expired). Older terminal records are pruned in the same
`mutatePreferences` transaction as any grant. The hook reads the whole file
without a lock on every edit, so the file stays small.

### Where you see it

- **Block log, gate log and block card.** Every grant carries an origin
  badge, **UI** or **CLI**. After a grant, the card reads "Allowed once
  (CLI), *reason*, waiting for the agent to retry". After consumption it reads "Used
  by *artifact title*". After revocation, session end or expiry,
  the card says which one happened. The UI
  joins block entries to exceptions by `blockId` from a new
  `GET /api/stance-exceptions`, so the daemon stays the only writer of the
  block log.
- **The artifact.** Its preflight trace gains an optional `exception` summary
  (`{id, stance, reason, grantedAt, grantedVia}`), and the breadcrumb reads
  "Admitted once by your exception (UI) for '*stance*' (*reason*)".
- **Ledger drawer.** Each stance shows "N one-time exceptions" with the
  receipts and a Revoke button on active ones.
- **Live updates.** The daemon broadcasts `stance_exception_granted`,
  `stance_exception_consumed`, `stance_exception_revoked`, so open tabs update
  in place.

### Revocation

An `active` exception can be revoked from the UI or the CLI. Under the lock,
the status goes from `active` to `revoked`. Revoking a `consumed` exception
returns "Already used by *artifact*". It does not retract the artifact; you
reject that the usual way. Revoke and claim take the same lock, so their order
is well defined, and whichever runs first wins.

## 5. Expiry: single-use, and only until the session ends

**Decided 2026-10-08 (D1):** an exception is **single-use**, and an unused one
**ends when its Claude session ends**, not after a fixed time. A 72-hour
ceiling applies only when the end of a session could not be observed.

- **Single-use** matches the issue's "one proposal". After one admission the
  authority is gone, so an exact retry later is blocked again. The block
  message then names the artifact that used it, so the agent knows its first
  call succeeded.
- **It ends with the session**, because a grant is a judgement about this
  piece of work in this conversation. It should not still be armed in some
  later run.

### What "the session" and "ends" mean in the code today

There are three different "session" ideas in the codebase, so this needs
care:

- **The artifact session id.** `deriveSessionId` (`session-id.ts`) builds
  `session_<project>_<hash>`. When Claude Code sets
  `CLAUDE_CODE_SESSION_ID`, it appends that id ("split" mode). In fallback
  mode, without that variable, **every** Claude session in the project shares
  one id, and the bucket on disk never ends. A `--resume` reuses the same
  Claude id. So the session id alone cannot express "ended".
- **The wrapper registration.** Each MCP wrapper process (`standalone.ts`)
  calls `POST /api/internal/sessions/:sid/register` when it starts. It calls
  `/unregister` from its `exit`, `SIGINT` and `SIGTERM` handlers, which
  removes the session from the daemon's in-memory `activeSessions`. The
  daemon keeps the session's store afterwards, so the UI can still read it.
  The unregister is best-effort: it is an async request in an exit handler,
  and it never runs on `SIGKILL`, a crash, or a host power loss.
- **The daemon instance.** `activeSessions` exists only in daemon memory.
  A daemon restart, whether a crash, an idle shutdown or an upgrade, forgets
  every registration. `DaemonClient` then re-registers on its next call
  after a 404 (AA2).

There is no "close session" action. The context bank's
`/api/decisions/:id/close-out` closes a *decision*, not a session, so it plays
no part here.

**Definition.** The session a grant belongs to is **the live wrapper
registration that was blocked**, identified by `registrationId`. That session
has **ended** at the first of these:

| Event | How the daemon knows | Effect on the grant |
|---|---|---|
| The wrapper exits cleanly (Claude Code quits, `/exit`, the terminal closes and sends SIGTERM or SIGINT) | `/unregister` for that registration | Ended |
| The wrapper dies without unregistering (SIGKILL, crash, OOM) | A liveness check at claim time and when the UI renders: the daemon records the wrapper's process identity at `/register` and reuses `file-lock.ts`'s proof-of-death rule (an exact identity match plus ESRCH, or a different start time for the same pid) | Ended once death is **proven**. An unprovable identity, such as a mismatched pid namespace, is not treated as proof, so the 72-hour ceiling applies instead. |
| The MCP server reconnects (`/mcp` restart) within the same Claude conversation | A new wrapper process registers with a new `registrationId` | Ended. This is a deliberate cost: you have to grant again. The agent is told "the allowance ended with the earlier connection; ask your pair again". |
| `claude --resume` of the same conversation | New wrapper, new registration, even though the Claude session id is the same | Ended. The run you granted in is over. |
| The daemon restarts | `registrationId` includes the daemon's `instanceId`, so no registration survives a restart | Ended, and the wrapper's AA2 re-registration does not bring it back. Restarts are rare, and failing closed costs one re-grant. |

Because this definition keys on the **registration**, it also works in
fallback mode: two concurrent Claude sessions sharing one artifact session id
still have different registrations, so neither can use the other's grant.

What this needs in the code, all of it additive (§9):

- `/register` returns a `registrationId`, made of the daemon `instanceId`
  plus a random part. It also records the wrapper's process identity.
- The daemon keeps a map from `registrationId` to live registrations,
  alongside `activeSessions`. Today `activeSessions` is a `Set` of session
  ids, so in fallback mode one wrapper's unregister removes the shared id for
  everyone. The new map does not have that problem. The design does not
  change idle-shutdown semantics.
- `DaemonClient` keeps its `registrationId`, replacing it when it
  re-registers. It sends the id with `recordPreflightBlock` and with every
  claim.

There are no ended-session timers and no extra writes. "Ended" is computed
whenever an exception is read or claimed, because the daemon is the only
party that knows which registrations are live. A CLI grant asks the daemon
(through a hash-gated `GET`) whether the block's registration is live. It
refuses if the registration is not live, **or if the daemon cannot be
reached**, because then it cannot show that anyone could use the grant.

### The bounded fallback: a 72-hour ceiling

A ceiling is still needed for the one case the definition cannot see: a
registration that stays "live" because it was never unregistered and its
death could not be proven. In that case the daemon keeps it in memory for as
long as the daemon runs. A stale registration also keeps the daemon from
idling out, so that could be indefinitely. Nobody legitimate can claim such a
grant, because the wrapper that held the `registrationId` is gone. But a
forger could, and the receipt would read "active" for ever.

- **Why 72 hours:** it is far longer than a live working session is likely to
  run without a reconnect, so in practice it never cuts off a real grant. It
  covers a grant made on Friday evening and used on Monday morning. It also
  bounds a stale grant to days, not weeks. It is a constant that can be
  changed.
- **Why not 24 hours:** Mitch chose session lifetime as the rule. A short
  timer would quietly bring back the rule that was rejected for long
  sessions.
- Like every other expiry, it is derived from `ceilingAt` at read time and
  needs no timer.

Rejected options:

- *A fixed 24 hours.* Superseded by D1. It would cut off long live sessions
  and keep a grant armed after a quick exit.
- *The artifact session id only.* In fallback mode that id never ends, and in
  split mode it survives `--resume`.
- *N days, reusable.* That is a time-boxed Retire for one text. Reuse is
  exactly the loophole the issue warns about.
- *Permanent.* That is Retire.

## 6. Interaction with the hook and with preflight

### Preflight (`present_*` and `revise_artifact`): the exception applies

The admission flow:

1. `runPreflight` blocks on session stance **S**.
2. Look up an `active` exception that matches S and this session, this live
   registration, tool, type and digest, and whose session has not ended
   (§5). The agent-side process asks the daemon through a
   new **claim-only** call; see Concurrency below. If none matches, return the
   block exactly as today.
3. If one matches, re-run `runPreflight` with S removed for this call only.
   If any other session stance or team rule still blocks, return **that**
   block, and do not consume the exception.
4. If the proposal is otherwise admitted, **claim** the exception, then
   create the artifact, then finalize the claim (see Concurrency).

What the agent sees:

- **On the block (changed wording).** The current text says "ask the human to
  override this block in the companion UI's Ledger". The new text says:

  > If this is a false positive, ask your pair to choose **Allow this
  > proposal once** on the block card, then retry this **identical** call. Any
  > change to the content needs a new allowance. You cannot grant this
  > yourself.

  `_meta.retryable` stays `false`. An identical retry without a grant still
  fails.
- **On admission by exception.** The tool result appends:

  > Admitted once under an exception your pair granted for stance "*S*"
  > (reason: "*…*"). The stance still applies to everything else. A direct
  > edit carrying this content will still prompt your pair.

  The `_meta` gains `admittedByException: <id>`.
- **On a used, revoked, ended or expired exception.** The usual block, plus
  one line: "An exception for this proposal was already used by *art_x*". The
  other cases read "was revoked", "ended with an earlier session or
  connection; ask your pair again", or "expired at *t*".

### The direct-edit hook: unchanged in v1

The hook already **asks** and never denies. Its Claude Code permission
prompt *is* a one-edit, human-only allowance for exactly the content shown.
The platform renders it and the agent cannot answer it. Adding exceptions to
the hook would mean:

- the hook reading and matching exceptions in its lock-free, dependency-free
  hot path;
- worse, binding an exception to edit content. An Edit's `new_string` is not
  the same bytes as the `present_code_change` projection that was allowed, so
  you would need fuzzy matching between the two. That brings back the
  paraphrase problem the exact digest just closed.

So after an admitted `present_code_change`, the agent's actual Edit still
gets one permission prompt. That costs one more click and keeps one clear
rule: **the exception lifts a refusal; it never removes a prompt.** The
guarantee table changes on the `present_*` row only.

A possible v2 is an annotation only: the hook adds "you allowed a matching
proposal for this stance at *t* (*reason*)" to its ask text, and the prompt
stays. That is deferred until someone shows the extra prompt is real friction.

## 7. Concurrency and write ordering

All four operations run in `FileStore`, inside `mutatePreferences`, under
`preferences.json.lock`. That is the #408 transaction on #416's cross-process
lock, and it is reentrant in-process. A busy lock past the timeout throws
`ELOCKED`, which maps to 503 `lock_busy`. Nothing is ever written without the
lock.

| Operation | Who runs it | Inside the lock |
|---|---|---|
| **Grant** | The daemon (UI route), or the CLI's own `FileStore` (`stance allow`, after the interactive checks and the daemon liveness check) | Check that the block's stance row still exists with the same identity. If an `active` exception already has the same binding, return it (idempotent, same `id`, 200). Otherwise append a new one and prune. |
| **Claim** | The daemon only, from a new internal route `POST /api/internal/sessions/:sid/stance-exceptions/claim` | The body carries the projection, stance identity and `registrationId`, and the daemon recomputes the digest. It requires the stance row present, a matching `active` record, a matching session **and** registration, a registration that is still live (§5), and a time before `ceilingAt`. A store with no daemon has no registrations, so it never admits by exception. That is fail-closed. Production always runs through the daemon. It then sets `consumed`, `consumedAt` and a fresh `claimToken`, and returns `{id, claimToken, reason}`. If anything fails, it returns "no exception", and the caller returns the normal block. |
| **Finalize** | The tool, after `createArtifact` succeeds | Stamp `consumedArtifactId` where the `claimToken` matches. This is best effort: if it fails, the receipt shows "used (artifact not linked)", and the artifact's trace still carries the exception id. |
| **Release** | The tool, if `createArtifact` throws (for example a secret-scan refusal, or a store error) | If the `claimToken` matches and the status is still `consumed` with no artifact linked, go back to `active`. |
| **Revoke** | The daemon, from the UI route, or the CLI's own `FileStore` | Change `active` to `revoked`. |

**Write ordering.** The authority change is written before the effect it
authorizes, the same discipline as #408, where the local record lands first.
The exception is consumed on disk **before** the artifact exists. So a crash,
or a lock timeout, between the two can only leave a consumed exception with
no artifact. That is fail-closed: you see "used (artifact not linked)" and can
grant again. The opposite order would be create, then consume. If the consume
step failed, there would be an artifact *and* an armed exception, and an
identical retry could pass a second time. That is fail-open on authority, so
it is rejected. Release is the compensation step, just as
`retractRejectedApproach` is for verdicts. If the release step itself hits a
busy lock, the exception stays consumed, which is still fail-closed. This
mirrors the `dedup.abort()` / `dedup.commit()` pair that `present_options`
already uses around `createArtifact`.

**Races.**

- **Two identical proposals at once,** from parallel tool calls or two
  processes. Only one claim can see `active` under the lock. The other gets
  the normal block, with "already used by …".
- **Claim against revoke, from the CLI and the daemon.** Both take the same
  lock file, so one runs first. Either the revoke wins (the claim finds
  `revoked`, so the proposal is blocked) or the claim wins (the revoke returns
  "already used").
- **Claim against Retire.** Retire deletes the stance row, so a claim that
  runs afterwards fails its "stance present" check. That does not matter,
  because with the stance gone the gate no longer blocks. A claim that runs
  first consumes the exception, and then Retire proceeds. Neither order is
  unsafe.
- **Lock-free readers.** The hook and `getSessionMemory` read through an
  atomic rename, so they always see a full snapshot from before or after the
  write.

## 8. Alternatives considered

| Alternative | Why it was rejected |
|---|---|
| **Retire, then re-reject the stance** | (a) While the stance is retired, *every* proposal in *every* session is unguarded on that stance, and a parallel session can slip through. (b) With publishing on, Retire writes a global `approved` counter-instance, so one false positive changes your derived cross-project stance. (c) Re-rejecting depends on you remembering, and the reinstated row gets a new `rejectedAt` and loses its `sourceArtifactId` link. (d) Nothing records *why*. This is the very problem the issue describes. |
| **Edit the stance concept to narrow it** | A worthwhile feature, but a different one. It is a permanent policy change for all future proposals. Narrowing a lexical concept to dodge one false positive can open real paraphrase holes, for example removing "state" from "global mutable state for config". It is right when the stance is badly *worded*. It is wrong when the stance is right and one proposal is a false hit. Candidate follow-up: "Edit wording" in the Ledger drawer. |
| **Snooze the stance for a session** | This is the "broad session bypass" the issue rules out. Every proposal in that session, including true re-proposals, would pass, so the gate would be off exactly while the agent works. |
| **A path- or glob-scoped exception** ("allow this stance under `packages/x/**`") | The issue says to prefer one tightly scoped allowance before reusable path exceptions. Paths are also gated text and do not identify a proposal. Deferred. |
| **An MCP tool for the agent to request an exception** | The block card already is the request. Adding a tool gives the agent an exception-shaped verb in its schema, and the authority test would have to separate "request" from "grant". Deferred until there is a need. Even then it would only open the same dialog. |
| **Telling the agent "approved" in chat** | Chat is not an authority. The agent could quote it, or make it up. This is the `review-authorization.ts` rule: no "the human said so" bypass. |
| **Key the exception on a normalized token set, or on the matched phrase** | Both are reusable across different proposals. See §2. |

## 9. Migration and backward compatibility

- **Only new optional fields.** This follows CLAUDE.md: "All new fields in
  schemas must be optional."
  - `preferences.json` gains `stanceExceptions?`.
  - `PreflightTraceSchema` (shared) gains `exception?`.
  - `PreflightBlockEntry` gains `proposalDigest?`, `proposalPreview?` and
    `stance?`.
  - The `preflight_blocked` event `match` gains `projection?` and
    `rejectedAt?`, and the event gains `registrationId?`.
  - The `/register` response gains `registrationId?`, and the request
    gains an optional wrapper process identity. An older wrapper that sends
    neither can never claim, which is the safe direction.
  - A new `StanceExceptionSchema` goes in `packages/shared`. The hook
    does not import it, because the hook does not read exceptions in v1, so
    the hook stays free of `@deeppairing/shared`.
- **Existing stance rows are not changed.** The binding uses fields rows
  already have. It adds **no** stance id, because an older build's
  `normalizeRejectedApproaches` would remove one on its next rewrite. Legacy
  rows without `rejectedAt` bind on `{description, concept}` alone.
- **Old blocks.** Block log entries from before this change have no
  projection. Their cards show Retire only, with the tooltip "Retry the
  proposal to allow it once".
- **Downgrade.** `mutatePreferences` changes the raw record in place, so an
  older daemon that rewrites `preferences.json` keeps `stanceExceptions`. It
  just never reads it, so the proposal is blocked, which is the safe
  direction.
- **Docs to update with the implementation.**
  - README "False positives and overrides": add "**Allow this proposal once**
    lets one exact proposal through until this Claude session ends; the
    stance stays."
  - The faq guarantee paragraphs, with the CLI grant and the honest TTY and
    forgery limits from §3 added next to the existing same-uid note.
  - The block message text in `preflight-validator.ts`.
  - The SKILL guidance on what to do after a block.
  - The guarantee wording itself does not change: the gate still refuses,
    and only you can lift a refusal, once.
- **New error codes**, in `error-codes.ts`: `stance_exception_block_not_found`,
  `stance_exception_not_eligible` (team, demo, too large, stance retired,
  session ended), `stance_exception_reason_required` and
  `stance_exception_interactive_required` (the CLI refusals).

## 10. Test plan

Fakes, not mocks. That means a real `FileStore` on a temp directory, real
child processes for anything across processes, and an injected clock for
expiry.

### Unit

- Digest canonicalization. It is stable across runs and key order. NFC and
  CRLF variants give the same digest. **Any** change to case, word order,
  inner whitespace, an added or removed string, the type or the path gives a
  different digest.
- The claim state machine: active to consumed to finalized, active to
  consumed to released to active, active to revoked, and derived end and expiry:
  - an unregistered registration counts as ended;
  - a registration from another daemon `instanceId` counts as ended;
  - a wrapper proven dead counts as ended;
  - an unprovable identity counts as live, until the ceiling;
  - exactly `ceilingAt` counts as expired.
- Multiple stances: excepting A, while B (session) or a team avoid still
  matches, blocks on B, and A is **still active** afterwards.

### Adversarial

1. **The agent tries to self-grant.**
   - The authority-surface test from §3 runs over MCP tool schemas,
     `IStore`, `DaemonClient`, `/api/internal/*` and the CLI.
   - The grant route without a bearer token returns 401.
   - The grant route with extra body fields (`digest`, `stance`,
     `sessionId`, `scope`) returns 400.
   - The grant route with an unknown or pruned block id returns 404.
   - A team-source block, a `demo_` session or a retired stance is refused.
   - Calling claim with no grant returns "none" and the proposal is blocked.
   - **The CLI grant without a TTY is refused.** Spawn
     `deeppairing stance allow <id>` as a child process with piped stdin, and
     again with only stdout piped. Each exits non-zero with
     `stance_exception_interactive_required`, and `preferences.json` is
     byte-identical afterwards.
   - **Non-interactive flags are refused.** `--yes`, `-y`, `--force`,
     `--non-interactive` and `--reason "..."` are each refused, even under a
     real pty.
   - **A grant with no reason is refused.** Under a test pty:
     - an empty reason, then a whitespace-only one, then a two-character
       one, then EOF writes nothing;
     - three failed prompts exit non-zero;
     - an empty UI `{reason}` returns 400 `stance_exception_reason_required`.
   - **An invocation shaped like the agent's is refused.** Run it the way
     Claude Code's Bash tool does: no TTY, `CLAUDECODE=1` set, and stdin from
     `/dev/null` or a heredoc piping `allow`. It is refused. Then run it under
     a pty with `CLAUDECODE=1` still set. That is refused too, by the
     env heuristic.
   - **Confirmation needs the typed word.** Under a pty, a valid reason
     followed by Enter or `y` at the confirm prompt writes nothing. Only
     typing `allow` grants, and it records `grantedVia: "cli"`.
   - **The CLI checks the session first.** A block whose registration has
     ended is refused. So is any grant while the daemon is unreachable.
   - **The origin is recorded and shown.** A UI grant records
     `grantedVia: "ui"`. A CLI grant records `"cli"`. Both badges render in
     the block log, the gate log, the Ledger drawer and the artifact
     breadcrumb.
   - **The residual is documented, not a test failure.** One test drives
     the CLI through a scripted pty with `CLAUDECODE` unset, and asserts that
     the grant **succeeds** and is shown as `cli`. This pins the documented
     limit, so nobody later claims the TTY check is a security boundary.
2. **A paraphrase of an excepted proposal.**
   - Grant for P, then submit P with one character changed, P with an
     option reordered, P with a synonym from the alias table, P with a
     trailing clause, and P through a different tool. Every one is blocked by
     the same stance, and the exception for P is still active.
   - A forged block event whose `proposal` (matched phrase) differs from its
     projection still produces a digest of the projection shown in the
     dialog.
3. **Session end and expiry.** These use a real daemon and real wrapper
   child processes.
   - After a grant, the wrapper exits by SIGTERM, which sends `/unregister`.
     Its replacement, with the same Claude session id, retries the
     identical proposal and is **blocked** with "ended".
   - The wrapper is SIGKILLed with no unregister. Proof of death ends the
     grant at the next claim or UI read.
   - An `/mcp`-style reconnect (new wrapper, same session id) is blocked.
   - A `--resume`-style respawn with the same `CLAUDE_CODE_SESSION_ID` is
     blocked.
   - A daemon restart between grant and retry blocks the proposal. The AA2
     re-registration gets a new `registrationId`, which does not match.
   - **Fallback mode.** Two wrappers with no `CLAUDE_CODE_SESSION_ID`
     share one session id. A grant bound to wrapper 1's block cannot be
     claimed by wrapper 2.
   - **Ceiling.** Use an unprovable wrapper identity with an injected clock.
     At `ceilingAt` minus 1 ms the proposal is admitted. At `ceilingAt` it
     is blocked with "expired".
   - **Survival while the session is live.** A grant made and used by the
     same live registration, with a daemon `FileStore` re-read in between,
     admits once.
4. **Revocation.** Revoke before the retry blocks the proposal. Revoke after
   consumption returns "already used" and leaves the artifact as it is.
   Revoke from the CLI is seen by the daemon's next claim.
5. **A concurrent CLI and daemon.**
   - Two real processes, each with its own `FileStore`, race claim against
     claim for the same exception: exactly one admission.
   - Revoke (CLI) races claim (daemon): exactly one of "revoked, blocked" or
     "admitted, revoke reports used", with no torn file, checked over many
     iterations.
   - Grant races an unrelated `recordRejectedApproach`: both changes are
     present.
   - `ELOCKED` on claim returns the normal block (fail-closed).
   - `ELOCKED` on grant returns 503 and the dialog stays open.
6. **Session binding.** The same content from another session id, or from
   another registration of the same session id, is blocked,
   and so is the same content after the stance is retired and re-rejected (new
   `rejectedAt`).
7. **Idempotency.**
   - A double-click on grant returns one exception with the same id.
   - An identical retry after a successful admission is blocked, and the
     message names the artifact.
   - `createArtifact` throwing (a secret-scan fixture) after the claim
     releases the exception back to active.
   - A release that hits a busy lock leaves it consumed.
8. **No leakage.**
   - With publishing on, grant, consume and revoke write **nothing** to the
     global ledger (fake HOME, compare bytes).
   - `approvedPatterns` is unchanged.
   - The cross-project advisory dedupe still sees the stance.
   - Gate-escape and near-miss telemetry skip admissions made by exception.
9. **The hook is unchanged.** After an admitted `present_code_change`, an
   Edit with the same text still returns `ask`. This pins the v1 rule while
   D5 is open.

### Web (jsdom, plus one real-browser check flagged for the reviewer)

- **Keyboard path.** Tab to Allow-once, focus moves to the reason field,
  Enter is disabled while the reason is empty, Enter submits, Esc cancels and
  makes no request, and focus returns to the card.
- **Failure display.** A 503 or 409 keeps the dialog open and shows the
  message.
- **The two actions stay separate.** Allow-once and Retire have distinct
  labels and tooltips. Retire's wording is unchanged.
- **The card updates live** from the broadcasts: allowed → used → revoked or
  expired.

## 11. Decisions (recorded)

Mitch decided D1 to D4 on **2026-10-08**. D5 is still open.

- **D1. Unused-allowance lifetime: until the session ends.** An unused
  allowance ends when its Claude session ends, not after 24 hours. §5 defines
  "ends" from the code's lifecycle:
  - the wrapper unregisters;
  - the wrapper is proven dead;
  - the MCP server reconnects, or the conversation is resumed (a new
    registration);
  - the daemon restarts.

  A 72-hour ceiling covers registrations whose end cannot be observed.
- **D2. CLI grant: yes, from both the UI and the CLI.** The CLI grant is
  `deeppairing stance allow <blockId>`. It refuses without an interactive TTY
  on stdin and stdout, refuses every non-interactive flag (`--yes`, `-y`,
  `--force`, `--non-interactive`, `--reason`), and refuses an invocation that
  looks like the agent's (`CLAUDECODE=1` or `CI`). It shows the exact
  proposal and the stance, requires a typed reason, and requires `allow`
  typed to confirm. Every grant records `grantedVia: "ui" | "cli"`, and that
  origin is shown wherever the grant is.

  This deliberately weakens "only the human, only in the UI". §3 states the
  limits honestly: it blocks the agent's normal non-interactive Bash path, but
  not a determined local process scripting a pty, and it sits next to the
  forgery gap.
- **D3. The forgery gap is documented, not closed, and grants are made
  visible.** A same-uid process can forge a grant through the bearer-gated
  route, a scripted pty, or the file. The docs will say "human-only by
  design; visible if forged", never "enforced". Visibility comes from the
  origin badge on every grant and from the "admitted by exception" stamp on
  every artifact that used one.
- **D4. Own stances only.** Team-rule blocks stay out of v1 and keep
  pointing to `.deeppairing/team.json`, at both doors.
- **D5 (open). The hook still prompts once after an allowed proposal.** This
  is not decided yet. The proposal in §6 stands: the exception lifts a
  refusal and never removes a prompt, so the direct Edit still gets a
  permission prompt. A v2 annotation that adds context to the prompt text
  without removing the prompt is deferred until this is decided.
