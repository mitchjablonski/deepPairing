---
description: Delegate a task — a brief only when there's a real decision, a quiet run, a short summary and one packet at the end
argument-hint: [issue-number-or-url-or-text]
---

I'm handing you this to build: $ARGUMENTS. I want a brief card only when there's
a real call for me to make, to stay out of your way while you work, and then a
short summary of what landed, with one packet behind it as the record. I'm not
looking for a stream of cards. I want the few that need me, then the summary.

Five moves, in order. The brief card is for real decisions only (move 2). When
you do post one, it is the only card before you build.

**Two rules for the whole run.**

- **Omit `confidence` on every artifact in the run** — the brief, the options,
  the changeset, the debrief. At the `balanced` autonomy level a draft with
  `confidence: "high"` arms the auto-approve countdown, and I'd lose the
  approval the brief exists to get.
- **Post nothing during the run except the required-decision list in move 3.**
  No findings, no per-step `log_reasoning` (move 3's `update_plan_progress`
  is the progress signal), no `present_code_change` per edit, no explainer I
  didn't ask for.

If my autonomy level is `supervised`, always post the brief (the move-2 condition
doesn't apply) and the packet, since I asked for them. Nothing is quieted: every
fork is presented the way it is today, and you ask as you would without this
command.

**(1) Read.** If $ARGUMENTS is an issue number or URL, fetch it (`gh issue view
$ARGUMENTS --comments`); if it's free text, that text is the issue. Read the code
it touches, and `recall` the concepts you'll lean on. If `gh` isn't available or
the issue isn't found, say so plainly and stop. Don't brief from a guess.

**(2) Brief, only for a real decision.** First decide whether this run needs a
brief card. Post one when **any** of these holds:

- the risk class is `escalated`: a guardrail path, a schema or CI change, a new
  dependency, or anything hard to reverse;
- your will-ask list is non-empty;
- there's a genuine architectural or hard-to-reverse fork to settle before code.

**Otherwise, a quiet start.** The work is trivial or low-risk and there's nothing
to ask, so post no card. Write the five answers in chat (objective, acceptance,
decide alone, `Will ask: none`, and the risk class with a one-line why) and start
building. Three things follow from having no brief:

- **Don't wait for an approval.** There's nothing to approve, so don't poll
  `check_feedback` before you build. With no draft pending it returns at once
  anyway; looping on it just burns turns.
- **The guardrail hook still guards.** Without a brief, a guardrail path
  (migrations, CI workflows, infrastructure, secrets: the SKILL's Guardrails
  section) is covered only if an approved artifact from the last ~8 hours lists
  that exact file in its `file_map`. A scopeless options or findings card covers
  nothing. So an edit there prompts me, or stops in strict-stop mode. That prompt is correct, not a nag: such an edit makes the run
  escalated, so brief before you make it (move 3). Ordinary edits never touch it.
- **No checklist.** Skip `update_plan_progress`; there's no brief to mark.

**When you post the brief:** one `present_spec`, and nothing else first:

- `objective` — one sentence.
- `requirements[]` — each with `acceptanceCriteria` I could run.
- `context` — five headed lines: `Decide alone:` (calls you'll make without me),
  `Will ask:` (calls you'll bring to me, a promise), `Risk class:` (trivial,
  low-risk or escalated), `Why:` (the reason for that class), and `Review:`
  (`packet` by default, or `line-by-line` if you think I should read every hunk;
  I can flip it when I approve).
- `design` — one short paragraph on the shape: the pieces, the boundaries between
  them, and the interface each side sees. Name the alternative shape you rejected.
- `edgePaths[]` — each `{id, path, risk, handling}`. List every state and
  transition the change must handle, every call path that must see it (early
  returns, wake and long-poll shapes, filtered views), every input you don't
  control, and any mode where the change is inert or behaves differently. Give
  each edge path a stable `id` and keep it across revisions, as with requirement
  ids. A reviewer finds these after the code; I'd rather catch them here.
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
I add to your will-ask list gets a card too.

**(3) Run.** Build. Post a `present_options` card for each of these, and only
these:

- every item on your will-ask list, however small;
- every architectural or hard-to-reverse fork not on it;
- any doubt about whether a call is yours, or how risky it is — **uncertainty
  escalates**; batch only what you're sure is yours;
- a gate block you can't route around and still meet done;
- done being unreachable as written. Name the scope fork; never redefine done.

**Stop and brief** if you're about to edit a guardrail path, a file outside
your declared `file_map` visual in a different top-level package or directory
(after a quiet start, where nothing is declared: any file outside the top-level
package or directory the task names), add a dependency, or change a schema or
CI. With a brief posted, supersede it: `revise_artifact` with
`mode: "supersede"`, a `reason`, and new `content` whose `context` has the line
`Risk class: escalated` and whose `file_map` visual lists the newly declared
files. After a quiet start, post the brief now: a `present_spec` built as in
move 2, with `Risk class: escalated` and a `file_map` visual listing the files.
Either way, wait for my approval before the edit. A new will-ask item or fork
mid-run escalates the same way: post its card then (**uncertainty escalates**).
The guardrail hook backs only the guardrail-path part of this rule, and an
approved brief's `file_map` silences it for the files listed, so for everything
else this rule is the only thing that stops you. With a brief, track progress on
the approved brief itself:
`update_plan_progress` with the brief's id and `stepIndex` set to the task's
0-based index in `tasks[]` — mark a task `in_progress` when you start it and
`done` (or `skipped`, with a `statusNote` saying why) when you finish. I watch
the brief's checklist fill in; no `log_reasoning` per task. After an escalation
supersede (`revise_artifact` mode supersede), send `update_plan_progress` to the
**new** brief's id; the old one is closed and warns.

**(4) Packet.** `present_changeset` with `summary`, `risks[]` and a `visuals[]`
entry of `kind: "diagram"` showing the changed files and their neighbours. Then **one** `present_debrief` with the
same `feature`:

- `sections[]`, the first with `changesetRef` set and a `Brief:` line in its
  `body` naming the spec title and version, or `Brief: none (quiet start)` with
  the risk class you stated;
- `summary` in three sentences;
- a `Done when` section, one line per requirement id (after a quiet start, one
  per acceptance line you wrote in chat);
- `needsYourEyes[]`, three at most, ranked, each with file and lines in `why`;
- `decisionsMade[]`, each with `what`, `why` and the `alternative` you passed over;
- a `Not sure about` section — what you doubt, or "none";
- a `Proof` section — the commands you ran and what came back. `not-run` is a
  valid outcome, with a reason;
- `deferred[]`.

**(5) Wait, then summarize.** Call `check_feedback`, answer what I raise, and if I
ask for a walk-through, serve it with a scoped `present_explainer`. If the debrief
needs to change, supersede it with `revise_artifact`. Never post a second one.
The packet is the record, not a gate: the debrief is informational, so don't loop
waiting for me to read it.

End the run with a **short terminal summary**, three to five lines in chat: what
landed, what to check first, and anything deferred. The summary is the default
touchpoint; the packet is the record behind it.

**The per-run record.** This is a dogfood run, so the debrief's `openQuestions`
carries the record, for me to fill in or confirm:

- whether a brief was posted, and which move-2 condition called for it (or
  "quiet start");
- every interruption, tagged **required** (a will-ask item, a fork, uncertainty,
  a block, a scope change) or **nuisance** (a choice I'd have left to you);
- minutes from the packet landing to my approval;
- which block of the packet prompted any feedback;
- whether I read the diff;
- my rating, 1 to 4, which I give by hand. Don't fill it in.

One honest failure beats a flattering run: a required decision you made alone is
worth more in that record than ten tidy cards.
