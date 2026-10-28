---
description: Plan a feature as a code skeleton (stubs fenced with SKEL markers plus an architecture diagram), get the shape approved once, then fill each fence with edits gated to it
argument-hint: [what to build]
---

Build what I describe next as a **skeleton plan** (see "Skeleton plans" in the
pairing protocol):

1. Read the code this touches, then write the skeleton to disk: real files,
   imports, types, signatures, one-line contract doc comments, and the wiring
   into existing code. Every body is a fence: `SKEL[id] <what>` on its own
   comment line, a `SKEL_TODO` throw or raise, then `/SKEL[id]`. Each step should be
   5–30 lines of eventual code, with ids in build order. Tests are part of the
   shape: fence each step's test stub with the same id, so filling the step
   makes its test real. Edits to unfenced files ask me during the fill. Run the
   typechecker if there is one.
2. `present_plan` with one step per fence (`skelId`), each step's `files`, a
   Mermaid architecture `diagram` visual (how the new pieces connect to each
   other and to the existing system) and a `file_map` of every skeleton file.
   In the diagram, give each step's node the id `step_<id>`, with dots and
   dashes as underscores (step `2.1` is `step_2_1`). The plan card colours
   those nodes by fence status, read from the code, and jumps to the fence on
   click. Style existing-system nodes with `classDef existing`. Tell me which one or two calls you're
   least sure about. Then wait for my verdict with `check_feedback`.
3. Once I approve, fill **one step** the way `/deeppairing:skeleton-fill`
   does: `update_plan_progress` → `in_progress`, replace the stub inside the
   fence, run the tests, then `done`. Then stop and report. I continue with
   `/deeppairing:skeleton-fill` (the next step), `/deeppairing:skeleton-fill <id>`
   or `/deeppairing:skeleton-fill all` (the rest, in order). Each progress call
   re-reads the fenced files, so the plan card follows the fills, and the reply
   warns when the checklist and the code disagree. Approving the shape doesn't
   lower my autonomy level: anything it routes to me still comes to me.
4. If a step needs a structural change, stop and propose it. Don't work around
   the fence, and don't set the step back to `pending` to lift it. Once I
   agree, `revise_artifact` the plan (`mode: "supersede"`, a reason that starts
   `Skeleton change:`). I re-review the new skeleton, and fills pause until I
   approve it.
5. When every step is done, strip the marker lines (the progress reply and
   `present_changeset` warn about any `SKEL[`, `/SKEL[` or `SKEL_TODO` left in
   the plan's files), then present the whole change with `present_changeset`
   for my review before it lands. That floor holds at every autonomy level; an
   approved shape isn't a reviewed diff. Close with `present_debrief`.

$ARGUMENTS
