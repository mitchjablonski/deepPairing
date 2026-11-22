/**
 * #679 — the CLI's mapping from the daemon's present-page result to the JSON
 * receipt `deeppairing present page` prints. Pure function, real inputs.
 */
import { describe, expect, it } from "vitest";
import { pageReceiptFromResult } from "../standalone-session.js";

const receipt = { sessionId: "review_x", requestId: "11111111-1111-4111-8111-111111111111" };
const url = "http://localhost:20001/?session=review_x";
const ok = (structuredContent: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: "ok" }], structuredContent });

describe("pageReceiptFromResult", () => {
  it("passes a fresh file-backed present through", () => {
    expect(pageReceiptFromResult(receipt, url, ok({ artifactId: "art_1", sourcePath: "docs/p.html" })))
      .toEqual({ ...receipt, artifactId: "art_1", companionUrl: url, sourcePath: "docs/p.html" });
  });

  it("carries status, the successor (including currentStatus) and the moved note on a replay", () => {
    expect(pageReceiptFromResult(receipt, url, ok({
      artifactId: "art_1", sourcePath: "docs/p.html", replayed: true, status: "superseded",
      currentArtifactId: "art_2", currentVersion: 2, currentStatus: "draft",
    }))).toEqual({
      ...receipt, artifactId: "art_1", companionUrl: url, sourcePath: "docs/p.html", replayed: true, status: "superseded",
      currentArtifactId: "art_2", currentVersion: 2, currentStatus: "draft",
      note: "replayed; the page has since moved to v2 (art_2)",
    });
  });

  it("keeps a still-approved parent's real status beside its successor, and notes a closed page without one", () => {
    expect(pageReceiptFromResult(receipt, url, ok({
      artifactId: "art_1", replayed: true, status: "approved", currentArtifactId: "art_2", currentVersion: 2, currentStatus: "draft",
    }))).toMatchObject({ status: "approved", currentArtifactId: "art_2", currentStatus: "draft", note: "replayed; the page has since moved to v2 (art_2)" });
    expect(pageReceiptFromResult(receipt, url, ok({ artifactId: "art_1", replayed: true, status: "rejected" })))
      .toEqual({ ...receipt, artifactId: "art_1", companionUrl: url, replayed: true, status: "rejected", note: "replayed; the page is rejected" });
    expect(pageReceiptFromResult(receipt, url, ok({ artifactId: "art_1", replayed: true, status: "draft" })))
      .toEqual({ ...receipt, artifactId: "art_1", companionUrl: url, replayed: true, status: "draft" });
  });

  it("maps a gate refusal to the typed receipt with the verbatim reason", () => {
    expect(pageReceiptFromResult(receipt, url, {
      content: [{ type: "text", text: "Blocked." }], isError: true,
      structuredContent: { code: "rejected_approach_blocked", reason: "No Redis here." },
    })).toEqual({
      ...receipt, isError: true, code: "rejected_approach_blocked", reason: "No Redis here.",
      message: "Blocked. Reuse the request ID for unchanged input. Use a new UUID if you change the input.",
    });
  });
});
