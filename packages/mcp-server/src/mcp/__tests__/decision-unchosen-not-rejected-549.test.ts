/**
 * #549 — resolving a decision card must NOT turn the unchosen options into
 * rejected stances. The human's rule: only if they say so. Picking A records A
 * as approved; B and C add no ledger rows and never feed the pre-flight gate.
 * The explicit per-option "Never suggest this" (POST
 * /api/decisions/:id/options/:optionId/never-suggest) records exactly the one
 * option the human named.
 *
 * Fakes, not mocks: a real FileStore, the real HTTP routes, and the real MCP
 * server (present_options → resolve → check_feedback → present_options again).
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { FileStore } from "../../store/file-store.js";
import { createHttpRoutes } from "../../http/routes.js";
import { withHash } from "../../http/__tests__/routes.harness.js";
import { setupServerTest, makeCallTool } from "./server-test-harness.js";

const ctx = setupServerTest();
const callTool = makeCallTool(ctx);
let store: FileStore;
let app: ReturnType<typeof createHttpRoutes>;
let httpBroadcasts: any[];
beforeEach(() => {
  store = ctx.store;
  httpBroadcasts = [];
  app = withHash(createHttpRoutes(store, ctx.tmpDir, (e) => httpBroadcasts.push(e)), ctx.tmpDir);
});

const DEPLOY_OPTIONS = [
  {
    id: "a", title: "AWS Fargate", description: "managed container service",
    pros: ["mature"], cons: ["complex"], effort: "medium", risk: "low", recommendation: true,
    concept: { name: "managed container service" },
  },
  {
    id: "b", title: "Fly.io", description: "pay-per-request hosting on the edge",
    pros: ["cheap"], cons: ["less mature"], effort: "low", risk: "medium", recommendation: false,
    concept: { name: "pay-per-request hosting" },
  },
  {
    id: "c", title: "Bare EC2", description: "hand-managed virtual machines",
    pros: ["control"], cons: ["ops burden"], effort: "high", risk: "medium", recommendation: false,
    concept: { name: "hand-managed VMs" },
  },
];

async function presentDeploy(): Promise<{ decisionId: string; artifactId: string }> {
  const res = await callTool("present_options", { title: "Deploy target", context: "Where should the API run?", options: DEPLOY_OPTIONS });
  expect(res.isError).toBeFalsy();
  const art = store.getArtifacts().find((a) => a.type === "decision")!;
  return { decisionId: (art.content as { decisionId: string }).decisionId, artifactId: art.id };
}

const resolve = (decisionId: string, optionId: string, reasoning?: string) =>
  app.request(`/api/decisions/${decisionId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ optionId, reasoning }),
  });

const neverSuggest = (decisionId: string, optionId: string, body: Record<string, unknown> = {}) =>
  app.request(`/api/decisions/${decisionId}/options/${optionId}/never-suggest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("#549 — picking one option does not reject the others", () => {
  it("resolving a decision (route + check_feedback) adds ZERO rejection rows and still records the approval", async () => {
    const { decisionId } = await presentDeploy();
    expect((await resolve(decisionId, "a", "fits our infra")).status).toBe(200);
    const fb = await callTool("check_feedback", {});
    expect(fb.text).toContain('selected "AWS Fargate"');

    const memory = store.getSessionMemory();
    expect(memory.rejectedApproaches).toHaveLength(0);
    expect(memory.approvedPatterns).toContain("Deploy target: AWS Fargate");
    // No rejection ledger_write was broadcast either.
    expect(ctx.broadcasts.filter((b) => b?.type === "ledger_write" && b.kind === "rejected")).toHaveLength(0);
    // And preferences.json on disk carries no rejections.
    const prefs = JSON.parse(fs.readFileSync(path.join(ctx.tmpDir, ".deeppairing", "preferences.json"), "utf-8"));
    expect(prefs.rejectedApproaches ?? []).toHaveLength(0);
  });

  it("the gate does NOT fire on a re-proposal of an unchosen-but-not-rejected option", async () => {
    const { decisionId } = await presentDeploy();
    await resolve(decisionId, "a");
    await callTool("check_feedback", {});

    const again = await callTool("present_options", {
      title: "Preview environments",
      context: "Where should preview builds run?",
      options: [
        { id: "x", title: "Fly.io", description: "pay-per-request hosting on the edge", pros: [], cons: [], effort: "low", risk: "low", recommendation: true, concept: { name: "pay-per-request hosting" } },
        { id: "y", title: "Render", description: "managed PaaS", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
      ],
    });
    expect(again.isError).toBeFalsy();
    expect(again.text).not.toContain("REJECTED_APPROACH_BLOCKED");
  });
});

describe("#549 — the explicit per-option 'Never suggest this'", () => {
  it("adds exactly ONE rejection row — the named option, with the human's reason and its concept", async () => {
    const { decisionId, artifactId } = await presentDeploy();
    await resolve(decisionId, "a");
    await callTool("check_feedback", {});

    const res = await neverSuggest(decisionId, "b", { reason: "  edge cold starts hurt us before  " });
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; description: string; alreadyRecorded: boolean };
    expect(body).toMatchObject({ status: "recorded", description: "Deploy target: Fly.io", alreadyRecorded: false });

    const rejected = store.getSessionMemory().rejectedApproaches;
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      description: "Deploy target: Fly.io",
      reason: "edge cold starts hurt us before",
      concept: "pay-per-request hosting",
      sourceArtifactId: artifactId,
    });
    // C was not named — still not rejected.
    expect(rejected.some((r) => r.description.includes("Bare EC2"))).toBe(false);
    expect(httpBroadcasts.filter((b) => b?.type === "ledger_write" && b.kind === "rejected")).toHaveLength(1);
  });

  it("is idempotent: a retried click adds no second row", async () => {
    const { decisionId } = await presentDeploy();
    await resolve(decisionId, "a");
    await neverSuggest(decisionId, "b", { reason: "no" });
    const second = await neverSuggest(decisionId, "b", { reason: "no" });
    expect(second.status).toBe(200);
    expect((await second.json() as { alreadyRecorded: boolean }).alreadyRecorded).toBe(true);
    expect(store.getSessionMemory().rejectedApproaches).toHaveLength(1);
  });

  it("with no reason, falls back to the option's own cons; with neither, records no reason", async () => {
    const { decisionId } = await presentDeploy();
    await resolve(decisionId, "a");
    await neverSuggest(decisionId, "c");
    expect(store.getSessionMemory().rejectedApproaches[0]?.reason).toBe("ops burden");

    // concept falls back to the option's description when it names none
    // (AA1 back-compat, the same key the implicit path used to mint).
    await callTool("present_options", {
      title: "Queue",
      context: "Which queue?",
      options: [
        { id: "q1", title: "SQS", description: "managed queue", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
        { id: "q2", title: "Redis Streams", description: "in-memory queue with persistence", pros: [], cons: [], effort: "medium", risk: "medium", recommendation: false },
      ],
    });
    const q = store.getArtifacts().find((a) => a.type === "decision" && a.title.includes("Queue"))!;
    const qId = (q.content as { decisionId: string }).decisionId;
    expect((await neverSuggest(qId, "q2")).status).toBe(200);
    const row = store.getSessionMemory().rejectedApproaches.find((r) => r.description === "Queue: Redis Streams");
    expect(row?.reason).toBeUndefined();
    expect(row?.concept).toBe("in-memory queue with persistence");
  });

  it("the gate DOES fire on a re-proposal of an explicitly rejected option", async () => {
    const { decisionId } = await presentDeploy();
    await resolve(decisionId, "a");
    await callTool("check_feedback", {});
    expect((await neverSuggest(decisionId, "b", { reason: "cold starts" })).status).toBe(200);

    const again = await callTool("present_options", {
      title: "Preview environments",
      context: "Where should preview builds run?",
      options: [
        { id: "x", title: "Fly.io", description: "pay-per-request hosting on the edge", pros: [], cons: [], effort: "low", risk: "low", recommendation: true, concept: { name: "pay-per-request hosting" } },
        { id: "y", title: "Render", description: "managed PaaS", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
      ],
    });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("REJECTED_APPROACH_BLOCKED");
    expect(again.text).toContain("cold starts");
  });

  it("refuses the option the human CHOSE, an unknown option, and a decision from another session", async () => {
    const { decisionId } = await presentDeploy();
    await resolve(decisionId, "a");
    expect((await neverSuggest(decisionId, "a")).status).toBe(400);
    expect((await neverSuggest(decisionId, "zzz")).status).toBe(400);
    expect((await neverSuggest("dec_nope", "b")).status).toBe(404);
    expect((await neverSuggest(decisionId, "b", { reason: 42 })).status).toBe(400);
    expect(store.getSessionMemory().rejectedApproaches).toHaveLength(0);
  });

  it("works before the card is resolved too (marking an option while still deciding)", async () => {
    const { decisionId } = await presentDeploy();
    expect((await neverSuggest(decisionId, "c", { reason: "no VMs" })).status).toBe(200);
    expect(store.getSessionMemory().rejectedApproaches.map((r) => r.description)).toEqual(["Deploy target: Bare EC2"]);
  });
});

describe("#549 — existing ledgers load unchanged", () => {
  it("a legacy row auto-recorded from an unchosen option is kept as-is, still gates, and a new resolve removes nothing", async () => {
    // The exact shape the pre-#549 check_feedback wrote for an unchosen
    // option (no origin marker existed, so nothing can tell it apart).
    const legacy = {
      rejectedApproaches: [
        {
          description: "Deploy target: Fly.io",
          reason: "less mature — picked \"AWS Fargate\": fits our infra",
          rejectedAt: "2026-10-01T00:00:00.000Z",
          sourceArtifactId: "art_legacy",
          concept: "pay-per-request hosting",
        },
        "Legacy string row: Heroku",
      ],
      approvedPatterns: ["Deploy target: AWS Fargate"],
    };
    const prefsPath = path.join(ctx.tmpDir, ".deeppairing", "preferences.json");
    fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
    fs.writeFileSync(prefsPath, JSON.stringify(legacy, null, 2));
    const reloaded = ctx.fx.track(new FileStore(ctx.tmpDir, "test_session_reloaded"));

    const memory = reloaded.getSessionMemory();
    expect(memory.rejectedApproaches).toHaveLength(2);
    expect(memory.rejectedApproaches[0]).toEqual(legacy.rejectedApproaches[0]);
    expect(memory.rejectedApproaches[1]?.description).toBe("Legacy string row: Heroku");
    expect(memory.approvedPatterns).toEqual(["Deploy target: AWS Fargate"]);

    // The legacy row still gates (the MCP server's store reads the same file):
    // #549 leaves existing stances in place for the human to retire.
    const gated = await callTool("present_options", {
      title: "Preview environments",
      context: "Where should preview builds run?",
      options: [
        { id: "x", title: "Fly.io", description: "pay-per-request hosting on the edge", pros: [], cons: [], effort: "low", risk: "low", recommendation: true, concept: { name: "pay-per-request hosting" } },
        { id: "y", title: "Render", description: "managed PaaS", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
      ],
    });
    expect(gated.text).toContain("REJECTED_APPROACH_BLOCKED");

    // Resolving a fresh decision on the reloaded store neither adds nor drops rows.
    const app2 = withHash(createHttpRoutes(reloaded, ctx.tmpDir, () => {}), ctx.tmpDir);
    reloaded.createArtifact({
      id: "art_new", type: "decision", title: "Logs",
      content: { decisionId: "dec_new", title: "Logs", context: "Where do logs go?", options: [
        { id: "l1", title: "Loki", description: "log store", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
        { id: "l2", title: "CloudWatch", description: "aws logs", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
      ] },
    });
    const r = await app2.request(`/api/decisions/art_new`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ optionId: "l1" }),
    });
    expect(r.status).toBe(200);
    expect(reloaded.getSessionMemory().rejectedApproaches.map((x) => x.description))
      .toEqual(["Deploy target: Fly.io", "Legacy string row: Heroku"]);
  });
});
