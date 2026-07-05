---
description: Begin a deepPairing session — pull cross-project philosophy, active session state, and any rejected approaches before I propose anything
---

Before we start, do three things:

1. Read the `deeppairing://session/current` MCP resource to see what's
   already in this session (if anything).
2. Call `recall` with mode: "philosophy" (no query) to show me the
   top stances from my cross-project philosophy ledger. Call it out if any
   'avoid' stances look like they'll collide with the task I'm about to
   describe.
3. Tell me the URL of the companion UI. Read it from a tool response (the
   first-call hint or a `check_feedback` `companionUrl`) or the
   `deeppairing://onboarding` resource — NEVER guess it. `localhost:5173` is
   NOT the answer (that's Vite's default); the daemon picks a per-project port
   in 3847-3974. Keep it brief — I know what deepPairing is.

Then wait for me to tell you what I'm working on.
