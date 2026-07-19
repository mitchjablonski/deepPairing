import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileStore } from "../file-store.js";
import { setGlobalStoreForTests, getGlobalStore } from "../global-store.js";
import { composeOptionRejectReason, recordRejectedOption, recordRejectedOptionConcept, optionConceptKey } from "../rejected-option-recorder.js";
import type { DecisionOption } from "@deeppairing/shared";

function opt(over: Partial<DecisionOption> = {}): DecisionOption {
  return {
    id: "o1",
    title: "Redis",
    description: "in-memory cache",
    pros: [],
    cons: [],
    effort: "low",
    risk: "low",
    recommendation: false,
    ...over,
  };
}

describe("#169 rejected-option-recorder (shared logic)", () => {
  let tmpDir: string;
  let store: FileStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-ror-test-"));
    setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
    store = new FileStore(tmpDir, "test_session");
  });
  afterEach(() => {
    store.forceFlush();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    setGlobalStoreForTests(null);
  });

  describe("composeOptionRejectReason", () => {
    it("prefers the option's own cons and appends the context suffix", () => {
      const reason = composeOptionRejectReason(
        opt({ cons: ["cold-start latency", "eviction complexity"] }),
        " — you rejected this framing: wrong question",
        "wrong question",
      );
      expect(reason).toBe("cold-start latency; eviction complexity — you rejected this framing: wrong question");
    });

    it("falls back to the shared reason when the option lists no cons", () => {
      const reason = composeOptionRejectReason(opt({ cons: [] }), " — suffix ignored", "wrong question, not wrong options");
      expect(reason).toBe("wrong question, not wrong options");
    });

    it("bounds the composed reason to ~240 chars with an ellipsis (matches the legacy 237+…)", () => {
      const longCon = "x".repeat(300);
      const reason = composeOptionRejectReason(opt({ cons: [longCon] }), "", undefined);
      expect(reason).toBeDefined();
      expect(reason!.length).toBeLessThanOrEqual(240);
      expect(reason!.length).toBe(238); // slice(0,237) + "…"
      expect(reason!.endsWith("…")).toBe(true);
    });

    it("filters blank/whitespace cons before composing", () => {
      const reason = composeOptionRejectReason(opt({ cons: ["  ", "real con", ""] }), "", "fallback");
      expect(reason).toBe("real con");
    });
  });

  describe("recordRejectedOption", () => {
    it("keys the session ledger on `${context}: ${title}` and the concept on option.concept.name", async () => {
      const broadcasts: any[] = [];
      await recordRejectedOption(store, (e) => broadcasts.push(e), {
        context: "Which cache strategy?",
        option: opt({ title: "Redis", concept: { name: "redis for caching" } }),
        reason: "wrong question, not wrong options",
        sourceArtifactId: "art_dec",
      });

      const rejected = store.getSessionMemory().rejectedApproaches;
      expect(rejected).toHaveLength(1);
      expect(rejected[0].description).toBe("Which cache strategy?: Redis");
      expect(rejected[0].concept).toBe("redis for caching");
      expect(rejected[0].reason).toBe("wrong question, not wrong options");
      expect(rejected[0].sourceArtifactId).toBe("art_dec");

      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0]).toMatchObject({
        type: "ledger_write",
        kind: "rejected",
        description: "Which cache strategy?: Redis",
        concept: "redis for caching",
      });
    });

    it("falls back to option.description as the concept key when no concept is named", async () => {
      await recordRejectedOption(store, () => {}, {
        context: "Which cache?",
        option: opt({ title: "Memcached", description: "simple LRU cache", concept: undefined }),
        reason: "r",
      });
      const rejected = store.getSessionMemory().rejectedApproaches;
      expect(rejected[0].concept).toBe("simple LRU cache");
    });

    it("#169 F2 — recordRejectedOptionConcept keys on the CONCEPT ONLY (no context prefix)", async () => {
      const broadcasts: any[] = [];
      await recordRejectedOptionConcept(store, (e) => broadcasts.push(e), {
        option: opt({ title: "Redis", description: "network cache", concept: { name: "redis for caching" } }),
        reason: "none of these fit",
        sourceArtifactId: "art_dec",
      });
      const rejected = store.getSessionMemory().rejectedApproaches;
      expect(rejected).toHaveLength(1);
      // Both description AND concept are the concept key — no "Context: Title".
      expect(rejected[0].description).toBe("redis for caching");
      expect(rejected[0].concept).toBe("redis for caching");
      expect(rejected[0].reason).toBe("none of these fit");
      expect(broadcasts[0]).toMatchObject({ type: "ledger_write", kind: "rejected", concept: "redis for caching" });
    });

    it("#169 F2 — optionConceptKey falls back concept.name → description → title", () => {
      expect(optionConceptKey(opt({ concept: { name: "named concept" }, description: "d", title: "T" }))).toBe("named concept");
      expect(optionConceptKey(opt({ concept: undefined, description: "prose desc", title: "T" }))).toBe("prose desc");
      expect(optionConceptKey(opt({ concept: undefined, description: "", title: "Just Title" }))).toBe("Just Title");
    });

    it("#193 seam — a DEMO session's option rejection never reaches the REAL cross-project ledger", async () => {
      // demo_-prefixed sessions keep preferences purely in memory and must
      // never mirror into ~/.deeppairing's philosophy ledger. Because
      // recordRejectedOption delegates to recordRejectedApproach, it inherits
      // that isolation for free — this pins it. Force publish ON so the ONLY
      // thing blocking the global mirror is #193's !isDemoSession belt.
      const demoStore = new FileStore(tmpDir, "demo_test");
      demoStore.setGlobalLedgerPublish(true);
      await recordRejectedOption(demoStore, () => {}, {
        context: "Which cache?",
        option: opt({ title: "Redis", concept: { name: "redis for caching" } }),
        reason: "demo fiction",
        sourceArtifactId: "art_demo",
      });
      // Session-local (in-memory demo prefs) still records — the local gate is
      // what arms THIS demo's preflight; only the cross-project mirror is off.
      expect(demoStore.getSessionMemory().rejectedApproaches.map((r) => r.concept)).toContain("redis for caching");
      // The REAL global philosophy ledger stays untouched.
      expect(getGlobalStore().size()).toBe(0);
      expect(getGlobalStore().get("redis for caching")).toBeNull();
      demoStore.forceFlush();
    });
  });
});
