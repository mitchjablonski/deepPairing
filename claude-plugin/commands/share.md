---
description: Turn this session into a self-contained HTML page a colleague who wasn't here can read — you write the story, then export it
argument-hint: [who it's for, e.g. "the backend team"]
---

Write up this pairing session as a page I can send to someone.

**First, gather what actually happened.** Read the
`deeppairing://session/current` MCP resource, and call `check_feedback` if
anything might still be unread. Use `recall` (mode: "sessions") if the session
started before this conversation and you need the earlier artifacts. Don't
guess at any of it — if you can't find something, leave it out.

**Then compose the narrative.** This is the part only you can do: you're the
only party who saw the whole thing. Write it in markdown, for a colleague who
wasn't here and doesn't use deepPairing:

- **What we set out to do** — the problem in one short paragraph, in the terms
  someone on the team would use.
- **The forks** — each real decision, what the options were, which way it went,
  and *why*. Quote my reasons verbatim where I gave them; my words carry more
  than your paraphrase.
- **What got rejected** — say plainly what was proposed and turned down, and
  why. If a rejection was recorded as a stance, say that the tooling now blocks
  it from coming back, so a reader understands it isn't just a note.
- **What shipped** — what actually landed, and anything still open or needing
  eyes.

Tone rules:
- Write to a person, not for a log. "We decided to keep the ledger advisory
  because …" — never "the artifact was approved".
- No protocol jargon: no artifact ids, no tool names, no "present_options", no
  status enums. Say "the plan", "the change", "the call we made".
- Don't dress it up. If the session was three findings and one decision, that's
  a five-sentence story — write five sentences.
- Never claim something happened that you can't point at in the session.

**Then export it.** Call `export_session` with:

```
format: "html"
narrative: <your composed markdown>
audience: "$ARGUMENTS"   (omit if I didn't say)
```

Add `includeCode: false` only if I ask for it — the diffs are usually the most
useful part of the page.

**Then tell me the file path** the tool returns, and one line on what's in the
page. The file is self-contained: no network requests, opens straight from
disk, and can be sent to anyone as-is.
