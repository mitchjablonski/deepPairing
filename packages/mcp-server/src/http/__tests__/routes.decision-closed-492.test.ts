/**
 * #492 — a decision whose backing artifact is CLOSED (superseded, retracted,
 * obsolete) refuses a late answer on BOTH resolve routes: 409 decision_closed
 * with the status (superseded: `supersededBy` naming the newest version),
 * nothing written, nothing broadcast. Real FileStores; a real daemon + a real
 * DaemonClient for the typed outcome. The same-pick no-op is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";
import { withHash } from "./routes.harness.js";
import { createHttpRoutes } from "../routes.js";
import { createDaemonRoutes, type SessionMeta } from "../../daemon/routes.js";
import { createDaemon, type Daemon } from "../../daemon/create-daemon.js";
import { DaemonClient } from "../../daemon/client.js";

const OPTS = [
  { id: "a", title: "A", description: "d", pros: [], cons: [], effort: "low" as const, risk: "low" as const, recommendation: true },
  { id: "b", title: "B", description: "d", pros: [], cons: [], effort: "low" as const, risk: "low" as const, recommendation: false },
];
const json = (body: unknown) => ({ method: "POST" as const, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
type Closer = (s: { updateArtifactStatus: FileStore["updateArtifactStatus"]; createArtifact: FileStore["createArtifact"] }) => void | Promise<void>;
const CLOSERS: Record<"retracted" | "obsolete" | "superseded", Closer> = {
  retracted: (s) => { s.updateArtifactStatus("art_d", "retracted", "agent_retract"); },
  obsolete: (s) => { s.updateArtifactStatus("art_d", "obsolete", "ui_dismiss_obsolete"); },
  superseded: (s) => {
    s.updateArtifactStatus("art_d", "superseded", "agent_supersede");
    s.createArtifact({ id: "art_d2", type: "decision", title: "Which? (revised)", parentId: "art_d", version: 2, content: { decisionId: "dec_d2", question: "Which?", options: OPTS } });
  },
};
const seed = (store: FileStore) => {
  store.createArtifact({ id: "art_d", type: "decision", title: "Which?", content: { decisionId: "dec_d", question: "Which?", options: OPTS } });
  store.recordDecisionRequest({ decisionId: "dec_d", artifactId: "art_d", context: "Which?", options: OPTS });
};
const onDisk = (dir: string, sid: string) => {
  const list = JSON.parse(fs.readFileSync(path.join(dir, ".deeppairing", "sessions", sid, "decisions.json"), "utf8")) as Array<{ decisionId: string; response?: unknown }>;
  return list.find((d) => d.decisionId === "dec_d")?.response ?? null;
};

let fx: GlobalStoreFixture;
beforeEach(() => {
  fx = withGlobalStore("dp-decision-closed-492-");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fx.dispose();
});

describe.each(["retracted", "obsolete", "superseded"] as const)("#492 — a %s decision refuses a late answer", (status) => {
  it("public route: 409 decision_closed, nothing written, nothing broadcast", async () => {
    const store = fx.track(new FileStore(fx.dir, `s_pub_${status}`));
    seed(store);
    await CLOSERS[status](store);
    await store.forceFlush();
    const events: Array<Record<string, unknown>> = [];
    const app = withHash(createHttpRoutes(store, fx.dir, (m) => events.push(m as Record<string, unknown>)), fx.dir);
    const res = await app.request("/api/decisions/dec_d", json({ optionId: "a", reasoning: "late" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ code: "decision_closed", currentStatus: status, decisionId: "dec_d", artifactId: "art_d" });
    if (status === "superseded") expect(body.supersededBy).toEqual({ artifactId: "art_d2", decisionId: "dec_d2" });
    else expect(body.supersededBy).toBeUndefined();
    expect(store.getDecisionResponse("dec_d")).toBeNull();
    expect(onDisk(fx.dir, `s_pub_${status}`)).toBeNull();
    expect(store.getArtifacts().find((a) => a.id === "art_d")?.status).toBe(status);
    expect(events.filter((e) => e.type === "decision_resolved")).toHaveLength(0);
  });

  it("internal route: the same refusal", async () => {
    const sessions = new Map<string, FileStore>();
    const meta = new Map<string, SessionMeta>();
    const events: Array<Record<string, unknown>> = [];
    const make = (sid: string) => { const s = fx.track(new FileStore(fx.dir, sid)); sessions.set(sid, s); return s; };
    const app = createDaemonRoutes(sessions, meta, make, (_sid, e) => events.push(e as Record<string, unknown>), undefined, fx.dir);
    const sid = `s_int_${status}`;
    await app.request(`/api/internal/sessions/${sid}/register`, json({}));
    const store = sessions.get(sid)!;
    seed(store);
    await CLOSERS[status](store);
    await store.forceFlush();
    const res = await app.request(`/api/internal/sessions/${sid}/decisions/dec_d/resolve`, json({ optionId: "a" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "decision_closed", currentStatus: status });
    expect(store.getDecisionResponse("dec_d")).toBeNull();
    expect(events.filter((e) => e.type === "decision_resolved")).toHaveLength(0);
  });
});

describe("#492 — unchanged around it", () => {
  it("an ANSWERED decision closed afterwards: the same pick stays a no-op 200 (not decision_closed)", async () => {
    const store = fx.track(new FileStore(fx.dir, "s_same"));
    seed(store);
    const app = withHash(createHttpRoutes(store, fx.dir, () => {}), fx.dir);
    expect((await app.request("/api/decisions/dec_d", json({ optionId: "a" }))).status).toBe(200);
    store.updateArtifactStatus("art_d", "obsolete", "ui_dismiss_obsolete");
    const again = await app.request("/api/decisions/dec_d", json({ optionId: "a" }));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ alreadyResolved: true });
  });
});

describe("#492 — DaemonClient keeps the typed outcome", () => {
  let daemon: Daemon;
  let server: ReturnType<typeof serve>;
  afterEach(() => {
    daemon?.dispose();
    try { server?.close(); } catch { /* closed */ }
  });

  it("a real daemon + a real client: resolveDecisionAtomic on a superseded decision is { kind: 'closed', supersededBy }", async () => {
    daemon = createDaemon({ projectRoot: fx.dir, authToken: "tok", log: () => {}, exitProcess: () => {}, releaseListenSocket: () => {}, env: {} });
    server = serve({ fetch: daemon.app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((resolve) => {
      const s = server as unknown as { address(): AddressInfo | null; once(ev: string, cb: () => void): void };
      if (s.address()) return resolve();
      s.once("listening", () => resolve());
    });
    const port = ((server as unknown as { address(): AddressInfo }).address()).port;
    const client = new DaemonClient(port, "s_cli", fx.dir, "tok");
    await client.register({ title: "t", expectedProjectRoot: fx.dir });
    await client.createArtifact({ id: "art_d", type: "decision", title: "Which?", content: { decisionId: "dec_d", question: "Which?", options: OPTS } });
    await client.recordDecisionRequest({ decisionId: "dec_d", artifactId: "art_d", context: "Which?", options: OPTS });
    await client.updateArtifactStatus("art_d", "superseded", "agent_supersede");
    await client.createArtifact({ id: "art_d2", type: "decision", title: "Which? (revised)", parentId: "art_d", version: 2, content: { decisionId: "dec_d2", question: "Which?", options: OPTS } });

    const outcome = await client.resolveDecisionAtomic("dec_d", "a");
    expect(outcome).toEqual({ kind: "closed", currentStatus: "superseded", artifactId: "art_d", supersededBy: { artifactId: "art_d2", decisionId: "dec_d2" } });
  });
});

describe("#493 review — the revise window and a closed successor", () => {
  it("revise window: v2 exists but v1 isn't marked superseded yet → v1 is refused with supersededBy v2 (v2 stays the one to answer)", async () => {
    const store = fx.track(new FileStore(fx.dir, "s_window"));
    seed(store);
    store.createArtifact({ id: "art_d2", type: "decision", title: "Which? (revised)", parentId: "art_d", version: 2, content: { decisionId: "dec_d2", question: "Which?", options: OPTS } });
    expect(store.getArtifacts().find((a) => a.id === "art_d")?.status).toBe("draft"); // not marked yet
    const events: Array<Record<string, unknown>> = [];
    const app = withHash(createHttpRoutes(store, fx.dir, (m) => events.push(m as Record<string, unknown>)), fx.dir);
    const res = await app.request("/api/decisions/dec_d", json({ optionId: "a" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "decision_closed", currentStatus: "superseded", supersededBy: { artifactId: "art_d2", decisionId: "dec_d2" } });
    expect(store.getDecisionResponse("dec_d")).toBeNull();
    expect(events.filter((e) => e.type === "decision_resolved")).toHaveLength(0);
  });

  it("v1 → v2 (retracted): no link to the withdrawn card; the message says the newer version was withdrawn too", async () => {
    const store = fx.track(new FileStore(fx.dir, "s_chain"));
    seed(store);
    store.updateArtifactStatus("art_d", "superseded", "agent_supersede");
    store.createArtifact({ id: "art_d2", type: "decision", title: "Which? (revised)", parentId: "art_d", version: 2, content: { decisionId: "dec_d2", question: "Which?", options: OPTS } });
    store.updateArtifactStatus("art_d2", "retracted", "agent_retract");
    const app = withHash(createHttpRoutes(store, fx.dir, () => {}), fx.dir);
    const res = await app.request("/api/decisions/dec_d", json({ optionId: "a" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ code: "decision_closed", currentStatus: "superseded", successorStatus: "retracted" });
    expect(body.supersededBy).toBeUndefined();
    expect(body.message).toMatch(/revised, and the newer version was withdrawn too — there's nothing to answer here/);
  });

  it("internal route: the revise window is refused the same way", async () => {
    const sessions = new Map<string, FileStore>();
    const meta = new Map<string, SessionMeta>();
    const make = (sid: string) => { const s = fx.track(new FileStore(fx.dir, sid)); sessions.set(sid, s); return s; };
    const app = createDaemonRoutes(sessions, meta, make, () => {}, undefined, fx.dir);
    await app.request("/api/internal/sessions/s_wi/register", json({}));
    const store = sessions.get("s_wi")!;
    seed(store);
    store.createArtifact({ id: "art_d2", type: "decision", title: "Which? (revised)", parentId: "art_d", version: 2, content: { decisionId: "dec_d2", question: "Which?", options: OPTS } });
    const res = await app.request("/api/internal/sessions/s_wi/decisions/dec_d/resolve", json({ optionId: "a" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ currentStatus: "superseded", supersededBy: { artifactId: "art_d2" } });
  });
});

/**
 * #493 delta review — ONE answerability rule (shared decisionCanAcceptAnswer):
 * any newest version that can't take an answer gets no link and honest copy.
 */
describe("#493 — a non-answerable successor, by the shared rule", () => {
  const REASON = { rejected: "ui_reject_button", revised: "ui_revise_button", superseded: "agent_supersede", retracted: "agent_retract", obsolete: "ui_dismiss_obsolete" } as const;
  const VERB = { rejected: "rejected", revised: "sent back for changes", superseded: "replaced", retracted: "withdrawn", obsolete: "closed" } as const;

  it.each(Object.keys(REASON) as Array<keyof typeof REASON>)("v1 → v2 (%s): no link, honest copy", async (v2Status) => {
    const store = fx.track(new FileStore(fx.dir, `s_succ_${v2Status}`));
    seed(store);
    store.updateArtifactStatus("art_d", "superseded", "agent_supersede");
    store.createArtifact({ id: "art_d2", type: "decision", title: "Which? (revised)", parentId: "art_d", version: 2, content: { decisionId: "dec_d2", question: "Which?", options: OPTS } });
    store.updateArtifactStatus("art_d2", v2Status, REASON[v2Status]);
    expect(store.getArtifacts().find((a) => a.id === "art_d2")?.status).toBe(v2Status);
    const app = withHash(createHttpRoutes(store, fx.dir, () => {}), fx.dir);
    const res = await app.request("/api/decisions/dec_d", json({ optionId: "a" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ code: "decision_closed", currentStatus: "superseded", successorStatus: v2Status });
    expect(body.supersededBy).toBeUndefined();
    expect(body.message).toBe(`This question was revised, and the newer version was ${VERB[v2Status]} too — there's nothing to answer here.`);
  });

  it("control: an OPEN v2 (draft) is still linked", async () => {
    const store = fx.track(new FileStore(fx.dir, "s_succ_open"));
    seed(store);
    store.updateArtifactStatus("art_d", "superseded", "agent_supersede");
    store.createArtifact({ id: "art_d2", type: "decision", title: "Which? (revised)", parentId: "art_d", version: 2, content: { decisionId: "dec_d2", question: "Which?", options: OPTS } });
    const app = withHash(createHttpRoutes(store, fx.dir, () => {}), fx.dir);
    const body = await (await app.request("/api/decisions/dec_d", json({ optionId: "a" }))).json();
    expect(body.supersededBy).toEqual({ artifactId: "art_d2", decisionId: "dec_d2" });
    expect(body.successorStatus).toBeUndefined();
  });
});
