# FAQ

The questions we expect, answered honestly. Open an issue if yours
isn't here.

---

## "Isn't this just grep over a JSON file of your past `no`s?"

Partially yes, and that's the point. The mechanic is intentionally
simple: every `present_*` MCP tool call gets matched against a JSON
ledger of stances you've rejected, using concept-token + scope-glob
rules from [`runPreflight`](packages/mcp-server/src/mcp/preflight-validator.ts).
What makes it work isn't ML magic; it's that the match happens
**before** the artifact is created and the tool returns an error the
agent has to react to. Cursor's canvases let the agent ship the
artifact and ask the human to reject again. Claude Code's auto-memory
hopes the model consults the right context. deepPairing makes the
rejection a hard gate: the `present_*` tool refuses
(`REJECTED_APPROACH_BLOCKED`), and a PreToolUse hook catches a *direct*
edit that tries to skip the protocol and surfaces it for your decision.

The "ledger is a JSON file" critique is the same critique you could
level at git ("a tree of text diffs"), `package.json` ("a JSON
manifest"), or `.gitignore` ("a list of strings"). Simple substrates
that gate the right action at the right time are how this stuff
actually works.

## "What about false positives?"

Real concern, and we don't pretend they don't happen. Concept-match
is fuzzy by design (it has to be, to catch paraphrases). Two
mitigations:

1. **Every block is one-click overridable** from the companion UI.
   Override → the agent gets a "user has explicitly allowed this in
   this case" signal and proceeds.
2. **The override updates the ledger.** Next time the same concept-
   match would fire on similar wording, deepPairing knows you've
   carved an exception and doesn't trip again.

The first week of using deepPairing on a real project is mostly
calibrating the ledger via overrides. After that the block rate
drops to ~once or twice a day on a serious refactor — which is
roughly the rate at which you'd actually want to think about whether
you're paraphrasing past yourself.

## "Why MCP and not a Cursor / Continue / editor extension?"

Two reasons:

1. **MCP is the right protocol layer for this.** The pre-flight gate
   needs to be a return value the agent reads and reacts to. MCP
   tools return structured results to the LLM; editor extensions
   sit in the UI layer and can't refuse the agent's choice. We
   experimented with the editor-plugin shape and it kept collapsing
   into "show the user a diff and hope they say no" — which is what
   Cursor canvases already do.
2. **MCP is portable.** deepPairing runs inside Claude Code today,
   inside a (future) VSCode MCP host tomorrow, inside whatever
   Cursor's MCP support looks like the day after. The ledger and
   the gate don't care which client is on the other end.

A companion web UI ships alongside because the artifact-review
surface (commenting on findings, voting on options, reviewing diffs)
doesn't fit in a terminal. The terminal stays the primary chat
surface; the web UI is read + steer.

## "How is the Philosophy Ledger different from Claude Code's auto-memory?"

Auto-memory is a **recall** the model is encouraged to consult.
Philosophy Ledger is a **gate** the model has to pass through. Same
underlying data shape (stored decisions), different semantics:

- Auto-memory: model sees "you previously rejected Railway" → might
  factor it in → might not. No commitment.
- Philosophy Ledger: agent tries to propose Railway → `runPreflight`
  matches → tool returns `REJECTED_APPROACH_BLOCKED` → artifact is
  never created. The agent has to revise or escalate; it cannot
  silently proceed.

Both surfaces have a place; deepPairing's bet is that for
architectural taste decisions you've already made, gating beats
recall.

## "Why per-project opt-in for cross-project publish? Doesn't that dilute the moat?"

The opt-in is for **publish** (writes) only. Reads from the global
ledger are always on — every project benefits from your accumulated
cross-project taste on day one.

The opt-in defends against a single attack class: a malicious
dependency in one project seeding avoid-stances ("validate untrusted
input", "use parameterized queries") that every other project then
cites in preflight. Without opt-in, the project where the malicious
dep lives could poison the global ledger for every other project on
your machine. Default off, one prompt at `init`, flip later via
`deeppairing philosophy publish on`.

The narrative trade-off: the moat is real, but it's now an opt-in
moat. We think honesty about the trust model beats a frictionless
poisoning surface.

## "Does it phone home? What's stored where?"

Nothing leaves your machine that you didn't already send to Anthropic.

- **No telemetry.** No analytics endpoints; no usage tracking.
- **No account.** No login; no server we run.
- **Local-only daemon.** Binds explicitly to `127.0.0.1` on its
  per-project port (in `3847-3974`); sibling devices on the same wifi
  can't reach it.
- **Storage on your disk only.** Sessions at
  `.deeppairing/sessions/{id}/`; cross-project ledger at
  `~/.deeppairing/philosophy/v1.json`. Plain JSON; inspect with
  `cat` or `jq`.

The only network egress deepPairing performs is what your MCP client
(Claude Code) does anyway — sending tool results to Anthropic's API.
See [SECURITY.md](SECURITY.md) for the threat model in full.

## "What's the install size? Cold-clone time?"

- Repo: ~12 MB unpacked; built dist is ~12 MB (most of which is the
  bundled Shiki language grammars for syntax highlighting in the
  companion UI).
- Cold `pnpm install`: 60-90s on a normal laptop (Turborepo + a few
  hundred deps).
- Build: ~10s for the monorepo, ~7s for the companion UI alone.
- Demo: ~5s end-to-end once built.

We've measured these numbers on a recent MacBook Pro and a Linux
desktop. Slower hardware (or first-time `pnpm setup`) adds maybe
30s. If your numbers are dramatically worse, that's worth an issue.

## "Is it stable enough for daily use?"

Pre-1.0 honest answer: it works for the team that built it on real
projects, but it's not battle-tested. ~1,300 tests, an explicit threat
model in SECURITY.md, atomic writes on the data plane, structured
error codes — the foundations are solid. The next ~weeks are about
real-user signals telling us where the false-positive rate, the
companion-UI ergonomics, and the agent-protocol seams are
under-baked.

If you try it, the most useful feedback is "the rejection-block
fired on something it shouldn't have" — that's the signal that
shapes the next milestone.

## "Where's the roadmap?"

Open in [Discussions](https://github.com/mitchjablonski/deepPairing/discussions)
once we have ~10 active users. Pre-launch we're deliberately not
publishing one; council reviews kept landing "wait for real-user
signals before prioritizing the next bundle." The deferred items
from the launch reviews — opaque cursor refactor, second prompt,
secret-shape redaction (not just warning), three-process daemon
collapse — are in the issue tracker tagged `post-launch`.

## "Does it work with [Cursor / Cline / Continue / etc.]?"

The MCP server itself is host-agnostic and should work with any MCP
client. We test against Claude Code because that's the primary
target and the only client with rich enough elicitation +
notifications support today. Reports of it working (or breaking) in
other clients are welcome.

The companion web UI is independent of the MCP host — once any MCP
client registers a session with the daemon, the UI renders the
artifacts and broadcasts events normally.

## "I want to contribute. Where do I start?"

[CONTRIBUTING.md](CONTRIBUTING.md). TL;DR: `good-first-issue` label
on the issue tracker; design discussions in Discussions before
large refactors; fakes over mocks for tests; one concept per commit.
