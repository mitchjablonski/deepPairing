---
description: Fill an approved skeleton plan's fences. One step then stop by default, a step id to fill that step, or `all` to fill the rest in order
argument-hint: [all | step-id]
---

Fill the approved **skeleton plan** (see "Skeleton plans" in the pairing
protocol) inside its fences only.

Pacing, from the argument:
- **none**: fill the next pending step, then **stop and report**.
- **a step id** (e.g. `3`): fill that step, then stop and report.
- **`all`**: fill the remaining steps in order without stopping between them.
  Still stop for any skeleton change, and for anything my autonomy level
  routes to me.

For each step:
1. `update_plan_progress` → `in_progress`. That opens the step's fence.
2. Say in 2–4 lines how you'll do it and the one non-obvious choice. In
   one-step mode this is my moment to redirect.
3. Replace only the `SKEL_TODO` stub, with `old_string` from inside the fence
   (leave the marker lines). Make the step's fenced test real in the same step.
4. Run the tests or the typechecker, and fix problems inside the fence.
5. `update_plan_progress` → `done` (the reply warns if `SKEL_TODO` is left, or
   if the checklist and the code disagree).
6. Report what landed in one or two lines. In one-step mode, **stop here**.

If a step needs a structural change (a new helper, a changed signature, another
file), stop and propose it: what, where and why. Don't work around the fence,
and don't set the step back to `pending` to lift it (the card tells me when a
fence is lifted without the step being done). Once I agree, `revise_artifact`
the plan (`mode: "supersede"`) with a reason that starts `Skeleton change:`.
The card shows it to me as a skeleton change for re-review. Fills pause until I
approve the new version; continue on the new version's id.

When every step is done, strip the marker lines. The `update_plan_progress`
reply and `present_changeset` check the plan's files for any `SKEL[`, `/SKEL[`
or `SKEL_TODO` left behind. Then present the whole change with
`present_changeset` for my review, and close with `present_debrief`.

$ARGUMENTS
