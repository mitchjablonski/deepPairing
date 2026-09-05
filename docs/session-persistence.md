# Session persistence and concurrent writers

FileStore keeps an immutable baseline for each persisted record collection.
On flush it writes only locally changed collections, reading their current disk
contents and applying the local field deltas. A stale comment writer cannot
revert a newer artifact review, and a rename cannot restore a stale status.
Requests and render failures follow the same rules as artifacts, comments,
decisions, and plan reviews. Deleting the final render failure writes `[]`.

Concurrent changes to different fields are preserved. Conflicting changes to
the same scalar, field deletion, or ordinary array use last successful flush
wins, not wall-clock timestamps. Status-history append deltas are retained in
commit order and exact duplicate entries are collapsed. A record removed on
disk is not resurrected by a stale writer that previously loaded it. This
replaces the old behavior of restoring every cached record after external pruning.
Whole-file disappearance is not treated as intentional deletion: a dirty writer
that previously observed the collection fails its flush and retains its pending
delta until a valid file is restored. A collection that has never existed may
still be created normally.

Cooperating FileStore writers take an exclusive per-session `.flush.lock` across
read/merge/write. Lock acquisition is bounded to 250 ms; contention never causes
an unlocked write. Debounced contention retries with backoff capped at two
seconds while the process remains alive. Attempts continue indefinitely, but
each acquisition attempt remains bounded. `forceFlush()` reports failure to its
caller. Successful per-file commits advance only that file's baseline, so a
retry after a later-file failure does not duplicate already committed deltas.

Limits: this is not a transaction across JSON files, a power-loss durability
guarantee, or protection against older FileStore versions / tools which ignore
the lock. Different-process readers may observe a partially completed multi-file
flush. Same-field conflicts do not provide compare-and-swap or user arbitration.
Metrics merge this writer's appended observations; other sidecars have their
own persistence contracts. Existing session JSON formats are unchanged. A
debounced HTTP mutation can return after changing memory but before persistence;
non-lock disk failures are logged and remain pending until a later mutation or
an explicit successful `forceFlush()`. Callers that require confirmed durability
must use a route that performs and reports that flush.

## Recovering a review/content conflict

When one writer changes an artifact's reviewed identity (content, version, type,
or parent) while another records review authority, their stale states are not
merged. Review authority includes terminal verdicts, decision responses, plan
reviews, and a changeset's per-file `reviewState` / `reviewReasons`. Plan-step
execution `status` / `statusNote` is progress rather than proposal identity, so
progress-only updates may still merge without transplanting a review.

The writer that detects the conflict freezes authorization reads and later
artifact, decision, plan-review, and review-metrics writes, so its stale review
authority cannot be committed after the fact. Independent comments, requests,
and render-failure records still get their own flush attempts; this isolates
accepted human input but does not make the files transactional. Affected HTTP
state and review-authority surfaces return a structured
`session_review_conflict` 409 instead of reporting success.

Preserve and inspect the on-disk artifact, then stop and restart the daemon or
other session writer to create a fresh FileStore. Review the reloaded artifact
before authorizing it. A browser refresh alone does not recreate the daemon's
FileStore and therefore does not clear the freeze.

## Recovering an abandoned flush lock

A crash can leave `.deeppairing/sessions/<session-id>/.flush.lock` behind.
The lock contains its creator's PID and creation time. It is never broken by
age: a paused live writer could otherwise resume and overwrite a newer commit.
An `ELOCKED` error identifies the exact path. First stop **all** daemons, CLI
commands, and other writers for this project. Inspect the named lock, remove
only that session's `.flush.lock`, then restart the writer. Do not remove locks
while writers are running, and do not infer ownership from PID alone (PIDs can
be reused). This recovery does not delete session records.
