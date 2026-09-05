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

## Supported hook host contract

Generated project hooks are supported on macOS, Linux, and Windows when Claude
Code launches hook commands through its POSIX-compatible shell contract. The
registered command uses `$CLAUDE_PROJECT_DIR` and quotes it, so hooks remain
anchored to the project even when the current directory differs or the path
contains spaces. On Windows this means the Git Bash environment used by Claude
Code; running the command text directly in PowerShell or `cmd.exe` is not a
supported substitute because those shells use different variable syntax.

The installer marks generated `.mjs` files executable on filesystems with POSIX
mode bits. The command still invokes `node` explicitly, so Windows does not rely
on an executable bit or shebang. CI smoke-tests this installed command and the
native Node runtime on both Ubuntu and Windows.

A receipt tracks presentation, not human approval or equality between the
presented text and the applied edit. The hook remains a non-blocking reminder;
the preflight and artifact-review mechanisms retain their separate roles.
