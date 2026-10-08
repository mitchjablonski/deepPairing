/**
 * The SHIPPED plugin bundle must boot with plain `node` — no workspace, no
 * dist, no node_modules — and answer an MCP handshake.
 *
 * Why this exists: from v0.1.43 to v0.1.56, `claude-plugin/server/standalone.js`
 * crashed at module load ("TypeError: Class2 is not a constructor", Node 20,
 * 22 and 24; Linux and Windows). A dynamic `import("./lifecycle.js")` made
 * esbuild wrap zod in lazy initialisers, and the MCP SDK's top-level
 * `z.custom(...)` ran before zod was initialised. Every check stayed green
 * because nothing ever loaded the bundle: in a monorepo checkout the launcher
 * (server.mjs) prefers `packages/mcp-server/dist/standalone.js`, and only a
 * marketplace install — which has no dist — runs the bundle.
 *
 * This copies ONLY `claude-plugin/` into a temp dir (exactly what a
 * marketplace install has), launches `server.mjs` with plain node, completes
 * `initialize` + `tools/list` over stdio, and stops the daemon it spawned.
 * The daemon binds the test port window and never opens a browser.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expandReleasedRuntime, UpgradeProject } from "./plugin-upgrade.harness.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginSrc = path.resolve(here, "../../../../claude-plugin");
const bundle = path.join(pluginSrc, "server", "standalone.js");

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) { try { cleanups.pop()!(); } catch { /* best effort */ } } });

interface UpgradeState {
  sessionId: string;
  artifacts: Array<{ id: string; title: string; type: string; content: { decisionId?: string; summary?: string }; [key: string]: unknown }>;
  comments: Array<{ id: string; content: string; target: { artifactId: string; findingIndex?: number }; [key: string]: unknown }>;
  decisions: Array<{ decisionId: string; response?: { optionId: string; reasoning?: string }; [key: string]: unknown }>;
  autonomyLevel: string;
  detailDensity: string;
  persona: string;
  globalLedgerPublish: boolean;
  sessionMemory: { rejectedApproaches: Array<{ description: string; reason?: string; concept?: string; sourceArtifactId?: string; rejectedAt: string }> };
}

const rejectedFraming = "Tenant configuration storage";
const rejectedConcept = "global mutable configuration state";
const rejectedReason = "Tenant configuration must not leak between customers.";
const rejectedProposal = {
  title: rejectedFraming, context: "Choose tenant configuration storage", stakes: "medium",
  options: [
    { id: "global", title: "Global configuration", description: "Share mutable configuration between tenants", pros: ["Simple lookup"], cons: ["Tenant leakage"], effort: "low", risk: "high", concept: { name: rejectedConcept, oneLineExplanation: "All tenants share mutable state" } },
    { id: "isolated", title: "Tenant-local configuration", description: "Keep configuration scoped to each tenant", pros: ["Tenant isolation"], cons: ["Additional plumbing"], effort: "medium", risk: "low" },
  ],
};

/** Compare every retained semantic field, allowing additive candidate fields. */
function expectRetained(actual: UpgradeState, retained: UpgradeState): void {
  expect(actual.sessionId, "retained session ID").toBe(retained.sessionId);
  for (const kind of ["artifacts", "comments", "decisions"] as const) {
    for (const oldRecord of retained[kind]) {
      const found = actual[kind].find((record) => kind === "decisions"
        ? (record as UpgradeState["decisions"][number]).decisionId === (oldRecord as UpgradeState["decisions"][number]).decisionId
        : (record as { id: string }).id === (oldRecord as { id: string }).id);
      expect(found, `retained ${kind} record`).toMatchObject(oldRecord);
    }
  }
  expect(actual.autonomyLevel, "retained autonomy preference").toBe(retained.autonomyLevel);
  expect(actual.detailDensity, "retained density preference").toBe(retained.detailDensity);
  expect(actual.persona, "retained session persona").toBe(retained.persona);
  expect(actual.globalLedgerPublish, "retained project publish preference").toBe(retained.globalLedgerPublish);
  for (const rejection of retained.sessionMemory.rejectedApproaches) {
    const found = actual.sessionMemory.rejectedApproaches.find((record) => record.description === rejection.description);
    expect(found, "retained rejection memory record").toMatchObject(rejection);
  }
}

describe("released runtime upgrades to the shipped plugin", () => {
  // Deliberately NOT runIf(bundle): missing packaged output must fail this gate.
  it("preserves two sessions, human feedback, rejection memory, decisions and preferences across upgrade and restart", async () => {
    expect(fs.existsSync(bundle), "candidate shipped bundle is required").toBe(true);
    const sandbox = new UpgradeProject();
    try {
      const released = path.join(sandbox.tmp, "released-plugin");
      expandReleasedRuntime(path.join(here, "fixtures/plugin-upgrade/v0.1.57"), released);
      const candidate = path.join(sandbox.tmp, "candidate-plugin");
      fs.cpSync(pluginSrc, candidate, { recursive: true });
      await sandbox.start(released);
      const snapshots: UpgradeState[] = [];
      for (const suffix of ["upgradealpha", "upgradebeta"]) {
        const { client, sessionId } = await sandbox.connect(released, suffix);
        await sandbox.tool(client, "present_findings", { title: `Upgrade findings ${suffix}`, summary: `Retain café evidence ${suffix}`, findings: [{ category: "reliability", detail: `Keep the user's retained feedback ${suffix}`, significance: "high", evidence: [{ filePath: "src/example.ts", lineStart: 2, lineEnd: 3, snippet: "const retained = true;", explanation: "A stable evidence anchor" }] }] });
        let state = await sandbox.http<UpgradeState>("/api/state", sessionId);
        const research = state.artifacts.find((artifact) => artifact.type === "research")!;
        expect(research.content.summary).toBe(`Retain café evidence ${suffix}`);
        await sandbox.http("/api/comments", sessionId, { artifactId: research.id, content: `Retained human question ${suffix}`, intent: "question", target: { artifactId: research.id, findingIndex: 0, evidenceIndex: 0 } });
        await sandbox.tool(client, "present_options", { context: `Choose retained strategy ${suffix}`, stakes: "medium", options: [{ id: "keep", title: "Keep", description: "Retain the old records", pros: ["Preserves review history"], cons: [], effort: "low", risk: "low" }, { id: "replace", title: "Replace", description: "Replace the records", pros: [], cons: ["Loses review history"], effort: "high", risk: "high" }] });
        state = await sandbox.http<UpgradeState>("/api/state", sessionId);
        const decision = state.decisions[0];
        expect(decision.decisionId).toBeTruthy();
        if (suffix === "upgradealpha") await sandbox.http(`/api/decisions/${decision.decisionId}`, sessionId, { optionId: "keep", reasoning: "The historical rationale must survive." });
        const persona = suffix === "upgradealpha" ? "stakeholder" : "new-to-this-code";
        // Autonomy/density/publish belong to the project; persona is per-session.
        await sandbox.http("/api/preferences", sessionId, { autonomyLevel: "balanced", detailDensity: "rich", globalLedgerPublish: true, persona });
        if (suffix === "upgradealpha") {
          // Reject the whole decision framing, not one option: the released
          // runtime must create the real project memory through its public API.
          await sandbox.tool(client, "present_options", rejectedProposal);
          state = await sandbox.http<UpgradeState>("/api/state", sessionId);
          const rejected = state.artifacts.find((artifact) => artifact.title === rejectedFraming)!;
          expect(rejected.type).toBe("decision");
          await sandbox.http(`/api/artifacts/${rejected.id}/status`, sessionId, { status: "rejected", feedback: rejectedReason, concept: rejectedConcept });
        }
        state = await sandbox.http<UpgradeState>("/api/state", sessionId);
        expect(state.comments[0]).toMatchObject({ content: `Retained human question ${suffix}`, target: { artifactId: research.id, findingIndex: 0, evidenceIndex: 0 } });
        expect(state).toMatchObject({ autonomyLevel: "balanced", detailDensity: "rich", globalLedgerPublish: true, persona });
        if (suffix === "upgradealpha") expect(state.decisions[0].response).toMatchObject({ optionId: "keep", reasoning: "The historical rationale must survive." });
        expect(state.sessionMemory.rejectedApproaches).toEqual([expect.objectContaining({ description: rejectedFraming, reason: rejectedReason, concept: rejectedConcept, sourceArtifactId: expect.any(String), rejectedAt: expect.any(String) })]);
        snapshots.push(state);
      }
      await sandbox.stop();

      await sandbox.start(candidate);
      for (const old of snapshots) {
        // Dead-session history is a user-facing route even before reattachment.
        expectRetained(await sandbox.http<UpgradeState>(`/api/sessions/${old.sessionId}`), old);
      }
      const alpha = await sandbox.connect(candidate, "upgradealpha");
      const beta = await sandbox.connect(candidate, "upgradebeta");
      expect(alpha.sessionId).toBe(snapshots[0].sessionId);
      expect(beta.sessionId).toBe(snapshots[1].sessionId);
      const listing = await sandbox.http<{ sessions: Array<{ id: string }> }>("/api/sessions");
      expect(listing.sessions.map((session) => session.id).sort()).toEqual(snapshots.map((state) => state.sessionId).sort());
      for (const old of snapshots) expectRetained(await sandbox.http<UpgradeState>("/api/state", old.sessionId), old);

      const expectMatchingProposalBlocked = async (client: typeof alpha.client, sessionId: string) => {
        const before = await sandbox.http<UpgradeState>("/api/state", sessionId);
        // A healthy MCP response with the specific gate code/reason, not merely
        // an exception or unavailable server, proves rejection remains useful.
        for (const proposal of [rejectedProposal, { ...rejectedProposal, title: "Service wiring", context: "Choose isolated service wiring" }]) {
          // The original framing and a differently framed proposal carrying
          // only the same named concept must both hit the preserved memory.
          const blocked = await client.callTool({ name: "present_options", arguments: proposal }, undefined, { timeout: 15_000 });
          expect(blocked.isError).toBe(true);
          expect(blocked._meta).toMatchObject({ code: "REJECTED_APPROACH_BLOCKED", retryable: false });
          const message = JSON.stringify(blocked.content);
          expect(message).toContain(proposal === rejectedProposal ? rejectedFraming : rejectedConcept);
          expect(message).toContain(rejectedReason);
        }
        const after = await sandbox.http<UpgradeState>("/api/state", sessionId);
        expect(after.artifacts.map((artifact) => artifact.id)).toEqual(before.artifacts.map((artifact) => artifact.id));
        expectRetained(after, before);
      };
      await expectMatchingProposalBlocked(alpha.client, alpha.sessionId);

      // Human can comment on OLD evidence; agent can create NEW artifacts; a
      // retained pending decision can still be resolved through the companion.
      await sandbox.http("/api/comments", alpha.sessionId, { artifactId: snapshots[0].artifacts[0].id, content: "Candidate follow-up on retained evidence", intent: "comment", target: { artifactId: snapshots[0].artifacts[0].id, findingIndex: 0 } });
      await sandbox.tool(alpha.client, "present_findings", { title: "Candidate follow-up", summary: "New durable candidate artifact", findings: [{ category: "reliability", detail: "New writes also survive restart", significance: "medium" }] });
      await sandbox.http(`/api/decisions/${snapshots[1].decisions[0].decisionId}`, beta.sessionId, { optionId: "keep", reasoning: "Resolved after upgrading." });
      await sandbox.http("/api/preferences", alpha.sessionId, { detailDensity: "terse" });
      await sandbox.http("/api/preferences", beta.sessionId, { detailDensity: "terse" });
      const afterWrites = await Promise.all(snapshots.map((state) => sandbox.http<UpgradeState>("/api/state", state.sessionId)));
      expect(afterWrites[0].comments).toHaveLength(snapshots[0].comments.length + 1);
      expect(afterWrites[0].comments.at(-1)?.content).toBe("Candidate follow-up on retained evidence");
      expect(afterWrites[0].artifacts.at(-1)?.content.summary).toBe("New durable candidate artifact");
      expect(afterWrites[0].detailDensity).toBe("terse");
      expect(afterWrites[1].decisions[0].response).toMatchObject({ optionId: "keep", reasoning: "Resolved after upgrading." });
      await sandbox.stop();

      await sandbox.start(candidate);
      for (const expected of afterWrites) expectRetained(await sandbox.http<UpgradeState>(`/api/sessions/${expected.sessionId}`), expected);
      const restarted = await sandbox.connect(candidate, "upgradealpha");
      expect(restarted.sessionId).toBe(alpha.sessionId);
      await expectMatchingProposalBlocked(restarted.client, restarted.sessionId);
      await sandbox.stop();

      // Real negative control: alter one retained on-disk record while stopped,
      // then boot a healthy candidate and read successfully BEFORE the assertion.
      // A network/startup failure cannot satisfy this expected rejection.
      const commentsPath = path.join(sandbox.project, ".deeppairing/sessions", snapshots[0].sessionId, "comments.json");
      const originalComments = fs.readFileSync(commentsPath, "utf8");
      const comments = JSON.parse(originalComments) as UpgradeState["comments"];
      comments[0].content = "NEGATIVE CONTROL: retained human question lost";
      fs.writeFileSync(commentsPath, JSON.stringify(comments));
      await sandbox.start(candidate);
      const altered = await sandbox.http<UpgradeState>(`/api/sessions/${snapshots[0].sessionId}`);
      expect(altered.comments[0].content).toBe(comments[0].content);
      expect(() => expectRetained(altered, afterWrites[0])).toThrow(/retained comments record/);
      await sandbox.stop();
      fs.writeFileSync(commentsPath, originalComments);

      const preferencesPath = path.join(sandbox.project, ".deeppairing/preferences.json");
      const originalPreferences = fs.readFileSync(preferencesPath, "utf8");
      for (const corruption of ["wipe", "lose-reason"] as const) {
        // Reset each control from the healthy snapshot: the prior corrupted
        // comment or memory must not be what makes this assertion fail.
        const preferences = JSON.parse(originalPreferences);
        expect(preferences.rejectedApproaches).toHaveLength(1);
        if (corruption === "wipe") preferences.rejectedApproaches = [];
        else delete preferences.rejectedApproaches[0].reason;
        fs.writeFileSync(preferencesPath, JSON.stringify(preferences));
        await sandbox.start(candidate);
        const lost = await sandbox.http<UpgradeState>(`/api/sessions/${snapshots[0].sessionId}`);
        if (corruption === "wipe") expect(lost.sessionMemory.rejectedApproaches).toEqual([]);
        else {
          expect(lost.sessionMemory.rejectedApproaches[0]).toMatchObject({ description: rejectedFraming, concept: rejectedConcept });
          expect(lost.sessionMemory.rejectedApproaches[0].reason).toBeUndefined();
        }
        expect(() => expectRetained(lost, afterWrites[0]), corruption).toThrow(/retained rejection memory record/);
        await sandbox.stop();
      }
      fs.writeFileSync(preferencesPath, originalPreferences);
    } finally { await sandbox.dispose(); }
  }, 90_000);
});

describe.runIf(fs.existsSync(bundle))("shipped plugin bundle boots with plain node", () => {
  it("answers initialize and tools/list from a copy of claude-plugin/ alone", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dp-plugin-boot-"));
    cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    const plugin = path.join(tmp, "plugin");
    fs.cpSync(pluginSrc, plugin, { recursive: true });
    const project = path.join(tmp, "project");
    fs.mkdirSync(project);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: tmp, USERPROFILE: tmp, CLAUDE_PROJECT_DIR: project,
      DEEPPAIRING_NO_OPEN: "1", DEEPPAIRING_OPEN_BROWSER: "0", BROWSER: "none",
      // A window of its own, clear of the canonical 3847-3974 range and of the
      // per-worker vitest windows (~20000-32000 are per-run jittered; 26000+
      // collisions just fall back to the next slot).
      DEEPPAIRING_PORT_BASE: "26000",
    };
    delete env.VITEST; delete env.NODE_ENV; delete env.CLAUDE_CODE_SESSION_ID;
    const mcp: ChildProcess = spawn(process.execPath, [path.join(plugin, "server.mjs")], { cwd: project, env, stdio: ["pipe", "pipe", "pipe"] });
    cleanups.push(() => {
      mcp.kill("SIGKILL");
      try {
        const info = JSON.parse(fs.readFileSync(path.join(project, ".deeppairing", "daemon.json"), "utf8"));
        process.kill(info.pid, "SIGTERM");
      } catch { /* no daemon */ }
    });

    let stderr = "";
    mcp.stderr!.on("data", (d) => { stderr += d; });
    // Fail FAST when the server dies (the #437 crash exited at load): reject
    // every pending request with the exit code and stderr tail instead of
    // waiting out the per-request timeout.
    let exited: string | null = null;
    const failAll = () => { for (const fail of failers.values()) fail(new Error(exited!)); };
    mcp.once("exit", (code, signal) => {
      // Let the last stderr chunk land before reporting.
      setTimeout(() => {
        exited = `plugin server exited (${signal ? `signal ${signal}` : `code ${code}`}) before answering; stderr:\n${stderr.slice(-2000)}`;
        failAll();
      }, 50);
    });
    let buf = "";
    const waiters = new Map<number, (m: any) => void>();
    const failers = new Map<number, (e: Error) => void>();
    mcp.stdout!.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        waiters.get(msg.id)?.(msg);
      }
    });
    let id = 0;
    const rpc = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
      const my = ++id;
      if (exited) return reject(new Error(exited));
      const timer = setTimeout(() => reject(new Error(`${method} timed out; stderr:\n${stderr.slice(-2000)}`)), 45_000);
      const done = () => { clearTimeout(timer); waiters.delete(my); failers.delete(my); };
      waiters.set(my, (m) => { done(); resolve(m); });
      failers.set(my, (e) => { done(); reject(e); });
      mcp.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: my, method, params }) + "\n");
    });

    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bundle-boot-test", version: "0" } });
    expect(stderr).not.toMatch(/failed to start server|is not a constructor/);
    expect(init.result?.serverInfo?.name).toBeTruthy();
    mcp.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const tools = await rpc("tools/list", {});
    const names = (tools.result?.tools ?? []).map((t: { name: string }) => t.name);
    expect(names).toContain("present_findings");
    expect(names).toContain("check_feedback");

    // The daemon the bundle spawned (daemon.js, also bundled) is really up:
    // its companion answers HTTP 200 on the port it recorded.
    const info = JSON.parse(fs.readFileSync(path.join(project, ".deeppairing", "daemon.json"), "utf8"));
    expect(info.port).toBeGreaterThanOrEqual(26000);
    const res = await fetch(`http://127.0.0.1:${info.port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/<html/i);
  }, 90_000);
});

/**
 * Cheap static guard for the #437 class. esbuild emits `__esm(` lazy-init
 * wrappers only when a module is reached through a dynamic `import()` (or a
 * require of ESM). In 6f82ce2c (#317) `lifecycle.ts` — imported dynamically by
 * client.ts and create-daemon.ts — gained an `@deeppairing/shared` import, so
 * esbuild wrapped shared AND zod in `__esm` initialisers; the MCP SDK's
 * top-level `z.custom(...)` then ran before zod was initialised and every
 * marketplace install crashed at load from v0.1.43 to v0.1.56 (105 wrappers
 * in that bundle; 0 after the fix). Keep every shipped bundle free of them:
 * don't dynamically import a module that (transitively) pulls in
 * `@deeppairing/shared` or zod — import it statically.
 */
describe("shipped bundles contain no esbuild lazy-init wrappers (__esm)", () => {
  const serverDir = path.join(pluginSrc, "server");
  const bundles = fs.existsSync(serverDir)
    ? [
      path.join(pluginSrc, "server.mjs"),
      ...fs.readdirSync(serverDir).filter((f) => /\.(m?js)$/.test(f)).map((f) => path.join(serverDir, f)),
    ]
    : [];
  const generatedHooks = path.resolve(here, "../cli/hook-scripts.generated.ts");

  it.runIf(bundles.length > 0)("claude-plugin/server.mjs and claude-plugin/server/*.{js,mjs}", () => {
    const offenders = bundles.filter((file) => fs.readFileSync(file, "utf8").includes("__esm("));
    expect(offenders.map((file) => path.relative(pluginSrc, file))).toEqual([]);
    // Sanity: the set really covers the MCP server, the daemon and the hooks.
    expect(bundles.map((file) => path.basename(file))).toEqual(
      expect.arrayContaining(["standalone.js", "daemon.js", "preflight.mjs", "stop.mjs"]),
    );
  });

  it("the generated hook scripts init writes into projects", () => {
    expect(fs.readFileSync(generatedHooks, "utf8")).not.toContain("__esm(");
  });
});
