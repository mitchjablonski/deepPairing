/**
 * Issue candidate 1 — Server.notification() silently drops
 * notifications/resources/list_changed on a 2026-07-28 (modern-era) connection.
 *
 * Standalone: only @modelcontextprotocol/server + /client @ 2.0.0-beta.2.
 * Run: npx tsx scratch-issues/issue1-notification-drop.ts
 */
import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

function makeServer() {
  const server = new Server(
    { name: "repro-server", version: "1.0.0" },
    { capabilities: { tools: {}, resources: { listChanged: true } } },
  );
  server.setRequestHandler("tools/list", async () => ({
    tools: [
      {
        name: "touch_resource",
        description: "mutates a resource then notifies",
        inputSchema: { type: "object" as const, properties: {} },
      },
    ],
  }));
  server.setRequestHandler("tools/call", async () => {
    // The claim under test: this promise RESOLVES on a modern-era
    // connection, but the client never receives the notification.
    await server.notification({ method: "notifications/resources/list_changed" });
    console.log("[server] server.notification() resolved without error");
    return { content: [{ type: "text" as const, text: "ok" }] };
  });
  return server;
}

async function scenario(label: string, clientOpts: ConstructorParameters<typeof Client>[1]) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = makeServer();
  serveStdio(() => server, { transport: serverTransport });

  let received = 0;
  const client = new Client({ name: "repro-client", version: "1.0.0" }, clientOpts);
  client.fallbackNotificationHandler = async (n: { method: string }) => {
    if (n.method === "notifications/resources/list_changed") received++;
  };
  await client.connect(clientTransport);
  console.log(`[${label}] negotiated protocol version:`, client.getNegotiatedProtocolVersion());

  await client.callTool({ name: "touch_resource", arguments: {} });
  await new Promise((r) => setTimeout(r, 100)); // drain microtasks/timers
  console.log(`[${label}] fallbackNotificationHandler saw list_changed:`, received, "time(s)");
  await client.close();
  return received;
}

async function scenarioWithListChanged() {
  // Control: the documented modern-era path — ClientOptions.listChanged
  // auto-opens a subscriptions/listen. Does the notification arrive then?
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = makeServer();
  serveStdio(() => server, { transport: serverTransport });

  let viaListChanged = 0;
  const client = new Client(
    { name: "repro-client", version: "1.0.0" },
    {
      versionNegotiation: { mode: { pin: "2026-07-28" } },
      listChanged: {
        resources: { onChanged: () => { viaListChanged++; }, debounceMs: 0, autoRefresh: false },
      },
    } as any,
  );
  await client.connect(clientTransport);
  await client.callTool({ name: "touch_resource", arguments: {} });
  await new Promise((r) => setTimeout(r, 500));
  console.log("[pinned+listChanged] listChanged.resources callback fired:", viaListChanged, "time(s)");
  await client.close();
  return viaListChanged;
}

const legacy = await scenario("legacy default", undefined);
const modern = await scenario("pinned 2026-07-28", {
  versionNegotiation: { mode: { pin: "2026-07-28" } },
});
const control = await scenarioWithListChanged();

console.log("\n--- summary ---");
console.log("legacy connection delivered unsolicited list_changed:", legacy > 0);
console.log("modern (pinned 2026-07-28) delivered unsolicited list_changed:", modern > 0);
console.log("modern + ClientOptions.listChanged (subscriptions/listen) delivered:", control > 0);
