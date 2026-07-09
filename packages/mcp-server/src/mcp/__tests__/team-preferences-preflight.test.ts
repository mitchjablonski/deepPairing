/**
 * N6.5: team-preferences pre-flight end-to-end.
 *
 * Covers the slices the existing suites don't:
 *   - Pre-flight blocks on `avoid` match (through the full MCP tool call path).
 *   - Pre-flight blocks on `require` violation when concept is "<thing> for <domain>".
 *   - Pre-flight stays silent on a `require` without a "for" clause (advisory only).
 *   - `prefer` never blocks.
 *   - Scope paths gate the block: proposal inside scope fires; outside scope passes.
 *   - Broadcast includes `source: "team"` + via + kind attribution.
 *   - Session-rejected wins over team-pref when both would block (order preserved).
 *   - matchesGlob unit behavior.
 *
 * Loader / firstCallHint coverage lives in file-store.test.ts and server.test.ts;
 * don't duplicate here.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, matchesGlob } from "../server.js";
import { FileStore } from "../../store/file-store.js";
import { setGlobalStoreForTests } from "../../store/global-store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;
let broadcasts: any[] = [];

function writeTeamJson(prefs: any[]): void {
  fs.mkdirSync(path.join(tmpDir, ".deeppairing"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, ".deeppairing", "team.json"),
    JSON.stringify({ version: 1, preferences: prefs }),
  );
}

const openStores: FileStore[] = [];

async function makeServer(): Promise<{ store: FileStore; client: Client }> {
  const store = new FileStore(tmpDir, `session_${Date.now()}`);
  openStores.push(store);
  const { server } = createMcpServer(store, (e) => broadcasts.push(e), 4000);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "1.0" });
  await client.connect(ct);
  return { store, client };
}

async function callTool(client: Client, name: string, args: Record<string, any>) {
  const result = await client.callTool({ name, arguments: args });
  return {
    text: (result.content as any[])?.[0]?.text ?? "",
    isError: result.isError ?? false,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-team-preflight-"));
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
  broadcasts = [];
  openStores.length = 0;
});

afterEach(() => {
  // Cancel any pending debounced flush before rm'ing the dir, so no timer
  // fires against a gone tmpdir during teardown (flake #134).
  for (const s of openStores) s.dispose();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  setGlobalStoreForTests(null);
});

describe("team-preferences pre-flight — avoid", () => {
  it("blocks a proposal matching an 'avoid' team preference", async () => {
    writeTeamJson([
      { id: "a1", kind: "avoid", concept: "global mutable state", rationale: "breaks testability" },
    ]);
    const { client } = await makeServer();

    const { text, isError } = await callTool(client, "present_findings", {
      title: "Global store refactor",
      summary: "Introduce a global mutable state singleton for config",
      findings: [{ category: "x", detail: "x", significance: "low" }],
    });
    expect(isError).toBe(true);
    expect(text).toContain("REJECTED_APPROACH_BLOCKED");
    expect(text).toContain("global mutable state");
    expect(text).toContain("breaks testability");
    expect(text).toMatch(/team/i);

    const blocked = broadcasts.find((b) => b.type === "preflight_blocked");
    expect(blocked).toBeDefined();
    expect(blocked.source).toBe("team");
    expect(blocked.match.via).toBe("avoid");
    expect(blocked.match.kind).toBe("avoid");
  });

  it("does NOT block unrelated proposals", async () => {
    writeTeamJson([
      { id: "a1", kind: "avoid", concept: "global mutable state", rationale: "testability" },
    ]);
    const { client, store } = await makeServer();

    const { isError } = await callTool(client, "present_findings", {
      title: "Rename a utility function",
      summary: "Clean up the naming in utils/",
      findings: [{ category: "x", detail: "x", significance: "low" }],
    });
    expect(isError).toBeFalsy();
    expect(store.getArtifacts()).toHaveLength(1);
  });
});

describe("team-preferences pre-flight — require", () => {
  it("blocks when domain is proposed without the required tech", async () => {
    writeTeamJson([
      { id: "r1", kind: "require", concept: "argon2id for password hashing", rationale: "bcrypt is brute-forceable" },
    ]);
    const { client } = await makeServer();

    const { text, isError } = await callTool(client, "present_findings", {
      title: "Auth refactor",
      summary: "Switch password hashing to bcrypt with cost factor 10",
      findings: [{ category: "x", detail: "x", significance: "low" }],
    });
    expect(isError).toBe(true);
    expect(text).toContain("REJECTED_APPROACH_BLOCKED");
    expect(text).toContain("argon2id for password hashing");
    expect(text).toContain("bcrypt is brute-forceable");

    const blocked = broadcasts.find((b) => b.type === "preflight_blocked");
    expect(blocked.source).toBe("team");
    expect(blocked.match.via).toBe("require");
    expect(blocked.match.kind).toBe("require");
  });

  it("does NOT block when the required tech is mentioned", async () => {
    writeTeamJson([
      { id: "r1", kind: "require", concept: "argon2id for password hashing", rationale: "y" },
    ]);
    const { client, store } = await makeServer();

    const { isError } = await callTool(client, "present_findings", {
      title: "Auth refactor",
      summary: "Switch password hashing to argon2id",
      findings: [{ category: "x", detail: "x", significance: "low" }],
    });
    expect(isError).toBeFalsy();
    expect(store.getArtifacts()).toHaveLength(1);
  });

  it("stays advisory (no block) when the concept has no 'for' clause", async () => {
    // "TypeScript strict mode" has no domain→required split, so we can't infer
    // what counts as a violation. Leave it in firstCallHint as guidance.
    writeTeamJson([
      { id: "r1", kind: "require", concept: "TypeScript strict mode", rationale: "y" },
    ]);
    const { client, store } = await makeServer();

    const { isError } = await callTool(client, "present_findings", {
      title: "Disable strict null checks",
      summary: "Loosen TypeScript strict mode for the legacy package",
      findings: [{ category: "x", detail: "x", significance: "low" }],
    });
    expect(isError).toBeFalsy();
    expect(store.getArtifacts()).toHaveLength(1);
  });
});

describe("team-preferences pre-flight — prefer never blocks", () => {
  it("'prefer' is taste; pre-flight ignores it even on direct concept match", async () => {
    writeTeamJson([
      { id: "p1", kind: "prefer", concept: "repository pattern", rationale: "clean separation" },
    ]);
    const { client, store } = await makeServer();

    const { isError } = await callTool(client, "present_findings", {
      title: "Avoid the repository pattern here",
      summary: "Inline SQL is fine for this one endpoint",
      findings: [{ category: "x", detail: "x", significance: "low" }],
    });
    expect(isError).toBeFalsy();
    expect(store.getArtifacts()).toHaveLength(1);
  });
});

describe("team-preferences pre-flight — scope paths", () => {
  it("fires when a proposal path matches the scope glob", async () => {
    writeTeamJson([
      { id: "s1", kind: "avoid", concept: "direct SQL queries", rationale: "use repository",
        scope: { paths: ["packages/api/**"] } },
    ]);
    const { client } = await makeServer();

    const { isError } = await callTool(client, "present_findings", {
      title: "Refactor route",
      summary: "Add direct SQL queries to the users endpoint",
      findings: [{
        category: "x",
        detail: "x",
        significance: "low",
        evidence: [{ filePath: "packages/api/routes/users.ts", lineStart: 1, lineEnd: 1, snippet: "x", explanation: "x" }],
      }],
    });
    expect(isError).toBe(true);
  });

  it("does NOT fire when proposal paths are outside the scope", async () => {
    writeTeamJson([
      { id: "s1", kind: "avoid", concept: "direct SQL queries", rationale: "use repository",
        scope: { paths: ["packages/api/**"] } },
    ]);
    const { client, store } = await makeServer();

    const { isError } = await callTool(client, "present_findings", {
      title: "Refactor utility",
      summary: "Add direct SQL queries to a test helper",
      findings: [{
        category: "x",
        detail: "x",
        significance: "low",
        evidence: [{ filePath: "packages/frontend/test-utils.ts", lineStart: 1, lineEnd: 1, snippet: "x", explanation: "x" }],
      }],
    });
    expect(isError).toBeFalsy();
    expect(store.getArtifacts()).toHaveLength(1);
  });

  it("skips the scoped pref when the proposal carries no path info (avoid false positives)", async () => {
    writeTeamJson([
      { id: "s1", kind: "avoid", concept: "direct SQL queries", rationale: "y",
        scope: { paths: ["packages/api/**"] } },
    ]);
    const { client, store } = await makeServer();

    const { isError } = await callTool(client, "present_findings", {
      title: "General discussion",
      summary: "Thinking about direct SQL queries vs repositories in general",
      findings: [{ category: "x", detail: "x", significance: "low" }], // no evidence → no paths
    });
    expect(isError).toBeFalsy();
    expect(store.getArtifacts()).toHaveLength(1);
  });
});

describe("team-preferences pre-flight — source attribution ordering", () => {
  it("session-rejected lane wins over team-pref when both would match", async () => {
    writeTeamJson([
      { id: "a1", kind: "avoid", concept: "global state", rationale: "team: testability" },
    ]);
    const { client, store } = await makeServer();
    // Session rejection of the same concept, added mid-session.
    await store.recordRejectedApproach({ description: "Global state singleton", reason: "user: tried it last week", concept: "global state" });

    const { text } = await callTool(client, "present_findings", {
      title: "Global state singleton",
      summary: "Introduce a global state singleton",
      findings: [{ category: "x", detail: "x", significance: "low" }],
    });
    expect(text).toContain("REJECTED_APPROACH_BLOCKED");
    // Session message attributes to the user, not to team policy.
    expect(text).toMatch(/previously rejected/i);

    const blocked = broadcasts.find((b) => b.type === "preflight_blocked");
    expect(blocked.source).toBe("session");
  });
});

describe("matchesGlob util", () => {
  it("matches ** across separators", () => {
    expect(matchesGlob("packages/api/routes/users.ts", "packages/api/**")).toBe(true);
    expect(matchesGlob("packages/api/", "packages/api/**")).toBe(true);
  });

  it("matches * only within a segment", () => {
    expect(matchesGlob("src/foo.ts", "src/*.ts")).toBe(true);
    expect(matchesGlob("src/foo/bar.ts", "src/*.ts")).toBe(false);
  });

  it("treats other characters literally (no regex leakage)", () => {
    expect(matchesGlob("a.b.c", "a.b.c")).toBe(true);
    expect(matchesGlob("axb.c", "a.b.c")).toBe(false);
  });
});
