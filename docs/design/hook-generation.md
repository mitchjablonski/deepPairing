# Design — generate standalone hooks from shared tested infrastructure

Issue: [#342](https://github.com/mitchjablonski/deepPairing/issues/342).
Stack: [#332](https://github.com/mitchjablonski/deepPairing/pull/332) → [#333](https://github.com/mitchjablonski/deepPairing/pull/333) → [#335](https://github.com/mitchjablonski/deepPairing/pull/335) → this.

Status: proposal. Opened as a draft PR with the design only, per CONTRIBUTING.md
("Don't ship a large refactor without aligning first").

## Problem

deepPairing's hook layer exists in two distributions that must behave
identically:

* the **init lane** — `deeppairing init` writes self-contained `.mjs` files into
  `.deeppairing/hooks/` and points `.claude/settings.local.json` at them. Those
  files run under plain `node` in an arbitrary user project, so they may not
  import anything: no project-local `node_modules`, no path back into the
  deepPairing checkout.
* the **plugin lane** — `claude-plugin/hooks/hooks.json` runs
  `server/stop.mjs` / `server/preflight.mjs`, which esbuild produces from real
  TypeScript entrypoints.

Today the init lane's scripts are **template string literals** in
`setup-tasks.ts`. The compiler never sees them, the test suite can only reach
them by writing them to disk and spawning `node`, and every shared behaviour has
to be typed out again by hand. The result is four hand-maintained copies of the
same lockfile/state machine and two of the debrief gate.

### The duplicated implementations

`readState` / `writeStateAtomic` / `acquireLock` / `releaseLock` / `recordFire`
(the `hooks-state.json` read-modify-write under an `O_EXCL` lockfile):

| # | Location | Form |
|---|---|---|
| 1 | `packages/mcp-server/src/cli/preflight-hook-core.ts:429,447,478-582,584` | real TS, imported by the preflight lanes |
| 2 | `packages/mcp-server/src/cli/stop-hook-entry.ts:46,67,82,110,119,139` | real TS, hand-ported copy for the bundled Stop hook |
| 3 | `packages/mcp-server/src/cli/setup-tasks.ts:287,297,307,325,326,347` | JS text inside `STOP_HOOK_SCRIPT` (`:269`) |
| 4 | `packages/mcp-server/src/cli/setup-tasks.ts:623,633,643,661,662,676` | JS text inside `CHECKPOINT_HOOK_SCRIPT` (`:562`) |

The debrief gate:

| # | Location | Form |
|---|---|---|
| 1 | `packages/mcp-server/src/debrief-gate.ts` — `sessionOwesDebrief` | real TS, imported by `check-feedback.ts` and `stop-hook-entry.ts:18` |
| 2 | `packages/mcp-server/src/cli/setup-tasks.ts:381-411` | inline twin, held in lock-step only by `cli/__tests__/stop-hook-debrief-parity.test.ts` |

Error formatting:

| # | Location | Form |
|---|---|---|
| 1 | `packages/shared/src/errors.ts:17` — `errorMessage` | duck-types any `{message: string}` |
| 2/3/4 | `setup-tasks.ts:421`, `setup-tasks.ts:747`, `stop-hook-entry.ts:202` | `err instanceof Error ? err.message : String(err)` |

Project-root resolution (`CLAUDE_PROJECT_DIR || DEEPPAIRING_PROJECT_ROOT ||
ev.cwd || process.cwd()`) is retyped at `setup-tasks.ts:276`, `:613`, `:697`,
`stop-hook-entry.ts:37`, and `preflight-hook-entry.ts`.

### Why this is worth a refactor rather than more parity tests

The cost is measured, not hypothetical:

* **#332** — one bounded-lock repair, four identical edits. The adversarial
  review's **M1** (the deadline check was placed before the stale-lock breaker,
  so a slow first `openSync` permanently disables the only code in the repo that
  removes `hooks-state.json.lock`) and its fix must land in all four. Four
  chances to get it wrong.
* **#333** — the emitted scripts called `errorMessage()`, an identifier that
  exists in the *generator's* module scope and nowhere in the *emitted* file.
  `ReferenceError` inside the error handler, on the exact malformed-input path
  the handler exists for. This bug class is only possible because the emitted
  script is untyped text living in a module that has other bindings in scope.
  Its review also found the replacement (`instanceof Error`) is narrower than
  the `errorMessage` it replaced — a second, quieter divergence.
* **#335** — the receipt reader (emitted hook, `setup-tasks.ts:704`) and the
  receipt writer (`file-store.ts` via `deriveSessionId`) derive the session id
  by two independent expressions that can disagree in the field.
* `stop-hook-debrief-parity.test.ts` is an entire test file whose only job is to
  detect drift between copies 1 and 2 of the debrief gate. It is good insurance,
  and it should not have to exist.

Every one of these is a *drift* defect, not a logic defect. One implementation
removes the category.

## Proposal

Add `packages/mcp-server/src/hooks/` — real, strict-TS, unit-testable modules —
and **generate the init-lane scripts from them at build time** with the esbuild
pipeline that already produces the plugin lane.

```
packages/mcp-server/src/hooks/
  hook-state.ts          # THE lock/state/fire-log implementation + hookErrorMessage
                         # + resolveHookProjectRoot  (replaces copies 1-4)
  stop-hook.ts           # runStopHook(): blocking-draft nag + debrief gate,
                         # importing sessionOwesDebrief from ../debrief-gate.js
  checkpoint-hook.ts     # runCheckpointHook(): #335 one-shot file/session receipts,
                         # importing deriveSessionId from ../session-id.js
  entries/
    stop-standalone.ts        # init-lane entry  -> .deeppairing/hooks/stop.mjs
    checkpoint-standalone.ts  # init-lane entry  -> .deeppairing/hooks/checkpoint.mjs

packages/mcp-server/scripts/generate-hook-scripts.mjs
    esbuild(bundle, platform:node, format:esm, target:node20) each entry
    -> src/cli/hook-scripts.generated.ts, exporting the two script strings.
```

`setup-tasks.ts` then imports `STOP_HOOK_SCRIPT` / `CHECKPOINT_HOOK_SCRIPT` from
the generated module and keeps `ensureStopHook` / `ensureCheckpointHook`
byte-for-byte as they are — same write, same `chmod 0755`, same unconditional
overwrite, same settings surgery. `stop-hook-entry.ts` collapses to a thin
`runStopHook()` call. `preflight-hook-core.ts` keeps its exported names and
delegates their bodies to `hook-state.ts`.

The generated module is **committed** and guarded by a drift test that
regenerates into a tmpdir and byte-compares — the same contract
`claude-plugin/server/` already lives under, and the same one CI's "Plugin
bundle staleness gate" enforces transitively (the module is bundled into
`daemon.js`).

### Why the emitted script must be a string, not a file lookup

`ensureStopHook` runs from three different layouts: `tsx src/standalone.ts` in a
dev checkout, `dist/cli/init.js` from npm, and the single-file `daemon.js`
bundle in a marketplace install. A string constant is present in all three by
construction. `resolvePreflightCoreUrl()` (`setup-tasks.ts:859`) shows the
alternative's cost: it must return `{url, exists}` and degrade when the file
isn't beside the entry.

### What this buys, concretely

* `acquireHookStateLock` exists **once**. #332's M1 fix (below) is one edit, and
  no future lock repair can land in three places and miss the fourth.
* The emitted script is *compiled output of typechecked source*. An identifier
  that isn't defined in the emitted file is an esbuild build error, so #333's
  bug class cannot be written.
* `sessionOwesDebrief` is imported by both Stop lanes and inlined by esbuild.
  `stop-hook-debrief-parity.test.ts` stops being insurance and becomes a
  behavioural test of one implementation (kept, retargeted).
* The checkpoint hook imports the real `deriveSessionId`, so #335's reader and
  writer are the same function rather than two expressions that agree today.

### Reviewed defects this consolidation makes single-site, and fixes here

These are carried from the #332/#333/#335 adversarial reviews. They are not new
policy; they are the reviews' own minimal fix lists, applied once instead of
four times:

1. **#332 M1** — bound the stale-lock breaker with a one-shot `brokeStale` flag
   (set *before* the `unlink`, so a throwing unlink cannot re-arm it) instead of
   gating it on the deadline. Restores slow-filesystem stale recovery while
   keeping every path bounded.
2. **#332 M2** — `hook-lock-retry.test.ts:91` asserts `state.fires.at(-1)` on a
   fire log that is never reset between cases, so it can pass on a record it did
   not write. Snapshot `fires.length` before the spawn and assert the delta.
3. **#333 LOW** — restore `errorMessage` parity: duck-type `.message` rather than
   `instanceof Error`, in the single `hookErrorMessage`.
4. **#332 L1/L2** — one accurate docblock for the three terminal `return null`
   paths; rename the shadowed inner `catch (error)` to `staleErr` (which also
   removes the source-vs-bundle `error` / `error2` noise).

### Contract-test matrix

One `describe.each` spec, four lanes, all in `spawnSync` with an explicit
`timeout` so a regression fails the test instead of hanging vitest:

| lane | artefact under test |
|---|---|
| `generated stop` | `ensureStopHook(tmp)` output, run as `node stop.mjs` |
| `generated checkpoint` | `ensureCheckpointHook(tmp)` output |
| `bundled stop` | `esbuild(src/cli/stop-hook-entry.ts)`, i.e. the plugin's `stop.mjs` |
| `core` | `esbuild(src/cli/preflight-hook-core.ts)`, driven via `-e` (lock cases only) |

Cases (each asserting exit 0, no `permissionDecision:"deny"` on any lane, and a
`fires.length` **delta** of exactly one):

* **malformed input** — non-JSON stdin, `null`, `[]`, empty stdin, an event with
  no `tool_name`, `artifacts.json` containing `[null]` / a bare object.
* **filesystem faults** — `openSync`/`statSync`/`unlinkSync`/`readdirSync`/
  `existsSync` failing with `ENOENT`/`EACCES`/`ENOSPC`, injected through an
  `--import` preload scoped to the hook's own paths (a fake at the fs boundary,
  not a mock framework — the `hook-lock-retry.test.ts` pattern).
* **contention** — N concurrent hooks; every fire survives (the lost-update
  regression the lockfile exists to prevent).
* **stale lock under a slow filesystem** — the #332 M1 probe: a 6 s-old lock
  plus a stalled first `openSync`. Recovery must happen and the call must stay
  bounded.
* **missing directories** — no `.deeppairing/`, no `sessions/`, no
  `hooks-state.json`, and a `.deeppairing` that is a *file*.
* **paths with spaces** — project root, and the edited file path, containing
  spaces and non-ASCII.
* **non-Error throws** — a duck-typed `{message: "..."}` must record its message
  (#333's LOW), a thrown string must record itself.
* **#335 semantics** — one receipt covers exactly one edit; file A cannot cover
  file B; session A cannot cover session B; expired / future-dated / corrupt /
  mismatched receipts are rejected *and consumed*; concurrent hooks cannot both
  claim one receipt.

## Trade-offs considered

**A. Build-time esbuild codegen into a committed generated module (proposed).**
One implementation; the emitted script is compiled from typechecked source; init
stays string-based with no new runtime failure mode. Costs: a second
generated-and-committed surface needing a drift gate; esbuild becomes a
build-order dependency of `tsc` (a `prebuild` step); the generated string is
large and mostly unreadable in a diff (mitigated — reviewers read
`src/hooks/*.ts`, and the drift test proves the string matches it).

**B. Emit the hook `.mjs` as build artefacts and have `ensureStopHook` copy
them.** No generated source file; `claude-plugin/server/` already has a
staleness gate. Rejected: it adds a runtime lookup that can fail, needs a second
copy under `dist/` for the npm path, and turns a guaranteed install into a
conditional one. Kept as the fallback if the codegen step proves fragile in CI.

**C. Stamp an absolute `import` of the shared module into the emitted script**
(what `preflightHookScript` does for its heavy core via `CORE_URL`). Rejected by
the issue's own constraint — a developer-machine path baked into a user's
`.deeppairing/hooks/stop.mjs` breaks when the plugin moves or is uninstalled,
and the Stop/checkpoint hooks must keep working with no deepPairing install
resolvable. The preflight core accepts this deliberately, for a much heavier
dependency; the state machine is ~120 lines and does not warrant it.

**D. Keep the templates; extract the shared JS as string constants spliced into
both.** Smallest diff, no build change. Rejected: it halves the duplication (the
two emitted scripts share text) but leaves the TS-vs-text split intact, so
#333's exact bug class survives and the shared text is still neither typechecked
nor unit-testable.

## Compatibility and migration

* **Emitted behaviour is intended to be equivalent, not byte-identical.**
  esbuild output differs textually from the hand-written templates; the contract
  suite is the equivalence proof, not a snapshot.
* **Existing installs self-heal.** `ensureStopHook`/`ensureCheckpointHook`
  overwrite `.deeppairing/hooks/*.mjs` unconditionally
  (`setup-tasks.ts:440`, `:762`), so the next `deeppairing init` or daemon
  re-stamp replaces an old script. Until then the old script keeps working: no
  on-disk format changes. `hooks-state.json` keeps its `{version:1, fires:[…]}`
  shape and the `.deeppairing/sessions/<id>/code-checkpoints/` receipt layout
  from #335 is untouched, so a new hook reads an old project's state and an old
  hook reads a new project's receipts.
* **Entrypoint contracts are unchanged**: same `Stop` / `PostToolUse` /
  `PreToolUse` wiring, same `node "$CLAUDE_PROJECT_DIR/.deeppairing/hooks/*.mjs"`
  commands, same `hooks.json`, same fail-open exit-0 policy, same
  `permissionDecision:"ask"`-only on the preflight lane. No hook gains the
  ability to deny.
* **Version lockstep** is untouched; no schema fields are added.
* **Bundle**: `pnpm build:clean` + `git add claude-plugin/server` on every PR in
  this stack, per CLAUDE.md.

## Coordination

[#334](https://github.com/mitchjablonski/deepPairing/pull/334) (targeting `main`)
edits `preflight-hook-core.ts:497` with its own copy of #332's EEXIST fix and
adds `cli/__tests__/hook-lock-failures.test.ts`. This design touches the same
function. To keep the conflict mechanical, `preflight-hook-core.ts` here keeps
its exported signatures and delegates the *bodies* to `hooks/hook-state.ts`
rather than being rewritten in place; whichever lands second resolves by keeping
the delegation. #334's unrelated changes (`demo_` ceremony filter, review
enforcement, ledger) are out of scope.
[#336](https://github.com/mitchjablonski/deepPairing/pull/336) does not touch the
hook lane.

## Out of scope

* Any change to hook **policy**: what nags, when, the 30-minute draft age guard,
  the debrief-owed rules, the skip-list, the `ask`/`deny` decision surface, the
  `PreToolUse` guardrail matcher.
* The #335 review's `M2` (per-artifact `expiresAt` receipt TTL), `L1`
  (`path.resolve` on the project root), `L3` (receipt reuse within TTL), `L5`
  (Windows `MAX_PATH` receipt filenames) and `L6` (receipt sweeping) — all real,
  all behaviour changes, all belong in a follow-up on #335's own terms.
* The #335 review's `M1` (event-id vs env-id session derivation) is *partly*
  addressed as a side effect — both sides call `deriveSessionId` — but the
  "try both derivations" fix is a behaviour change and stays out.
* Merging or rebasing any PR in this stack onto `main`.
* The preflight hook's `CORE_URL` / `RULES_URL` on-disk resolution.
