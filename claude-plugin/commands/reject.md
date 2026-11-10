---
description: Record a stance in this project from the terminal — "don't do X, because Y" — so the gate quotes your reason when X comes back
argument-hint: <what to avoid> -- <why>
---

I'm asking you to record a stance in this project. My words, verbatim:

$ARGUMENTS

Call `record_stance` with `text` set to exactly those words (everything above,
unchanged: don't paraphrase, shorten, fix typos or split it yourself) and
`requestedBy: "user"`. The server splits it on the first ` -- `: what to avoid
before it, the reason after. The reason is required.

Then show me the tool's reply verbatim: the concept and reason it saved, the
scope, and what it will and won't catch. Matching is on words, not meaning, so
if the concept is worded differently from how you would describe that
approach, say so and suggest wording I could use instead. Don't record the
suggestion yourself; I'll run this command again if I want it.

If the tool refuses (no ` -- `, no reason, too long, too generic, or it would
block deepPairing's own recovery commands), show me the refusal and the usage:
`/deeppairing:reject <what to avoid> -- <why>`. Don't retry with your own
wording.

This command only adds. To change or remove a stance, use "Retire this stance"
in the companion's gate log, or edit `.deeppairing/preferences.json` yourself.
