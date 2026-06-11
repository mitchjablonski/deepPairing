#!/usr/bin/env node
/* eslint-disable */
// VI1 — placeholder reservation. The real deepPairing project lives at
// https://github.com/mitchjablonski/deepPairing. This file exists to deny
// a typosquatter the chance to publish first under this name.
process.stderr.write(
  "\n  deepPairing is pre-1.0 and not yet shipping via npm.\n" +
  "  Install from source: https://github.com/mitchjablonski/deepPairing\n\n" +
  "  Quick path (no Claude Code needed for the demo):\n" +
  "    git clone https://github.com/mitchjablonski/deepPairing.git\n" +
  "    cd deepPairing && pnpm install && pnpm build\n" +
  "    node packages/mcp-server/dist/cli/init.js demo\n\n",
);
process.exit(1);
