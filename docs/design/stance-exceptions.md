# One-proposal stance exceptions (proposal, #470)

> **Status: PROPOSAL, revision 3. No code is included.** It is written for
> Astra's scope and authority review, which must happen before any
> implementation starts.
>
> - Revision 3 answers the two CHANGES verdicts on `f0bd817f`: Astra's review
>   comment and Fable's review. §12 maps each finding to the section that
>   addresses it.
> - Revision 2 applied Mitch's decisions of 2026-10-08 (§11).
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
card and in the block log, with a `deeppairing stance allow` CLI counterpart.

- **Who grants it:** only the human. Every grant is written by the daemon.
- **Where it is recorded:** this project's `preferences.json`.
- **What it is bound to:** one stance, one live Claude session registration,
  one tool, and a digest of the **full proposal payload** the gate refused.
- **How long it lasts:** it is single-use, and it ends with the session or
  after 72 hours, whichever comes first.
- **What it does:** it admits exactly one mutation, with a durable operation
  id that makes retries replay instead of re-running.
- **What stays the same:** the stance stays in force for every other proposal.
  Nothing reaches the cross-project ledger. Retire stays as a separate,
  clearly worded action.

## 1. What the gate does today (audited)

| Piece | Where | Behaviour that matters here |
|---|---|---|
| Proposal projection | `mcp/artifact-preflight.ts` `artifactProposal` | For each artifact type, it picks the strings, paths and named concepts the gate reads. It is **not** the whole proposal. For `code_change` it reads only `filePath`, `reasoning` and `concept.name` (lines 34–37), and never `before` or `after`. Evidence snippets and option pros and cons are not read either. Debriefs and external changesets are `advisory`. |
| Matcher | `mcp/preflight-validator.ts` `runPreflight` | The session lane runs first, then the team lane. It returns the **first** match only, and the match is lexical. The block message tells the agent to "ask the human to override this block". |
| Refusal | `mcp/tool-helpers.ts` `preflightRejectedApproaches` | Broadcasts the block, persists it (`store.recordPreflightBlock`), records a metric, and returns `REJECTED_APPROACH_BLOCKED` with `retryable: false`. **The artifact is never created, so it has no id.** `revise_artifact` re-gates under its own tool name (`revise-artifact.ts:118`). |
| Arg hashing | `tool-helpers.ts:724` `hashPresentArgs` | SHA-256 of a key-sorted stable stringify of the raw tool args. It is used by N2's in-memory 30-second duplicate window (`beginPresentIdempotency`), which is not durable. |
| Transport | `daemon/client.ts:221–243`, `:411–413`; `daemon/routes.ts:517–519` | `DaemonClient` retries a request once, transparently, after a network-level failure. The daemon persists the artifact before it responds. **A lost response means the artifact was committed but the tool saw an error, and the retry runs the create again.** |
| Block log | `store/preflight-block-log.ts` | `.deeppairing/preflight-blocks.json`, project-scoped, newest 50 entries, written by the daemon on a fail-soft basis. It stores the matched phrase only, not the proposal. |
| Stance storage | `FileStore.recordRejectedApproach` / `normalizeRejectedApproaches` | Each row in `preferences.json` `rejectedApproaches[]` is `{description, reason?, rejectedAt?, sourceArtifactId?, concept?}`. **A rewrite drops unknown row fields.** |
| Retire | `FileStore.overrideRejectedApproach`, `POST /api/philosophy/override`, `ToastLayer.tsx` | Deletes the stance from the project. Team blocks are refused. There is an internal twin route that the agent can reach. |
| Write path | `FileStore.mutatePreferences` (#408 on #416's `file-lock.ts`) | Read, mutate and atomic replace, all under `preferences.json.lock`, which works across processes. `ELOCKED` maps to 503 `lock_busy`. Readers never lock. |
| Session lifecycle | `standalone.ts:125–152`, `daemon/routes.ts:418–495`, `create-daemon.ts:214` | The wrapper calls `/register` when it starts. `/unregister` drops the session from the in-memory `activeSessions` **set of session ids**. All three exit paths (`exit`, `SIGINT`, `SIGTERM`) fire `unregister()` without awaiting it, and `SIGINT`/`SIGTERM` then call `process.exit(0)` straight away. **Whether the unregister lands is a race.** Nothing listens for stdin closing. |
| Direct-edit hook | `cli/preflight-hook-core.ts`, `cli/setup-tasks.ts:465` | The PreToolUse matcher covers `Write\|Edit\|MultiEdit` **only**. A match returns `ask`, never `deny`, and the hook fails open. The guardrail backstop (`guardrail-rules.ts:93–118`) asks only when no live pre-work ceremony exists, and only once per class per time window. |
| Mutation auth | `http/routes.ts` SP1, `SECURITY.md` | Every public non-GET route needs the bearer token. Any same-uid process can read that token. |

Two facts drive the design:

- **No artifact exists at block time**, so an exception has to be keyed on
  content.
- **The agent runs as the same user as everything else.** It cannot be stopped
  from forging state, only kept off the sanctioned paths. The design therefore
  states which paths are sanctioned, closes the easy unsanctioned ones, and is
  precise about what detection can and cannot promise (§3).

## 2. Scope: what gets exempted

### Two digests, two jobs

| | Matching projection | **Allowance digest** (new) |
|---|---|---|
| Purpose | Decides *whether* a stance blocks | Decides *which exact proposal* the human allowed |
| Input | `artifactProposal(type, title, content)` | The tool's complete validated `arguments` object, with the exclusions listed below |
| Function | Unchanged | `hashPresentArgs` (stable, key-sorted stringify, then SHA-256), wrapped as `sha256(stableStringify({v: 1, toolName, type, args}))` |
| Changed by `before`/`after`, evidence, pros/cons, `relatedFindings`, `feature`, title | Only if projected | **Always** |

The gate keeps using the projection to **match**. The allowance is bound to the
**allowance digest**, so *any* change to the proposal, gated or not, needs a
new allowance. That is the immutable-content contract #470 asks for. A
`present_code_change` whose diff changes while its `reasoning` stays the same
no longer reuses the allowance.

**What the payload includes:** every key of the tool's `arguments` as the MCP
server received and validated them. That covers content, title, `feature`,
related ids, and for `revise_artifact` the target `artifactId`.

**What the payload excludes:** only transport metadata, never content.

- The MCP request's `params._meta`, such as the progress token. This is not
  part of `arguments` at all.
- A top-level `_meta` key inside `arguments`, if a client sends one.
- Nothing else is excluded.

There is no extra canonicalization beyond what stable stringify does (key
order). Whitespace, case, Unicode form and array order all count, so an
identical retry means byte-identical argument values. The server mints ids
(such as `dec_`/`art_`) **after** hashing, which is the property N2 already
relies on.

### Binding: an allowance admits a call only if all six match

| Binding | Value |
|---|---|
| Project | Implicit: the record is in this project's `.deeppairing/preferences.json`, and it is never mirrored. |
| Stance | The blocking row's `{description, concept, rejectedAt}`, compared exactly. No new stance id is added, because an older build would strip it on rewrite (§9). Including `rejectedAt` means a stance that was retired and then re-rejected does not inherit old allowances. |
| Session | The block's `sessionId` **and** `registrationId` (§5). |
| Tool and type | `toolName` and artifact type. These are inside the digest too. |
| Content | The `allowanceDigest`. The **daemon** computes it from the payload it stores. It never takes a digest from the client. |
| Lifetime | The registration is live, and the time is before `ceilingAt` (§5). |

### The preview shows what is covered

The UI dialog and the CLI prompt show two things:

1. **"What matched":** the projection, with the matched phrase highlighted.
2. **"What you are allowing (all of this is covered)":** the full payload,
   rendered in the shape of the artifact. A `code_change` shows its
   before/after diff. A decision shows every option with its pros and cons.
   Research shows its evidence.

The footer says: "Any change to anything above needs a new allowance."

### Why not the other candidates

- **A normalized-token fingerprint.** `not` is a stopword, so *"do not keep
  global mutable state"* and *"keep global mutable state"* would collide.
- **The projection alone** (revision 1 used this). It admits different code
  under the same reasoning. Astra P2 and Fable HIGH both raised this.
- **An artifact id.** None exists when the gate blocks.

### Why this does not open a paraphrase loophole

- A near-copy has a different digest, so the unchanged matcher checks it as
  usual.
- The allowance lifts **only its own stance**. The gate is re-run with that one
  row removed for this call only. Any other session stance or team rule still
  blocks, and the allowance is not consumed (§6).
- It is single-use (§5). It never feeds `approvedPatterns`, the ledger or the
  advisory dedupe. Gate-escape and near-miss telemetry skip admissions made by
  allowance.
- It admits the proposal to **review**, not to approval. The artifact still
  lands as a draft.

### Size and secrets

- **Size.** The block event now carries the canonical payload, so the daemon
  can store the preview and compute the digest. Above 48 KiB of canonical
  payload the block is recorded, but it is not eligible: "Too large to allow
  once. Retire the stance or ask for a smaller proposal."
- **Secrets.** A blocked proposal used to leave only its matched phrase on
  disk. Now it would leave the whole payload. So the payload goes through the
  same secret scanner `createArtifact` uses. If the scanner flags it, the
  payload is **not** persisted and the block is not eligible ("This proposal
  may contain a secret, so it can't be stored for allow-once.").

## 3. Authority: who can grant

### Invariant A1: only the daemon writes a grant, and only on a human-facing request

> No MCP tool, MCP tool argument, `IStore` or `DaemonClient` method,
> `/api/internal/*` route, or hook output can create an allowance. The only
> writer is the daemon's grant handler, behind the bearer-gated public route
> `POST /api/preflight-blocks/:blockId/exception`. Two clients call that
> route:
> - the companion UI, after an explicit gesture;
> - `deeppairing stance allow <blockId>`, which reaches the route only after
>   its interactive checks **and** a Claude Code permission prompt when the
>   agent's Bash runs it.

How it is enforced:

1. **Structural absence, pinned by a test.** The grant function exists only in
   the daemon's route handler and in `FileStore`. It is not added to `IStore`,
   so `DaemonClient` cannot call it, and no internal route exposes it. An
   **authority-surface test** enumerates:
   - MCP tool schemas;
   - `IStore` and `DaemonClient` method names;
   - `/api/internal/*` routes;
   - CLI subcommands, where `stance allow` must be the only command that
     reaches the grant route, behind the interactive guard.

   The test fails if any of these changes.
2. **The CLI writes through the daemon, not its own `FileStore`** (Fable
   HIGH a). `stance allow` reads the token from `daemon.json` and POSTs to
   the same route the UI uses, with `X-DeepPairing-Grant-Origin: cli`.
   - If the daemon is unreachable, the grant is refused. This also makes the
     liveness check (§5) authoritative.
   - All grant, claim and revoke writes happen in **one process**. The
     cross-process CLI-against-daemon races of revision 2 go away. The
     preferences lock stays, because other CLI commands such as
     `philosophy publish` still write the file.
3. **A block id, not a scope.** The body is `{reason}` and nothing else. The
   daemon copies stance, session, registration, tool, type and payload from
   the server-minted block record, and computes the digest itself. Extra body
   fields get a 400. An unknown or pruned block id gets a 404.
4. **What you see is what you allow.** The digest is computed from the same
   stored payload the preview renders. A forged block event can only get you to
   allow exactly what is on your screen.
5. **Shared guards.** The route refuses:
   - team blocks (D4);
   - `demo_` sessions;
   - a retired stance;
   - an ended session (§5);
   - a payload that is not eligible (§2).
6. **Origin is recorded.** `grantedVia` is `"ui"` or `"cli"`, taken from the
   origin header. That header is **self-reported**: it labels the door, it
   does not authenticate it.

### The CLI grant (D2) and the Bash prompt

`deeppairing stance allow <blockId>` keeps revision 2's interactive checks.
Each failure exits non-zero and writes nothing.

- It refuses unless both stdin and stdout are TTYs.
- It refuses all flags that would make it non-interactive, including
  `--reason`.
- It refuses when `CLAUDECODE=1` or `CI` is set.
- It shows the stance and the full covered payload.
- It requires a typed reason of 3–280 characters, and then requires you to
  type `allow`.

**Fable showed that these checks are one shell line from the agent.** Bash has
`script` and Python, so
`printf 'reason\nallow\n' | script -qc 'env -u CLAUDECODE deeppairing stance allow <id>' /dev/null`
gets past all of them. The checks stay, because they stop casual and accidental
use, but the protection now comes from a channel the agent cannot answer:

**(b) A narrow `Bash` PreToolUse matcher.** `init` adds a second PreToolUse
entry to the generated hooks, `matcher: "Bash"`. It runs a dependency-free
`.mjs` that reads `tool_input.command` and does exactly one thing:

- If the command matches `/\bstance\s+allow\b/`, it returns
  `permissionDecision: "ask"` with the text "The agent is trying to grant a
  stance allowance from the shell. Only allow this if you asked for it." This
  catches the one-liner above, because the words appear inside the `script
  -qc` string.
- For **every other Bash command**, it exits 0 with **no output**. Claude
  Code then behaves exactly as it does today. There is no other matching, no
  guardrail logic, no stance matching on Bash, and no logging.

The added cost is one `node` start per Bash call. It is budgeted at 50 ms or
less at the 95th percentile and measured in a test. If that budget fails, the
fallback is a matcher written in POSIX `sh`.

**Honest limits of (b).** It is a substring check, not a shell parser. These
all get past it:

- splitting the words (`s=stance; deeppairing $s allow`);
- encoding the command (base64);
- writing a script to a file and running that file;
- calling the HTTP route with `curl`.

At that point the agent is deliberately evading the check, which is the same
class as editing the file directly (below). The prompt closes the
**obvious** path and the one Fable published. It does not close every path.

**(c) Detection reaches the human, not just the log.**

- **A grant raises a toast.** The `stance_exception_granted` broadcast shows
  "Allowance granted from the CLI for '*stance*': *reason*". The CLI origin
  is styled to stand out, because it is the less expected door.
- **An admitted artifact carries a persistent badge on its card.** It reads
  "Allowed once (CLI)", in addition to the trace breadcrumb, and stays as long
  as the artifact exists.
- **Allowances are listed in the debrief view and in the export.** The
  debrief view renders a system section, "Allowances used this session", built
  from the store and **not** written by the agent. `export_session` (both
  Markdown and HTML) includes the same list.

### Direct file edits (Fable MED, Astra P2)

The agent's Edit and Write tools can write `preferences.json` and create a
grant without any prompt. So:

- **A new guardrail class, `deeppairing-state`**, is added to
  `GUARDRAIL_RULES`. Its file patterns match
  `(^|/)\.deeppairing/preferences\.json$` and
  `(^|/)\.deeppairing/team\.json$`, and it **always** returns `ask`.
  - It ignores the "live pre-work ceremony" skip that suppresses the other
    guardrail classes.
  - It ignores the per-class dedup window.
  - It is the only class that behaves like this, and the parity test pins it.
  - deepPairing's own writes are not tool calls, so they never trigger it.
  - The cost is that agent edits to `team.json`, which is shared committed
    config, now also prompt. We consider that correct.
- **The claim checks that the stored record is consistent.** It requires
  `sha256(stableStringify(storedPayload)) === allowanceDigest`. It **also**
  requires the incoming call's recomputed digest to be equal to it. A
  hand-edited record whose preview and digest disagree is refused, and it
  shows as "record inconsistent".
- **Bash writes to the file are not covered.** `jq … > preferences.json` is
  outside the narrow Bash matcher on purpose.

### What the audit trail does and does not promise (narrowed, Astra P2)

- **Promised:** for operations done through the **supported paths** (the UI
  route, the CLI through the daemon, and the daemon's claim during
  admission), every grant, consumption and revocation produces:
  - a stored receipt;
  - a broadcast;
  - an origin badge;
  - on admission, an artifact badge and a trace stamp.
- **Not promised:** the receipts are **not tamper-evident** and do **not**
  authenticate anyone. A process running as your user can edit or delete
  `preferences.json`, the block log, the session files or the export. It can
  write a grant that is internally consistent, and it can erase receipts.
  Nothing here can **guarantee** that a same-user file modification will be
  detected. The guardrail `ask` and the Bash `ask` make the agent's *direct*
  attempts visible as prompts. They are not a detection guarantee.
- The docs (§9) must say exactly this: "Human-only by design. Receipts cover
  supported operations. Not tamper-evident against same-user processes." The
  phrase "visible if forged" from revision 2 is withdrawn.

### Surfaces

| Surface | Grant | List | Revoke |
|---|---|---|---|
| UI: block card and block log | **Yes** | Yes | Yes |
| UI: Ledger drawer, debrief view, artifact card badge | No | Yes | Yes (Ledger) |
| CLI `stance allow <blockId>` (interactive, via the daemon, Bash prompt) | **Yes** | — | — |
| CLI `stance exceptions [revoke <id>]` (via the daemon) | No | Yes | Yes |
| MCP tools, `/api/internal/*` | **No** | No | No |

The UI dialog shows the two-part preview (§2). Its scope text reads "Allows
this exact proposal, once, until this Claude session ends (at most 72 hours).
The stance stays on for everything else." It requires a reason and is
reachable by keyboard: focus starts on the reason field, Enter submits once a
reason is present, and Esc cancels. When a request fails, the dialog stays
open and shows the error. **Retire this stance** is unchanged.

## 4. Recording and audit

### Where

The record is a new optional array, `stanceExceptions[]`, in project-scoped
`.deeppairing/preferences.json`.

- It is written only by the daemon, through `mutatePreferences`.
- It is never mirrored to the ledger.
- It sits next to the stance rows, so "the stance still exists" and "the
  allowance is active" can be checked in one locked transaction.

§8 discusses an in-memory alternative and leaves it as an open question.

### Shape (all fields are new; the container is optional)

| Field | Notes |
|---|---|
| `id` | `sx_<random>`. |
| `status` | `active`, `consumed` or `revoked`. "Ended" and "expired" are **derived** when the record is read (§5). |
| `stance` | `{description, concept?, rejectedAt?}`. |
| `sessionId`, `registrationId`, `toolName`, `artifactType` | The binding. |
| `allowanceDigest` | `sha256:<hex>` of the canonical payload (§2). |
| `payload` | The canonical payload, at most 48 KiB. It is both the receipt and what the claim's consistency check (§3) hashes. |
| `projectionPreview` | What matched. |
| `blockId` | Links back to the block log, which keeps only 50 entries. |
| `grantedAt`, `grantedVia` (`"ui"` or `"cli"`, required), `grantedBy?` | `grantedBy` is a best-effort `git config user.name`. These are labels, not authentication. |
| `reason` | Required at both doors, 3–280 characters. |
| `ceilingAt` | `grantedAt` plus 72 hours. **Applies unconditionally** (§5). |
| `operation?` | `{id, state: "committed" \| "unknown", artifactId?, at}`. Set by the claim (§7). |
| `revokedAt?`, `revokedVia?` | Set by revoke. |

**Retention:** keep every `active` record, plus the newest 100 terminal
records. Pruning happens in the same transaction as a grant.

### Where you see it

- **The block card and the gate log.** Each grant shows an origin badge, and
  the card shows the current state: allowed, used, outcome unknown, revoked,
  ended or expired.
- **A toast** when a grant is made, with CLI grants made more prominent.
- **The artifact card.** A persistent "Allowed once (UI/CLI)" badge, plus the
  trace's `exception` summary: `{id, stance, reason, grantedVia, grantedAt}`.
- **The Ledger drawer.** Each stance shows "N one-time allowances", with
  their receipts and a Revoke button.
- **The debrief view and `export_session`.** Both list the allowances used in
  the session.
- **Live updates.** Broadcasts for `granted`, `consumed`, `revoked` and
  `unknown` keep open tabs current.

### Revocation

Revoking changes `active` to `revoked` in the daemon, under the lock. A
`consumed` record cannot be revoked; the response is "already used by
*artifact*". If you no longer want that artifact, reject it as you would any
other.

## 5. Expiry: single-use, until the session ends, capped at 72 hours

**D1 (2026-10-08), with an amendment in this revision.** An allowance is
single-use. An unused one ends when its session ends, or 72 hours after it was
granted, **whichever comes first**. The amendment makes the 72-hour ceiling
unconditional. It can only **narrow** what Mitch decided: it never extends an
allowance's life, and it makes this revision's definition of "ended" (below)
safe even though that definition is coarse. §11 records it as a one-line
amendment.

### Definition: "ended" means the registration id is not in the live map

The daemon keeps an in-memory map from `registrationId` to
`{sessionId, registeredAt}`. An allowance's session has **ended** when its
`registrationId` is not in that map. Process ids are **not** probed: Fable
pointed out that pid probing is fragile, and Astra wanted a single policy.

Today's `activeSessions` is a set of session ids. In fallback mode several
wrappers share one id, so one wrapper's unregister removes the id for all of
them. The map sits **next to** that set. It does not change idle-shutdown
semantics.

What removes an entry from the map:

| Event | Removes the entry? | Notes |
|---|---|---|
| `/unregister` from that wrapper | Yes | This revision does not overstate how reliable it is (Fable MED). Today all three exit handlers fire an un-awaited request, and two of them exit immediately afterwards, so the request often never lands. The implementation must (1) **await** unregister in the `SIGINT` and `SIGTERM` handlers, with a 500 ms timeout before exiting, and (2) add a **stdin `end`/`close` listener** that unregisters. Stdin closing is how Claude Code tears down a stdio MCP server. The `exit` handler cannot await, so it stays best-effort. |
| A newer `/register` for the same `sessionId` in split mode | Yes, for the older entries | In split mode the session id contains the Claude conversation id, so a new registration means the old wrapper is gone, as after `/mcp` reconnect or `--resume`. In fallback mode older entries are not evicted, because concurrent conversations legitimately share the id. |
| The daemon restarts | Yes, all entries | The map is in memory, and `registrationId` includes the daemon's `instanceId`. The AA2 re-registration gets a new id. |
| The wrapper crashes or is SIGKILLed | **No** | The entry lingers. The **72-hour ceiling** ends the allowance. Also, a lingering entry cannot be claimed through the supported path, because only the dead wrapper's `DaemonClient` held that id. |
| Fallback mode, wrapper never unregisters | No | Same as above: the ceiling ends it. |
| Decision close-out (`/api/decisions/:id/close-out`) | No | It closes a decision, not a session. It is unrelated. |

**One policy for a registration that is live and older than 72 hours** (Astra):
the allowance is **expired**, and the claim refuses it with "expired at *t*".
§5 and §7 now both check `ceilingAt` unconditionally, and §10 tests it.

Rejected options:

- **A fixed 24 hours** was superseded by D1.
- **The session id alone** never ends in fallback mode, and in split mode it
  survives `--resume`.
- **Pid probing** was dropped in this revision.
- **Reusable for N days** is a time-boxed Retire.
- **Permanent** is Retire.

## 6. Interaction with preflight, revisions, and the hook

### Admission: inspect first, then consume atomically

Astra pointed out that revision 2's steps 2 and 3 conflicted. They are now
separate steps.

1. **Gate.** `runPreflight` blocks on session stance **S**.
2. **Inspect (does not consume).** The tool calls a read-only internal
   `GET` that returns candidate allowances for this session and registration
   with a matching `allowanceDigest`. Each candidate must be `active`, not
   ended and not expired. This takes no lock and writes nothing. If there are
   no candidates, the tool returns the block exactly as today, unless the
   replay check in §7 applies.
3. **Re-gate.** Re-run `runPreflight` with the stances covered by those
   candidates removed, for this call only.
   - If anything else blocks, return **that** block. Nothing is consumed.
   - If the proposal matches two session stances, it needs an allowance for
     each. The human grants them one block at a time, both against the same
     digest.
4. **Consume, which is also the mutation.** The tool sends the create (or the
   revise) **with** `admission: {operationId, exceptionIds[]}`, and the daemon
   claims atomically inside the same request (§7). If the claim fails because
   of a race, a revoke, the session ending or the ceiling, the daemon refuses
   the create, and the tool returns the normal block with the reason.

### Revisions need a new allowance (Fable MED)

`revise_artifact` re-gates under `revise_artifact`, with the revised content.
**An allowance never carries across the artifact's lineage.**

- A revision is different content, and different content is exactly what
  the digest is there to catch.
- A revision that no longer matches the stance passes anyway.
- A revision that still matches needs its own allowance, granted against the
  block for the revision.

The `consumedArtifactId` / `operation.artifactId` link is kept for audit only.
It never authorizes anything.

### What the agent sees

- **On a block:**

  > If this is a false positive, ask your pair to choose **Allow this
  > proposal once** on the block card. Then retry this **identical** call:
  > every argument must be the same, not only the matched text. You cannot
  > grant this yourself.

- **On admission:**

  > Admitted once under an allowance your pair granted (*UI/CLI*) for stance
  > "*S*" (reason: "*…*"). It covered this exact version only. If you revise
  > this artifact and the revision still matches the stance, your pair must
  > allow it again. The stance still applies to everything else. A direct edit
  > carrying this content will still prompt your pair.

- **On a replay** (§7): "Already admitted. Returning the original result for
  *art_x* (allowance *sx_…*). Nothing new was created."
- **When an allowance is used, revoked, ended, expired, unknown or
  inconsistent:** the usual block, plus one line that names which.

### The direct-edit hook: unchanged in v1 (D5 still open)

The Edit/Write/MultiEdit hook keeps asking. The allowance lifts a refusal and
never removes a prompt. An Edit's bytes are not the same as an admitted
`code_change` payload, so binding the two would need fuzzy matching. The new
Bash matcher (§3) and the guardrail class (§3) add prompts. They do not take
any away.

## 7. Concurrency, write ordering and idempotency

All allowance writes run in the **daemon**, under `mutatePreferences`. The CLI
now goes through the daemon. `ELOCKED` maps to 503 `lock_busy`, and nothing is
written without the lock.

### The admitted mutation carries a durable operation id (Astra P1)

Each **tool invocation** mints one `operationId` (a random UUID) before it
sends anything. The same id rides every transport attempt, including
`DaemonClient`'s transparent retry.

The daemon's create route (and the revise sequence) handles
`admission: {operationId, exceptionIds[]}` in **one synchronous section**. The
daemon is single-threaded, and every step below except the preferences write
is a synchronous `FileStore` call.

1. **Replay check.** If an artifact in this session already carries
   `admission.operationId === operationId`, return it unchanged, flagged
   `replayed: true`. This is the transparent-retry case.
2. **Claim**, under the preferences lock. Every listed exception must be
   `active`, bound to this session and registration, digest-equal to the
   recomputed payload digest, consistent (stored payload hashes to the
   digest), not ended and not expired. If so, each becomes `consumed`, with
   `operation: {id, state: "unknown"}`. If not, nothing changes and the
   response is a refusal.
3. **Create.** Create the artifact, stamped with the new optional field
   `admission: {operationId, exceptionIds}`. Then **flush before
   responding**: this is a write-through, the same rule `recordPostedReview`
   follows. The stamp is what makes replay work after a restart.
4. **Finalize**, under the lock. Set `operation.state` to `committed` with the
   artifact id.
5. **Respond.**

**When a release is allowed.** A consumed allowance goes back to `active`
**only** when the authoritative writer can prove that no effect happened. The
only such case is when the create in step 3 throws inside this same
synchronous section, before anything is persisted. `FileStore.createArtifact`
must be all-or-nothing on throw, which the implementation must test. In that
case the daemon reverts the claim, again under the lock, before it responds.
**The MCP tool never releases.** A failure the client sees (a network throw,
a timeout, a 5xx after a retry) is an **unknown outcome**. The allowance stays
consumed, with `operation.state: "unknown"`.

**Reconciliation.** Whenever the daemon reads allowances (the UI list, an
inspect, or startup), it handles each `unknown` operation:

- If an artifact stamped with that `operationId` exists, the state becomes
  `committed` and the artifact is linked.
- If no such artifact exists, the state stays **`unknown`**. The card shows
  "Outcome unknown. If nothing appeared, allow it again." The allowance is
  **never** re-armed automatically.

**Agent-level retry and restart replay.** Suppose the agent retries the
identical call, with a **new** tool invocation and therefore a new
`operationId`. Inspect (§6 step 2) also returns `consumed` allowances with a
matching digest and session. If one of those has an operation with a stamped
artifact, the tool returns the **original result** (the artifact id and URL,
in `buildDedupResponse` style) and creates nothing.

- This works after a daemon restart, because the stamp is in the flushed
  `artifacts.json`. It works even though the restart ended the registration:
  a replay grants nothing new, it only reports what already exists.
- If there is no stamped artifact, the call is blocked as usual, with the
  allowance's state named.

**The revise path.** The admitted mutation is the new version's create
(steps 1–4, keyed by `operationId`). The follow-ups run in the same daemon
sequence, and each is idempotent:

- superseding the parent (setting a status that is already set is a no-op);
- the carryover comment, with its id derived from `operationId`;
- the decision and plan-review records.

On a replay the daemon returns the original new-version id and re-applies
only the follow-ups that are missing.

### Races

- **Two identical calls at once, across sessions or within one.** Only one
  claim sees `active` under the lock. The other is refused. If both share an
  `operationId` (a transport retry), the second one replays.
- **Revoke against claim.** Both run in the daemon under the same lock, so
  one goes first.
- **Retire against claim.** A Retire that runs first removes the stance, so
  the claim's "stance present" check fails. That is harmless, because the
  gate no longer blocks. A claim that runs first wins, and Retire then
  proceeds.
- **Lock-free readers** (the hook, `getSessionMemory`) see either the old or
  the new snapshot, because writes are an atomic rename.

## 8. Alternatives considered

| Alternative | Why it was rejected |
|---|---|
| **Retire, then re-reject** | While the stance is retired, every session is unguarded on it. With publishing on, the global ledger also records an approval. Re-rejecting depends on you remembering. Nothing records why. |
| **Edit the stance's wording to narrow it** | That is a permanent policy change, and it can open real paraphrase holes. It is a worthwhile separate follow-up. |
| **Snooze the stance for a session** | This is the broad session bypass the issue rules out. |
| **A path-scoped exception** | The issue says to prefer one tightly scoped allowance first. Deferred. |
| **An MCP "request exception" tool** | The block card already is the request. It would put an exception-shaped verb in the agent's schema. Deferred. |
| **"Approved" said in chat** | Chat is not authority. |
| **A projection-only or token-set digest** | §2. |
| **Carrying the allowance along the revise lineage** | §6. That would reuse authority across changed content. |

### The in-memory, registration-bound alternative (Fable LOW)

**The idea:** hold *active* allowances only in daemon memory, keyed by
`registrationId`. There would be no schema change and no `preferences.json`
writes for authority. Receipts would go to an append-only, display-only log.

**Advantages over this design:**

- **A file edit cannot create live authority.** That closes the
  `preferences.json` forgery path for grants without relying on the
  guardrail prompt.
- **Session end becomes automatic.** Memory dies with the daemon, and
  removing a registration drops its grants.
- **No migration** is needed.
- **No preferences lock** is needed for the grant path, now that the CLI goes
  through the daemon anyway.

**Costs:**

- The receipt and the authority live in different places, so the claim
  cannot check "the stance still exists" and "the grant is active" in one
  transaction. A Retire racing a claim is still harmless, though.
- The replay and reconciliation in §7 do not need grant durability, since
  they key off the stamped artifact. So durability buys **less** than it
  first appears.
- It departs from the original brief, which said to "record via
  `mutatePreferences`".

**Status:** this revision keeps the persisted design so that the review covers
one coherent model. Because the CLI now writes through the daemon, switching
to in-memory authority is a contained change, and it would remove the
direct-edit forgery class outright. **It is flagged as open question O1 for
Astra and Mitch**, and the author leans toward it.

## 9. Migration, backward compatibility and docs impact

### Schema

Only new optional fields are added, per CLAUDE.md.

| Where | New optional fields |
|---|---|
| `preferences.json` | `stanceExceptions?` |
| `Artifact` (shared) | `admission?: {operationId, exceptionIds}` |
| `PreflightTraceSchema` | `exception?` |
| `PreflightBlockEntry` | `allowanceDigest?`, `payload?`, `projectionPreview?`, `stance?`, `registrationId?`, `eligible?` |
| `preflight_blocked` event | `payload?`, `rejectedAt?`, `registrationId?` |
| `/register` response | `registrationId?` |
| `StanceExceptionSchema` | New, in `packages/shared` |

- **No stance row changes.** No stance id is added. A legacy row without
  `rejectedAt` binds on `{description, concept}`.
- **Old blocks**, which have no payload, offer Retire only.
- **Old wrappers** have no `registrationId`, so they can never claim. That
  fails safe.
- **Downgrade.** An older daemon keeps `stanceExceptions` through its raw
  read-modify-write and ignores the field, so the proposal is blocked again.
  That also fails safe.
- **New error codes:**
  - `stance_exception_block_not_found`;
  - `stance_exception_not_eligible` (team, demo, too large, secret, stance
    retired, session ended);
  - `stance_exception_reason_required`;
  - `stance_exception_interactive_required`;
  - `stance_exception_claim_refused` (used, revoked, ended, expired,
    inconsistent);
  - `stance_exception_operation_unknown`.

### Docs: the guarantee wording DOES change (Fable MED)

Revision 2 said the guarantee wording would not change. That was wrong.
Implementation PRs must update:

| File and lines (at 842f4495) | Change |
|---|---|
| README L190–191 (the `present_*` row) | "Refused" stays, with an added clause: "unless you allowed that exact proposal once, from the UI or an interactive CLI. The artifact then carries an 'Allowed once' badge." |
| README L223–227 ("False positives and overrides") | Split this into **Allow once** (one exact proposal, until the session ends or 72 hours, the stance stays, nothing is mirrored) and **Retire** (deletes the stance). |
| README L197–199 (the direct-edit row, which says "doesn't see `Bash`") | Becomes: "It doesn't check `Bash` against your stances. One narrow `Bash` check asks before the shell grants a stance allowance, and that is the only Bash command it looks at." |
| FAQ L39–49 (the "every block is one-click overridable" list) | Split Retire from Allow once. Say that allow-once is **not** mirrored to the ledger and writes no approval. |
| FAQ L59–63 ("every fire is one click from an override") | Add Allow once as the non-destructive option. Retire stays the wholesale one. |
| `claude-plugin/skills/pairing-protocol/SKILL.md` L620–623 ("Don't retry a blocked call") | Add the one exception: retry the **identical** call only after your pair says they allowed it once. Never try to grant it yourself, and expect a permission prompt if you try. |
| `SECURITY.md`, threat model | Add the residuals: an allowance is human-only by design, not by enforcement. A same-user process can script a pty, bypass the Bash substring check, call the bearer route, or edit `preferences.json` (which is now guarded by an `ask` for the agent's Edit and Write tools). Receipts are not tamper-evident. |
| The block message in `preflight-validator.ts` and the hook reason text | §6 wording. |

## 10. Test plan

The tests use fakes, not mocks:

- a real `FileStore` on a temp directory;
- a real daemon, with real child processes for wrappers and the CLI;
- an injected clock;
- a fault-injecting fetch shim in front of `DaemonClient`.

### Unit

- **Allowance digest.** It is stable across key order. Changing *any*
  argument changes it, including non-projected ones. `params._meta` and a
  top-level `arguments._meta` do not change it. Whitespace, case and NFC
  versus NFD do change it.
- **Projection independence.** The matching projection is unchanged by
  `before`/`after`, so matching behaviour is identical to today.
- **State machine.** These transitions:
  - active, then consumed (unknown), then committed;
  - active, then consumed, then reverted on an in-section throw;
  - active, then revoked.

  Derived ended and expired:
  - a registration missing from the map is ended;
  - a registration with an old `instanceId` is ended;
  - in split mode, a newer registration evicts the older one;
  - in fallback mode, there is no eviction;
  - at `ceilingAt` the allowance is expired **even while the registration is
    live**, and 1 ms before it is admitted.
- **Multiple stances.** With an allowance for A, a proposal that still
  matches B is blocked on B, and A stays `active`. With allowances for both A
  and B against the same digest, one claim consumes both atomically.

### Adversarial

1. **Self-grant.**
   - The authority-surface test.
   - A grant without the bearer token gets 401.
   - Extra body fields get 400.
   - An unknown block id gets 404.
   - A team block, a demo session or a retired stance is refused.
   - Inspect never consumes: 100 inspects leave the allowance `active`.
2. **Non-projected content** (Astra P2, Fable HIGH). Grant P, a
   `present_code_change`. Then each of these is **blocked** and the allowance
   stays `active`:
   - the same `filePath`, `reasoning` and `concept` with a changed `after`;
   - a changed `before`;
   - a changed `concept.description`.

   Also blocked: a decision with one option's pros changed, and research with
   one evidence snippet changed. The digest equality test covers every key of
   each tool's input schema, generated from the zod schema so that new fields
   are covered automatically.
3. **Paraphrase.** A one-character change, a reorder, an alias synonym, a
   trailing clause, or a different tool: each is blocked, and the allowance
   stays `active`.
4. **Dropped response after commit** (Astra P1). The fetch shim lets the
   create reach the daemon, then destroys the socket before the response.
   - **Transparent retry:** `DaemonClient` retries with the same
     `operationId`, and the daemon replays. Result: exactly **one** artifact,
     the allowance is `consumed`/`committed`, and nothing is re-armed.
   - **Retry fails too:** the shim kills both attempts. The tool reports an
     error, and the allowance is `consumed`/`unknown`, **not** `active`. The
     agent's identical retry, as a new invocation, gets the **original**
     artifact back through replay, and still exactly one artifact exists.
   - **Restart:** commit, drop the response, kill and restart the daemon,
     then the agent retries. The replay returns the original artifact from
     the stamp in `artifacts.json`, the artifact count is 1, and the
     allowance is not re-armed.
   - **Revise path:** the same three cases for `revise_artifact`. There is
     exactly one new version, the parent is superseded once, and there is
     exactly one carryover comment.
   - **In-section throw:** a fixture that makes `createArtifact` throw before
     persisting. The claim reverts to `active`, and the identical retry is
     admitted.
   - **Crash between claim and create:** kill the daemon between steps 2
     and 3. After restart the allowance shows `consumed`/`unknown` and is
     never re-armed, and the retry is blocked as "ended".
5. **The CLI grant.**
   - Without a TTY it is refused. Each flag (`--yes`, `-y`, `--force`,
     `--non-interactive`, `--reason`) is refused. A missing or short reason
     is refused. `CLAUDECODE=1` is refused. In every case
     `preferences.json` is byte-identical afterwards.
   - **The CLI writes through the daemon.** With the daemon stopped, the
     grant is refused and no file is written. With the daemon up, the grant
     record is written by the daemon process, which the test checks through
     the lock-owner pid in a lock-trace hook. The record carries
     `grantedVia: "cli"`.
   - **Fable's one-liner, through the Bash hook.** Feed the generated Bash
     PreToolUse hook a `tool_input.command` of
     `printf 'reason\nallow\n' | script -qc 'env -u CLAUDECODE deeppairing stance allow <id>' /dev/null`.
     The hook returns `ask`. So do the plain command, a `bash -c '…'`
     wrapper, and a `python -c` wrapper that contains the words.
   - **Narrowness.** Over a corpus of 200 ordinary Bash commands (`ls`,
     `git status`, `pnpm test`, `grep -r stance`, `echo allow`,
     `deeppairing stance exceptions`), the hook writes **no output** and
     exits 0. The latency budget is checked.
   - **Documented residuals, pinned as passing.** `s=stance; deeppairing $s
     allow` is **not** caught by the hook. A scripted pty with `CLAUDECODE`
     unset **does** grant, and that grant is labelled `cli`. These tests
     exist so that nobody later claims these paths are closed.
6. **Direct file edits.**
   - Edit or Write to `.deeppairing/preferences.json` or `team.json` returns
     `ask`, even with a live pre-work ceremony and inside the dedup window.
   - Edits to other files are unaffected (parity test).
   - A hand-written grant whose `payload` does not hash to
     `allowanceDigest` is refused as inconsistent.
   - A consistent hand-written grant **is** admitted. This pins the
     documented limit, and the artifact still gets its badge.
7. **Session end and expiry.** These use a real daemon and wrappers.
   - SIGTERM is now awaited, so the unregister lands and the retry is
     blocked as "ended".
   - Closing stdin unregisters, and the retry is blocked as "ended".
   - After SIGKILL the registration lingers, and the allowance is admitted
     until `ceilingAt` and expired at it.
   - A `/mcp` reconnect and a `--resume` respawn in split mode evict the old
     registration, so the retry is blocked.
   - A daemon restart blocks the retry.
   - In fallback mode, wrapper 2 cannot claim wrapper 1's allowance.
   - A live registration past 72 hours is expired.
8. **Revisions.** A proposal admitted by allowance, then revised so it still
   matches, is **blocked** under `revise_artifact`. A revision that no longer
   matches is admitted with no allowance. The admission message names the
   one-version scope.
9. **Detection reaches the human.**
   - A grant raises a toast, and a CLI grant gets the stronger style.
   - The artifact card shows a persistent badge.
   - The debrief view's system section lists the allowances used.
   - The Markdown and HTML exports include them.
   - An agent-authored debrief cannot suppress the system section.
10. **Idempotency.** A double grant returns the same id. Revoking a consumed
    allowance reports "already used".
11. **No leakage.** With publishing on, nothing is written to the global
    ledger. `approvedPatterns` is unchanged. A payload the secret scanner
    flags is not persisted, and the block is marked not eligible.
12. **The edit hook is unchanged (D5 open).** An Edit with admitted content
    still gets `ask`.

### Web

- **Keyboard path.** Focus moves to the reason field, Enter is disabled while
  the reason is empty, Enter submits, Esc cancels, and focus returns to the
  card.
- **Failures.** 503 and 409 responses keep the dialog open.
- **The two-part preview** renders a `code_change` diff and decision pros and
  cons.
- **Live states.** The card shows allowed, used, unknown, revoked, ended and
  expired correctly.

## 11. Decisions (recorded)

Mitch decided D1–D4 on **2026-10-08**. D5 is still open, and O1 is new.

- **D1. Unused-allowance lifetime: until the session ends.** §5 defines
  "ended" as the registration being absent from the daemon's live map.
  - *Amendment (rev 3, narrows only):* the 72-hour ceiling applies
    unconditionally, even to a live session, so a live registration older
    than 72 hours is expired.
- **D2. CLI grant: yes, from both the UI and the CLI.** The CLI requires an
  interactive TTY, refuses non-interactive flags and agent-shaped
  environments, and needs a typed reason and a typed `allow`. Each grant
  records `grantedVia: ui | cli`.
  - *Rev 3, after review:* the CLI writes **through the daemon's bearer
    route**, the agent's Bash invocations of `stance allow` get a Claude Code
    `ask`, and grants surface as a toast, an artifact badge and debrief/export
    entries.
- **D3. The forgery gap is documented, not closed.** *Narrowed in rev 3:*
  receipts and badges cover supported operations only. They are not
  tamper-evident. Detection of same-user file modification is not
  guaranteed. Agent edits to `preferences.json` and `team.json` now always
  prompt.
- **D4. Own stances only.** Team-rule blocks stay out of v1.
- **D5 (open). The hook still prompts once after an allowed proposal.** The
  proposal in §6 stands. This review does not authorize removing the prompt.
- **O1 (open, new). In-memory active allowances** versus the persisted design
  (§8). The author leans toward in-memory.

## 12. Review response map (rev 3)

| Finding | Source | Addressed in |
|---|---|---|
| Admitted mutations must be idempotent; do not release on a client throw; replay across restart; cover create and revise | Astra P1 (Fable concurs) | §7 (operation id, replay, release only on proof, reconciliation, revise path); §10 adversarial 4 |
| The projection digest does not bind content (`code_change` `before`/`after`, evidence, pros/cons) | Astra P2, Fable HIGH | §2 (separate allowance digest via `hashPresentArgs`, the excluded transport metadata, the preview that shows what is covered); §10 adversarial 2 |
| The audit visibility claim is too strong | Astra P2 | §3 "What the audit trail does and does not promise"; §11 D3 |
| Inspect versus consume conflict | Astra | §6 steps 2–4 |
| 72 hours: unobservable-end fallback or unconditional? | Astra | §5 (unconditional, a single policy); §11 D1 amendment; §10 unit and adversarial 7 |
| The TTY gate is one shell line from the agent | Fable HIGH | §3 (a: CLI via the daemon route; b: narrow Bash `ask` matcher, with its limits; c: toast, badge, debrief/export); §10 adversarial 5 and 9 |
| Direct Edit to `preferences.json` | Fable MED, Astra P2 | §3 "Direct file edits" (guardrail class that always asks, the digest consistency check); §10 adversarial 6 |
| "Clean exit, then unregister" overstated; pid probing | Fable MED, Astra | §1 lifecycle row; §5 (live-map definition, awaited signals and stdin close, split-mode eviction, no pid probing) |
| Revisions | Fable MED | §6 "Revisions need a new allowance"; the admission message; §10 adversarial 8 |
| The docs guarantee wording does change | Fable MED | §9 docs table |
| The in-memory alternative | Fable LOW | §8; §11 O1 |
| D5 stays open, and the direct-edit prompt stays | Astra, coordinator | §6; §11 D5 |
