import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { handleCheckFeedback } from "../tools/check-feedback.js";
import type { ToolContext } from "../tools/types.js";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";

/**
 * G1 (#198a) — the #199 suggested-edits machinery now lives on the changeset
 * surface too. The delivery lane (deliverComment) is artifact-type-agnostic, so
 * a suggestion posted on a CHANGESET file reads back with its file context and
 * is covered by the same must-respond guard as a code_change suggestion. These
 * pin that on a real changeset artifact (fake FileStore, no mocks).
 */

let fx: GlobalStoreFixture;
let tmpDir: string;
beforeEach(() => {
  fx = withGlobalStore("dp-cf-cs-sugg-");
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

function seedChangeset(store: FileStore) {
  return store.createArtifact({
    id: "art_cs",
    type: "changeset",
    title: "Move TTL refresh into middleware",
    content: {
      files: [
        {
          path: "auth/middleware.ts",
          changeType: "modified",
          hunks: [{
            header: "@@ -24,3 +24,4 @@",
            lines: [
              { kind: "del", content: "const s = await store.get(sid);", oldLine: 26 },
              { kind: "add", content: "const s = await store.getAndTouch(sid);", newLine: 26 },
            ],
          }],
        },
      ],
    },
  });
}

describe("#198a check_feedback delivers a changeset-file suggestion with file context", () => {
  it("a new-side suggestion on a changeset file delivers with the file path + must-respond guard", async () => {
    const store = fx.track(new FileStore(tmpDir, "s1"));
    seedChangeset(store);
    store.addComment({
      id: "cmt_cs_sug",
      artifactId: "art_cs",
      content: "prefer an explicit option",
      author: "human",
      intent: "suggestion",
      target: { artifactId: "art_cs", filePath: "auth/middleware.ts", lineStart: 26, lineEnd: 26 },
      suggestion: {
        originalText: "const s = await store.getAndTouch(sid);",
        replacementText: "const s = await store.getAndTouch(sid, { sliding: true });",
        lineStart: 26,
        lineEnd: 26,
        state: "pending",
      },
    });
    const res = await handleCheckFeedback(makeCtx(store), {});
    const text = res.content[0]!.text as string;
    // The must-respond guard block, and the file-qualified location.
    expect(text).toMatch(/Suggested edits \(1\) — you MUST respond/);
    expect(text).toMatch(/auth\/middleware\.ts:26/);
    const sc = res.structuredContent as { suggestions?: Array<{ file?: string; artifactId?: string; state?: string }> };
    expect(sc.suggestions).toHaveLength(1);
    expect(sc.suggestions![0]!.file).toBe("auth/middleware.ts");
    expect(sc.suggestions![0]!.artifactId).toBe("art_cs");
    expect(sc.suggestions![0]!.state).toBe("pending");
  });

  it("a del-side suggestion on a changeset file still delivers with its file path", async () => {
    const store = fx.track(new FileStore(tmpDir, "s1"));
    seedChangeset(store);
    store.addComment({
      id: "cmt_cs_del_sug",
      artifactId: "art_cs",
      content: "keep this removed",
      author: "human",
      intent: "suggestion",
      target: { artifactId: "art_cs", filePath: "auth/middleware.ts", lineStart: 26, lineEnd: 26, side: "old" },
      suggestion: {
        originalText: "const s = await store.get(sid);",
        replacementText: "// intentionally removed",
        lineStart: 26,
        lineEnd: 26,
        state: "pending",
      },
    });
    const res = await handleCheckFeedback(makeCtx(store), {});
    const sc = res.structuredContent as { suggestions?: Array<{ file?: string }> };
    expect(sc.suggestions).toHaveLength(1);
    expect(sc.suggestions![0]!.file).toBe("auth/middleware.ts");
  });
});
