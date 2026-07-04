/**
 * Issue candidate 3 — a directly-connected low-level Server
 * (server.connect(transport), the v1-style pattern every migration starts
 * from) never answers server/discover, so a versionNegotiation mode:'auto'
 * client silently falls back to the legacy era with zero signal.
 *
 * Run: npx tsx scratch-issues/issue3-direct-connect-legacy-fallback.ts
 */
import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

function makeServer() {
  const server = new Server(
    { name: "repro-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler("tools/list", async () => ({ tools: [] }));
  return server;
}

async function probe(label: string, wire: (server: Server, t: any) => Promise<void> | void) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  // Spy on raw wire traffic so we can see what (if anything) answers
  // server/discover.
  const rawInbound: any[] = [];
  const origOnMessage = Object.getOwnPropertyDescriptor(clientTransport, "onmessage");
  await wire(makeServer(), serverTransport);

  const client = new Client(
    { name: "repro-client", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  await client.connect(clientTransport);
  console.log(`[${label}]`);
  console.log("  negotiated protocol version:", client.getNegotiatedProtocolVersion());
  console.log("  getDiscoverResult():", client.getDiscoverResult() === undefined ? "undefined (LEGACY fallback)" : "defined (modern)");
  await client.close();
  void rawInbound; void origOnMessage;
}

// Pattern A: the v1-style direct connect — what every migrating v1 codebase does first.
await probe("A: server.connect(transport) direct", async (server, t) => {
  await server.connect(t);
});

// Pattern B: the serving entry, same factory.
await probe("B: serveStdio(() => server, { transport })", (server, t) => {
  serveStdio(() => server, { transport: t });
});
