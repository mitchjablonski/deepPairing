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
- No ids of any kind in the narrative — not artifact ids, not the session id.
  Neither the page nor the download filename prints them (the session id is a
  folder name off my machine), so putting one in your prose would be the only
  place it appears.
- No absolute paths from my machine. Say `src/auth/hash.ts`, never
  `/home/me/work/checkout/src/auth/hash.ts`. The exporter collapses what it can
  find, but it is scrubbing your writing after the fact — don't write it.
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
page. If the tool's reply carries a possible-secret warning, relay it to me
verbatim before anything else — the file is about to leave the building. The file is self-contained: no network requests, opens straight from
disk, and can be sent to anyone as-is.

**If this session reviewed someone else's pull request**, the page carries a
provenance block naming that PR at the top, so the reader can't mistake our
verdicts for an approval that landed. Confirm the PR number with me before I
send the page anywhere — the block is built from what you recorded on the
changeset, and a wrong number on a page going to the PR's author is worse than
no number at all.
