# Fixing the `deeppairing` npm placeholder — USER ACTION REQUIRED

> **This is a manual step only you (the npm package owner) can do.** It cannot be
> automated from CI or this repo — it needs your npm credentials. Nothing in the
> build depends on it; it exists purely to stop `npx deeppairing` from being a
> hostile dead end for anyone who tries it.

## The problem

deepPairing is **not** published to npm as a real package yet — the codebase
installs via the Claude Code marketplace (or from a source clone), never
`npx deeppairing`. But the name `deeppairing` *is* claimed on npm by a
placeholder version (`0.0.x`) that currently **exits 1 and prints a wrong repo
URL**. So a user who guesses `npx deeppairing …` (an easy guess) gets an error
and a link that goes nowhere — the worst possible first impression.

This repo's own suggestions were all rewritten off `npx deeppairing` (issue
#170); the grep guard `packages/mcp-server/src/cli/__tests__/no-npx-deeppairing.test.ts`
keeps them from coming back. This doc closes the *other* half: making the
squatted npm name itself point people the right way.

## The fix — republish the placeholder as a friendly redirect

Publish a new `0.0.x` version whose `bin` just tells the user where to actually
go, and whose `repository` field is correct.

1. In a scratch directory, create `package.json`:

   ```json
   {
     "name": "deeppairing",
     "version": "0.0.4",
     "description": "deepPairing installs via the Claude Code marketplace, not npm. See the repo.",
     "bin": { "deeppairing": "./redirect.js" },
     "repository": {
       "type": "git",
       "url": "git+https://github.com/mitchjablonski/deepPairing.git"
     },
     "homepage": "https://github.com/mitchjablonski/deepPairing#readme",
     "license": "MIT"
   }
   ```

   > Bump `version` to the next unused `0.0.x` (npm forbids republishing an
   > existing version). Check the current one first with `npm view deeppairing version`.

2. Create `redirect.js` — a clean message, exit 0 (a successful, informative
   run reads better than an error):

   ```js
   #!/usr/bin/env node
   console.log(`
   deepPairing isn't installed from npm — it runs inside Claude Code.

   Install it via the Claude Code marketplace:
     /plugin marketplace add https://github.com/mitchjablonski/deepPairing
     /plugin install deeppairing@deeppairing

   Or from a source clone — see:
     https://github.com/mitchjablonski/deepPairing#install-in-claude-code
   `);
   ```

3. Publish:

   ```bash
   npm login                 # the account that owns the `deeppairing` name
   npm publish               # from the scratch dir with the two files above
   ```

4. Verify:

   ```bash
   npx -y deeppairing@latest   # should print the redirect message and exit 0
   npm view deeppairing repository.url   # should show the mitchjablonski repo
   ```

## When this stops being a placeholder

If deepPairing is ever published to npm for real, delete this doc and replace the
redirect with the actual package — and the `npx deeppairing …` invocations can
come back (drop the grep guard at that point).
