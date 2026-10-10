# Synthetic attention walkthrough harness (#430)

From a clean checkout with Node 22 and the repository's pinned pnpm:

```sh
pnpm install --frozen-lockfile
pnpm build:clean
pnpm --filter @deeppairing/mcp-server exec playwright install chromium
pnpm --filter @deeppairing/mcp-server exec playwright test --config playwright.attention.config.ts
```

For a bounded smoke row add `--grep 'S1 ON 1280x800'`. The separate
`*.walkthrough.ts` configuration does not alter the ordinary e2e job. It uses
the existing validated port policy (noncanonical default, explicit valid
overrides honored), one worker, no retries, dark Chromium, reduced motion and
no raw trace/video/automatic screenshot archives.

The explicit manifest has 12 variants × OFF/ON × two viewports = **48 rows**:
S1–S3; S4 already-exited landing and exit while open; S5 empty/live arrivals,
disconnected, historical replay, long titles, idle hold, hold with pending
decision, and empty-bound sibling blocker. This count is derived from the
actual matrix, not asserted to reproduce the old report's 44 runs. Each JSON
includes the complete manifest, exact checkout SHA/runtime/browser, seed-input
digest, actual keyboard presses/focus stops, assertions, bounded ARIA and live
DOM text, relative screenshot paths, cleanup outcome and explicit limits.
Two additional infrastructure fault tests prove a simulated full/unwritable
diagnostic output cannot prevent real owned-daemon cleanup or hide its original
setup error, and evidence publication cannot mask a primary row failure or
silently pass without published evidence; neither is a walkthrough matrix row.

JSON records tracked-worktree dirtiness and its diff digest, exact harness and
lockfile digests, and the actual built daemon entry/module tree, served web tree
and shared-runtime fingerprints at each startup and after the row. HEAD alone
does not establish that a developer's dist is fresh. The cold-build precondition
is not inferred by the runner; compare the recorded built-runtime fingerprints
with the tested cold-built checkout. Runtime changes during a row are explicit.

Output is under `packages/mcp-server/test-results/attention-walkthroughs/`;
keep it untracked. Every row owns a mkdtemp HOME/project and an isolated browser
context; Chromium's temporary profile is managed by Playwright. Only the
owned daemon handle is signaled. Its process exit and TCP refusal must be
confirmed before deleting the owned sandbox; a failed barrier retains it.
Shared diagnostic helpers provide bounded redacted failure logs. Never export
browser storage, served HTML, bearer tokens, WebSocket/network payloads or raw
traces. Screenshots and recorded text contain synthetic data only.

Journeys use real keyboard Tab/Enter/shortcuts, never scripted focus or clicks.
Tab-search automation is not an optimal human route or a replication of the
historical report's counts. Internal API seeding is not a live agent; it affects
activity signals. ARIA/live text is a bounded potential-announcement proxy,
not NVDA/JAWS/VoiceOver speech. The harness makes no usability verdict, measures
no people or trust, does not replace the external pilot, does not change the
rollout default and does not close #430. The long-disconnect escalation,
alternate themes/zoom/high-contrast/mobile/webview and real screen readers are
not measured. See `docs/design/attention-walkthroughs.md` for historical evidence.
