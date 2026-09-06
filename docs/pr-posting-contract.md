# Recoverable PR review posting (#344)

Status: implemented for review; draft stack, **do not merge**. Commit provenance comes from
#343; this protocol must not weaken its target, verdict, or reviewed-SHA gates.

## Invariant

For one session and canonical GitHub PR, at most one operation may be reserved
or possibly sent. A recorded successful review still requires explicit human
repost authorization. An unresolved operation blocks **even `repost: true`**.
Changing the event, payload, spelling of the target, or reviewed SHA cannot
evade that unresolved-operation guard.

The scope is deliberately one session, not all reviews in a project. Separate
sessions can contain independent human-reviewed payloads and may post to the same
PR. Cross-session duplicate prevention is not claimed. The CLI requires an explicit
`--session-id` identifying the same reviewed session as MCP; it never selects the
most recent session for an external write. That id is validated against the
sessions already on disk before anything constructs a store, so a typo can
neither create a session directory nor reach `gh`. Membership is all it
establishes: naming a *different* existing session remains the operator's
explicit choice and gets that session's journal, with no cross-session
deduplication implied. Starting another session is not recovery
for an unknown result: inspect and resolve the original operation first.

The remote review endpoint sends notifications and accepts `commit_id`, but
does not document an idempotency key or conditional compare-and-post API.
Consequently this is duplicate prevention and honest uncertainty, **not
exactly-once delivery**. See the [GitHub review API](https://docs.github.com/en/rest/pulls/reviews).

## Durable state machine

| State | Meaning | Allowed next state |
| --- | --- | --- |
| reserved | Locally claimed; network POST has not begun | sending, failed |
| sending | Durable marker written before invoking POST; may have landed | succeeded, unknown, explicit operator abandonment, live-lease unsent release |
| succeeded | Validated remote review identity recorded | terminal |
| failed | This operation is known not to have invoked POST | terminal |
| unknown | Remote acceptance cannot be established | succeeded by reconciliation, explicit operator abandonment |
| abandoned | Operator acknowledged uncertainty and duplicate risk | succeeded only by independently verified reconciliation; fresh explicit repost required |

A `sending` operation released through the live-lease door records an
`unsentRelease` marker naming its prior state, so `list` distinguishes "never
left `reserved`" from "had written its sending marker when its live coordinator
attested it never reached POST". A `sending` state on its own never carries that
meaning. See [Live-lease unsent release](#live-lease-unsent-release).

A process dying in `sending` leaves an unresolved operation, never permission
to retry. A timeout, dropped response, malformed success response, or failed
local success stamp is uncertain. Conservatively treat any failure after POST
invocation as unknown, even if it might be a harmless authentication rejection.
An operator may explicitly acknowledge `sending`/`unknown` as `abandoned` using the
offline procedure below. This records a human decision, **not** a definite failure
or proof that GitHub accepted nothing. Ordinary `repost` never performs this step.

Reserve and transition operations use a short, exclusive session-local claim.
Do not hold that filesystem claim across a network await. Every transition
compares an unguessable operation ID/token and its expected current state;
late callers cannot send after a reservation was cancelled. No age-only or
cross-platform PID-based claim stealing. An orphaned filesystem claim requires
all writers to stop before explicit local repair.
The journal claim is distinct from the artifact writer's `.flush.lock`; neither
is held while acquiring the other or while awaiting a network operation.

## Identity and authorization

Persist versioned, strictly validated records with canonical case-folded
github.com owner/repository, positive PR number, session ID, event, reviewed
commit (or explicit legacy-unbound non-approval), payload digest, operation ID,
state, and timestamps. Fingerprint the exact authorized payload and immutable
provenance; do not store tokens, raw credentials, or raw review bodies in the
operation journal. A token is a local fencing value, not external authorization.

For recovery correlation, the wire body appends an HTML comment containing the
random operation ID (never its fencing token or the session ID). The stored
payload digest covers the authorized payload before this deterministic suffix.
Reconciliation requires that exact suffix, removes it, and compares the remote
body and original inline-comment coordinates/content with the stored digest.
An older identical review without this operation marker is not a match.

Both CLI and MCP must use one coordinator and the same durable store methods.
Resolve/read remote preparation first, re-read local authorization, reserve,
and compare the prepared payload/provenance with the current authorized result
again before the durable `sending` transition, then re-check once more after
that transition's response and immediately before invoking POST. The coordinator
posts only that frozen payload. Any mismatch or error before POST is invoked is a
known-not-sent failure, including one raised after the durable `sending`
transition; see [Live-lease unsent release](#live-lease-unsent-release) for the
narrow conditions under which that classification is permitted. Nothing at or
after POST invocation may be classified this way.
No fake/in-memory fallback is allowed when durable posting methods are absent;
the coordinator verifies the store implements every durable method and refuses
before reserving, because its best-effort failure paths would otherwise swallow
an absent method and silently degrade a door.

The final check is an authorization snapshot, not a distributed transaction:
a human verdict or remote head can change after it. #343 binds the POST to the
reviewed SHA; this protocol must not advertise an atomic lock on GitHub state.

Posting uses `getReviewPostState`, not the cached UI hydration snapshot. FileStore
reads the persisted artifact collection under the same short `.flush.lock` used
by cooperating writers, then projects pending local changes against its immutable
baseline. This read does not flush, replace the live cache, or advance baselines.
External revocations and deletions therefore affect the next posting gate even
when the daemon has no locally dirty artifacts. Divergent concurrent verdicts,
review/content conflicts, and incompatible same-ID additions refuse posting and
freeze the writer. Malformed, duplicate, unreadable, or lost previously observed
artifact collections fail closed. The daemon client uses a dedicated authenticated
route; older daemons cannot silently fall back to cached state. Ordinary UI
hydration and last-flush-wins persistence keep their existing contracts.
Every posting snapshot also strictly validates legacy posted-review history,
including reauthorization after reservation; malformed history is never treated
as an empty record merely because the journal's initial reservation succeeded.
These checks assume supported review handlers and cooperating current writers.
They do not prove historical human authorization after direct JSON tampering or
privileged mutation of an approved artifact without using the revision workflow.

## Recovery and compatibility

Keep valid legacy `posted-reviews.json` readable and duplicate-blocking. Missing
history is allowed for a never-posted session; malformed, truncated, or
structurally invalid history/journals fail closed, not empty. The new journal
is authoritative for new operations. A compatibility history mirror must not
be the only durable success record; if mirroring fails, succeeded/sending still
blocks a duplicate. Older binaries cannot honor the new journal: stop writers
before downgrade, and do not downgrade an unresolved session.

An abandoned `reserved` operation can be explicitly cancelled with an atomic
state/token check, which fences any late attempt to enter `sending`. A
`sending`/`unknown` operation cannot be cancelled as though it never sent.

### Live-lease unsent release

The second reauthorization runs *after* the durable `sending` transition, because
that transition is itself an awaited daemon round trip during which a human can
withdraw approval. When it fails — a revoked verdict, an `ELOCKED` authorization
read, an unreadable journal, or an ambiguous `markSending` response — the
coordinator has not reached its POST call, a fact established by its own control
flow rather than by anything the journal can check. Leaving that attempt unresolved
would demand an operator acknowledgement that accepts duplicate risk for a review
that certainly does not exist. The coordinator therefore releases its own exact
attempt to `failed`.

This is a **trust boundary, not remote proof of non-delivery.** The journal
cannot observe GitHub. It verifies one thing and trusts another:

1. *Verified:* the caller presents the exact unguessable fencing token issued to
   that operation. The token is held only in the live coordinator's memory, is
   persisted only as a digest, and is never logged — so a restarted process, a
   competing process, and the operator CLI cannot produce it. Holding it means
   being the live coordinator of that attempt.
2. *Trusted, not verified:* that the caller has not invoked POST. This is an
   in-process code-path invariant of the coordinator, whose only call site is
   the failure path of the block that precedes the single POST call.

Be precise about what the journal's state check does **not** do. `sending` is
written *before* the POST and persists across it — that is the whole point of
the marker — so `reserved`/`sending` is **not** evidence that POST was never
invoked. The check only rejects operations that already reached a resolved or
uncertain outcome, which is what fences replay and any post-send downgrade.
Non-invocation rests entirely on premise 2.

Consequently the following must **not** reach this door, and do not:

- A crash or restart in `sending` — the lease is gone with the process.
- A wrong, forged, stale, or replayed lease, or a second release of one already
  released.
- Any invocation of POST, including a timeout, a dropped response, and a
  malformed success response; those remain `unknown`.
- Generic operator cancellation. `cancel-reserved` stays `reserved`-only, and no
  operator command releases an unsent attempt — the operator has no lease.
- Elapsed time, missing remote evidence, or an absent remote review.

The release is best-effort and fail-closed: if its own durable write fails, the
operation stays blocking and the caller is told the reservation was not released.
Over the daemon this is a distinct `unsent` protocol action, kept separate from
the reserved-only `failed` action so an older client's narrower release keeps its
meaning; an older daemon rejects the new action and the attempt stays blocking.

Like operator acknowledgements, the `unsentRelease` marker is a journal field an
older binary rejects as invalid rather than ignores. That refusal is fail-closed,
but it blocks posting for the whole session: do not downgrade a session whose
journal records one.
Reconciliation may record a verified matching remote review from `sending`,
`unknown`, or `abandoned` without posting anything. Reconciliation after an
acknowledgement preserves that complete audit unchanged beside the remote result;
it never revives the original lease or resolves a separately authorized repost.
The same receipt is idempotent and a conflicting remote identity is refused.
No match, unavailable API, or ambiguous matches are not evidence that the operation
failed: leave it blocked and ask the human to inspect GitHub.
Do not turn generic `repost` into an unknown-outcome bypass. Explicit human
recovery must identify the operation and acknowledge the uncertainty.

Operator commands are `review-posts <session-id> list`,
`review-posts <session-id> cancel-reserved <operation-id>`, and
`review-posts <session-id> reconcile <operation-id> <remote-review-id>`.
Reconciliation fetches the selected review and all bounded comment pages via
GET only. Wrong marker, edited content, missing original coordinates, unsupported
multi-line/reply records, changed comment order, API failure, or pagination beyond
the safety cap leaves the operation blocked. It does not search for approximate
matches or claim remote absence proves non-delivery.

### Where the operator commands live

These commands are a thing a **person** runs. They are never exposed as MCP
tools or daemon mutation routes: they accept duplicate risk on a human's
assertion, and an agent must not be able to make that assertion.

They are runnable on every install path:

| Install | Invocation |
| --- | --- |
| Marketplace / `--plugin-dir` plugin | `node "<plugin>/server/review-posts.mjs" <session-id> …` |
| Source checkout | `node claude-plugin/server/review-posts.mjs <session-id> …` — or `node packages/mcp-server/dist/cli/init.js review-posts <session-id> …` |
| npm install (when the package is installed) | `npx -y -p @deeppairing/mcp-server deeppairing review-posts <session-id> …` |

`<plugin>` is the installed plugin directory. `CLAUDE_PLUGIN_ROOT` names it for
hooks and slash commands but is **not** set in your shell, so locate it once:

```bash
find ~/.claude/plugins -name review-posts.mjs -path '*deeppairing*'
```

Run it with `--help` and it prints its own absolute path in every example, so
the invocation is true for wherever it actually landed. It acts on the project
at `CLAUDE_PROJECT_DIR`, else `DEEPPAIRING_PROJECT_ROOT`, else the current
directory, and names that project on stderr. `list` and `inspect` print JSON on
stdout, so `… <session-id> | jq` works.

A session id it cannot find in that project is **refused**, naming the ids that
do exist — a typo, or the right id in the wrong directory, must not answer `[]`
and exit 0, which reads exactly like "this session posted nothing". The check is
directory existence only, never session readability: gating it on
`FileStore.listSessions` the way the posting door does would make a session with
corrupt artifacts unrecoverable through the one tool that exists to recover it.
A session directory with no journal yet still answers with an empty list.

The entry ships the **whole** operator surface, in two honest classes:

- **Offline** — `list`, `inspect`, `cancel-reserved`, `release-claim`,
  `acknowledge-unknown`. These open no network connection at all.
- **Read-only GitHub** — `reconcile`, which needs `gh` installed and
  authenticated. It issues GETs for the review id you give it and its comment
  pages, checks the correlation marker, destination, verdict, reviewed commit,
  body and every inline comment, and records the result locally on a match. A
  mismatch, a missing review, or an unavailable API leaves the operation
  blocked; recovery never sends a review.

It **cannot** submit a review, and that is structural rather than promised: the
remote read lives in `github/read-review.ts`, which `github/post-review.ts`
imports (never the reverse), so the posting module and the payload builder are
outside the operator bundle's module graph. The shipped file contains no HTTP
method string but `GET` and constructs exactly one outbound command — asserted
against the built artifact in `__tests__/plugin-operator-entry.test.ts`.

Shipping only the offline verbs would have left an operator who *found* the
review on the PR with two moves: accept duplicate risk, or install the source
tree. Reconciling against real evidence is strictly better information than an
acknowledgement, so the drain that uses it has to be in the box.

### Offline operator inspection and acknowledgement

`review-posts <session-id> inspect` reports bounded file metadata, validity, and a
claim digest without printing raw bytes, claim tokens, credentials, or review bodies.
`list` also returns blocked inspection details when journal/history validation fails.
Neither command repairs, deletes, or converts corrupted history into an empty journal.
Preserve corrupted files and restore them from trustworthy evidence before posting.

If a claim is abandoned, stop **all** writers for that session, including CLI/MCP
processes and the daemon. Inspect it, then explicitly run
`review-posts <session-id> release-claim <digest> --all-writers-stopped`.
Only the unchanged inspected claim is removed; journal/history remain untouched.
The flag is the operator's coordination assertion, not an automatic liveness check.
Do not run it concurrently with any writer. A changed digest refuses removal.

If remote evidence cannot reconcile an operation and the human chooses to accept
the risk of a duplicate review, stop all writers, inspect `list`, and run
`review-posts <session-id> acknowledge-unknown <operation-id> <operationDigest> --all-writers-stopped --accept-duplicate-risk`.
This preserves the original operation and records its prior uncertain state, digest,
and acknowledgement time as `abandoned`. A stale digest or non-uncertain state refuses.
It sends nothing, and late original callers are fenced. A subsequent attempt still
requires an explicit human-authorized repost plus current target/verdict/SHA checks.
Never run this automatically, on the agent's initiative, or as a substitute for
checking available remote evidence. If exact matching evidence is found later,
`reconcile` records `succeeded` while retaining the acknowledgement; the original
lease stays permanently fenced and any later unresolved repost remains untouched.
Older binaries reject acknowledgement-bearing journal records, including a
reconciled-success record: the on-disk version field cannot teach an old binary
this schema. Stop all writers and do not downgrade such a session.

## Verification

Use fake gh only: two calls/processes racing to the same target; different PR
targets; mixed event/SHA/payload and target case variants; failure before send;
process death before/after `sending`; remote acceptance followed by timeout;
invalid response identity; local stamp failure; corrupt legacy/new records;
abandoned reservations and stale tokens; reauthorization after delayed remote
preparation; a real held `.flush.lock` during the second reauthorization;
wrong/forged/replayed leases against the unsent release; and CLI/MCP parity. A restart must never turn uncertainty into a
second POST. Source tests, typecheck/lint, clean bundle, and independent
adversarial review are required before this draft is considered ready.
