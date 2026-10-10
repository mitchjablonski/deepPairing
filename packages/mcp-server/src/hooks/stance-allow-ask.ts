/**
 * #470 slice 3 (design §3 "The CLI grant (D2), and the Bash prompt") — the
 * narrow PreToolUse Bash check.
 *
 * `deeppairing stance allow` is the CLI door to a stance allowance. Its TTY,
 * flag and environment checks are one shell line away from the agent (a
 * scripted pty), so the real protection is a channel the agent can't answer:
 * when the AGENT's Bash tool runs a command containing `stance allow`, Claude
 * Code asks the human first.
 *
 * Deliberately narrow:
 *  - One decision. If any `"command"` string in the hook payload, after a
 *    JSON-aware decode (so `stance\tallow` / `stance\nallow` sent escaped are
 *    the real characters), matches the WORDS `stance<whitespace>+allow`
 *    case-insensitively, it prints a PreToolUse `ask`. Word boundaries keep
 *    `instance allowance` quiet; the real command's argument is always a word.
 *  - Every other Bash command: no output, exit 0 — Claude Code behaves exactly
 *    as before. No stance or guardrail logic, no logging.
 *  - POSIX `sh` + `awk`, so it doesn't start `node` on every Bash call.
 *
 * Before matching it normalises what a shell would: a backslash-newline and
 * `$IFS` / `${IFS}` count as whitespace, and quotes and backslashes (which only
 * group or escape) are dropped — so `stance 'allow'`, `"stance" allow`,
 * `al""low`, `\allow` and `stance${IFS}allow` all ask. It also asks when a
 * command names the grant route itself (`preflight-blocks/…/exception`, e.g.
 * a `curl`), the cheap common case of going around the CLI.
 *
 * Honest limits (documented in README/SECURITY): it is a pattern check, not a
 * shell parser. A word built at runtime (`s=stance; deeppairing $s allow`), an
 * encoded command, a script written to disk, or a URL assembled at runtime all
 * get past it. It also asks on harmless text that contains the words, such as
 * `grep -rn "stance allow"` or a commit message — narrowing that by command
 * name would reopen `grep x; deeppairing stance allow`. A payload whose
 * command matches asks even if the rest of the payload is malformed (it reads
 * any "command" string it can find); a payload with no recognisable command
 * stays silent. It makes the obvious path a human prompt; it detects nothing.
 *
 * The plugin ships a committed copy at claude-plugin/hooks/stance-allow-ask.sh
 * (pinned equal to this string by a test); `init` writes this same text to
 * .deeppairing/hooks/stance-allow-ask.sh.
 */

export const STANCE_ALLOW_ASK_REASON =
  "The agent is trying to grant a stance allowance from the shell. Only allow this if you asked for it.";

export const STANCE_ALLOW_ASK_REL_PATH = ".deeppairing/hooks/stance-allow-ask.sh";
export const STANCE_ALLOW_ASK_COMMAND = `sh "$CLAUDE_PROJECT_DIR/${STANCE_ALLOW_ASK_REL_PATH}"`;
export const STANCE_ALLOW_ASK_PLUGIN_COMMAND = 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/stance-allow-ask.sh"';
export const STANCE_ALLOW_ASK_MATCHER = "Bash";

const ASK_JSON = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "ask",
    permissionDecisionReason: STANCE_ALLOW_ASK_REASON,
  },
});

export const STANCE_ALLOW_ASK_SCRIPT = `#!/bin/sh
# deepPairing — narrow Bash check for \`stance allow\` (#470). GENERATED, do not
# edit: source is packages/mcp-server/src/hooks/stance-allow-ask.ts.
# If the agent's Bash command contains "stance allow" (case-insensitive, any
# whitespace between, after decoding JSON escapes), ask the human first.
# Every other command: no output, exit 0. A substring check, not a parser.
LC_ALL=C awk -v sq="'" '
function hexval(h,   i, c, v) {
  v = 0; h = tolower(h)
  for (i = 1; i <= length(h); i++) {
    c = index("0123456789abcdef", substr(h, i, 1))
    if (c == 0) return -1
    v = v * 16 + c - 1
  }
  return v
}
function decode(s, start,   out, i, n, ch, nx, v) {
  out = ""; n = length(s)
  for (i = start; i <= n; i++) {
    ch = substr(s, i, 1)
    if (ch == "\\"") return out
    if (ch == "\\\\") {
      i++; nx = substr(s, i, 1)
      if (nx == "n") out = out "\\n"
      else if (nx == "t") out = out "\\t"
      else if (nx == "r") out = out "\\r"
      else if (nx == "b" || nx == "f") out = out " "
      else if (nx == "u") {
        v = hexval(substr(s, i + 1, 4)); i += 4
        if (v == 9 || v == 10 || v == 11 || v == 12 || v == 13 || v == 32 || v == 133 || v == 160) out = out " "
        else if (v > 32 && v < 127) out = out sprintf("%c", v)
        else out = out "?"
      }
      else out = out nx
    } else out = out ch
  }
  return out
}
{ buf = buf $0 "\\n" }
END {
  rest = buf
  while (match(rest, /"command"[ \\t\\r\\n]*:[ \\t\\r\\n]*"/)) {
    cmd = tolower(decode(rest, RSTART + RLENGTH))
    # Normalise what the shell would: a backslash-newline continuation and
    # $IFS / \${IFS} are whitespace; quotes and backslashes only group or
    # escape, so drop them (quoted words, al""low, \\allow).
    gsub(/\\\\\\n/, " ", cmd)
    gsub(/\\$\\{ifs\\}|\\$ifs/, " ", cmd)
    gsub(sq, "", cmd); gsub(/"/, "", cmd); gsub(/\\\\/, "", cmd)
    if (cmd ~ /(^|[^a-z0-9_])stance[ \\t\\r\\n\\v\\f]+allow([^a-z0-9_]|$)/ || cmd ~ /preflight-blocks\\/[^ \\t\\r\\n]*\\/exception/) { print ${JSON.stringify(ASK_JSON)}; exit 0 }
    rest = substr(rest, RSTART + RLENGTH)
  }
}'
exit 0
`;
