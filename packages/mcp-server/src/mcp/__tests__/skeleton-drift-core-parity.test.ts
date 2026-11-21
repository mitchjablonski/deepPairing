/**
 * #686 P2c — skeleton-drift.ts must stay Node built-ins only (the bundled Stop
 * hook reaches it), so it mirrors three tiny helpers from @deeppairing/shared
 * instead of importing them. This pins the mirrors to the originals.
 */
import { describe, expect, it } from "vitest";
import * as shared from "@deeppairing/shared";
import { SKELETON_VISUAL_PREFIX, isLivePlanVersion, isSkeletonApprovedVisualId } from "../skeleton-drift.js";

describe("skeleton-drift built-ins mirrors", () => {
  it("the approved-visual prefix and predicate match shared", () => {
    expect(SKELETON_VISUAL_PREFIX).toBe(shared.SKELETON_VISUAL_PREFIX);
    for (const id of ["skelcode:a.ts", "skelcode-live:a.ts", "skelcode:", "x", 3, undefined, null]) {
      expect(isSkeletonApprovedVisualId(id)).toBe(shared.isSkeletonApprovedVisualId(id));
    }
  });

  it("isLivePlanVersion matches shared across statuses, types and lineage", () => {
    const statuses = ["draft", "approved", "rejected", "revised", "superseded", "retracted", "obsolete"];
    for (const type of ["plan", "spec"]) {
      for (const status of statuses) {
        for (const all of [[], [{ parentId: "a" }], [{ parentId: "b" }, { parentId: null }]]) {
          const art = { id: "a", type, status };
          expect(isLivePlanVersion(art, all)).toBe(shared.isLivePlanVersion(art, all));
        }
      }
    }
  });
});
