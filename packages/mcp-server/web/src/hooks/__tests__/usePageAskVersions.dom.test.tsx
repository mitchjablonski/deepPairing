/**
 * #727 — the asks parse for page versions: a version whose HTML doesn't parse
 * counts as parsed (never pending forever), and a version the shared LRU
 * evicts while the page is mounted is parsed again.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { Artifact } from "@deeppairing/shared";
import { usePageAskVersions } from "../usePageAskVersions";
import { peekVersionAsks, versionAsks } from "../../lib/pageAskVersions";

const page = (id: string, html: string): Artifact =>
  ({
    id, sessionId: "sess_1", type: "page", version: 1, parentId: null, status: "draft",
    title: "P", content: { title: "P", html }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }) as unknown as Artifact;

/** A DOMParser that can't parse anything (a fake, not a mock). */
class ThrowingDOMParser {
  parseFromString(): Document {
    throw new Error("unparseable");
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("usePageAskVersions (#727)", () => {
  it("a version whose HTML doesn't parse is settled: not pending, no asks", async () => {
    vi.stubGlobal("DOMParser", ThrowingDOMParser);
    const v = page(`art_null_${Math.random()}`, '<p id="q" data-dp-question>Q?</p>');
    const { result } = renderHook(() => usePageAskVersions([v], true));
    expect(result.current.pending).toBe(true);
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(peekVersionAsks(v.id)).toBeNull();
    expect(result.current.get(v.id)).toBeUndefined();
  });

  it("parses a version again when the shared cache evicts it while mounted", async () => {
    const v = page(`art_evict_${Math.random()}`, '<p id="q" data-dp-question>Q?</p>');
    const { result, rerender } = renderHook(() => usePageAskVersions([v], true));
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.get(v.id)?.map((a) => a.id)).toEqual(["q"]);
    // Other pages fill the LRU past its cap.
    for (let i = 0; i < 60; i++) versionAsks(`art_fill_${i}_${Math.random()}`, "<p>x</p>");
    expect(peekVersionAsks(v.id)).toBeUndefined();
    rerender();
    expect(result.current.pending).toBe(true);
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.get(v.id)?.map((a) => a.id)).toEqual(["q"]);
  });

  it("disabled: nothing is requested or pending", () => {
    const v = page(`art_off_${Math.random()}`, "<p>x</p>");
    const { result } = renderHook(() => usePageAskVersions([v], false));
    expect(result.current.pending).toBe(false);
  });
});
