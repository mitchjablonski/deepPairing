import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { handleCheckFeedback } from "../tools/check-feedback.js";
import { buildFirstCallHint } from "../first-call-hint.js";
import type { ToolContext } from "../tools/types.js";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";
import fs from "node:fs";
import path from "node:path";

/**
 * #204 (code lens F1) — the request composer's free text is HUMAN-authored text
 * that flows into agent context (check_feedback + the first-call obligations
 * inventory) and lands on disk — the SAME risk the comment scan (#160), the
 * artifact-content scan (#158), and the render-failure scan (#176) already cover.
 * It was the last human-text ingress that bypassed the store-authoritative scan.
 * `FileStore.addRequest` now scans and persists a labels-only result; both
 * delivery surfaces append a TEXT-ONLY marker; the structured `requests` mirror
 * is unchanged (healthy-payload contract intact). Fakes, not mocks.
 */

let fx: GlobalStoreFixture;
let tmpDir: string;
beforeEach(() => {
  fx = withGlobalStore("dp-cf-req-secret-");
  tmpDir = fx.dir;
});
afterEach(() => {
  fx.dispose();
});

function makeCtx(store: FileStore): ToolContext {
  return {
    server: { notification: () => {} },
    store,
    broadcast: () => {},
    port: 4000,
    helpers: {} as ToolContext["helpers"],
    state: {
      checkFeedbackPollCount: 0,
      reportedRejectedVerdicts: new Set<string>(),
      reportedPlanVerdicts: new Set<string>(),
    },
    progressToken: "tok",
  } as unknown as ToolContext;
}

const FAKE_AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const FAKE_GH_PAT = "ghp_abcdefghijklmnopqrst1234";

describe("#204 addRequest scans request free text (store-authoritative)", () => {
  it("NEAR-MISS MATRIX: a real-shaped secret is warned (labels only, never the value); benign text stays clean", () => {
    const store = fx.track(new FileStore(tmpDir, "s1"));
    const hot = store.addRequest({ text: `explain why we hard-code ${FAKE_AWS_KEY} in config`, intent: "explain" });
    const benign = store.addRequest({ text: "explain the auth middleware — no secrets here, just AKIA as a prose word", intent: "explain" });

    expect(hot.secretWarnings).toBeDefined();
    expect(hot.secretWarnings!.map((w) => w.label)).toEqual(["AWS access key id"]);
    // Labels/pattern/line only — the matched VALUE is never captured.
    expect(JSON.stringify(hot.secretWarnings)).not.toContain(FAKE_AWS_KEY);

    // Benign text (a bare "AKIA" prose word has no key-shaped payload) stays clean:
    // the field is simply ABSENT so stored JSON is byte-identical to pre-#204.
    expect(benign.secretWarnings).toBeUndefined();
  });

  it("a clean request persists byte-identical (no secretWarnings key on disk)", () => {
    const store = fx.track(new FileStore(tmpDir, "s1"));
    store.addRequest({ text: "the cache layer", intent: "plan" });
    store.forceFlush();
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, ".deeppairing", "sessions", "s1", "requests.json"), "utf8")) as unknown[];
    expect(raw).toHaveLength(1);
    expect("secretWarnings" in (raw[0] as object)).toBe(false);
  });
});

describe("#204 check_feedback delivery marks a scanner-flagged request (text only)", () => {
  it("appends the ⚠ note to the flagged request's line and NOT to a clean one", async () => {
    const store = fx.track(new FileStore(tmpDir, "s1"));
    store.addRequest({ text: `is ${FAKE_AWS_KEY} still valid?`, intent: "status" });
    store.addRequest({ text: "the retry logic", intent: "plan" });

    const res = await handleCheckFeedback(makeCtx(store), {});
    const text = res.content[0]!.text as string;
    expect(text).toMatch(/📨 REQUEST .*still valid\? ⚠ possible secret in this request/);
    expect(text).toContain("the retry logic\n");
    expect(text).not.toMatch(/the retry logic ⚠/);

    // TEXT ONLY: the structured `requests` mirror carries NO secretWarnings key —
    // the healthy-payload contract (byte-parity) is unchanged. (The `text` field
    // necessarily echoes the request verbatim so the agent can act on it — same
    // accepted tradeoff as a comment's `content`; the marker is the delta.)
    const sc = res.structuredContent as { requests?: Array<Record<string, unknown>> };
    expect(sc.requests).toHaveLength(2);
    expect(sc.requests!.some((r) => "secretWarnings" in r)).toBe(false);
  });

  it("a clean request slate delivers no secret text anywhere", async () => {
    const store = fx.track(new FileStore(tmpDir, "s1"));
    store.addRequest({ text: "the migration", intent: "plan" });
    const res = await handleCheckFeedback(makeCtx(store), {});
    expect((res.content[0]!.text as string)).not.toMatch(/possible secret/);
  });
});

describe("#204 first-call obligations inventory marks a scanner-flagged request", () => {
  it("appends the ⚠ note to the flagged request's first-call line", async () => {
    const store = fx.track(new FileStore(tmpDir, "s1"));
    store.addRequest({ text: `rotate ${FAKE_GH_PAT} everywhere`, intent: "status" });
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).toMatch(/pending human request/);
    expect(hint).toMatch(/⚠ possible secret in this request/);
    // The WARNING is the fixed phrase only — it never carries the vendor LABEL
    // (the request `text` itself is necessarily echoed so the agent can act,
    // exactly like a comment body; the label/pattern stay out of the surface).
    expect(hint).not.toContain("GitHub personal access token");
  });

  it("a clean request produces no secret marker in the first-call hint", async () => {
    const store = fx.track(new FileStore(tmpDir, "s1"));
    store.addRequest({ text: "explain the router", intent: "explain" });
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).not.toMatch(/possible secret/);
  });
});

describe("#204 backward compatibility", () => {
  it("an old persisted request WITHOUT the field loads clean (no crash, no phantom warnings)", () => {
    const dir = path.join(tmpDir, ".deeppairing", "sessions", "s_old");
    fs.mkdirSync(dir, { recursive: true });
    // A pre-#204 request record: no `secretWarnings` key at all.
    fs.writeFileSync(
      path.join(dir, "requests.json"),
      JSON.stringify([{ id: "req_old", text: "the legacy path", intent: "explain", createdAt: new Date().toISOString() }]),
    );
    const store = fx.track(new FileStore(tmpDir, "s_old"));
    const reqs = store.getPendingRequests();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.text).toBe("the legacy path");
    expect(reqs[0]!.secretWarnings).toBeUndefined();
  });
});
