---
description: Delegate a task — one brief to approve, a quiet run, one understanding packet at the end
argument-hint: [issue-number-or-url-or-text]
---

I'm handing you this to build: $ARGUMENTS. I want to approve one brief, stay out
of your way while you work, and then understand what you did from one packet. I'm
not looking for a stream of cards. I want the few that need me, then the summary.

Five moves, in order. Don't skip the brief: it is the only card before you build.

**Two rules for the whole run.**

- **Omit `confidence` on every artifact in the run** — the brief, the options,
  the changeset, the debrief. At the `balanced` autonomy level a draft with
  `confidence: "high"` arms the auto-approve countdown, and I'd lose the
  approval the brief exists to get.
- **Post nothing during the run except the required-decision list in move 3.**
  No findings, no per-step `log_reasoning` (move 3's `update_plan_progress`
  is the progress signal), no `present_code_change` per edit, no explainer I
  didn't ask for.

If my autonomy level is `supervised`, still post the brief and the packet, since I
asked for them. But nothing is quieted: every fork is presented the way it is
today, and you ask as you would without this command.

**(1) Read.** If $ARGUMENTS is an issue number or URL, fetch it (`gh issue view
$ARGUMENTS --comments`); if it's free text, that text is the issue. Read the code
it touches, and `recall` the concepts you'll lean on. If `gh` isn't available or
the issue isn't found, say so plainly and stop. Don't brief from a guess.

**(2) Brief.** One `present_spec`, and nothing else first:

- `objective` — one sentence.
- `requirements[]` — each with `acceptanceCriteria` I could run.
- `context` — five headed lines: `Decide alone:` (calls you'll make without me),
  `Will ask:` (calls you'll bring to me, a promise), `Risk class:` (trivial,
  low-risk or escalated), `Why:` (the reason for that class), and `Review:`
  (`packet` by default, or `line-by-line` if you think I should read every hunk;
  I can flip it when I approve).
- `design` — one short paragraph on the shape: the pieces, the boundaries between
  them, and the interface each side sees. Name the alternative shape you rejected.
- `edgePaths[]` — each `{path, risk, handling}`. List every state and transition
  the change must handle, every call path that must see it (early returns, wake
  and long-poll shapes, filtered views), every input you don't control, and any
  mode where the change is inert or behaves differently. A reviewer finds these
  after the code; I'd rather catch them here.
- `tasks[]` — your intended steps.
- `visuals[]` with two entries:
  - one of `kind: "file_map"` — its `files` are the paths you declare you'll touch;
  - one of `kind: "diagram"` — the proposed architecture **before** you build:
    modules or components, how they connect, and where the change sits. This is
    the card where I review the shape, not the lines, so make the boundaries and
    data flow the point. I may comment on regions of it.

If my approval or comments set `Review: line-by-line`, lead the move-4
packet with the changeset's hunks and skip the summary-first framing.

Poll `check_feedback` until I approve it. Do nothing else meanwhile. Everything
I add to your will-ask list gets a card too. **Trivial work skips the card:**
write the five answers (objective, acceptance, decide alone, will ask, risk class)
in chat and go.

**(3) Run.** Build. Post a `present_options` card for each of these, and only
these:

- every item on your will-ask list, however small;
- every architectural or hard-to-reverse fork not on it;
- any doubt about whether a call is yours, or how risky it is — **uncertainty
  escalates**; batch only what you're sure is yours;
- a gate block you can't route around and still meet done;
- done being unreachable as written. Name the scope fork; never redefine done.

**Stop and re-brief** if you're about to edit a guardrail path, a file outside
your declared `file_map` visual in a different top-level package or directory, add a
dependency, or change a schema or CI. supersede the brief:
`revise_artifact` with `mode: "supersede"`, a `reason`, and new `content` whose
`context` has the line `Risk class: escalated` and whose `file_map` visual lists
the newly declared files. Then wait for my approval. A low-risk brief silences the guardrail hook, so this rule is the only
thing that stops you. Track progress on the approved brief itself:
`update_plan_progress` with the brief's id and `stepIndex` set to the task's
0-based index in `tasks[]` — mark a task `in_progress` when you start it and
`done` (or `skipped`, with a `statusNote` saying why) when you finish. I watch
the brief's checklist fill in; no `log_reasoning` per task.

**(4) Packet.** `present_changeset` with `summary`, `risks[]` and a `visuals[]`
entry of `kind: "diagram"` showing the changed files and their neighbours. Then **one** `present_debrief` with the
same `feature`:

- `sections[]`, the first with `changesetRef` set and a `Brief:` line in its
  `body` naming the spec title and version;
- `summary` in three sentences;
- a `Done when` section, one line per requirement id;
- `needsYourEyes[]`, three at most, ranked, each with file and lines in `why`;
- `decisionsMade[]`, each with `what`, `why` and the `alternative` you passed over;
- a `Not sure about` section — what you doubt, or "none";
- a `Proof` section — the commands you ran and what came back. `not-run` is a
  valid outcome, with a reason;
- `deferred[]`.

**(5) Wait.** Poll `check_feedback`, answer what I raise, and if I ask for a
walk-through, serve it with a scoped `present_explainer`. If the debrief needs to
change, supersede it with `revise_artifact`. Never post a second one.

**The per-run record.** This is a dogfood run, so the debrief's `openQuestions`
carries the record, for me to fill in or confirm:

- every interruption, tagged **required** (a will-ask item, a fork, uncertainty,
  a block, a scope change) or **nuisance** (a choice I'd have left to you);
- minutes from the packet landing to my approval;
- which block of the packet prompted any feedback;
- whether I read the diff;
- my rating, 1 to 4, which I give by hand. Don't fill it in.

One honest failure beats a flattering run: a required decision you made alone is
worth more in that record than ten tidy cards.
