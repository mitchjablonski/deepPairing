import { describe, it, expect } from "vitest";
import { FileStore } from "../../store/file-store.js";
import { setupServerTest, makeCallTool } from "./server-test-harness.js";

/**
 * #158 — the secret scanner's output must PERSIST, not just broadcast.
 *
 * Pre-#158, present_code_change / present_findings ran scanManyForSecrets and
 * emitted a `secret_warning` WS event — which nothing consumed, and which in
 * daemon mode (the only production wiring) was a no-op broadcast. The scan
 * result is now also stored on the artifact (`secretWarnings`: pattern prefix
 * + label, NEVER the matched value) so the companion UI banner and the
 * check_feedback pending line can render it, including after a reload.
 *
 * Fixture secrets are documented example values (AWS's AKIAIOSFODNN7EXAMPLE),
 * never real credentials.
 */
const FAKE_AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

const ctx = setupServerTest();
const callTool = makeCallTool(ctx);

describe("#158 — present_code_change persists secretWarnings", () => {
  it("stores pattern+label on the artifact when the change contains a secret shape — and still broadcasts", async () => {
    await callTool("present_code_change", {
      filePath: "src/config.ts",
      changeType: "modify",
      before: "const key = process.env.AWS_KEY;",
      after: `const key = "${FAKE_AWS_KEY}";`,
      reasoning: "hardcode the key for the demo",
    });

    const [artifact] = await ctx.store.getArtifacts();
    expect(artifact).toBeDefined();
    expect(artifact!.secretWarnings).toEqual([
      { pattern: "AKIA", label: "AWS access key id" },
    ]);
    // The warning metadata must never carry the matched value itself.
    expect(JSON.stringify(artifact!.secretWarnings)).not.toContain(FAKE_AWS_KEY);

    // The legacy fire-and-forget broadcast is kept (loud on the wire in
    // standalone wiring), now alongside the persisted field.
    const warning = ctx.broadcasts.find((b) => b.type === "secret_warning");
    expect(warning).toBeDefined();
    expect(warning.artifactId).toBe(artifact!.id);
    expect(warning.labels).toEqual(["AWS access key id"]);
  });

  it("stores NO secretWarnings key on a clean change", async () => {
    await callTool("present_code_change", {
      filePath: "src/math.ts",
      changeType: "modify",
      before: "export const add = (a, b) => a + b;",
      after: "export const add = (a: number, b: number) => a + b;",
      reasoning: "add types",
    });

    const [artifact] = await ctx.store.getArtifacts();
    expect(artifact).toBeDefined();
    // Key OMITTED (not an empty array) so clean stored JSON is unchanged.
    expect("secretWarnings" in artifact!).toBe(false);
    expect(ctx.broadcasts.find((b) => b.type === "secret_warning")).toBeUndefined();
  });

  it("SURVIVES A RELOAD: a fresh FileStore over the same dir still reads the warning", async () => {
    await callTool("present_code_change", {
      filePath: "src/config.ts",
      changeType: "modify",
      before: "x",
      after: `const key = "${FAKE_AWS_KEY}";`,
      reasoning: "r",
    });
    ctx.store.forceFlush();

    // A brand-new store instance = the daemon restarting / the page reloading
    // and rehydrating from disk. The warning must come back with the artifact.
    const rehydrated = new FileStore(ctx.tmpDir, "test_session");
    const [artifact] = rehydrated.getArtifacts();
    expect(artifact?.secretWarnings).toEqual([
      { pattern: "AKIA", label: "AWS access key id" },
    ]);
  });
});

describe("#158 — present_findings persists secretWarnings", () => {
  it("flags a secret pasted into an evidence snippet", async () => {
    await callTool("present_findings", {
      title: "Auth audit",
      summary: "Found a hardcoded credential.",
      findings: [
        {
          category: "security",
          title: "Hardcoded AWS key",
          detail: "The config hardcodes a credential.",
          evidence: [
            {
              filePath: "src/config.ts",
              lineStart: 3,
              lineEnd: 3,
              snippet: `const key = "${FAKE_AWS_KEY}";`,
              explanation: "credential in source",
            },
          ],
          significance: "high",
          impact: "credential leak",
          recommendation: "move to env",
        },
      ],
    });

    const [artifact] = await ctx.store.getArtifacts();
    expect(artifact?.type).toBe("research");
    expect(artifact?.secretWarnings).toEqual([
      { pattern: "AKIA", label: "AWS access key id" },
    ]);
  });

  it("stores NO secretWarnings on clean findings", async () => {
    await callTool("present_findings", {
      title: "Docs audit",
      summary: "Everything is fine.",
      findings: [
        {
          category: "quality",
          title: "README is current",
          detail: "No drift found.",
          significance: "low",
          evidence: "README.md matches the CLI surface.",
        },
      ],
    });
    const [artifact] = await ctx.store.getArtifacts();
    expect(artifact).toBeDefined();
    expect("secretWarnings" in artifact!).toBe(false);
  });
});

describe("#158 — revise_artifact re-scans the superseding content", () => {
  it("a v2 that still contains the secret keeps a warning; a cleaned v2 drops it", async () => {
    await callTool("present_code_change", {
      filePath: "src/config.ts",
      changeType: "modify",
      before: "x",
      after: `const key = "${FAKE_AWS_KEY}";`,
      reasoning: "r",
    });
    const [v1] = await ctx.store.getArtifacts();
    expect(v1?.secretWarnings).toHaveLength(1);

    // v2 still carries the secret → re-scan must flag it again.
    await callTool("revise_artifact", {
      artifactId: v1!.id,
      mode: "supersede",
      reason: "tweak",
      content: {
        filePath: "src/config.ts",
        changeType: "modify",
        before: "x",
        after: `// keep\nconst key = "${FAKE_AWS_KEY}";`,
        reasoning: "r2",
      },
    });
    const v2 = (await ctx.store.getArtifacts()).find((a) => a.version === 2);
    expect(v2?.secretWarnings).toEqual([
      { pattern: "AKIA", label: "AWS access key id" },
    ]);

    // v3 removes the secret → the warning honestly clears.
    await callTool("revise_artifact", {
      artifactId: v2!.id,
      mode: "supersede",
      reason: "remove the hardcoded key",
      content: {
        filePath: "src/config.ts",
        changeType: "modify",
        before: "x",
        after: "const key = process.env.AWS_KEY;",
        reasoning: "r3",
      },
    });
    const v3 = (await ctx.store.getArtifacts()).find((a) => a.version === 3);
    expect(v3).toBeDefined();
    expect("secretWarnings" in v3!).toBe(false);
  });
});
