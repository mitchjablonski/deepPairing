/**
 * #470 — §10 unit: the call fingerprint, the effective snapshot + digest, the
 * declared preconditions, and the claim-time re-resolution.
 */
import { describe, expect, it } from "vitest";
import type { Artifact, ProposalSnapshot } from "@deeppairing/shared";
import {
  EXCEPTION_TOOL_TYPES,
  callFingerprint,
  checkPreconditions,
  deriveReviseContent,
  effectiveDigest,
  finalizeReviseContent,
  resolveCodeChange,
  reviseSnapshot,
  reviseTargetPrecondition,
  type ProposalStoreReader,
} from "../proposal-resolution.js";

const art = (over: Partial<Artifact> & { id: string; type: Artifact["type"] }): Artifact => ({
  sessionId: "s", version: 1, parentId: null, title: "T", status: "draft", content: {}, agentReasoning: null,
  createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z", ...over,
});
const code = (id: string, after: string, createdAt: string) =>
  art({ id, type: "code_change", content: { filePath: "src/a.ts", after, before: "" }, createdAt });

/** A store reader that records whether the resolver read store state. */
function recordingReader(artifacts: Artifact[]) {
  const reads: string[] = [];
  const reader: ProposalStoreReader = { getArtifacts: () => { reads.push("getArtifacts"); return artifacts; } };
  return { reader, reads };
}

describe("call fingerprint (§2)", () => {
  const args = { filePath: "src/a.ts", after: "x", reasoning: "Remove global mutable state" };
  it("is computed from RAW args: identical raw calls match even when history changed", () => {
    expect(callFingerprint("present_code_change", args)).toBe(callFingerprint("present_code_change", { ...args }));
  });
  it("is stable across key order", () => {
    expect(callFingerprint("present_code_change", { reasoning: args.reasoning, after: "x", filePath: "src/a.ts" }))
      .toBe(callFingerprint("present_code_change", args));
  });
  it("every argument changes it, and so does the tool", () => {
    const base = callFingerprint("present_code_change", args);
    for (const key of Object.keys(args)) {
      expect(callFingerprint("present_code_change", { ...args, [key]: `${(args as Record<string, string>)[key]}!` })).not.toBe(base);
    }
    expect(callFingerprint("present_code_change", { ...args, extra: 1 })).not.toBe(base);
    expect(callFingerprint("present_options", args)).not.toBe(base);
  });
  it("a top-level arguments._meta does not change it", () => {
    expect(callFingerprint("present_code_change", { ...args, _meta: { progressToken: 3 } })).toBe(callFingerprint("present_code_change", args));
  });
  it("whitespace, case and NFC versus NFD all change it", () => {
    const base = callFingerprint("present_code_change", { ...args, reasoning: "café" });
    expect(callFingerprint("present_code_change", { ...args, reasoning: "café " })).not.toBe(base);
    expect(callFingerprint("present_code_change", { ...args, reasoning: "Café" })).not.toBe(base);
    expect(callFingerprint("present_code_change", { ...args, reasoning: "café".normalize("NFD") })).not.toBe(base);
  });
});

describe("effective snapshot + preconditions (§2)", () => {
  it("present_code_change with `before` omitted captures the reconstructed before, the corrected changeType and the prior", async () => {
    const prior = code("art_p1", "old body", "2026-10-10T00:00:01.000Z");
    const older = code("art_p0", "older body", "2026-10-10T00:00:00.000Z");
    const { reader, reads } = recordingReader([older, prior]);
    const r = await resolveCodeChange(reader, { filePath: "src/a.ts", before: "", changeType: "create" });
    expect(reads).toEqual(["getArtifacts"]);
    expect(r).toMatchObject({ before: "old body", changeType: "modify", resolvable: true });
    expect(r.precondition).toMatchObject({ kind: "code_change_prior", priorCodeChangeId: "art_p1" });
  });

  it("with `before` supplied it reads no store state and declares no precondition", async () => {
    const { reader, reads } = recordingReader([code("art_p1", "old", "2026-10-10T00:00:01.000Z")]);
    const r = await resolveCodeChange(reader, { filePath: "src/a.ts", before: "given", changeType: "create" });
    expect(reads).toEqual([]);
    expect(r).toMatchObject({ before: "given", changeType: "modify", precondition: null });
  });

  it("history that can't be read makes the proposal unresolvable (never allowance-eligible)", async () => {
    const r = await resolveCodeChange({ getArtifacts: () => { throw new Error("down"); } }, { filePath: "src/a.ts", before: "", changeType: "modify" });
    expect(r.resolvable).toBe(false);
  });

  it("schema-driven: every exception-capable tool that reads store state declares a precondition", async () => {
    // The resolvers are the only store readers in the exception path:
    //  - present_code_change → resolveCodeChange (reads only when before is omitted);
    //  - present_options      → no resolver: its snapshot is a pure function of args;
    //  - revise_artifact      → reads its target, ALWAYS declares revise_target.
    expect(Object.keys(EXCEPTION_TOOL_TYPES).sort()).toEqual(["present_code_change", "present_options", "revise_artifact"]);
    for (const before of ["", "given"]) {
      const { reader, reads } = recordingReader([code("art_p1", "old", "2026-10-10T00:00:01.000Z")]);
      const r = await resolveCodeChange(reader, { filePath: "src/a.ts", before, changeType: "modify" });
      expect(reads.length > 0).toBe(r.precondition !== null);
    }
    const target = art({ id: "art_t", type: "research", title: "T" });
    expect(reviseTargetPrecondition(target)).toMatchObject({ kind: "revise_target", targetId: "art_t", targetVersion: 1, targetStatus: "draft" });
  });

  it("revise captures the inherited title, provenance (never headSha), stakes, refs, feature, parentId/version, and drops review state", () => {
    const external = art({
      id: "art_cs", type: "changeset", title: "PR #1", version: 3, featureId: "auth", relatedArtifactIds: ["art_x"],
      content: { summary: "s", files: [], reviewIntent: "external", source: { kind: "github-pr", number: 1, url: "u", headSha: "abc123" } },
    });
    const content = finalizeReviseContent(external, deriveReviseContent(external, { summary: "s2", files: [], reviewState: { a: 1 }, reviewReasons: {} }));
    expect(content).toMatchObject({ reviewIntent: "external", source: { kind: "github-pr", number: 1, url: "u" } });
    expect((content.source as Record<string, unknown>).headSha).toBeUndefined();
    expect(content.reviewState).toBeUndefined();
    expect(content.reviewReasons).toBeUndefined();
    const snap = reviseSnapshot(external, external.title, "why", content);
    expect(snap).toMatchObject({ kind: "revise", title: "PR #1", parentId: "art_cs", version: 4, feature: "auth", relatedArtifactIds: ["art_x"], agentReasoning: "why" });

    const decision = art({ id: "art_d", type: "decision", content: { context: "c", options: [], stakes: "high", decisionId: "dec_old" } });
    const dContent = finalizeReviseContent(decision, deriveReviseContent(decision, { context: "c2", options: [], decisionId: "dec_agent" }));
    expect(dContent.stakes).toBe("high");
    expect(dContent.decisionId).toBeUndefined(); // minted by the daemon at admission
  });

  it("the effective digest changes whenever any captured field or precondition changes", () => {
    const snap: ProposalSnapshot = { kind: "create", type: "code_change", title: "modify a", content: { after: "x" } };
    const pre = [{ kind: "code_change_prior" as const, filePath: "a", priorCodeChangeId: "art_1", priorAfterHash: "h" }];
    const base = effectiveDigest(snap, pre);
    expect(effectiveDigest({ ...snap, title: "modify b" }, pre)).not.toBe(base);
    expect(effectiveDigest({ ...snap, content: { after: "y" } }, pre)).not.toBe(base);
    expect(effectiveDigest({ ...snap, feature: "f" }, pre)).not.toBe(base);
    expect(effectiveDigest(snap, [{ ...pre[0]!, priorAfterHash: "h2" }])).not.toBe(base);
    expect(effectiveDigest(snap, [])).not.toBe(base);
  });
});

describe("claim-time re-resolution (checkPreconditions)", () => {
  const p1 = code("art_p1", "one", "2026-10-10T00:00:01.000Z");
  it("passes when nothing moved, and names a newer prior / an edited prior / an appeared prior", async () => {
    const r = await resolveCodeChange({ getArtifacts: () => [p1] }, { filePath: "src/a.ts", before: "", changeType: "modify" });
    expect(checkPreconditions([p1], [r.precondition!])).toEqual({ ok: true });
    expect(checkPreconditions([p1, code("art_p2", "two", "2026-10-10T00:00:02.000Z")], [r.precondition!]))
      .toMatchObject({ ok: false, what: "prior", dependencyId: "art_p1", detail: "newer_prior" });
    expect(checkPreconditions([{ ...p1, content: { ...p1.content, after: "edited" } }], [r.precondition!]))
      .toMatchObject({ ok: false, detail: "prior_edited" });
    const none = await resolveCodeChange({ getArtifacts: () => [] }, { filePath: "src/a.ts", before: "", changeType: "create" });
    expect(checkPreconditions([p1], [none.precondition!])).toMatchObject({ ok: false, detail: "prior_appeared", dependencyId: null });
  });

  it("a revise target: revised, status moved, or any inheritable field changed (incl. external provenance) refuses", () => {
    const target = art({ id: "art_t", type: "changeset", title: "PR", content: { summary: "s", files: [], reviewIntent: "external", source: { kind: "github-pr", number: 1, url: "u", headSha: "a" } } });
    const pre = [reviseTargetPrecondition(target)];
    expect(checkPreconditions([target], pre)).toEqual({ ok: true });
    expect(checkPreconditions([target, art({ id: "art_v2", type: "changeset", parentId: "art_t" })], pre)).toMatchObject({ ok: false, detail: "target_revised" });
    expect(checkPreconditions([{ ...target, status: "rejected" }], pre)).toMatchObject({ ok: false, detail: "target_status" });
    expect(checkPreconditions([{ ...target, title: "PR (renamed)" }], pre)).toMatchObject({ ok: false, detail: "target_changed" });
    const moved = { ...target, content: { ...target.content, source: { kind: "github-pr", number: 2, url: "u2", headSha: "a" } } };
    expect(checkPreconditions([moved], pre)).toMatchObject({ ok: false, detail: "target_changed" });
    // headSha alone is never inherited, so it is not a dependency.
    const newHead = { ...target, content: { ...target.content, source: { kind: "github-pr", number: 1, url: "u", headSha: "b" } } };
    expect(checkPreconditions([newHead], pre)).toEqual({ ok: true });
    expect(checkPreconditions([], pre)).toMatchObject({ ok: false, detail: "target_missing" });
  });
});
