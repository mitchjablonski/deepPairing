# Preflight hook compatibility modes

The default PreToolUse hook asks the human to approve or decline a matching edit.
Some Claude Code permission dialogs omit the hook reason, even when the harness
parses both `permissionDecisionReason` and `systemMessage`. For that case,
deepPairing offers an explicit halt-and-review compatibility mode:

```sh
DEEPPAIRING_PREFLIGHT_MODE=strict-stop claude
```

Set this environment variable for the Claude process that runs the hooks. Both
init-generated and plugin-bundled hooks read their received `process.env` on
each invocation and share the same parser and output formatter. deepPairing
does not implement Claude's shell/settings `env` precedence or hot reload. Use
a deliberate new session or runtime refresh when changing its environment.

| Received value | Behavior on a matching edit |
| --- | --- |
| Unset, empty string, or exactly `ask` | Existing ask output and telemetry |
| Exactly `strict-stop` | Deny the current tool call and stop continuation |
| Any other nonempty value, including case or whitespace variants | Strict stop with a fixed visible configuration warning |

Values are case-sensitive and are not trimmed. Unknown values are never echoed.
An invalid value does not create a policy match; nonmatching calls remain silent.

Strict mode emits one JSON object with `permissionDecision: "deny"`,
`continue: false`, and the same reason in `permissionDecisionReason`,
`stopReason`, and `systemMessage`. The deny protects the current call: do not
rely on `continue: false` alone to stop a write. Strict reasons have terminal
escapes/control characters removed and are capped at 1,800 characters. Default
ask text is unchanged. Fire telemetry records `kind: "deny"` and
`mode: "strict-stop"`; legacy records without a mode retain their existing ask
interpretation. The companion status and HTML export distinguish stops from asks.

Strict guardrail stops neither consult nor write the 30-minute ask dedup stamp,
including stamps left by an earlier default session. Every matching retry must
stop. Switching back to ask retains its existing dedup behavior.

## Recovery and limits

Cancel or revise the proposal before continuing. A human may explicitly retire
an unwanted personal stance in the companion UI. A team rule requires an
authorized durable change to that committed rule; it is not a personal override.
For guardrail work, present the required pre-work for review. For deepPairing
state, hooks, settings, or worktree links, an authorized human must make any
intended change themselves. This mode does not implement hook AllowOnce, and a
companion UI allowance is not a promise that the raw-file hook consumes it.

This is a protocol backstop, not a security boundary. Existing stdin parsing,
module import, ledger/session reads, and matcher/evaluation exceptions can still
fail open, with exit 0 and no decision. Strict mode does not add comprehensive
error telemetry or change those boundaries. Doctor/configuration diagnostics
are not part of this compatibility mode; an invalid-value warning appears on
the next matching edit.

Concurrent matching hook invocations each deny independently. Stopping a turn
does not roll back or guarantee cancellation of unrelated sibling tools that
already started. A subagent's stop must not be assumed to stop its parent or
make the warning visible to the lead. Actual lead/worker visibility remains a
separate runtime acceptance requirement.

An isolated manual-mode diagnostic on pinned Claude Code 2.1.301 verified the
deny-plus-stop output: one attempted Write, visible reason and stopped-turn
warning, no permission prompt, no file created. This identifies a verified
version, not a minimum-version guarantee. SDK/headless behavior and end-to-end
production/worker visibility are unvalidated by that diagnostic. The #540 trial
and #534/#535 work gates remain separate; enabling this mode does not pass them.

See the supported [hook JSON output](https://code.claude.com/docs/en/hooks#json-output)
and [PreToolUse decision control](https://code.claude.com/docs/en/hooks#pretooluse-decision-control).
