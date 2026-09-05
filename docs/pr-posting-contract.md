# Recoverable PR review posting (#344)

Status: implemented for review; draft stack, **do not merge**. Commit provenance comes from
#343; this protocol must not weaken its target, verdict, or reviewed-SHA gates.

## Invariant

For one session and canonical GitHub PR, at most one operation may be reserved
or possibly sent. A recorded successful review still requires explicit human
repost authorization. An unresolved operation blocks **even `repost: true`**.
Changing the event, payload, spelling of the target, or reviewed SHA cannot
evade that unresolved-operation guard.

The remote review endpoint sends notifications and accepts `commit_id`, but
does not document an idempotency key or conditional compare-and-post API.
Consequently this is duplicate prevention and honest uncertainty, **not
exactly-once delivery**. See the [GitHub review API](https://docs.github.com/en/rest/pulls/reviews).

## Durable state machine

| State | Meaning | Allowed next state |
| --- | --- | --- |
| reserved | Locally claimed; network POST has not begun | sending, failed |
| sending | Durable marker written before invoking POST; may have landed | succeeded, unknown |
| succeeded | Validated remote review identity recorded | terminal |
| failed | This operation is known not to have invoked POST | terminal |
| unknown | Remote acceptance cannot be established | succeeded by reconciliation only |

A process dying in `sending` leaves an unresolved operation, never permission
to retry. A timeout, dropped response, malformed success response, or failed
local success stamp is uncertain. Conservatively treat any failure after POST
invocation as unknown, even if it might be a harmless authentication rejection.

Reserve and transition operations use a short, exclusive session-local claim.
Do not hold that filesystem claim across a network await. Every transition
compares an unguessable operation ID/token and its expected current state;
late callers cannot send after a reservation was cancelled. No age-only or
cross-platform PID-based claim stealing. An orphaned filesystem claim requires
all writers to stop before explicit local repair.

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
posts only that frozen payload. Any mismatch before `sending` is a known-not-sent
failure. A mismatch after durable `sending` prevents POST but conservatively
leaves the journal unresolved; it is never rolled back into automatic retry
permission across an uncertain daemon response.
No fake/in-memory fallback is allowed when durable posting methods are absent.

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
Reconciliation may record a verified matching remote review without posting
anything. No match, unavailable API, or ambiguous matches are not evidence that
the operation failed: leave it blocked and ask the human to inspect GitHub.
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

## Verification

Use fake gh only: two calls/processes racing to the same target; different PR
targets; mixed event/SHA/payload and target case variants; failure before send;
process death before/after `sending`; remote acceptance followed by timeout;
invalid response identity; local stamp failure; corrupt legacy/new records;
abandoned reservations and stale tokens; reauthorization after delayed remote
preparation; and CLI/MCP parity. A restart must never turn uncertainty into a
second POST. Source tests, typecheck/lint, clean bundle, and independent
adversarial review are required before this draft is considered ready.
