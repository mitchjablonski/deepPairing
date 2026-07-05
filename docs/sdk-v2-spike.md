# SDK v2 spike — verdict record

**Run date:** 2026-07-02
**Target:** `@modelcontextprotocol/server@2.0.0-beta.2`
**Branch:** `spike/sdk-v2` (pushed, including the scratch-issues repros)

## Verdict: **GO**

Estimated **~2-4 days** of legacy-parity porting work, to start once v2 is
stable (expected **~Jul 28**). This is a record of what the spike proved, not a
migration plan — the port lands on its own PR when v2 ships.

## What was tested

The spike ran the v2 server side-by-side with the current (v1) server:

- **8/8 v2 tests green** against `@modelcontextprotocol/server@2.0.0-beta.2`.
- **257 v1 tests green** in the same run — no regression to the shipping path
  while the v2 surface was stood up beside it.

Running both suites side-by-side (rather than swapping v1 out) is what makes
the GO defensible: the v2 adoption is additive and reversible until we commit.

## Two adoptions the port needs

1. **`ClientOptions.listChanged`** — v2 moves list-change notifications to an
   explicit subscription model (`subscriptions/listen`) with a **300ms default
   debounce**. We adopt the subscription instead of relying on implicit
   list-changed pushes. Gate the port on confirming no `listChanged` regression
   under the debounce.
2. **`inputRequired()` replacing `elicitInput`** — v2 renames/reshapes the
   elicitation entry point. Our `tryElicit` wrapper **already degrades
   gracefully** when elicitation is unavailable, so this is a rename at the call
   site, not a behavioral change.

## Upstream-issue candidates: all refuted

Three defects looked like upstream bugs during the spike; all three were
refuted in validation (repros live on `spike/sdk-v2` under scratch-issues):

1. **Works as designed** — the observed behavior matched the v2 spec once the
   subscription/debounce model was accounted for.
2. **Spike artifact** — caused by the side-by-side harness, not the SDK.
3. **Docs already exist** — the "missing" documentation was present; the gap
   was in the search, not the docs.

No upstream issues were filed.

## Why GO

The port is small (~2-4 days), the two required adoptions are both bounded and
well-understood (one is a rename our wrapper already tolerates), the v1 path is
untouched until we cut over, and no upstream blockers survived validation. The
only real gate is v2 stabilizing (~Jul 28) and re-confirming there's no
`listChanged` regression under the 300ms debounce.
