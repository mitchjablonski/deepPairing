import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";
import { createMcpServer } from "../server.js";
import { buildFirstCallHint } from "../first-call-hint.js";

let fx: GlobalStoreFixture;
let store: FileStore;
const clients: Client[] = [];
beforeEach(() => {
  fx = withGlobalStore("dp-team-hint-624-");
  store = fx.track(new FileStore(fx.dir, "team_hint"));
});
afterEach(async () => { for (const client of clients.splice(0)) await client.close(); fx.dispose(); });
const file = () => path.join(fx.dir, ".deeppairing", "team.json");
const warning = "Team rules could not be loaded";

async function connect() {
  const { server } = createMcpServer(store, () => {}, 4000, { projectRoot: fx.dir });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "team-warning-test", version: "1" });
  clients.push(client);
  await client.connect(ct);
  return client;
}
function text(result: { content?: unknown }) {
  return (result.content as Array<{ type: string; text?: string }>).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
}
const recall = (client: Client) => client.callTool({ name: "recall", arguments: { mode: "project", query: "" } });

describe("#624 — existing first-call guidance carries the local load snapshot", () => {
  it("warns once on first success, survives a failed opener, and never includes file text or absolute path", async () => {
    const client = await connect();
    // Added after construction/connection: this must be a fresh local read,
    // not the FileStore's cached empty team preferences or a hook-state event.
    fs.writeFileSync(file(), "{ DO_NOT_ECHO_TEAM_CONTENT");
    const failed = await client.callTool({ name: "recall", arguments: { mode: "any" } });
    expect(failed.isError).toBe(true);
    expect(text(failed)).not.toContain(warning);
    const first = text(await recall(client));
    expect(first.match(/Team rules could not be loaded/g)).toHaveLength(1);
    expect(first).toContain("invalid JSON or schema");
    expect(first).toContain("Tell the human");
    expect(first).toContain("/deeppairing:doctor");
    expect(first).toContain("guidance snapshot, not continuous health monitoring");
    expect(first).not.toContain("DO_NOT_ECHO_TEAM_CONTENT");
    expect(first).not.toContain(fx.dir);
    expect(text(await recall(client))).not.toContain(warning);
  });

  it("does not warn for missing/valid-empty rules; a new session and explicit onboarding read reflect repair", async () => {
    expect(text(await recall(await connect()))).not.toContain(warning);
    fs.writeFileSync(file(), JSON.stringify({ version: 1, preferences: [{ id: "x", kind: "avoid", concept: "redis cache", rationale: "ops", addedAt: "bad" }] }));
    expect(text(await recall(await connect()))).toContain(warning);
    fs.writeFileSync(file(), JSON.stringify({ version: 1, preferences: [] }));
    const repaired = await connect();
    expect(text(await recall(repaired))).not.toContain(warning);
    const onboarding = await repaired.readResource({ uri: "deeppairing://onboarding" });
    expect(JSON.stringify(onboarding.contents)).not.toContain(warning);
    // Diagnostic reads don't silently hot-reload the existing enforcement cache.
    expect(store.getTeamPreferences()).toEqual([]);
  });

  it("bounds read failures and reads only the explicitly bound project", async () => {
    fs.mkdirSync(file());
    const hint = await buildFirstCallHint(store, 4000, [], { projectRoot: fx.dir });
    expect(hint).toContain("file unavailable");
    expect(hint).not.toContain(fx.dir);
    expect(hint).not.toContain("EISDIR");
    const other = path.join(fx.dir, "other-project");
    fs.mkdirSync(other);
    expect(await buildFirstCallHint(store, 4000, [], { projectRoot: other })).not.toContain(warning);
  });
});
