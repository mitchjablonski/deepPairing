---
description: Review a PR you were pinged on, in tandem — the diff on the rich surface, an orientation first, risks talked through together, posted only on your word
argument-hint: [pr-number-or-url]
---

Somebody asked me to review PR $ARGUMENTS. Work through it *with* me — I want to
come out of this actually understanding the change, not just holding a list of
your objections. You are not an automated reviewer running a pass over their
code; you are the person sitting next to me while I read it.

Six moves. Don't skip (b) — orientation before detail is the whole difference
between reviewing a PR and skimming a diff.

**(a) Ingest.** Get the full picture before you say anything:

```
gh pr view $ARGUMENTS --json title,body,author,headRefName,baseRefName,url,files,additions,deletions
gh pr view $ARGUMENTS --comments        # what's already been said
gh pr checks $ARGUMENTS                 # what CI thinks
gh pr diff $ARGUMENTS                   # the change itself
```

Read the surrounding code too — a diff is not a codebase, and most real risks
live in the code the diff *doesn't* show. If any of these fail (no `gh`, not
authenticated, PR not found), tell me plainly and stop. Don't guess at the
contents of a PR you couldn't fetch.

**(b) Orient me first — `present_explainer`.** Before a single finding: what
does this PR *do*, how do the pieces fit, and what is the blast radius? Audience
is me-as-reviewer, scope is this PR — not a tour of the whole repo. Say what
problem the author was solving, name the mechanism they chose, and be explicit
about what it touches that isn't in the diff (callers, migrations, config,
anything with a runtime coupling). Anchor sections to real code with `evidence`
so I can click through. If the PR description already explains it well, say so
and be short — don't pad.

**(c) Put the diff on the surface — `present_changeset` with
`reviewIntent: "external"`.** One changeset file per changed file, hunks
straight from `gh pr diff`. Also pass:

```
source: { kind: "github-pr", number: <N>, url: <url>, headRef: <head>, baseRef: <base>, author: <login> }
```

This is what lets me *read* it properly: comment on any hunk, hit "Explain this"
on the confusing one, and get a per-file sense of where the weight is. Because
it's marked external, my verdicts are my **review opinion** and stay local —
nothing posts until I say so. So: do not apply, revise, or "fix" these files,
and don't treat "needs changes" as a cue to redraft anything. It means I have
something to say about their code.

**(d) What worries you — `present_findings`, one call.** Every finding gets
structured `evidence` (`filePath`, `lineStart`, `lineEnd`, `snippet`,
`explanation`) and a `severity` (info / low / medium / high / critical).
Anchoring matters twice over here: those coordinates are what become inline
comments on the PR later, so a finding without them can't be posted. Name the
concept via `log_reasoning` so I learn the pattern, not just this instance.

Include what's *good* too, briefly. A review that only lists objections is a
worse review, and I have to send this to a colleague.

**Then sweep my ledger — this is the part only we can do.** Call `recall` on the
PR's key concepts (`mode: "any"`, one call per real concept — the pattern the
change introduces, the library it reaches for, the approach it takes). If
something in this PR matches a stance I've already recorded, that is a finding,
and say it *explicitly* rather than paraphrasing it as your own opinion:

> This PR introduces **<concept>**, which you rejected on <date>: "<my reason>".

Quote my words, cite the date, and let me decide whether it still applies —
their codebase, their call, and I may well say it's fine here. Your job is to
make sure I don't approve the exact thing I turned down last month without
noticing. If nothing matches, don't manufacture a match.

**(e) Now talk it through — poll `check_feedback` in a loop.** This is the point
of the whole exercise, not a formality at the end. I'll comment on hunks, argue
with findings, and ask you things. When I do:

- **Go and look.** Trace the callers, read the function three files over, check
  the test that covers it, run the test suite if it's safe and cheap. Answer
  from the code, not from the diff.
- Use `answer_question` for anything I raised as a question so it links back.
- If I hit "Explain this" on a hunk, `present_explainer` scoped to *those lines*.
- If I reject a finding with a reason, that reason is recorded — drop it and
  don't bring it back.
- If I convince you a concern is real that you'd rated low, say so and revise
  the artifact. Changing your mind out loud is useful to me.

Keep polling until I tell you we're done. Don't post anything in this phase.

**(f) Post it, on my word.** When I say "post it" / "ship what we found" /
"we're done here" — `post_pr_review` with `pr: "$ARGUMENTS"`. What posts is what
survived: findings in artifacts I didn't reject. If I dismissed something, take
it out of the artifact (`revise_artifact`) before posting rather than hoping it
gets filtered — rejection works at the artifact level, so a dead finding sitting
in a live artifact will go to the PR.

Event mapping:
- `REQUEST_CHANGES` — only if a surviving finding is **high or critical**.
- `APPROVE` — if I read it and had nothing to flag. That's a real outcome; don't
  invent findings to avoid it.
- `COMMENT` — everything else.

Report the review URL. Then offer `/deeppairing:share` — the session makes a
decent review record for the author or for me later, and it's one call.

Two things to hold onto: their code is theirs, so findings are *observations for
the author*, not orders. And I am the reviewer of record — everything you surface
is for my judgement, and nothing reaches the PR until I say it does.
