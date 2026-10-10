# Next-up bar: task-based walkthroughs (#430, design §9)

> **Status: evidence, not a usability study.** These are the five walkthroughs
> from `docs/design/attention-hierarchy.md` §9. Each one was run against `main`
> at v0.1.61 (`f1d7f429`), with the "Next-up bar (preview)" setting **OFF**
> ("before") and **ON** ("after"), at **1280×800** and **1920×1080**. That is 4
> runs per scenario and 44 runs in all. A script did the runs, not a person.
> The limits are listed at the end.
>
> Refs #430.

## How it was run

- **Real daemons, real sessions.** Each scenario booted its own
  `node packages/mcp-server/dist/daemon/index.js` from a fresh native clone
  (`pnpm install --frozen-lockfile && pnpm build`). Each daemon had a temp
  `HOME`, a temp project root, `DEEPPAIRING_NO_OPEN=1`, `BROWSER=none` and
  `DEEPPAIRING_PORT_BASE=26000`; every daemon bound in 26000–26127. State was
  seeded through the daemon's internal session API, the same
  `/api/internal/sessions/:id/{register,artifacts,decisions,comments,unregister,preflight-block}`
  routes the MCP server uses and the e2e specs seed with. Decisions were
  recorded as both an artifact and a decision request, with `stakes: "high"`.
- **Headless Chromium** (Playwright 1.60), `reducedMotion: "reduce"`, dark
  theme. The bar was toggled through its real preference key
  (`localStorage["dp-next-up-bar"] = "1"`), set before the page loads.
- **Keyboard-only.** Every path starts at page load and uses only real
  `keyboard.press` calls. Every press is counted, and each Tab stop is logged
  with the element it focused. No clicks were used, and focus was never set by
  script. The one exception is noted in S3.
- **Screen-reader proxy.** Two sources: Playwright `locator.ariaSnapshot()` of
  the bar, banner and sessions nav, and a `MutationObserver` installed before
  load that records every text change in an element with `aria-live`,
  `role=status`, `role=alert` or `role=log`, with a timestamp. **This is a proxy.**
  It shows what the accessibility tree exposes and what live regions *change
  to*. It cannot show what NVDA, JAWS or VoiceOver actually say, or how they
  queue or drop polite announcements.
- **Screenshots** are in `attention-walkthroughs/`, named
  `s<N>-<before|after>-<W>x<H>-<step>.png`. In the screenshots, the `💤`
  glyph renders as a box because the headless image has no emoji font. That
  is an environment artefact, not a product bug.

## Results at a glance

| # | Task | Verdict | One line |
|---|---|---|---|
| 1 | What does Claude need, and what happens when you answer? | **Better** | Only the bar answers the second half without opening anything. |
| 2 | Which session is blocked on you? | **Same** | Neither surface names the blocked session. The bar names the item, not the session (§4.6 not implemented). |
| 3 | 13-item queue, find the one high-stakes item | **Better** (to find it) · **Same** (to clear the queue) | "+1 high decision" is visible at both widths and reaches the decision in 8 keys. Off, nothing signals *stakes* (the ▲ glyph marks decisions, not stakes). |
| 4 | Claude exited — is anything still owed? | **Mixed** (better for sighted keyboard users, worse for screen readers) | Resume path 9 keys vs 20. But the plan's "after" text promises execution by an agent that has exited, and the exit/questions state is no longer announced. |
| 5 | Edge states | **Mixed** | Disconnected, replay, long titles and the hold-with-pending case are better. Empty is the same. The idle **HELD** line is worse than designed. A false "Nothing needs you" appears when the bound session is empty. |

---

## Scenario 1 — "What does Claude need from you right now, and what happens when you answer?"

**Setup.** One live session, "Session cache work", with four items in creation
order: a draft **plan** (4 steps, blocking), a **high-stakes decision**, a
high-significance finding (research draft) and an explainer.

**Target:** answer both halves from the bar alone, without opening a panel.

| | Before (bar OFF) | After (bar ON) |
|---|---|---|
| Visible top band (1280) | `Your turn` pill · `3 items waiting for you` + 3 truncated chips (`Add a write-through session …`, `Which store backs the sessio…`, `Session cache hit rate is 12…`) | `REVIEW ● Add a write-through session cache · Approve → Claude executes 4 steps · Request changes → Claude revises the plan [Open]  +1 high decision · Decide 3 · Read 1 ⌄` |
| "What does Claude need?" | Partly: three item names, in creation order, none ranked, no stakes | Yes: the oldest blocking item by name, plus "+1 high decision" |
| "What happens when you answer?" | **Not answered anywhere on screen.** No visible text matched "Claude continues / executes / reaches Claude / waiting / resumes" | **Answered in the bar**: "Approve → Claude executes 4 steps · Request changes → Claude revises the plan" |
| Panels opened | 0, but the second question stays unanswered | 0 |
| Keys from load to opening a pending item | 3: Tab, Tab → `Your turn — 1 finding, 1 decision, 1 plan · click to jump`, Enter. The pill cycles, so it opened the **decision**, not the plan already on screen | 4: Tab → `Jump to next up`, Enter, Tab → `Open`, Enter |

On landing, both modes already select the oldest pending item, the plan
(`s1-*-landing.png`). So "Open" is only needed when you have navigated away.

**Accessibility-tree evidence.**
- ON: `region "Next up"` exposes the whole line as text:
  `REVIEW ● Add a write-through session cache · Approve → Claude executes 4 steps · …`,
  then `button "Open"`, `button "+1 high decision"`, `text: Decide 3 Read 1`,
  `button "Expand next-up details"`, and a `status`.
- OFF: `region "Waiting for you"` exposes `3 items waiting for you` and three
  chips whose names are **truncated** to 28 characters
  (`button "Which store backs the sessio…"`). The full titles are only in the
  Dismiss buttons' names.
- Live regions on load. ON: `Agent working` (TurnIndicator, polite) **and**
  `Next up: review — Add a write-through session cache` (bar announcer). OFF:
  `Your turn`.

**Better.** Only the bar states the consequence before you act. It names the
item rather than counting it, and it surfaces the high-stakes decision without
your having to open anything.

**Worse.**
- With the bar ON, the header pill reads **"Agent working"** in the same frame
  where the bar says the agent is blocked on your plan review. OFF said "Your
  turn". The two surfaces disagree (see D6).
- The keyboard path to "Open" is one key longer than the old pill.
- Two polite announcements fire on initial load instead of one (D1, mount-only).

**Verdict: better.**

---

## Scenario 2 — "Which session is blocked on you?"

**Setup.** Three live sessions in one project:
- "Auth refactor": only approved work.
- "Billing migration": **the one blocker**, a high-stakes decision.
- "Docs cleanup": one explainer to read, which is not blocking.

The tab is bound to **Auth refactor**, the realistic case where you were
working in a different session.

| | Before | After |
|---|---|---|
| Session tabs (both) | `Auth refactor 2 · Billing migration 1 · Docs cleanup 1`. The number is the **artifact count**, and the tooltip says only `s_bill / Artifacts: 1`. No tab marks the blocker. | identical |
| Top band | `1 item waiting for you` + chip `Backfill invoices before or …` | `DECIDE ▲ Backfill invoices before or after the cutover? HIGH · The cutover is irreversible for 30 days… · Claude continues with the option you pick [Open]` |
| Is "Billing migration" paired with the blocker anywhere on screen? | **No.** The `Agents:` row says `Agent 1 (2) · Agent 2 (1) · Agent 3 (1)`, numbers with no session names | **No.** The `⌄` expansion lists `Decide (1) Backfill invoices… HIGH / Read (1) How the docs build…` and has no session name (`s2-after-*-expanded.png`) |
| Keys to open the blocker | 5 Tab + Enter = **6** (via the `Your turn` pill) | 4 Tab + Enter + Tab + Enter = **7** (skip link → Open). The recorded run is 10 because it also expanded `⌄` |
| Is the session identified after opening? | No: the detail pane does not name the session | No |

The **Threads** view does answer the question in both modes. It is the view
that opens when no `?session=` is bound. It shows "Needs you (1)" and the
decision's context, but it labels the row with the **project** directory and the
decision text, not the session title "Billing migration"
(observed in an exploratory run in both modes; not among the committed shots, which are bound to Auth).

**Accessibility tree.** In both modes, the `navigation "Sessions"` buttons are
`"Auth refactor 2"`, `"Billing migration 1"` and `"Docs cleanup 1"`. A
screen-reader user would hear "Billing migration 1" and could not tell that
"1" means one artifact, not one blocker.

**Better.** The bar tells you *what* is blocked, why it matters and what
answering does. It does this even though the item belongs to a session other
than the bound one.

**Worse / same.** The task is "which **session**", and nothing answers it. The
design says the bar "names the session of the top item" (§4.6, §6), but this is
not implemented: `AttentionItem` has no `sessionLabel` and `Queue` renders
none (D2).

**Verdict: same.**

---

## Scenario 3 — "Clear a 13-item queue; find the one high-stakes item among them"

**Setup.** One session with 13 pending items in creation order: 7
findings/plans, then **one high-stakes decision** ("Drop the legacy sessions
table during the cutover?"), then 5 more findings/plans. Seven of the findings
are high-*significance*, so a count that included findings would read wrongly
as "+6". The queue was re-seeded for every run.

### Finding the high-stakes item (keyboard-only, from load)

| | Before | After |
|---|---|---|
| Any stakes signal above the fold before opening anything? | **Nothing signals stakes.** Banner: `13 items waiting for you` + 3 chips + `+10 more`. PR 4's sidebar glyphs still mark the item as a decision (▲ vs ● review), and the palette's "Next pending" command exists, but neither says HIGH. | **`+1 high decision`**, in red on a red-dim pill, at x=1102 (1280 wide) and x=1713 (1920 wide). It is fully in the viewport and not clipped at either width. It counts decisions only, correctly "+1" not "+6". |
| Path | `n` ×7. Creation order; the ▲ marks a decision, but nothing tells you which item is high-stakes. | Tab → skip link, Enter, Tab → Open, Tab → `+1 high decision`, Enter (opens "High-stakes decisions (1)"), Tab, Tab → item, Enter |
| Keys | **7**, and only if you already know the item exists | **8**, and you know it exists from the first frame |
| Panels opened | 0 | 1 (the `⌄` high list) |

### Clearing all 13 (keyboard-only)

The same in both modes: **25 keys**, 0 panels. That is `n` + `a` (3-second
keyboard approve countdown) for each of the 12 reviews, and one Enter on the
decision card, which takes focus automatically. `n` follows `computePending`
creation order in both modes. All 13 cleared in all 4 runs. The bar ends at
`◇ Nothing needs you`, and the old UI ends with the banner gone.

**The exception noted above:** before pressing Enter on the decision, the
script called `page.focus()` on the card container. This only re-asserts the
autofocus the card already performs on mount (`DecisionCard.tsx:300-306`).

**Accessibility tree / live regions.**
- ON: `button "+1 high decision"` is a named button in the bar, but it is
  **never announced**. The announcer only speaks when `next` changes. A
  screen-reader user learns it exists only by tabbing to it or reading the
  region.
- While clearing with the bar ON, the announcer spoke 12 times
  (`Next up: review — add order_events table` … `Next up: nothing needs you`),
  once per cleared item, as designed. OFF announced `Your turn` / `1 for you` /
  `Up to date` from the pill.

**Better.** The high-stakes item is visible on landing at both sizes and
reachable in one marked step. Off, it is invisible until you happen to land on
it.

**Same.** Clearing cost is identical.

**Worse.** Twelve polite announcements in a clearing run may be chatty; we can't
judge that without a real screen reader. Shift+`n` (previous) and a global ⏎
"open next" from §7 are not implemented. The `n` handler ignores Shift, and
the bar has no Enter binding (D7).

**Verdict: better** for finding the item. **Same** for clearing the queue.

---

## Scenario 4 — "Claude exited — is anything still owed to you?"

**Setup.** Session "Rate limiting":
- one approved finding with an open question ("Does this cover websocket upgrades too?");
- a draft **plan** (4 steps, blocking);
- a draft finding with an open question ("Is the burst from retries or from real users?").

Then `unregister`: the agent exits and its history stays readable.

| | Before | After |
|---|---|---|
| Header | `Your turn`. Nothing in the header says the agent has gone. | `Agent exited — resume to continue` |
| What you owe | `2 items waiting for you` + chips | `REVIEW ● Add per-user API rate limiting … Decide 2` |
| What Claude owes you | `💤 2 questions waiting for Claude [Copy resume prompt]`, its own row | `💤 Exited with 2 of your questions open [Copy resume prompt]` · `Waiting 2` in the same line. `⌄` lists "Waiting on Claude (2)" with both questions. |
| What happens when you answer | Not stated (the composer says "The agent exited — your message is saved…") | The bar says **"Approve → Claude executes 4 steps · Request changes → Claude revises the plan"**, which **is not true while the agent is gone** (D3) |
| Keys to Copy resume prompt | **20** (19 Tab + Enter) | **9** (4 Tab → skip link, Enter, 3 Tab → Copy, Enter) |
| Clipboard | Correct resume prompt ("…I left 2 questions… Call check_feedback…") | identical |

**Accessibility tree / live regions.**
- OFF: the resume banner is a live status. It announced
  `2 questions waiting for Claude Copy resume prompt`, then
  `… Copied ✓` after the copy.
- ON: the only bar announcement was `Next up: review — Add per-user API rate limiting`.
  The "N questions waiting for Claude" count is **not announced**, and the
  `Copied ✓` confirmation is a button-label change, **not a live region**.
- The exit itself is a different matter. The exit *transition* is announced
  once, by TurnIndicator's live status (a deliberate #452 decision). This
  scenario unregisters the agent *before* page load, so no transition was
  observed in either mode.
- So with the bar ON a screen-reader user loses the open-questions count and
  the copy confirmation (D5).

**Better.**
- The Waiting lane is honest about direction: questions are "Waiting on
  Claude", never your to-do.
- The header finally says "exited".
- Resume is reachable in less than half the keys.

**Worse.**
- The plan's "after" copy promises execution by an exited agent (D3).
- Screen-reader users lose the "N questions waiting for Claude" and "Copied ✓" announcements (D5).

**Verdict: mixed.** Better for sighted and keyboard users. Worse on honest
copy and for screen readers. Fixing D3 and D5 would make it better outright.

---

## Scenario 5 — Edge states

| State | Before | After | Verdict |
|---|---|---|---|
| **Empty** (registered session, nothing yet) | Body: "Waiting for Claude". No extra row. | `◇ Nothing needs you ⌄` adds one row (expected, §4.2). When a finding and then a high decision arrived: `● Session cache hit rate is 12% · +1 high decision · Decide 2`, announced once (`Next up: review — …`). OFF announced `1 for you`, `Your turn`. | **Same** |
| **Disconnected** (daemon killed under an open tab, 5s later) | DisconnectBanner `Disconnected from server — reconnecting...` + the stale `2 items waiting for you` banner. No signal that the list is last-known. | `⚠ DISCONNECTED · DECIDE ▲ Which store backs the session cache? HIGH · … · Claude continues with the option you pick`. The prefix is pinned, and DisconnectBanner is still shown. **But** there is no "(last known)" and no `[doctor --fix]` (design state G). The after text still promises "Claude continues" (D3). The decision's Select buttons stay **enabled** while disconnected, in both modes; §4.3 rule 1 says act buttons disable with the reason. | **Better** (failure visible on the line), short of the design |
| **Replay** (deep link to an on-disk session this daemon did not register) | Scrubber `Replay mode 1/2 events … Exit` + the live `2 items waiting for you` banner + `Your turn`, with nothing tying them together | `REPLAY · ▲ Which store backs… · Decide 2` + scrubber. Esc exits, and the bar then truthfully reads `◇ Nothing needs you` for the live session. | **Better** |
| **Long titles** (a 220-character decision title, 140-character finding, 2 high decisions) | Chips cut at 28 characters (`Should the session cache key…`). No HIGH anywhere. | One line (28px at 1280, 33px at 1920). The title truncates first. `Open`, `+2 high decision`, `Decide 3` and `⌄` all measured in the viewport and unclipped at both widths. The full text is in the accessible name. | **Better** |
| **Blocked action, idle** (stance hold, nothing pending) | Hero toast (`role=alert`, 12s) with Retire/Ledger. After it fades, only the `⋯` button renamed to "Diagnostics — attention needed". **18 keys** to the gate log (⋯ → "Show recent gate blocks (1 waiting on you)"). | Same hero toast + bar `■ HELD [Why]`. **10 keys** to the record (skip link → Why). No Retire in the bar (good). **But the line shows only `■ HELD`**, not the concept or proposal of design state F (D4). Once the toast fades you can't tell *what* was held without pressing Why. | **Worse than designed**; about the same as before |
| **Blocked action, decision pending** | Toast + `Your turn` | `DECIDE ▲ Where should config be loaded? … · Decide 1 · Held 1`. The hold never covers the decision (§4.3 holds). `⌄` shows both. | **Better** |

**Accessibility tree / live regions.**
- The toast's `role=alert` fired in both modes.
- In the idle-hold case the bar's `status` was empty, because `next` did not
  change, so the bar adds nothing for screen readers.
- ON `region "Next up"` with a hold: `text: ■ HELD`, `button "Why"`,
  `button "Expand next-up details"`. "Held" is all an AT user gets until they
  press Why.

---

## Defects found (not fixed here)

**D1 — Co-announcement on initial load (mount-only).**
With the bar ON, `TurnIndicator` stays a polite live status
(`web/src/components/TurnIndicator.tsx:224`). That was a deliberate #452
review decision: it is the single announcer for agent-state transitions such
as an exit, so it must **stay live**. Making it non-live would recreate exit
silence. The narrow defect is that on **initial load** its first state and the
bar's first `next` both announce.
- *Repro:* bar ON, seed any pending draft, load the page. The live log shows
  `Agent working` (TurnIndicator) and `Next up: review — …` (bar) within about
  1ms of each other (S1, S2, S3 logs).
- Our API seeding inflates this: the seed traffic counts as agent activity,
  which is why the first state is "Agent working".
- *Suggested fix:* suppress TurnIndicator's announcement on mount. Keep it live
  for later transitions.

**D2 — The bar never names the session (design §4.6 / §6).**
`AttentionItem` has no `sessionLabel` (`web/src/lib/attention.ts`), and
`NextUpBar`'s `Queue` renders titles only.
- *Repro:* register three sessions, put one decision in the second, bind the
  tab to the first, then expand `⌄`. The item is listed with no session name.

**D3 — Blocking-review "after" copy ignores an exited agent.**
In `afterFor` (`web/src/components/NextUpBar.tsx:98-104`), the
`review-blocking` case returns "Approve → Claude executes N steps…" or "Your
verdicts go back as one review; Claude is waiting on it" whatever `agentGone`
is. The `decision` and `review` cases do check it.
- *Repro:* register, add a draft plan, `unregister`, then open with the bar ON.
  The header says "Agent exited — resume to continue" while the bar says
  "Approve → Claude executes 4 steps" (`s4-after-*-landing.png`).
- It also applies **while disconnected** and **during replay**. The bar keeps
  promising "Claude continues with the option you pick" or "Claude executes…"
  under `⚠ DISCONNECTED` and `REPLAY` (`s5-disconnected-after-*.png`,
  `s5-replay-after-*.png`).

**D4 — The HELD line omits what was held.**
`primaryToken` returns the bare `"■ HELD"`, and `whyFor`/`afterFor` return ""
for holds. Design state F shows
`■ HELD "global mutable state for config" stopped: Add a ConfigStore singleton… [Why]`.
- *Repro:* with nothing pending, POST a `preflight_blocked` event to
  `/api/internal/sessions/<id>/preflight-block`, then wait for the 12s toast to
  fade. The bar reads `■ HELD [Why]` (`s5-hold-idle-after-*.png`).

**D5 — The questions count and the copy confirmation are not announced with the bar ON.**
With the bar OFF, `ResumeQuestionsBanner` is `aria-live`, so it announces "N
questions waiting for Claude" and "Copied ✓". With the bar ON, the bar's resume
chip and copy button sit outside any live region, and the bar's announcer only
tracks `next`.

The exit *transition* is not lost: TurnIndicator still announces it once
(#452). S4 unregisters the agent before load, so it does not exercise the
transition.
- *Repro:* run S4 with the bar ON and compare the live log against the bar-OFF
  run.

**D6 — "Nothing needs you" when the bound session is empty.**
`MultiAgentSync` mounts inside `ArtifactPanel`
(`web/src/components/ArtifactPanel.tsx:1329`), which only renders once the
bound session has artifacts. So other live sessions' drafts are never merged.
- With the bar ON this becomes a **false positive claim**: `◇ Nothing needs you`.
- With the bar OFF the UI is merely silent. Only the Threads badge "1" hints at
  the blocker.
- *Repro:* register `s_new` (no artifacts) and `s_bill` with a decision, open
  `?session=s_new`, and wait 12s
  (`defect-empty-bound-session-{before,after}-1280x800.png`).
- *Related, smaller:* with a blocking item pending, the bar-ON header reads
  "Agent working" (45s activity window) right next to "REVIEW … Claude is
  waiting". Off, the header said "Your turn".

**D7 — Keyboard gaps against §7.**
- Shift+`n` (previous) is not bound: the `n` handler in `App.tsx` ignores
  `shiftKey`, and `N` matches nothing.
- There is no global ⏎ "open next".
- The skip link is first in the DOM, but on landing the app parks focus on the
  selected artifact's status chip (for example `✓ Approved`). Tab then goes
  textarea → textarea → (toast buttons) → body → skip link, so the skip link
  took 3–7 presses in S2, S4 and S5.

**D8 — Transient false announcement on load (intermittent).**
The connect payload resets and refills the artifact store. The announcer then
speaks `Next up: review — Finding 1` → `Next up: nothing needs you` →
`Next up: review — Finding 1` within about 33ms.
- Seen in 1 of 12 reloads in a dedicated loop, and in 1 of 4 S3 runs.
- Polite queuing may hide it on a real screen reader; we could not verify that.

## Recommendation on PR 6 (flip the default, delete the old banners)

**Not yet.** The bar is a real improvement for the two questions it was built
for:
- S1 is the only surface that says what answering does.
- In S3 the high-stakes item is visible on landing.

It also handles failure states better: disconnected, replay and long titles.
But flipping the default would also **delete** the old banners, and today the
bar-ON path regresses or overclaims in ways the old UI did not:
- **D3:** it promises execution by an exited agent.
- **D6:** it says "Nothing needs you" while a sibling session has an open decision.
- **D5:** screen-reader users lose the "N questions waiting for Claude" and "Copied ✓" announcements.
- **D4:** the HELD line is less informative than designed.
- **D2:** the "which session" task (S2) is not improved at all.

Suggested gate for PR 6 (in the reviewer's must-fix order):
1. **D6:** stop the false "Nothing needs you" when the bound session is empty.
2. **D3:** make the "after" copy honest when the agent has exited, the tab is
   disconnected, or the view is a replay.
3. **D5 (narrowed):** announce the questions count and the "Copied ✓"
   confirmation.
4. **D4:** make the HELD line name what was held.
5. **D2:** add the session label to the line or the expansion.
6. Rerun S2, S4 and S5. The harness is reproducible from this doc.
7. Run the **external pilot with real people and a real screen reader** that
   §9 calls for. Nothing here substitutes for it.

Nice-to-have, not gating:
- **D1 (mount-only):** suppress TurnIndicator's announcement on mount. Keep it
  live, because it announces exits (#452).
- **D8:** the transient load announcement.
- **D7:** keyboard gaps.
- **State G details:** "(last known)", `doctor --fix` in the bar, and act
  buttons disabled with a reason while disconnected.

## Independent review

An independent reviewer checked every defect against the code. It agreed with
the "not yet" verdict and asked for the corrections above:
- D1 narrowed to the mount-only co-announcement;
- D5 narrowed to the questions count and the copy confirmation;
- S3 bar-OFF wording changed to "nothing signals *stakes*".

It also asked that three understated findings be made explicit:
- state G is missing "(last known)" and the `doctor --fix` escalation;
- act buttons are not disabled while disconnected;
- D3 also applies while disconnected and during replay.

**Must-fix before PR 6, in ranked order:**
1. **D6:** false "Nothing needs you" when the bound session is empty.
2. **D3:** "after" copy that ignores an exited agent, a disconnection or replay.
3. **D5 (narrowed):** announce the questions count and the copy confirmation.
4. **D4:** the HELD line names what was held.
5. **D2:** session labels.

**Nice-to-have:**
- **D8:** the transient load announcement.
- **D1 (mount-only):** suppress TurnIndicator's announcement on mount.
- **D7:** keyboard gaps.
- **State G details:** "(last known)", `doctor --fix` in the bar, and act
  buttons disabled with a reason while disconnected.

## What this could not measure

- **Real screen readers.** No NVDA, JAWS or VoiceOver. The ARIA snapshot and
  the live-region text log are a proxy. They can't show speech order, whether
  polite updates are dropped or merged (relevant to D8 and S3's 12
  announcements), or verbosity.
- **Real humans.** There were no participants. That means no measure of whether
  "+1 high decision" is *noticed* (only that it is visible, unclipped, coloured
  and in the viewport), no task-completion times, no errors and no trust.
- **Cognitive load or preference.** Keystroke counts are a weak stand-in. A
  4-key path you understand can beat a 3-key path you don't.
- **Other conditions.** We tested only headless Chromium in dark theme, with no
  zoom, no light theme, no Windows high-contrast, no VS Code webview width
  (~900px) and no mobile.
- **The 60s DisconnectBanner escalation (`doctor --fix`).** Disconnected was
  sampled at 5s only.
- **Seeding fidelity.** State was seeded through the daemon's internal HTTP API
  rather than a live Claude Code agent. The agent-activity window therefore
  reflects seeding traffic, which is why "Agent working" appears in the header.
- **Emoji glyphs.** These render as boxes in the screenshots; this is
  environmental.

---

## Rerun after fixes (#458, #459)

> Rerun of **S2, S4 and S5**, plus an explicit **D6** check, against `main`
> `9f3059bc`. That commit includes #458 (D6, sibling freshness, quiet backfill)
> and #459 (D3, D5 narrowed, D4, D2, D8, D1 mount-only, Shift+`n`, state G).
>
> Method and rules are unchanged:
> - fresh native clone, `pnpm install --frozen-lockfile && pnpm build`;
> - real daemons seeded through the internal session API;
> - temp HOME, `DEEPPAIRING_NO_OPEN=1`, `BROWSER=none`,
>   `DEEPPAIRING_PORT_BASE=26000`;
> - headless Chromium;
> - bar OFF and ON at 1280×800 and 1920×1080;
> - keyboard-only, with ARIA snapshots and live-region logs as before.
>
> Live-region entries whose element had `aria-live="off"` at the time are
> treated as silent; #459's mount-time TurnIndicator uses this. New
> screenshots are in `attention-walkthroughs/rerun/`.
>
> **Live-region convention, applied throughout this section.** Any text a
> live region holds or changes to after page load counts as a *potential
> announcement*. That includes content populated during load. Whether a real
> screen reader speaks content that is already present at load can't be
> verified with this proxy. The convention therefore cuts both ways: it credits
> OFF's resume banner on landing (S4), and it counts the load-time
> "Disconnected…" status as a false announcement (N2).

### Per-scenario verdicts

| # | Before fixes | Now | Evidence |
|---|---|---|---|
| **S2** which session is blocked | Same | **Better** | OFF's 6 keys depends on seeding: the `Your turn` pill cycles pending items in creation order, and here the blocker is the first one it reaches. With other pending drafts created earlier, OFF needs more presses. The line reads `DECIDE ▲ Backfill invoices before or after the cutover? HIGH in Billing migration · …`. The expanded queue lists `Backfill invoices… HIGH — Billing migration` and `How the docs build pipeline works — Docs cleanup`. The ARIA text carries "in Billing migration". OFF is unchanged and still has no session name. Keys to open the blocker: 7 ON (skip link → Open) vs 6 OFF (`rerun/s2-*`). |
| **S4** Claude exited | Mixed | **Better** for sighted/keyboard users and for exit-while-open; **landing gap** for screen readers | **Copy:** the bar now says `Saved — Claude acts on your verdict when the session resumes` (D3 fixed). **Keys:** resume prompt in 9 ON vs 20 OFF, and the clipboard is correct in both. **Live regions, landing on an already-exited agent:** OFF's resume banner region holds `2 questions waiting for Claude` at load. Under the convention above that is a potential announcement. ON says nothing about the open questions until Copy, then `Copied ✓ — resume prompt`. This is a remaining **landing gap**, and the screen-reader "better" applies only to exit-while-open. **Live regions, exit while the tab is open** (new check, `rerun/s4-exit-transition-*`): ON announces `Agent exited — resume to continue` **and** `2 questions waiting for Claude`; OFF announces only the resume banner (its pill stays "Your turn"). |
| **S5** edge states | Mixed | **Better** (one carry-over) | See below. |

**S5 detail.**
- **Empty:** same as before. One extra `◇ Nothing needs you` row; on arrival, one bar announcement plus TurnIndicator's.
- **Disconnected:** the line now reads `⚠ DISCONNECTED · ▲ … (last known)`, with after-text `Disconnected — Claude resumes when it reconnects`.
  - A `doctor --fix` chip appears in the bar at about 60–65s of outage. We polled every 10s: absent at 55s, present at 65s (`rerun/s5-disconnected-after-1280x800-140s.png`).
  - **Act buttons are still enabled** while disconnected, in both modes. The decision's two Select buttons have `disabled=false`. This was a nice-to-have and is not fixed.
- **Replay:** the after-text is now `Replay is read-only — nothing you do here reaches Claude` (D3 in replay fixed). Esc still exits.
- **Long titles:** unchanged. Every pinned token is unclipped and in the viewport at both widths, and the bar is one line (28px / 33px).
- **Hold, idle:** the line now reads `■ HELD "global mutable state for config" stopped: Add a ConfigStore singleton that every module imports [Why]`. The record is visible after the toast fades. 10 keys to the record ON vs 18 OFF.
- **Hold, decision pending:** unchanged and correct: `▲ Where should config be loaded? · Decide 1 · Held 1`.

### Per-defect verdicts

| Defect | Status | Evidence |
|---|---|---|
| **D6** "Nothing needs you" with an empty bound session | **Fixed** (both modes) | Explicit recheck: bound to an empty `s_new`, with sibling `s_bill` holding a decision, after a 12s wait. ON: `DECIDE ▲ Backfill invoices… HIGH · … · Claude continues with the option you pick`. OFF: `1 for you` and the item in the sidebar (`rerun/d6-empty-bound-session-*`). **But see N1:** no session label here. |
| **D3** "after" ignores exit / disconnect / replay | **Fixed** | Exited: "Saved — Claude acts on your verdict when the session resumes". Disconnected: "Disconnected — Claude resumes when it reconnects". Replay: "Replay is read-only — nothing you do here reaches Claude". |
| **D5 (narrowed)** questions count + copy confirmation | **Fixed** | `next-up-announcer: 2 questions waiting for Claude` on the exit transition. `next-up-announcer: Copied ✓ — resume prompt` on copy. |
| **D4** HELD line omits what was held | **Fixed** | The line and its accessible text carry the concept and proposal. |
| **D2** session not named | **Fixed for multi-session merges** | S2 line and queue. See N1 for the single-sibling gap. |
| **D8** transient false announcement on load | **Not reproduced** | 0 of 12 reloads of a 13-item ON page (was 1 of 12). |
| **D1 (mount-only)** co-announcement on load | **Fixed** | ON load logs show TurnIndicator rendering with `aria-live="off"` (`Agent working`, `Agent exited — resume to continue`) and no bar announcement. Later transitions are announced (S4 exit-while-open). |
| **D7** keyboard gaps | **Partly checked** | Shift+`n` is in the #459 changelog; it was not re-measured here, because S3 was out of scope for this rerun. Skip-link reach is unchanged: 3–6 Tabs after the app's focus park. |
| State G details | **Mostly fixed** | "(last known)" and the `doctor --fix` chip are present. Act buttons are still enabled while disconnected (unchanged, both modes). |

### New defects

**N1 — The session label is missing when every merged item comes from one sibling session.**
`computeAttention` labels items only when the merged artifacts span more than
one session (`web/src/lib/attention.ts`, `sessionIds.size > 1`). When the bound
session is empty and a single sibling holds the work (exactly the D6 case), the
bar names the item but not its session. The tab is still bound to a
*different* session, so "which session is blocked?" goes unanswered in the
case #458 just made visible.
- *Repro:* register `s_new` (no artifacts) and `s_bill` ("Billing migration")
  with one decision. Open `?session=s_new` with the bar ON. The line reads
  `DECIDE ▲ Backfill invoices… HIGH · …` with no "in Billing migration"
  (`rerun/d6-empty-bound-session-after-1280x800.png`).
- *Suggested rule:* also label an item when its session is not the bound one.

**N2 (pre-existing, both modes; also visual with the bar ON) — A false outage on every page load.**
`DisconnectBanner` (`role="status"`) renders `Disconnected from server —
reconnecting...` before the first WebSocket connect. Every live-region log, ON
and OFF, before and after the fixes, starts with it about 100–700ms after load.
Under the convention above, that is a false announcement on every reload.

With the bar ON it is also **visual**. For about 70ms of each load
(t≈130→201ms) the bar renders `⚠ DISCONNECTED · ◇ Nothing needs you (last known)`
before the real line. That is a false "nothing" and a false outage at once.
- *Suggested fix:* a first-connect grace period before showing or announcing
  the disconnected state.

**N3 (wording, ON) — Disconnected after-text blames Claude.**
"Disconnected — Claude resumes when it reconnects" describes the *tab's*
connection as Claude's. "Your choice is sent when this tab reconnects" would be
accurate. Minor.

**N4 (pre-existing, OFF) — The disconnect banner rounds the outage up.**
It reads "Still disconnected after **2** min" at about 92s of outage. Minor.

### Residues to track (not blockers)

- **D8 edge.** The fix keeps the baseline silent until hydration settles. If
  the first snapshot never applies, the bar's announcer and TurnIndicator stay
  silent until recovery. This is by design but untested here.
- **#458 count-signal residue.** A sibling session is re-fetched only when its
  `artifactCount` moves. So:
  - a sibling's decision that is resolved elsewhere stays listed in Decide
    (over-report);
  - new questions on a sibling's existing artifacts don't refresh Waiting
    (under-report).

  Fixed in #464 (merged 2026-10-08 UTC; 2026-10-07 local time).

### Status after #467 and remaining PR 6 gates (2026-10-10)

The rerun above was performed against `main` `9f3059bc`, before #467. PR #467
(head `d4a10ee6d183c227815d2553314331240b1e800b`; merged 2026-10-08 UTC as
`13051f4e4a98c37b5cd994454a171e86faa635a1`) addressed N1–N4 and the
disconnected act-button gating. Current `main` `cd87e715` includes that merge;
in particular, N1's single-sibling/bound-session case is now handled in
`packages/mcp-server/web/src/lib/attention.ts`. This is implementation status,
not a new walkthrough result: the screenshots and verdicts above remain
evidence from the older revisions and must not be read as verification of the
post-#467 UI.

Before PR 6:

1. Rerun the five before/after task walkthroughs against current `main` and
   refresh the screenshots and findings at 1280×800 and 1920×1080. The existing
   walkthroughs used v0.1.61 and selectively reran S2/S4/S5 plus D6 on
   `9f3059bc`; the document describes the Playwright method but does not include
   a checked-in runner or command. Accessibility-tree and live-region logs are
   still proxies, not real screen-reader evidence.
2. Complete the consent-gated external pilot tracked in #434, including real
   participants and a real screen reader, then feed back the anonymized findings
   and limitations. Protocol preparation merged as #435 on 2026-10-08; #434
   remains open, and its approval requirements still apply before outreach,
   recruitment, or data collection.

Only after the current-main walkthrough gate and pilot findings are addressed
should PR 6 flip the default and delete the old banner components, with the
independent review required by #430. Do not call screenshots or scripted runs
alone usability validation.
