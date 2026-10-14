# Ordinary PR CI attention smoke (#531)

The normal `test:e2e` command selects **three** Next-up tests:

| Case | Checks |
| --- | --- |
| Dark | Actual applied theme, expanded full-page WCAG 2/2.1 A/AA axe, keyboard queue Up/Down without selection, recovery when the focused queue row is removed, keyboard Why → Enter → immediate Escape with no intervening Tab or scripted focus |
| Light | The same integration journey in the actual light theme |
| Failure control | A deliberately failing real Chromium subprocess must exit 1; its own daemon sandbox must disappear and its actual TCP port must refuse connections; diagnostics redact a browser-console authentication sentinel; no trace/video archive exists |

Local candidate runs passed 3/3 in **15.1 and 19.6 seconds** on WSL ext4,
Node 22.23.2 and pnpm 10.33.0, based on main
`a4f3844501a9d73c652cf5dc070b1663cbe2dbdb`. This is a measured sample, not a
CI duration guarantee. Tests have 60-second bounds; the fault subprocess has a
40-second Playwright bound inside a 50-second parent bound. The existing normal
E2E job remains capped at 25 minutes and the selection step at two minutes.
Each successful themed test prints a bounded runtime/checkout/web-digest
summary in the job log. Exact final-head measurements belong on the PR.

From an installed checkout, build first and install Chromium:

```sh
pnpm install --frozen-lockfile
pnpm build:clean
pnpm --filter @deeppairing/mcp-server exec playwright install chromium
pnpm --filter @deeppairing/mcp-server test:e2e:attention-selection
pnpm --filter @deeppairing/mcp-server exec playwright test attention-ci-smoke.e2e.ts
```

CI runs the selection guard before the actual **ordinary** `test:e2e` command.
The guard invokes that package script's real `--list --reporter=json` route,
including any selectors in the script; it rejects missing/duplicate/skipped
cases, missing risk tags, expected failures, extra projects, listing errors and
an accidentally included `.walkthrough.ts`. It never enables
`--pass-with-no-tests` or echoes raw child output. Focused negative fixtures
exercise those selection and workflow-policy failure conditions.

Every themed case uses a fresh synthetic HOME/project, real owned daemon and
isolated browser context. The existing noncanonical port policy and daemon
exit/TCP-refusal cleanup barriers are reused. Normal output is now
`test-results/e2e`, a sibling of `test-results/attention-walkthroughs`; ordinary
startup therefore cannot clear the opt-in walkthrough's directory. Different
concurrent invocations of the *same* suite must still use distinct `--output`
directories.

Passing smoke cases publish no artifacts. The smoke disables raw trace/video
recording and keeps automatic failure screenshots only. Failure diagnostics
contain bounded redacted text and runtime hashes, never HTML, browser storage,
network headers or raw WebSocket traffic. CI upload allowlists only
`test-failed-*.png` and `*diagnostics*.txt`. #531 discovered that the previous
workflow also uploaded unredacted Playwright `error-context.md`; that glob is
removed. Such framework context remains available locally, outside CI uploads.
The fault guard removes its own output only after confirming the resource
barriers; unconfirmed failures retain evidence and fail the parent test.

The larger 71-test attention walkthrough stays opt-in. High-only queues,
long titles, all A–G/empty/replay states, widths beyond this 1280×800 smoke,
extended disconnect, real screen readers and human usability/pilot evidence
remain outside this CI subset. No UI default or approval policy changes, and
no parent #430 acceptance claim, are made by this infrastructure change.
