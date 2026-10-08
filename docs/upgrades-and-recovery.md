# Upgrades, backups, and recovery

Updating the plugin replaces its executable files. Retained project data lives
separately in your project's `.deeppairing/`, including session artifacts,
comments, decisions, review history, memory, and preferences. Cross-project
philosophy and the project registry live in your home directory's
`.deeppairing/`. Keep both when backing up; an exported Markdown/HTML session
is useful for reading, but is not a restorable copy of all persisted state.

## Before updating

1. Finish outstanding reviews and close Claude Code sessions using deepPairing.
   Close companion tabs and stop the deepPairing daemon for each affected
   project. A wrapper exit alone does not immediately stop the shared daemon.
   Inspect that project's `.deeppairing/daemon.json` and use `doctor` to identify
   its process; stop only that verified process. Wait for it to exit before
   copying. To snapshot the shared home directory consistently, stop
   deepPairing in all projects that use that home.
2. Copy the entire project `.deeppairing/` and, if present, the home
   `.deeppairing/` to a new backup directory outside the project. Preserve
   permissions and keep this backup private: it may contain comments, source
   snippets, review authorization, and runtime credentials. Record the plugin
   version, project path, Node version, and backup date alongside it.
3. Update the plugin, reload it in Claude Code, and reopen the same project.
   Check a past session, its comments and decision rationale, and your
   preferences in the companion. Create a small new comment to confirm writes.

For example, after stopping the writers, on macOS/Linux/WSL:

```bash
mkdir /absolute/private-backups/deeppairing-before-upgrade
cp -a /absolute/project/.deeppairing /absolute/private-backups/deeppairing-before-upgrade/project-data
# If it exists, also copy the home store:
cp -a "$HOME/.deeppairing" /absolute/private-backups/deeppairing-before-upgrade/home-data
```

On Windows PowerShell, use your actual project/home paths and a new destination:

```powershell
New-Item -ItemType Directory -Path 'C:\private-backups\deeppairing-before-upgrade'
Copy-Item -LiteralPath 'C:\work\my-project\.deeppairing' -Destination 'C:\private-backups\deeppairing-before-upgrade\project-data' -Recurse
# If it exists, also copy the home store:
Copy-Item -LiteralPath 'C:\Users\you\.deeppairing' -Destination 'C:\private-backups\deeppairing-before-upgrade\home-data' -Recurse
```

Do not copy a running store and assume it is a consistent snapshot. Do not
commit these backups to Git. Keep the original backup untouched when testing
recovery.

## Restoring a backup

Stop all affected wrappers and daemons first, as above. Move the current project
`.deeppairing/` to a separate recovery directory so new work remains available.
Restore `project-data` as the project's `.deeppairing/`; do not merge individual
JSON files into a running store. If restoring shared philosophy/registry state,
also preserve the current home store and restore `home-data` to the same home
with all its project writers stopped. A shared-home rollback discards shared
changes from other projects since the snapshot, so choose that deliberately.

Runtime discovery (`daemon.json`), daemon credentials, PIDs, and ports are not
portable backup data. Do not reuse a captured runtime identity or signal its
recorded PID. After restoring, use the installed version's `doctor` to diagnose
stale discovery and reload the plugin to create a fresh daemon and credentials.
Restore to the same project path and platform for this recovery path; moving a
project or home to a different machine is outside the upgrade test's contract.
Check the restored past session and write behavior before resuming work.

If preservation looks wrong, keep both the pre-upgrade backup and the current
store. Report the exact versions, platform, and symptoms with a minimal
redacted reproducer. Avoid hand-editing retained records as a repair attempt.

## Compatibility and downgrade boundaries

CI checks one explicit forward-upgrade path: released **v0.1.57**, Git commit
`d9efe325454f96473ec84a4537e38661ffdd9aac`, to the candidate's shipped runtime.
It generates two sessions using the released MCP launcher and companion API,
then verifies artifacts/evidence, anchored human comments, a resolved and a
pending decision, per-session personas, project autonomy/density/publish preferences,
and a whole-decision rejection with its description, reason, and named concept.
The candidate reads and writes those retained sessions, restarts, and verifies
old state plus new writes. A matching proposal must still be blocked by that
rejection after upgrading and restarting. Deliberately altering a retained
comment, wiping rejection memory, or losing its reason must each be detected by
the same semantic preservation check after a successful candidate boot/read.
The fixture is an exact
released **runtime subset**, not a simulated old store or a full plugin-install
test; [the contributor instructions](../CONTRIBUTING.md#released-runtime-upgrade-gate)
document its provenance and exclusions.

This bounded forward check is the supported validation baseline. It does not
certify every historic release, every persisted feature, corrupt stores,
concurrent upgrades, crash-orphaned v0.1.57 lock files (the #416 recovery case),
arbitrary newer-to-older writes, or backward schema
compatibility. Additional fields being optional helps forward readers, but
does not guarantee an older writer will preserve a newer version's fields.

**Downgrading an executable against data already written by a newer version is
unsupported.** For rollback, reinstall the exact backed-up plugin version and
restore its matching pre-upgrade snapshot with all writers stopped. Work written
after that snapshot remains only in the separately preserved newer store; do
not load or merge it with the older writer. No automatic downgrade migration is
promised.
