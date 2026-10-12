---
description: Diagnose this project's deepPairing setup with the bundled doctor
argument-hint: [--fix]
---

Run the bundled doctor for the current project:

```bash
node "${CLAUDE_PLUGIN_ROOT}/server/doctor.mjs"
```

The default run reports daemon, hook, ledger, session-lock and clock health without
changing files. State the resolved project and summarize the findings, including
any warnings and suggested remedies.

If I explicitly requested `--fix`, run the same command with `--fix` to show the
proposed repairs. Interactive confirmation happens in the terminal. If the shell
cannot prompt, report the proposed repairs and give me the exact command to run
myself; do not add `--yes` unless I explicitly requested unattended repairs.
Unattended repairs use `--fix --yes` and skip shared/user hook cleanup, global
lock removal and daemon termination. Do not interpolate arbitrary arguments into shell commands. Only
accept `--fix`, `--yes` or `-y` (the latter two require `--fix`); for any other
arguments, show `node "${CLAUDE_PLUGIN_ROOT}/server/doctor.mjs" --help`.

Arguments: $ARGUMENTS
