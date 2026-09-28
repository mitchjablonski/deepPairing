# Attention hierarchy — one next-action surface (proposal, #430)

> **Status: PROPOSAL for review and approval. No UI code changes are included.**
> Refs #430. Source audited at `main` 2dfeeb58 (v0.1.56). Screenshots in
> `docs/design/attention-hierarchy/` were captured headless in real Chromium
> against a seeded daemon (temp HOME, isolated port window, no auto-open).
> This is a heuristic design proposal, not a usability study: nothing here is
> "usability-validated" until the pilot walkthroughs in §9 are run.

## 0. The ask, in one paragraph

Today the human learns "something needs you" from **up to nine surfaces at
once** (tab title, OS notification, header pill, Threads badge, pending banner,
sidebar dots, status chip, sticky footer, context bank), while the one thing
that should dominate — *the next consequential decision, why it matters, and
what happens when you answer* — has **no dedicated home** and can even be
**hidden**: in our seeded "urgent" session the only high-stakes decision sits
behind `▾ Show 6 older` on landing, wearing the same amber dot as twelve
low-stakes findings and an FYI explainer (`before-00-urgent-landing.png`).

**Proposal:** add one **Next-up bar** directly under the header that always
answers three questions — *what is next, why it matters, what happens after you
respond* — ordered by a single shared attention model with four lanes that keep
the existing distinctions intact:

| Lane | Colour | Meaning | Examples |
|---|---|---|---|
| **Decide** | amber, strong | needs your judgment and blocks the agent | open decision, draft plan/changeset/spec/research, secret warning |
| **Read** | neutral | for you, blocks nothing | explainer, reasoning, "Added to your Ledger" |
| **Waiting on the agent** | blue | your move is done; the agent owes you | unanswered questions, pending requests, revision requested |
| **System** | red / muted | connection, failure, gate | disconnected, stale daemon, send failed, gate block |

The bar **absorbs** the pending banner, the resume-questions banner and the
"your turn" half of the header pill; everything else becomes secondary behind
progressive disclosure or is removed as a duplicate (§5). Nothing pending is
hidden, nothing is auto-approved, no failure is suppressed.

**What I need from you (§10):** approve the lane model and the bar's position,
choose the ordering rule for Decide, and pick the migration start (§8, PR 1).

---

## 1. What the current UI looks like

Checked-in shots (`docs/assets/`) and new captures (`docs/design/attention-hierarchy/before-*.png`, 1440×900 unless noted):

| State | Shot | What a first-time reader has to parse before the content |
|---|---|---|
| Urgent decision pending (landing) | `before-00-urgent-landing.png` | Header pill "Your turn", Threads 1, 4 session tabs, **"15 items waiting for you" + 3 chips + "+12 more"**, "Ask Claude for something", `Agents: All (17) · Agent 1 (3) · …`, then a sidebar of 11 identical amber dots. **The high-stakes decision is not visible**: it is older than the 10 most recent and collapsed behind `▾ Show 6 older`. The landing selection is a low-stakes finding. |
| Urgent decision, opened | `before-01-urgent-decision.png` | The decision itself is excellent (context, HIGH STAKES, options, recommendation, keyboard hint). But nothing above it says *this* one is the blocker; the banner still says "15 items". |
| Info only (explainer) | `before-02-info-only.png` | Status chip says "New — for you to read" (honest), but the sidebar shows the **same amber "draft" dot** as review items, and the banner still counts the other sessions' 15. |
| Agent working / first move | `before-03-agent-working.png` | Header: "Connected — waiting for the agent's first move"; body: "Waiting for Claude"; composer: "The agent will see this the next time it checks in". Three phrasings of one state (acceptable, but computed with **three different idle windows**: 45s, 60s, 90s). |
| Long queue, laptop | `before-05-long-queue-1280.png` (1280×800) | Content starts ~y=160 of 800 (20% chrome); 13 findings/plans, identical dots, titles truncated; nothing ranks them. |
| Blocked / rejected action | `before-06-blocked.png` | Demo CTA + "Session wrapped" card + Agents row push content to ~y=310 of 900 (34%). Two toasts cover the lower-right of the detail pane. Composer says "agent exited". |
| No session bound | `before-07-aggregate-no-session.png` | The **Threads** view opens: "Needs you / Waiting on the agent / Quiet / Done". This is the clearest attention model in the app today — and it only exists across projects, not inside a session. |

Checked-in `docs/assets/review-surface.png`, `enforcement.png`, `debrief.png`
show the same pattern at 2×: "Your turn — 3 findings, 3 decisions, 1 plan, 2
debriefs, 2 explainers" (header) repeats "11 items waiting for you" (banner),
which repeats the 11 amber dots (sidebar), which repeats "Draft, awaiting
review" (status chip), which repeats the sticky Approve bar. `debrief.png`
shows the good pattern we want to generalise: the debrief's own
**"NEEDS YOUR EYES — 1 · Whether the mobile client shares this interceptor ·
Why: …· Open to review →"** block.

---

## 2. Inventory of attention and status signals

Paths are relative to `packages/mcp-server/web/src/`. Class: **A** needs your
judgment · **B** FYI · **C** waiting on the agent · **D** system/connection/failure.

### 2.1 Layout order (App.tsx), top to bottom

`SkillLoadBanner` 546 → `<header>` 559-725 → session bar `<nav aria-label="Sessions">` 732-779 → `DisconnectBanner` 783 → `ReplayScrubber` 786 → `PendingBanner` 793 → `ResumeQuestionsBanner` 797 → `RequestComposerBanner` 801 → demo "✓ Demo fired" CTA 820-842 → `SessionWrapCard` 847-854 → `<main>` 858-882 (ArtifactPanel: `Agents:` row 1237-1268, sidebar + detail 1270-1313) → composer 896-902 → overlays 905-940 → `ToastLayer` 943 → `CrossProjectCard` 948.

Up to **seven full-width rows** can stack above the artifact before you read a word of it.

### 2.2 Header

| Signal | file:line | Says | Class |
|---|---|---|---|
| Tab title "(N) Your turn — deepPairing" | hooks/useDocumentTitleBadge.ts:19-21 | N drafts wait | A |
| OS notification "deepPairing — your turn" | stores/connection.ts:33-42, 248 (called 483, 564, 571) | new draft while unfocused | A |
| ProjectSwitcher amber count | ProjectSwitcher.tsx:105-130, 156-164 | pending in *other* projects | A |
| Threads button count | App.tsx:132, 585-596 | threads needing you, all projects | A |
| TurnIndicator "Your turn — 1 finding, 1 plan…" (pulsing) | TurnIndicator.tsx:189-190, 244-278 (click cycles pending 237-242) | your turn | A |
| …collapsed "Your turn" / "N for you" | TurnIndicator.tsx:272-275; gated App.tsx:100-101 | dedup with banner | A |
| TurnIndicator ❓ "N questions waiting/unanswered" | TurnIndicator.tsx:94-111, 195-225 | agent owes you answers | C |
| "Agent working · Nm" / "Executing plan — step x of y" | TurnIndicator.tsx:71-89, 137-167, 310-316 | agent active (45s window) | C |
| Narration line | TurnIndicator.tsx:319-326 | last `log_reasoning` | C |
| "Up to date" / "Connected — waiting for the agent's first move" / "Agent exited — resume to continue" | TurnIndicator.tsx:147, 179-181, 290-309 | idle / first move / exited | B / C / D |
| Comment threads button count | App.tsx:112-114, 621-628 | unanswered questions (**duplicates the ❓ badge**) | C |
| ⋯ DiagnosticsMenu amber dot | DiagnosticsMenu.tsx:45-47, 90-96 | gate block ever / hook nag | D/B |
| PreflightBlockLog chip (unread count) | PreflightBlockLog.tsx:116-118, 142-157 | unread gate blocks | B |
| HookStatus dot | HookStatus.tsx:50-54, 87-97, 112-114 | last hook result | B/D |
| CompoundingBadge "Ledger · 🛡N · 🧭M" | CompoundingBadge.tsx:43, 65-78 | cumulative stats | B |

### 2.3 Session bar and banner rows

| Signal | file:line | Says | Class |
|---|---|---|---|
| Per-session dot (active **always pulses**) + artifact count | App.tsx:758-774 | live / exited / count | B/D |
| DisconnectBanner (escalates after 60s with `doctor --fix`) | App.tsx:783, 976-999 | connection lost | D |
| ReplayScrubber "REPLAY MODE" | ReplayScrubber.tsx:128-189 | historical, read-only | D |
| **PendingBanner** "N items waiting for you" + 3 chips + "+N more" | PendingBanner.tsx:26-126 | review queue | A |
| **ResumeQuestionsBanner** "N questions waiting for Claude" + copy resume prompt | ResumeQuestionsBanner.tsx:54, 77-103 | agent exited with your questions open | C/D |
| RequestComposerBanner "✎ Ask Claude for something" + request pips + resume bridge | RequestComposerBanner.tsx:81-97, 147-204 | initiate / request status | B/C |
| SkillLoadBanner | SkillLoadBanner.tsx:34, 97-143 | skill probably not loaded | D |
| Demo CTA | App.tsx:820-842 | onboarding next step | B |
| SessionWrapCard | SessionWrapCard.tsx:65-104 | closing recap | B |

### 2.4 Main area, sidebar, detail, footer

| Signal | file:line | Says | Class |
|---|---|---|---|
| HydrationSkeleton / WaitingForClaude / FirstRunWalkthrough / IdleHome | App.tsx:858-882, 959-968; WaitingForClaude.tsx:67-112; WalkthroughCards.tsx:39-60; IdleHome.tsx:39-106 | loading / waiting / empty / disconnected | C/D |
| `Agents:` filter row | ArtifactPanel.tsx:1237-1268 | per-session counts | B |
| Grouping Type/Flow/Time; "▾ Show N older" (keeps 10 most recent) | ArtifactPanel.tsx:561, 804-828, 864-893 | view / **can hide pending work** | B |
| Status glyph (● draft amber, ⧗, ✓, ↻, ✗, ⇈, ↩, ⊘) | ArtifactPanel.tsx:50-106, 972-1007 | status (**same amber for decision, finding, explainer**) | A/B |
| Unread dot, arrival glow, off-screen pip, sr-only "New artifact" | ArtifactPanel.tsx:600-703, 745-783, 931-971, 1009-1050, 1226-1234 | new since you looked | B |
| ⚠ secret marker / SecretWarningBanner | ArtifactPanel.tsx:992-1000; SecretWarningBanner.tsx:27, 44-65 | possible secret | A |
| Status chip ("Draft, awaiting review" / "New — for you to read") | ArtifactPanel.tsx:113-121, 336-341 | status | A/B |
| ClarityChip | ClarityChip.tsx:96, 106-168 | prose density | B |
| PreflightBreadcrumb (bootstrap / signal / ambient; near-miss) | PreflightBreadcrumb.tsx:253-466 | prior stances shaped this | B |
| ConceptBadge | ConceptBadge.tsx:107-161 | ledger recurrence | B |
| Review footer compact / full / auto-approve countdown / open-suggestion confirm / reject panel / explainer "Got it" / terminal chips | ArtifactStatusActions.tsx:227-287, 373-475, 616-960 | **the act surface** | A (terminal B/C) |
| DecisionCard "Let's think this through · HIGH STAKES", Recommended, resolved receipts, carry-over badges | DecisionCard.tsx:572-625, 759-767; decision/OptionCard.tsx:101; decision/ResolvedDecisionView.tsx:62-140; decision/CarryoverBadge.tsx:25-52 | decision + handoff status | A/B/C |
| Research "Reviewed N/M · Next unreviewed →"; Changeset progress, per-file chips, "!N" suggestions, own countdown; Debrief "N need your eyes"; Plan execution strip | artifacts/ResearchArtifact.tsx:137-164; artifacts/ChangesetArtifact.tsx:293-326, 645-650, 1200-1502; artifacts/DebriefArtifact.tsx:233-252, 415; artifacts/PlanArtifact.tsx:436-484 | in-artifact triage | A/C |
| Suggestion pills PENDING / COUNTERED / INSISTED / APPLIED | SuggestionCard.tsx:~123-127; lib/suggestionPill.ts:14-31 | negotiation | A/B |
| Comment receipts ("✓ seen by agent", "delivered · awaiting agent", "⏳ awaiting answer", AskTrigger pulse) | CommentThread.tsx:164-176, 463-550; LineComments.tsx:271-295; artifacts/OpenQuestionSection.tsx:95-118 | handoff | C |
| Composer latency line / "Sent ✓" / unbound-tab hint | MessageInput.tsx:209-216, 336-353; App.tsx:899-901 | handoff / system | C/D |

### 2.5 Overlays and toasts

| Signal | file:line | Class |
|---|---|---|
| ConversationRail counts, filter pills, unread dots, ⏳ rows | ConversationRail.tsx:237-297, 472-478, ~584-609 | B/C |
| ContextBankView lanes Needs you / Waiting on the agent / Quiet / Done | ContextBankView.tsx:20-92, 611-617 | A/C/B |
| ProjectDecisionsModal "Awaiting your decision" | ProjectDecisionsModal.tsx:280-293 | A |
| CrossProjectCard "Stance recorded. Flag on other projects?" | CrossProjectCard.tsx:49-145 | A (consent) |
| CommandPalette "Approve all N draft artifacts…" (**different counting rule**) | CommandPalette.tsx:49-54, 98-99 | A |
| Toast layer (bottom-right; error/block = role=alert; default 6s, `ttl:0` sticky) | ToastLayer.tsx:201-284; stores/toast.ts:65 | — |
| Hero "Blocked by your taste / team policy" | stores/connection.ts:659-683; ToastLayer.tsx:75-185 | A/B |
| "Added to your Ledger", "Your question was answered", "✓ Sent — Claude will see this…" | stores/connection.ts:623-633, 732-782 | B/C |
| Daemon / stale-tab / snapshot / session-conflict toasts | stores/connection.ts:201-206, ~459, 805-810, 889-894, 940-945, 1040-1090; stores/artifact.ts:148-298; lib/daemon-restart.ts:67-78 | D |
| "{action} failed" (status, request, comment, suggestion, file review, question) | stores/artifact.ts:293-298 (callers 350, 878, 983, 1035, 1278, 1332) | D |
| Composer "Send timed out" / "Send failed"; "Approval… not applied" | MessageInput.tsx:189-201; artifacts/ArtifactStatusActions.tsx:505-509 | D |

### 2.6 Keyboard paths to pending work

`n` next pending draft, wraps (App.tsx:431-438) · `j/k` all artifacts (410-427) · `a` arm approve, `r` revise (440-456) · `q` quick-ask (458-477) · ⌘K palette (362-367; **no "next pending" command**) · review footer ⌘⏎ / Esc (ArtifactStatusActions.tsx:257-269, 336-358, 794-805) · decision options j/k/↑/↓ (DecisionCard.tsx:258-293) · changeset keymap (lib/changesetKeymap.ts:42-48) · help list (KeyboardShortcutHelp.tsx:5-19).

### 2.7 The same fact in many places (duplicate sets)

1. **"N drafts wait for you" — 9 surfaces:** tab title, OS notification, TurnIndicator, PendingBanner, sidebar dots, status chip, review footer, Threads badge, ContextBank. Only the pill↔banner pair is deduped (App.tsx:100-101; lib/pending.ts:132-138). Counting rules differ: palette approve-all counts every non-decision draft (incl. explainer/reasoning); ProjectSwitcher counts other projects; Threads counts all projects.
2. **"Questions waiting on the agent" — 10+ surfaces;** the TurnIndicator ❓ badge and the Comment-threads badge show simultaneously.
3. **"Agent is working" — three idle windows:** 45s (TurnIndicator.tsx:137), 60s (hooks/useAgentRecentlyActive.ts:11), 90s (RequestComposerBanner.tsx:48). The active session dot always pulses regardless.
4. **"Agent exited" — 10+ surfaces** (pill, session dot, wrap card, resume banner, composer, request bridge, plan strip, rail rows, receipts, decision receipt, "Saved…" toast).
5. **Gate blocks — 4 surfaces;** the ⋯ dot keys on *total* blocks (never clears, DiagnosticsMenu.tsx:45), the chip on *unread*.
6. **Hook nag — 2 surfaces, 2 rules** (`exitCode===2` vs `kind==="ask"`; DiagnosticsMenu.tsx:46 vs HookStatus.tsx:51).
7. **One send → three confirmations** (toast, button "Sent ✓", receipt).
8. **Daemon/stale tab — 2 near-identical toasts** (connection.ts:1040 vs artifact.ts:263) and 2 restart paths.
9. **New artifact — 5 signals** (unread dot, glow, pip, sr-only, OS).
10. **Two approve countdowns** with different wording (ArtifactStatusActions.tsx:747 vs ChangesetArtifact.tsx:1479).

### 2.8 Inconsistencies found

- **Explainer (and likely reasoning) drafts** are excluded from pending (lib/pending.ts:35) yet show the amber "● Draft, awaiting review" dot in the sidebar (ArtifactPanel.tsx:942, 973, 1002); the header chip says "New — for you to read"; ExplainerArtifact.tsx:387's comment still calls it a "waiting on you" item.
- **"Waiting on the agent" colour:** violet (TurnIndicator, rail, resume banner) vs blue (ContextBank, Comment-threads badge).
- **Pending order is creation order** (lib/pending.ts `computePending`), not stakes; `n` therefore visits a HIGH-stakes decision no sooner than a low-significance finding.
- **The 10-most-recent sidebar cutoff can hide pending work** (ArtifactPanel.tsx:561, 804-828) — including the only decision (`before-00`).
- Receipt wording differs for plain comments (LineComments.tsx:295 vs CommentThread.tsx:175); AskTrigger uses a flat unanswered filter (CommentThread.tsx:463) instead of the thread-aware rule.

---

## 3. Principles (what must survive the redesign)

1. **One answer to "what's next?"** — in one place, in words, with its reason and its consequence.
2. **Needs-you and waiting-on-agent stay distinct** (recorded rule; ContextBankView.tsx:25-32). A question you asked is never shown as your to-do; an item that blocks the agent is never shown as "FYI".
3. **Honest waiting states.** "Waiting" says who is waiting on whom and what happens next (e.g. "saved — seen when the session resumes"), from **one** activity model.
4. **Nothing pending is hidden, nothing auto-approved, no failure suppressed** (#430 acceptance). Collapsing is allowed only when the collapsed count is shown and reachable in one step.
5. **Anchored comments and keyboard navigation are untouched** — the bar is a *router* to the existing act surfaces (review footer, decision card, changeset keymap), not a new place to approve from.
6. **Colour is never the only cue** — every lane has a word and an icon.

---

## 4. The proposal: the Next-up bar

### 4.1 One attention model, computed once

A pure selector `lib/attention.ts → computeAttention(state)` (no React) returns:

```ts
interface Attention {
  next: AttentionItem | null;          // the single most consequential Decide item
  lanes: {
    decide:  AttentionItem[];          // ranked (§4.3)
    read:    AttentionItem[];          // explainer, reasoning, FYI drafts
    waiting: AttentionItem[];          // unanswered questions, open requests, revised-awaiting-agent
    system:  SystemState | null;       // disconnected / stale / replay / exited / gate block (latest unread)
  };
  agent: "working" | "idle" | "first-move" | "exited";  // ONE idle window (proposal: 60s)
}
interface AttentionItem {
  id: string; title: string; kind: "decision" | "review" | "question" | "request" | "read" | "secret";
  why: string;          // one line: decision context / finding significance+title / "you asked: …"
  after: string;        // one line: what responding does (§4.4)
  stakes?: "high" | "medium" | "low";
  sessionLabel?: string; // only when >1 session is merged
}
```

Every existing counter (tab title, TurnIndicator, PendingBanner, Threads bank
lanes in-session, palette, `n`) reads this selector — fixing the counting drift
in §2.7/§2.8 in one place.

### 4.2 Where it lives

A single row **between the session bar and the content**, replacing the
PendingBanner / ResumeQuestionsBanner rows (net: one row fewer in the common
case, three fewer when the demo CTA/wrap card/request banner collapse per §5).
It is always present when a session is bound (never "pops in" and shifts the
layout), and its left edge is the first thing after the session tabs.

### 4.3 Ordering rule for Decide (needs your approval, §10)

1. Secret warnings (they are about to leave the machine).
2. Open decisions, **high stakes first**.
3. Drafts the agent is *blocked* on (plan awaiting approval before execution; changeset; code_change).
4. Remaining drafts by significance (high finding > medium > low), then oldest first.

`n` / Shift+`n` walk this order; the sidebar never hides an item in Decide
(the 10-most-recent cutoff applies only to non-pending items).

### 4.4 "What happens after you respond" — derived, never invented

| Item | `after` line (examples) |
|---|---|
| decision | "Claude continues with the option you pick" · if agent exited: "Saved — Claude sees your choice when the session resumes" |
| plan draft | "Approve → Claude executes 5 steps · Request changes → Claude revises the plan" |
| changeset | "Your per-file verdicts go back as one review" |
| research / spec | "Claude gets your verdict on its next check (usually < 30s)" |
| secret warning | "Nothing is sent until you resolve this" |
| waiting: question | "You asked 4m ago — Claude answers on its next check" / "agent exited — copy the resume prompt" |

These strings come from existing honest copy (MessageInput latency line,
ResolvedDecisionView receipts, ResumeQuestionsBanner) — the bar reuses them,
it does not add promises.

### 4.5 Low-fidelity mockups (1280–1440 wide)

**A. Urgent decision pending (in a busy multi-session project)**

```
┌ deepPairing  [Threads 1]                                 Decisions  Features  ⌘K  ⚙  ?  ⋯ ┐
├ ▣ Session cache design 3 │ Refresh path walkthrough 1 │ Orders schema migration 13 │ … ┤
├───────────────────────────────────────────────────────────────────────────────────────────┤
│ ▲ DECIDE  Which store backs the session cache?   HIGH STAKES · Session cache design      │
│   Why  Needed before Thursday's rollout; hard to reverse once sessions persist.          │
│   After  Claude continues with the option you pick.            [ Open  ⏎ ]  next n  ⌄   │
│   Decide 15 · Read 2 · Waiting on Claude 0                                               │
├──────────────┬────────────────────────────────────────────────────────────────────────────┤
│ ▲ Which store │  (DecisionCard exactly as today)                                         │
│ ● Session c…  │                                                                           │
│ ● Index str…  │                                                                           │
```

**B. Review queue, nothing high-stakes (long queue, 1280×800)**

```
│ ● REVIEW  Orders table has three nullable FKs that should be NOT NULL     high · 1 of 13 │
│   After  Claude gets your verdict on its next check.     [ Open ⏎ ]  next n   [Queue ⌄] │
```
`[Queue ⌄]` expands an in-place ranked list (the old chip strip, but complete
and ordered) — progressive disclosure instead of "+12 more".

**C. Info only**

```
│ ○ NOTHING NEEDS YOU   2 to read when you like:  How the token refresh path works  ⌄     │
```
Neutral colour, no pulse, no count in the tab title.

**D. Agent working (your move is done)**

```
│ ◌ WAITING ON CLAUDE   Working · 2m — "Adding a parallel-401 test"          Read 1  ⌄   │
```
Blue; the header TurnIndicator shrinks to the agent-state word only.

**E. Agent exited with your questions open**

```
│ ◌ WAITING ON CLAUDE   Claude exited with 2 of your questions unanswered.               │
│   After  They'll be answered when the session resumes.        [ Copy resume prompt ]    │
```

**F. An action was blocked by your stance**

```
│ ■ HELD BY YOUR STANCE  "global mutable state for config" stopped: Add a ConfigStore …  │
│   Nothing to do unless you want to retire the stance.   [ Why ]  [ Retire… ]  [ ✕ ]    │
```
The hero toast still fires (it is the product's proof moment); the bar keeps a
non-expiring, dismissible record so the block is not lost when the 12s toast ends.

**G. Disconnected / stale**

```
│ ⚠ DISCONNECTED  Reconnecting… your queue below is the last known state.  [ doctor --fix ] │
```
Decide items stay listed (never blanked); act buttons disable with a reason.

(Simple SVG versions can follow in PR 2 with the prototype; ASCII keeps this review cheap.)

### 4.6 Several sessions / agents

The bar ranks across **all merged sessions** (today's sidebar already merges
them) and names the session on the item (`· Session cache design`). The
`Agents:` row becomes a filter menu in the sidebar header (it filters, it does
not signal). Cross-project attention stays in **Threads** (unchanged), which is
already the model this bar mirrors in-session.

---

## 5. Signal disposition

| Signal (§2) | Disposition | Why |
|---|---|---|
| PendingBanner (+chips, "+N more") | **Absorbed** into bar (Decide next + `[Queue ⌄]`) | same fact, better ranked, complete |
| ResumeQuestionsBanner | **Absorbed** (state E) | same fact |
| TurnIndicator "Your turn — …" | **Absorbed**; TurnIndicator keeps agent state only (working / idle / exited / narration) | removes the 3rd copy of the count |
| TurnIndicator ❓ + Comment-threads count | **Merge** into one blue count on the Comment-threads button; bar shows Waiting lane | duplicate |
| Tab title badge, OS notification | **Keep** (secondary, off-screen channels); read `attention.lanes.decide.length` | you're not looking at the page |
| Sidebar status glyphs | **Keep, re-coded by lane**: ▲ decision, ● review, ○ read (neutral), ◌ waiting (blue) | fixes explainer/reasoning amber |
| "Show N older" | **Keep** for non-pending only | never hide Decide |
| Status chip, review footer, DecisionCard, changeset/research/debrief triage | **Keep unchanged** — the act surfaces the bar routes to | anchored comments + keyboard preserved |
| RequestComposerBanner row | **Secondary**: collapse to an "Ask" button in the header; request pips move to the Waiting lane | initiation ≠ attention |
| Demo CTA, SessionWrapCard | **Secondary**: render inside the bar's quiet state (C), dismissible | they are FYI, not rows of chrome |
| SkillLoadBanner, DisconnectBanner, ReplayScrubber | **Keep** as System state (bar shows state; replay keeps its scrubber) | failures must not be hidden |
| ClarityChip, PreflightBreadcrumb, ConceptBadge, CompoundingBadge, HookStatus, PreflightBlockLog | **Keep secondary** (unchanged location) | provenance / diagnostics |
| ⋯ DiagnosticsMenu dot | **Fix**: key on unread blocks + both nag kinds | never clears today |
| Active session dot always pulsing | **Remove pulse**; pulse only when `agent === "working"` | false activity |
| Toasts | **Keep** for failures, hero block, "answered"; drop the `feedback_received` "Sent" toast when the composer already shows "Sent ✓" and a receipt | triple confirmation |
| Duplicate stale-daemon toasts, two countdowns | **Unify** (one helper each) | drift |
| Palette | **Add** "Next pending" and "Open review queue" commands | keyboard parity |

---

## 6. Flows: current vs proposed

**One session, one high-stakes decision among findings**
- *Now:* land on a finding (default selection) → read banner "15 items" → scan chips (decision is chip 2 of 3, truncated) or expand "Show 6 older" → open decision → context → choose. The consequence of choosing is only visible after choosing (receipt).
- *Proposed:* land → bar reads "▲ DECIDE Which store… HIGH STAKES · Why … · After …" → ⏎ opens the DecisionCard → choose. One read, one keystroke.

**Several sessions / agents**
- *Now:* per-session tabs with counts + merged sidebar + `Agents:` row + banner total; which session owns the next blocker is inferred.
- *Proposed:* the bar names the session of the top item; `Decide 15 · Read 2 · Waiting 0` totals are project-wide; Threads remains the cross-project view.

**Long review queue (13+)**
- *Now:* 3 chips + "+12 more", identical dots, `n` in creation order, older items collapse.
- *Proposed:* `[Queue ⌄]` shows the complete ranked list in place; `n`/Shift+`n` follow the same ranking; position "1 of 13" is always visible; nothing collapses out of Decide.

---

## 7. Accessibility

- Bar is `<section role="region" aria-label="Next up">`, placed first in the tab order after the session nav, with a skip link "Jump to next up" (the first focusable element in the page).
- Lane changes announce through **one** polite live region ("Next up: decision — Which store backs the session cache?"); never `assertive` (alerts stay reserved for failures, as today).
- Every state has a text label (DECIDE / REVIEW / NOTHING NEEDS YOU / WAITING ON CLAUDE / HELD / DISCONNECTED) and an icon; colour is redundant. Waiting-on-agent is one colour everywhere (blue, matching ContextBank).
- No pulsing in the bar; `prefers-reduced-motion` already honoured elsewhere stays honoured.
- Long titles truncate visually with the full title in the accessible name and a tooltip; "Why"/"After" wrap to two lines max at 1280 wide.
- Keyboard: ⏎ open next, `n`/Shift+`n` next/previous in rank order, `⌄` toggles the queue (arrow keys inside, Esc closes and returns focus), existing `a`/`r`/`q`/`j`/`k` unchanged.
- Existing gates stay: `e2e/a11y.e2e.ts` axe scans (dark + light) extend to every bar state; the bar is added to the keyboard-only walkthrough.

---

## 8. Migration plan (small PRs, each independently reviewable)

1. **`computeAttention` selector + parity tests (no visible change).** One module feeding today's counters; fixes the counting drift (explainer/reasoning, one idle window, thread-aware unanswered rule) behind tests that pin current behaviour where it was right.
2. **Next-up bar prototype behind a setting (default OFF).** Renders states A–G from the selector; a11y + keyboard; before/after screenshots at 1280×800 and 1920×1080; SVG mockups replace ASCII.
3. **Absorb PendingBanner + ResumeQuestionsBanner + TurnIndicator "your turn" when the setting is ON;** merge the two question badges; palette commands.
4. **Sidebar lane glyphs + never-hide-Decide** (Show-older applies to non-pending only); explainer/reasoning go neutral.
5. **Collapse secondary rows** (request banner → header button + Waiting lane; demo CTA/wrap card into quiet state; `Agents:` row → sidebar filter menu); fix the ⋯ dot, session-dot pulse, duplicate toasts/countdowns.
6. **Pilot + flip the default** after task-based walkthroughs (§9) with independent review; then delete the old banner components.

Each PR: focused tests, full `web/src` suite, typecheck, lint, `pnpm build:clean` bundle, and independent sign-off (per #430).

---

## 9. Validation plan (before calling anything validated)

Task-based walkthroughs, before vs after, recorded at 1280×800 and 1920×1080, keyboard-only and with a screen reader:
1. "What does Claude need from you right now, and what happens when you answer?" (target: answer from the bar alone, no panel opened.)
2. "Which session is blocked on you?" (3 sessions, 1 blocker.)
3. "Clear a 13-item queue, highest stakes first." (count keystrokes / panels opened.)
4. "Claude exited — is anything still owed to you?" (Waiting lane honesty.)
5. Edge states: empty, disconnected, replay, long titles, a blocked action.

Findings from the external pilot feed back into #430; screenshots alone do not validate.

---

## 10. Decisions requested from you

1. **Lane model** — Decide / Read / Waiting on the agent / System: approve, or adjust names/colours?
2. **Placement** — a persistent bar under the session tabs (proposed) vs. inside the header vs. top of the detail pane?
3. **Ordering rule** (§4.3) — stakes-first as proposed, or plain oldest-first?
4. **Held-by-stance record** (state F) — keep it in the bar after the toast, or leave blocks only in the ⋯ log?
5. **Start** — begin with PR 1 (selector, no visible change) as proposed?

No UI code is changed by this document.
