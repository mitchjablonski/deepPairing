---
name: deeppairing
description: Use at the start of any coding task in a project that uses deepPairing, before you make a real design decision or hand your human something to review. Runs the deepPairing CLI guide, which explains how to present options and HTML pages for review in the browser companion, read your human's decision, and respect their past rejections.
---

# deepPairing

Run this at the start of the task and follow what it prints:

```bash
npx -y -p @deeppairing/mcp-server deeppairing guide
```

From a deepPairing source checkout, run `node <checkout>/packages/mcp-server/dist/cli/init.js guide` instead.

The guide is the protocol. It ships with the CLI you are driving, so don't work from memory or from this file.
