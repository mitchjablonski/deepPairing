# Per-edit checkpoint reminders

The generated PostToolUse hook checks whether an Edit, Write, or MultiEdit was
preceded by a code presentation for that file in the same artifact session.
Each `code_change` creates one receipt; a `changeset` creates one per file.
External PR reviews and demo artifacts do not create receipts.

Receipts live under
`.deeppairing/sessions/<session-id>/code-checkpoints/<path-sha256>.json`.
Each includes the normalized absolute file path, session ID, artifact ID,
presentation timestamp, and format version. The hook reads only the matching
file, rather than scanning artifact histories. A receipt is valid for 60 seconds
and is atomically claimed once. A second edit needs a new presentation, even
within that window. Rejection, revision requests, retraction, obsolescence, and
supersession revoke the artifact's unused receipts.

The hook uses the event's `session_id`, then `CLAUDE_CODE_SESSION_ID` when the
event omits it. Its session derivation matches the MCP wrapper. When neither
is available, only the wrapper's legacy per-project session can supply a
receipt; other sessions are never searched. Malformed nonempty identities do
not fall back to that shared session. Relative and absolute file paths resolve
against the selected project root.

The old project-wide `last-code-change.json` timestamp is still written for
older hook installations, but current hooks ignore it. Regenerating the hooks
through normal setup enables the scoped behavior; legacy timestamps cannot
identify a reviewed file. Missing, expired, future-dated, corrupt, or already
consumed receipts produce a reminder and exit 0. Lockfiles and generated paths
keep their existing exemptions; config files such as `.gitignore` are included.

A receipt tracks presentation, not human approval or equality between the
presented text and the applied edit. The hook remains a non-blocking reminder;
the preflight and artifact-review mechanisms retain their separate roles.
