/**
 * #430 PR 1b (docs/design/attention-hierarchy.md §2.7 item 3, §8 PR 1b) — the ONE
 * "is the agent working right now?" window, shared by the header pill
 * (TurnIndicator) and every useAgentRecentlyActive surface (the composer's
 * latency promise, the drafting beat, the closing-beat gate). They used 45s and
 * 60s and disagreed for 15s after each check-in.
 *
 * 60s: a working agent checks in about every 30s (#204), so 60s is two missed
 * check-ins — one late poll no longer flips the pill to "Up to date" while the
 * agent is mid-run (45s was 1.5 cycles). It also matches the connection store's
 * 60s working-streak continuity (stores/connection.ts, agentActiveSince), so the
 * "Agent working · Nm" elapsed label and the pill agree on what "still working"
 * means.
 *
 * NOT this window: RequestComposerBanner's 90s IDLE_WINDOW_MS. That is #204's
 * deliberate hysteresis for the resume bridge (~3 poll cycles, and never-seen ⇒
 * not idle) and stays separate — collapsing it here would bring the premature
 * resume nag back.
 */
export const AGENT_ACTIVE_WINDOW_MS = 60_000;
