#!/bin/sh
# deepPairing — narrow Bash check for `stance allow` (#470). GENERATED, do not
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
    if (ch == "\"") return out
    if (ch == "\\") {
      i++; nx = substr(s, i, 1)
      if (nx == "n") out = out "\n"
      else if (nx == "t") out = out "\t"
      else if (nx == "r") out = out "\r"
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
{ buf = buf $0 "\n" }
END {
  rest = buf
  while (match(rest, /"command"[ \t\r\n]*:[ \t\r\n]*"/)) {
    cmd = tolower(decode(rest, RSTART + RLENGTH))
    # Normalise what the shell would: a backslash-newline continuation and
    # $IFS / ${IFS} are whitespace; quotes and backslashes only group or
    # escape, so drop them (quoted words, al""low, \allow).
    gsub(/\\\n/, " ", cmd)
    gsub(/\$\{ifs\}|\$ifs/, " ", cmd)
    gsub(sq, "", cmd); gsub(/"/, "", cmd); gsub(/\\/, "", cmd)
    if (cmd ~ /(^|[^a-z0-9_])stance[ \t\r\n\v\f]+allow([^a-z0-9_]|$)/ || cmd ~ /preflight-blocks\/[^ \t\r\n]*\/exception/) { print "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"ask\",\"permissionDecisionReason\":\"The agent is trying to grant a stance allowance from the shell. Only allow this if you asked for it.\"}}"; exit 0 }
    rest = substr(rest, RSTART + RLENGTH)
  }
}'
exit 0
