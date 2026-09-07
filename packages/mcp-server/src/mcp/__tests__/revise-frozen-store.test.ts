/**
 * #338 (F1) — revise_artifact against a FROZEN store, through the real MCP
 * dispatch. The supersede path is create-v2-then-flip-v1; on a frozen writer
 * the agent must get an isError result (never "Superseded …") and v1 must be
 * exactly as it was on disk: no v2, no status flip, no superseded comment.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import fs from "node:fs";
import path from "node:path";
import { createMcpServer } from "../server.js";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";

let fx: GlobalStoreFixture;
let store: FileStore;
let client: Client;

beforeEach(async () => {
  fx = withGlobalStore("dp-revise-frozen-");
  store = fx.track(new FileStore(fx.dir, "test_session"));
  const { server } = createMcpServer(store, () => {}, 4000);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test-client", version: "1.0" });
  await client.connect(clientTransport);
});

afterEach(() => fx.dispose());

describe("#338 (F1) — revise_artifact on a frozen store", () => {
  it("returns isError and leaves v1 untouched on disk", async () => {
    store.createArtifact({
      id: "art_v1", type: "spec", title: "Cache spec",
      content: { summary: "Use Redis", requirements: ["fast reads"] },
    });
    store.forceFlush();
    const external = fx.track(new FileStore(fx.dir, "test_session"));
    const changed = external.getArtifacts()[0]!;
    changed.content = { summary: "Use an in-process map", requirements: ["fast reads"] };
    changed.version = 2;
    external.renameArtifact("art_v1", changed.title);
    external.forceFlush();
    store.updateArtifactStatus("art_v1", "approved", "ui_approve_button");
    expect(() => store.forceFlush()).toThrow(/changed content.*review verdict|review verdict.*changed content/i);
    const artifactsPath = path.join(fx.dir, ".deeppairing", "sessions", "test_session", "artifacts.json");
    const before = fs.readFileSync(artifactsPath, "utf8");

    const result = await client.callTool({
      name: "revise_artifact",
      arguments: {
        artifactId: "art_v1", mode: "supersede", reason: "tighten the requirements",
        title: "Cache spec", content: { summary: "Use Redis with a TTL", requirements: ["fast reads", "bounded memory"] },
      },
    }) as { isError?: boolean; content: Array<{ type: string; text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).not.toMatch(/^Superseded/);
    expect(result.content[0]!.text).toMatch(/restart.*review|review.*restart/i);

    expect(fs.readFileSync(artifactsPath, "utf8")).toBe(before);
    const recovered = fx.track(new FileStore(fx.dir, "test_session"));
    expect(recovered.getArtifacts()).toHaveLength(1);
    expect(recovered.getArtifacts()[0]).toMatchObject({ id: "art_v1", status: "draft", version: 2 });
    expect(recovered.getCommentsForArtifact("art_v1")).toEqual([]);
  });
});
