# One-proposal stance exceptions (proposal, #470)

> **Status: PROPOSAL, revision 1. No code is included.** It is written for
> Astra's scope and authority review, which must happen before any
> implementation starts.
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
card and in the block log. It is a human-only, single-use exception, recorded
in this project's `preferences.json`. It is bound to one stance, one session,
one tool, and the **exact content** of the proposal the gate refused. The
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
| Session | The `sessionId` of the block | A different session must not reuse the authority. This is what the issue asks for. |
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
> `/api/internal/*` route, hook output or CLI subcommand can create a
> stance exception. The only creator is the public route
> `POST /api/preflight-blocks/:blockId/exception`, which the companion UI calls
> after an explicit human gesture.

How it is enforced:

1. **Structural absence plus a test that pins it.** The grant method exists
   on `FileStore` only. It is *not* added to `IStore`, so `DaemonClient`
   (the agent-side store in the production plugin path) cannot call it, and
   no internal route exposes it. An **authority-surface test** enumerates:
   - every registered MCP tool's input schema, which must not grant;
   - `IStore` and `DaemonClient` method names, which must have no
     `grant*Exception`;
   - every `/api/internal/*` route, which must have no exception-creating route;
   - every CLI subcommand, which must have no grant.

   The test fails if any of these appears. This follows the
   `review-authorization.ts` lesson, "prose is not a gate": the check is in
   code, with one creator and no force flag.
2. **The grant route takes a block id, not a scope.** The body is
   `{reason}` and nothing else. The daemon looks up the server-minted block
   entry and copies the stance, session, tool, type and projection from that
   **durable record**. It computes the digest itself. The client cannot widen
   scope, choose a stance, or name content. Any extra body fields are rejected
   with 400. If the block id is unknown or has been pushed out of the log, the
   route returns 404 "retry the proposal to get a fresh block".
3. **What you see is what you allow.** The block event is agent-side data: the
   MCP process posts it through `DaemonClient.recordPreflightBlock`. Suppose
   the event were forged. The daemon still derives the digest from the *same*
   stored projection that the dialog shows you. A forged event can therefore
   only get you to allow the exact text on your screen. It cannot get you to
   allow different content hidden behind a matching preview.
4. **Route guards.** The route needs the SP1 bearer token and the project
   hash, like every mutation. It refuses `source: "team"` blocks (§7,
   decision D2), refuses `demo_` sessions, and refuses a block whose stance row
   no longer exists (409, "stance already retired").

### The honest residual (do not overclaim)

The agent runs as your user and has `Bash`. A same-uid process can read the
bearer token and `curl` the grant route, or edit `preferences.json` directly.
The same is true today for Retire, for verdict routes, and for decision picks
(`SECURITY.md`, SP1 comment in `http/routes.ts`). This design does **not**
claim to close that hole, and the docs must not say "cryptographically
human-only". What it does guarantee:

- The agent has no sanctioned path. Forging a grant means misusing the API
  out of band, through the same route a forged Retire would use, and Retire
  does more damage.
- **A forged grant is visible.** Every grant is broadcast, persisted with
  `grantedVia` and shown in the block log and Ledger drawer. Every admission
  by exception is stamped on the artifact's preflight trace and shown in its
  breadcrumb ("Admitted once by your exception: reason …"). A grant you did
  not make shows up next to an artifact you did not expect.

Optional speed bump, not a security claim: the route could also require the
`Origin` header of the daemon's own origin or `vscode-webview://`. A browser
sets this automatically, and curl has to spoof it on purpose. It is cheap and
keeps casual tooling off the route. Recommended, but it must be documented as
hygiene only.

### Surfaces

| Surface | Grant | List | Revoke | Why |
|---|---|---|---|---|
| Companion UI: the block card (hero toast) and the `PreflightBlockLog` entries | **Yes** | Yes | Yes | This is the place where you see the refused proposal in full. |
| Ledger drawer, on each stance | No (it shows the count and the receipts) | Yes | Yes | You review exceptions in the context of the stance. |
| CLI `deeppairing stance exceptions` | **No** | Yes | Yes | The CLI is the agent's most natural self-grant path (`Bash`), and the SKILL docs would advertise it. Revoke only narrows authority, so it is safe to offer there. |
| MCP tools and `/api/internal/*` | **No** | No | No | Covered by Invariant A1. The agent may *claim* an exception (§6), but cannot create, list or revoke one. |

The dialog behind **Allow this proposal once**:

- It shows the stance, the reason you gave for it, and the **full proposal
  preview** (the projection, not just the matched phrase).
- It states the scope in plain words: "Allows this exact proposal, once, in
  this session, for the next 24 hours. The stance stays on for everything
  else."
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
| `status` | `active`, `consumed` or `revoked`. "Expired" is **derived** from `expiresAt` at read time, so expiring needs no write. |
| `stance` | `{description, concept?, rejectedAt?}`, copied from the blocking row. |
| `sessionId`, `toolName`, `artifactType` | The binding (§2). |
| `proposalDigest` | `sha256:<hex>`, computed by the daemon. |
| `proposalPreview` | The canonical projection (at most 32 KiB). This is the receipt of what you allowed. |
| `blockId` | Links back to the block log entry. The block log keeps only 50 entries, so the preview here is the durable copy. |
| `grantedAt`, `grantedVia` (`"ui"`), `grantedBy?` | `grantedBy` is a best-effort display name taken from `git config user.name` on the daemon side, if available. deepPairing has no identity system, so this field labels the grant and does not authenticate anyone. |
| `reason` | **Required**, 3–280 characters after trimming. The dialog offers quick picks ("Wording overlap, not the approach I rejected", "Conditions changed for this case") that you can edit. A reason you have to type turns a click into a receipt, and it is what the agent reads back. |
| `expiresAt` | `grantedAt` plus 24 hours (§5). |
| `consumedAt?`, `consumedArtifactId?`, `claimToken?` | Set by the claim (§6). `claimToken` is internal and never shown. |
| `revokedAt?`, `revokedVia?` (`"ui"` or `"cli"`) | Set by revoke. |

Retention: all `active` records, plus the newest 100 terminal records
(consumed, revoked or expired). Older terminal records are pruned in the same
`mutatePreferences` transaction as any grant. The hook reads the whole file
without a lock on every edit, so the file stays small.

### Where you see it

- **Block log and block card.** After a grant, the card reads "Allowed once,
  *reason*, waiting for the agent to retry". After consumption it reads "Used
  by *artifact title*". After revocation or expiry, the card says so. The UI
  joins block entries to exceptions by `blockId` from a new
  `GET /api/stance-exceptions`, so the daemon stays the only writer of the
  block log.
- **The artifact.** Its preflight trace gains an optional `exception` summary
  (`{id, stance, reason, grantedAt}`), and the breadcrumb reads "Admitted once
  by your exception for '*stance*' (*reason*)".
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

## 5. Expiry

**Recommendation: single-use, bound to the session, and an unused grant
expires after 24 hours.**

- **Single-use** matches the issue's "one proposal". After one admission the
  authority is gone, so an exact retry later is blocked again. The block
  message then names the artifact that used it, so the agent knows its first
  call succeeded.
- **Bound to the session**, because a different session must not reuse
  authority. A Claude Code `--resume` keeps the same session id, so resuming
  a conversation does not lose a grant.
- **A 24-hour limit on unused grants** is cleanup. You might grant and the
  agent might never retry. A grant you forgot about should not stay armed
  indefinitely. 24 hours covers an overnight pause between your grant and the
  agent's retry. Expiry is derived from the stored time, so it survives a
  daemon restart with no timer.
- **Restarts.** Grants and claims are on disk, so a daemon restart between
  the grant and the retry changes nothing.

Rejected options:

- *Expires with the session only.* deepPairing sessions can live for days, so
  a stray grant would stay armed for too long.
- *N days, reusable.* That is a time-boxed Retire for one text. Reuse is
  exactly the loophole the issue warns about.
- *Permanent.* That is Retire.

## 6. Interaction with the hook and with preflight

### Preflight (`present_*` and `revise_artifact`): the exception applies

The admission flow:

1. `runPreflight` blocks on session stance **S**.
2. Look up an `active`, unexpired exception that matches S and this session,
   tool, type and digest. The agent-side process asks the daemon through a
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
- **On a used, revoked or expired exception.** The usual block, plus one
  line: "An exception for this proposal was already used by *art_x*" (or
  "was revoked" / "expired at *t*").

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
| **Grant** | The daemon, from the UI route | Check that the block's stance row still exists with the same identity. If an `active` exception already has the same binding, return it (idempotent, same `id`, 200). Otherwise append a new one and prune. |
| **Claim** | The daemon, from a new internal route `POST /api/internal/sessions/:sid/stance-exceptions/claim`, or `FileStore` directly in standalone mode | The body carries the projection and stance identity, and the daemon recomputes the digest. It requires the stance row present, a matching `active` and unexpired record, and a matching session. It then sets `consumed`, `consumedAt` and a fresh `claimToken`, and returns `{id, claimToken, reason}`. If anything fails, it returns "no exception", and the caller returns the normal block. |
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
    `rejectedAt?`.
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
    lets one exact proposal through in this session; the stance stays."
  - The faq guarantee paragraphs.
  - The block message text in `preflight-validator.ts`.
  - The SKILL guidance on what to do after a block.
  - The guarantee wording itself does not change: the gate still refuses,
    and only you can lift a refusal, once.
- **New error codes**, in `error-codes.ts`: `stance_exception_block_not_found`,
  `stance_exception_not_eligible` (team, demo, too large, stance retired) and
  `stance_exception_reason_required`.

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
  consumed to released to active, active to revoked, and derived expiry at
  the boundary (exactly `expiresAt` counts as expired).
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
2. **A paraphrase of an excepted proposal.**
   - Grant for P, then submit P with one character changed, P with an
     option reordered, P with a synonym from the alias table, P with a
     trailing clause, and P through a different tool. Every one is blocked by
     the same stance, and the exception for P is still active.
   - A forged block event whose `proposal` (matched phrase) differs from its
     projection still produces a digest of the projection shown in the
     dialog.
3. **Expiry.**
   - With an injected clock: at grant + 24 h minus 1 ms the proposal is
     admitted, at grant + 24 h it is blocked with "expired".
   - A daemon restart between grant and retry still admits (new `FileStore`
     instance, same disk).
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
6. **Session binding.** The same content from another session id is blocked,
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
   Edit with the same text still returns `ask` (pins the v1 rule).

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

## 11. Decisions that need Mitch

- **D1. Unused-grant lifetime.** 24 hours is proposed. Shorter (such as 1
  hour) is tighter. Longer helps grants made overnight.
- **D2. Team-rule blocks are excluded in v1.** They keep pointing to
  `team.json`. A personal exception to a committed team rule is a policy
  question, not a mechanism question.
- **D3. Grant is UI-only, with no CLI grant.** This costs terminal-only users
  a browser trip. The reason is that a CLI grant is the agent's easiest
  self-grant path.
- **D4. The hook keeps asking** after an admitted proposal. That is one extra
  prompt in exchange for one simple rule.
- **D5. The residual is documented, not closed.** A same-uid process holding
  the bearer token can forge a grant, as it can forge Retire today. The docs
  will say "human-only by design, visible if forged", and will not claim it
  is enforced.
