/**
 * #470 slice 2 — the export lists every allowance used in the session, built
 * from the artifacts' own `admission` stamps (no agent prose can drop it), and
 * never says "verified" or names a person.
 */
import { describe, expect, it } from "vitest";
import type { Artifact } from "@deeppairing/shared";
import { formatSessionHtml } from "../format-html.js";
import { formatSessionMarkdown, allowedOnceLines } from "../format-markdown.js";

const base = (artifacts: Artifact[]) => ({ sessionId: "s1", artifacts, comments: [], decisions: [], planReviews: [] });
const admitted = {
  id: "art_ok", sessionId: "s1", type: "code_change", version: 1, parentId: null, status: "draft", title: "modify src/config.ts",
  content: { filePath: "src/config.ts", before: "", after: "x" }, agentReasoning: null,
  createdAt: "2026-08-21T09:00:00.000Z", updatedAt: "2026-08-21T09:00:00.000Z",
  admission: { operationId: "op", callFingerprint: "f", effectiveDigest: "d", kind: "create", exceptionIds: ["sx_1"], grantedVia: "cli", followUps: {} },
} as unknown as Artifact;
const plain = { ...admitted, id: "art_plain", title: "other", admission: undefined } as unknown as Artifact;

describe("#470 — Allowed once in the export", () => {
  it("markdown (full) lists admitted artifacts with the door, and nothing when none", () => {
    const md = formatSessionMarkdown(base([admitted, plain]) as never, "full");
    expect(md).toContain("## Allowed once");
    expect(md).toContain("**modify src/config.ts** (`art_ok`) — allowed once past your stance (CLI)");
    expect(md).not.toContain("art_plain`) — allowed once");
    expect(md).not.toMatch(/verified|authenticated/i);
    expect(formatSessionMarkdown(base([plain]) as never, "full")).not.toContain("## Allowed once");
    expect(allowedOnceLines([plain])).toEqual([]);
  });

  it("the HTML page lists them too", () => {
    const html = formatSessionHtml(base([admitted]) as never, { version: "0.1.65", generatedAt: "2026-08-21T12:00:00.000Z", projectName: "p", projectRoot: "/tmp/p" });
    expect(html).toContain("<h2>Allowed once</h2>");
    expect(html).toContain("allowed once (CLI)");
    expect(html).not.toMatch(/verified|authenticated/i);
  });
});
