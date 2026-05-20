# npm-reserve — typosquat reservation packages

Pre-launch security checklist item flagged by the security council
across multiple passes: once the deepPairing name surfaces on Show HN
or in a Twitter feed, a squatter can publish a malicious package
under a near-name within hours. A developer who types `npx deeppair`
(typo) or `npm install deep-pairing` (guess) lands shell code on
their machine.

This directory holds four placeholder packages that **you** publish
to npm before the launch post goes live. Each one resolves to a
loud-fail script that points at the real repo. A future hostile
publish of the same name then collides with yours and gets refused.

## What's reserved

| Name | Reason |
| :--- | :--- |
| `deeppairing` | The obvious npm name. Eventually the real package will live here. |
| `deep-pairing` | Hyphenated variant — common typo / guess. |
| `deeppair` | Truncation; common shell habit. |
| `deeppairing-cli` | "Help me, surely the CLI is its own package?" guess. |

## Publish recipe (10 minutes, day-of-launch)

```bash
# Must be done by someone with npm publish rights on these names.
# Anyone can publish the FIRST time — the squat-defense is just to
# get there first.

cd tools/npm-reserve
for dir in deeppairing deep-pairing deeppair deeppairing-cli; do
  (cd "$dir" && npm publish --access public)
done
```

If you don't already have an npm account: `npm adduser` first.

If `npm publish` returns 403 "name already taken" — that's the
launch-blocker the council was warning about. Pick a longer
namespace (e.g. `@deeppairing/cli`) and update the README install
instructions accordingly. **Do this before posting.**

## When the real deepPairing package ships (v1.0)

Replace `deeppairing/package.json` with the real package contents and
`npm publish` over the placeholder. The other three names stay as
loud-fail redirects forever — they exist to deny the typosquat
surface, not to be useful packages.
