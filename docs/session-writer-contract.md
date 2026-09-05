# Session writer contract (#338)

Status: proposed, incremental hardening; **do not merge** before independent
review. This does not introduce a transactional database or change the JSON
format read by existing installations.

## Supported writers

The daemon remains the normal single owner of each session. CLI/tooling can
construct another FileStore, so merely documenting single ownership would not
enforce it. Cooperating FileStore flushes should serialize their complete
read/merge/write interval with a short, exclusive session-local filesystem
claim. No network work may run inside that interval. Older binaries and manual
file edits do not participate in that protocol: stop writers before maintenance
or downgrade. Network/distributed filesystems are not a supported locking target.

Never steal a claim solely because it is old or its PID appears absent: native
Windows and WSL have different PID domains, and a paused process can resume.
An abandoned claim must fail closed, with an explicit recovery procedure after
all writers have stopped. A busy claim must retain pending changes and surface
failure from an explicit flush; background contention needs a bounded retry.

## Conflict semantics

Use the last observed bytes as the three-way baseline for artifacts, comments,
decisions, plan reviews, and requests. Merge distinct additions and disjoint
field changes. Identical concurrent field edits are idempotent. Divergent edits
to the same semantic field are a conflict, **not** proof that the last process
to flush represents the latest human intent. Validate every merge before writing
any of those files. Timestamps are metadata, not conflict-ordering authority.

Deletion needs an explicit policy; silently unioning records can resurrect
removed review state. A missing or malformed previously observed file must not
be silently recreated from an old cache. Local edits against externally deleted
records must conflict. A disposed/evicted store must never persist again, even
if another store recreates the same directory.

## Boundaries that must remain explicit

Each JSON replacement is atomic to a reader; the sequence of replacements is
**not a cross-file transaction**. A process can stop after artifacts are written
but before decisions are written. A subsequent flush must not treat a partially
persisted merge as a new human edit or overwrite intervening changes. Tests must
cover write failure after an earlier file succeeded, retry, and fresh-process
reload. Read-only scanners do not acquire a writer claim and cannot be promised
a coherent multi-file snapshot by this increment.

Session preferences, annotations, project/global ledgers, metrics, and posted
review records have separate write paths; a flush claim does not magically
protect them. #344 owns the posting protocol. A future migration to a single
authoritative session snapshot/journal must include all safety-relevant readers,
not just FileStore, before claiming cross-file consistency. Until then this
increment must not close #338 as fully transactional.

## Verification gates

- Two real processes attempt overlapping flushes; no lost distinct additions.
- Conflicting verdicts never silently replace a persisted human verdict.
- Requests survive concurrent additions and fulfillment updates.
- Equal-size/same-mtime external edits still participate in conflict detection.
- Deletion, corruption, process death holding a claim, and partial writes have
  deterministic fail-closed outcomes and documented recovery.
- Disposed instances cannot write into a replacement session directory.
- Existing round-trip/salvage/skip-write behavior is preserved unless a test is
  deliberately changed to reflect the documented conflict/deletion policy.
- Source tests, typecheck, lint, and a clean committed plugin bundle pass.
