// O3 (#231) — cross-tab last-wins VERDICT guard. A stale second tab must not be
// able to REVERSE an already-final human verdict (approved↔rejected↔revised).
// Covers: the store backstop, the route 409 + refresh broadcast, and the pinned
// invariants that MUST stay normal (draft→terminal, same-verdict re-assert,
// agent supersede/revise, J1 decision-resolve).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";
import { withHash } from "./routes.harness.js";
import { createHttpRoutes } from "../routes.js";
import { isCrossTerminalVerdictFlip } from "../../store/verdict-guard.js";

let fx: GlobalStoreFixture;
let store: FileStore;
let app: ReturnType<typeof createHttpRoutes>;
let broadcasts: Array<Record<string, unknown>>;

beforeEach(() => {
  fx = withGlobalStore("dp-verdict-guard-");
  store = fx.track(new FileStore(fx.dir, "test_session"));
  broadcasts = [];
  app = withHash(createHttpRoutes(store, fx.dir, (m) => broadcasts.push(m as Record<string, unknown>)), fx.dir);
});

afterEach(() => {
  fx.dispose();
});

const postStatus = (id: string, status: string, feedback?: string) =>
  app.request(`/api/artifacts/${id}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(feedback ? { status, feedback } : { status }),
  });

describe("O3 (#231) — verdict-guard predicate", () => {
  it("flags a human verdict flip between DIFFERENT terminal states", () => {
    expect(isCrossTerminalVerdictFlip("approved", "rejected", "ui_reject_button")).toBe(true);
    expect(isCrossTerminalVerdictFlip("rejected", "approved", "ui_approve_button")).toBe(true);
    expect(isCrossTerminalVerdictFlip("approved", "revised", "ui_revise_button")).toBe(true);
  });

  it("does NOT flag draft→terminal, same-verdict re-assert, or agent transitions", () => {
    // Draft → terminal is the normal first verdict.
    expect(isCrossTerminalVerdictFlip("draft", "approved", "ui_approve_button")).toBe(false);
    expect(isCrossTerminalVerdictFlip("reviewing", "rejected", "ui_reject_button")).toBe(false);
    // Same verdict re-asserted (idempotent double-click) is allowed.
    expect(isCrossTerminalVerdictFlip("approved", "approved", "ui_approve_button")).toBe(false);
    // Agent lifecycle transitions carry non-human reasons → never guarded.
    expect(isCrossTerminalVerdictFlip("approved", "superseded", "agent_supersede")).toBe(false);
    expect(isCrossTerminalVerdictFlip("approved", "rejected", "agent_revise")).toBe(false);
    expect(isCrossTerminalVerdictFlip("approved", "obsolete", "ui_dismiss_obsolete")).toBe(false);
  });
});

describe("O3 (#231) — store backstop", () => {
  it("refuses to reverse an already-final human verdict (approved stays approved)", () => {
    store.createArtifact({ id: "art_1", type: "research", title: "t", content: {} });
    store.updateArtifactStatus("art_1", "approved", "ui_approve_button");
    // A stale tab's reject lands on the store directly.
    store.updateArtifactStatus("art_1", "rejected", "ui_reject_button");
    expect(store.getArtifacts().find((a) => a.id === "art_1")?.status).toBe("approved");
    // No spurious statusHistory entry for the refused flip.
    const history = (store.getArtifacts().find((a) => a.id === "art_1") as { statusHistory?: Array<{ status: string }> }).statusHistory ?? [];
    expect(history.filter((h) => h.status === "rejected")).toHaveLength(0);
  });

  it("allows a same-verdict re-assert and draft→terminal", () => {
    store.createArtifact({ id: "art_2", type: "research", title: "t", content: {} });
    store.updateArtifactStatus("art_2", "approved", "ui_approve_button");
    store.updateArtifactStatus("art_2", "approved", "ui_approve_button"); // idempotent
    expect(store.getArtifacts().find((a) => a.id === "art_2")?.status).toBe("approved");
  });
});

describe("O3 (#231) — HTTP route 409 + refresh", () => {
  it("THE RACE: approved then a stale reject → 409, verdict preserved, truth re-broadcast", async () => {
    store.createArtifact({ id: "art_r", type: "research", title: "t", content: {} });
    const ok = await postStatus("art_r", "approved");
    expect(ok.status).toBe(200);
    broadcasts.length = 0;

    const res = await postStatus("art_r", "rejected", "changed my mind");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("verdict_already_final");
    expect(body.currentStatus).toBe("approved");

    // The verdict is preserved.
    expect(store.getArtifacts().find((a) => a.id === "art_r")?.status).toBe("approved");
    // The stale tab is refreshed to the TRUE status (not the attempted reject).
    const refresh = broadcasts.find((b) => b.type === "artifact_updated");
    expect(refresh).toMatchObject({ artifactId: "art_r", status: "approved" });
  });

  it("draft→approved is unaffected (200) and a same-verdict re-assert is not a 409", async () => {
    store.createArtifact({ id: "art_ok", type: "research", title: "t", content: {} });
    expect((await postStatus("art_ok", "approved")).status).toBe(200);
    // Re-asserting the SAME verdict is idempotent, not a conflict.
    expect((await postStatus("art_ok", "approved")).status).toBe(200);
    expect(store.getArtifacts().find((a) => a.id === "art_ok")?.status).toBe("approved");
  });

  it("an AGENT supersede after a human approve is NOT blocked (revise lifecycle intact)", () => {
    store.createArtifact({ id: "art_s", type: "plan", title: "t", content: { steps: [] } });
    store.updateArtifactStatus("art_s", "approved", "ui_approve_button");
    // The agent supersedes with a v2 — a non-human reason, so it flows through.
    store.updateArtifactStatus("art_s", "superseded", "agent_supersede");
    expect(store.getArtifacts().find((a) => a.id === "art_s")?.status).toBe("superseded");
  });

  it("J1 decision-resolve still flips a draft decision to approved", async () => {
    store.createArtifact({
      id: "art_dec",
      type: "decision",
      title: "Which hash?",
      content: { decisionId: "dec_1", question: "Which hash?", options: [{ id: "opt_a", title: "argon2id" }] },
    });
    const res = await app.request("/api/decisions/dec_1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ optionId: "opt_a", reasoning: "modern" }),
    });
    expect(res.status).toBe(200);
    expect(store.getArtifacts().find((a) => a.id === "art_dec")?.status).toBe("approved");
  });
});
