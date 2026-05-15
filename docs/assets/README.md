# README assets

The README references two visual assets that need to be supplied
before launch (or replaced with placeholder text). These are blocking
for the GitHub social-preview / HN/Reddit posting moment — without
them, "show me" instinct is unsatisfied and discovery suffers.

## Required (for launch)

### `hero.png` — the rejection-block toast firing

Capture the moment when the agent paraphrases a previously-rejected
stance and deepPairing's preflight intercepts. Recommended setup:

1. Run `node packages/mcp-server/dist/cli/init.js demo`.
2. Trigger one rejection through the UI (mark a finding rejected with
   a reason like "we tried global state for config last project").
3. Ask the agent to revisit the same area — it will paraphrase.
4. Screenshot the moment when the `🛡 Blocked` toast appears, with
   the considered-stance pill visible in the breadcrumb.

Target: ~1200×700, PNG, ≤300 KB.

### `ledger.png` — the Your Taste drawer / Ledger view

Open the YourTasteDrawer (header button "Your taste") and switch to
the Ledger tab. The screenshot should show:
- The headline stat tiles (proposals shaped here, cross-project stances)
- 1-2 "Seeded by you" entries with [SEED] badges
- 3-5 "Top cited stances" entries with citation counts
- The ledger digest framing visible at the top

Target: ~900×800, PNG, ≤300 KB.

## Optional (improves landing)

### `demo.gif` — 20-second screen recording

The full loop: agent proposes → human comments → agent revises →
ledger updates. Compressed GIF, ≤2 MB. Embed below the hero PNG
once produced.

## Why these matter

The pre-launch readiness review flagged the absence of any visual
assets as the #1 GitHub-discovery gap. The companion UI IS the value
prop; a README with no screenshot can't sell a UI tool.
