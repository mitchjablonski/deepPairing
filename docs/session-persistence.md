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
authority cannot be committed after the fact. Writes into those lanes are
refused at the store entrypoint — `createArtifact`, `updateArtifactStatus`,
`renameArtifact`, `setRetractReason`, `updatePlanProgress`,
`setChangesetFileReview`, `acknowledgeStatusChanges`, `acknowledgeDecisions`,
and the decision / plan-review record and resolve calls — before any in-memory
mutation, checkpoint receipt, hint file, or
render-failure clear, so no caller holds a success receipt for a record the
flush would discard. A refused revision leaves its parent untouched. Independent
comments, requests, and render-failure records still get their own flush
attempts; this isolates accepted human input but does not make the files
transactional. Affected HTTP state and review-authority surfaces return a
structured `session_review_conflict` 409 instead of reporting success, and a
rejection refused this way records no cross-project rejection stance (see
`docs/troubleshooting.md`).

Preserve and inspect the on-disk artifact, then stop and restart the daemon or
other session writer to create a fresh FileStore. Review the reloaded artifact
before authorizing it. A browser refresh alone does not recreate the daemon's
FileStore and therefore does not clear the freeze.

## Project preferences and the philosophy ledger

Two whole-file records outside the session directory use the same lock
mechanism (`src/store/file-lock.ts`), because separate processes write them:

- `.deeppairing/preferences.json` (rejected approaches, approved patterns,
  publish opt-in, autonomy and density) is written by the project's daemon and
  by CLI commands such as `philosophy publish on|off`. Every mutation holds
  `.deeppairing/preferences.json.lock` across read, change and atomic replace.
- `~/.deeppairing/philosophy/v1.json`, the cross-project ledger, is written by
  every project's daemon and by `philosophy import` / `philosophy remove`. Every
  mutation holds `~/.deeppairing/philosophy/v1.json.lock`.

Acquisition waits at most one second, then throws `ELOCKED`. The mutation is
not applied. Routes answer HTTP 503 `lock_busy`, and CLI commands print the
error. The one
exception is the ledger mirror inside a rejection or approval: it logs the
failure, and the project-local record still lands. Readers, including the
preflight hook, never take these locks; they read the atomically replaced file.
Concurrent `philosophy remove` and a new instance for the same concept are
serialized: whichever commits second wins, so a record after a remove creates
the concept again. An abandoned lock is recovered the same way as a flush
lock. A dead owner's lock is recovered automatically. For any other lock, stop
every daemon and CLI writer, then remove only the named lock file.

### Known residual cases

- **Mispredicted conflict with a busy lock.** The reject route checks for a
  review conflict before recording. If it predicts a conflict that the save
  then does not hit, it records after the save. If the preferences lock is busy
  at that point, the status is `rejected`, the route returns 503, and the
  approach is not remembered. Rejecting again records it.
- **Conflict race with publish on.** A review conflict that lands in the
  milliseconds between that check and the save removes the local rejection row.
  With cross-project publish on, the ledger entry already mirrored for it stays
  in the ledger.
- **Windows boot-ID drift.** On Windows the boot ID is derived from uptime,
  rounded to the minute. Sleep, a clock step, or a minute boundary (about 0.05%
  of locks) can make two processes disagree about it. The owner is then
  "unknown", and the lock stays fail-closed until `doctor` or a manual delete
  removes it.

## Recovering an abandoned flush lock

A crash can leave `.deeppairing/sessions/<session-id>/.flush.lock` behind.
The lock records its creator's full process identity: platform, hostname, boot
ID, PID namespace, PID and (on Linux) process start time. It is never broken by
age, because a paused live writer could otherwise resume and overwrite a newer
commit. The next writer recovers it only when the identity matches its own
operating-system instance exactly and the owner is provably dead: the PID no
longer exists, or (on Linux) it now belongs to a process with a different start
time. WSL2 and Windows share a hostname but not a PID space, and a container
shares a boot but not a PID namespace. Any missing or mismatched identity field
therefore leaves the lock in place.

Recovering writers are serialized through `<lock>.break`. Under it, a writer
re-reads the lock and removes it only if its bytes are unchanged, so two
recovering writers cannot both win. A `.break` left by a crashed recoverer is
recovered by the same rule through `<lock>.break.recover`. Writers never remove
`.recover`. Stranding it takes two crashes, and `deeppairing doctor --fix`
removes it when its owner is provably dead. Concurrent `doctor --fix` runs take
turns through their own `<lock>.doctor` guard, so removing a `.recover` is
byte-exact and never deletes a live one. A file another run already removed
is reported as "already removed".

On release the owner checks the lock is still its own. If it is not, the owner
logs a warning; the write under the lock has already completed.

A lock with a live owner, from another operating-system instance, or with an
unreadable or older-format body still fails closed with an `ELOCKED` error that names the
exact path. `deeppairing doctor` lists every lock with its owner and liveness,
and `doctor --fix` removes only dead-owner locks. For any other lock, first
stop **all** daemons, CLI commands and other writers for this project. Then
inspect the named lock, remove only that lock, and restart the writer. This
recovery does not delete session records.
