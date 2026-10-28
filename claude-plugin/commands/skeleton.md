---
description: Plan a feature as a code skeleton (stubs fenced with SKEL markers plus an architecture diagram), get the shape approved once, then fill each fence with edits gated to it
---

Build what I describe next as a **skeleton plan** (see "Skeleton plans" in the
pairing protocol):

1. Read the code this touches, then write the skeleton to disk: real files,
   imports, types, signatures, one-line contract doc comments, and the wiring
   into existing code. Every body is a fence: `SKEL[id] <what>` on its own
   comment line, a `SKEL_TODO` throw or raise, then `/SKEL[id]`. Each step should be
   5–30 lines of eventual code, with ids in build order. Run the typechecker if
   there is one.
2. `present_plan` with one step per fence (`skelId`), a Mermaid architecture
   `diagram` visual (how the new pieces connect to each other and to the
   existing system) and a `file_map`. Tell me which one or two calls you're
   least sure about. Then wait for my verdict with `check_feedback`.
3. Once I approve, fill the steps in order. For each one, `update_plan_progress`
   → `in_progress`, replace the stub inside the fence, run the tests, then
   `done`. Don't stop between steps unless something needs my call.
4. If a step needs a structural change, stop and propose it. Don't work around
   the fence.
5. When every step is done, strip the marker lines and close with
   `present_debrief`.

$ARGUMENTS
