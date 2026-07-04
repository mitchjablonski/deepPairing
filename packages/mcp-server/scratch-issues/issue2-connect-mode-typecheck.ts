/**
 * Issue candidate 2 — does client.connect(transport, { mode: "auto" })
 * TYPECHECK (claim: ConnectOptions is open enough that the bogus `mode`
 * key passes), and is it silently ignored at runtime?
 *
 * Typecheck: npx tsc --noEmit --strict scratch-issues/issue2-connect-mode-typecheck.ts
 * Runtime:   npx tsx scratch-issues/issue2-connect-mode-typecheck.ts
 */
import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = new Server(
  { name: "repro-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler("tools/list", async () => ({ tools: [] }));
serveStdio(() => server, { transport: serverTransport });

const client = new Client({ name: "repro-client", version: "1.0.0" });

// THE CLAIM UNDER TEST: this line typechecks even though `mode` is not a
// ConnectOptions member (version negotiation is a constructor-only option).
await client.connect(clientTransport, { mode: "auto" });

console.log("connect resolved");
console.log("negotiated protocol version:", client.getNegotiatedProtocolVersion());
console.log("discover result:", client.getDiscoverResult());
await client.close();
