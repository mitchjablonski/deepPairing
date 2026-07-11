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
 * #160 — closes the remaining tool-input gaps: present_plan / present_spec /
 * present_options / log_reasoning now scan + persist the same way, and every
 * match carries its LOCATION (content field path + 1-based line — derived
 * from the match index, never the value).
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
      { pattern: "AKIA", label: "AWS access key id", field: "after", line: 1 },
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
      { pattern: "AKIA", label: "AWS access key id", field: "after", line: 1 },
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
    // #160 — the match names the exact content field + line it was found in.
    expect(artifact?.secretWarnings).toEqual([
      { pattern: "AKIA", label: "AWS access key id", field: "findings[0].evidence[0].snippet", line: 1 },
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
    // #160 — the revision's re-scan carries the location too: the key moved
    // to line 2 of `after` and the warning says so.
    expect(v2?.secretWarnings).toEqual([
      { pattern: "AKIA", label: "AWS access key id", field: "after", line: 2 },
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

// #160 — the four tool inputs that were NEVER scanned (the real hole from the
// #158 report): present_plan, present_spec, present_options, log_reasoning.
// Each persists the same shape present_code_change/present_findings do, so
// the #158 banner + check_feedback consumers work for free.
describe("#160 — present_plan persists secretWarnings", () => {
  it("flags a secret pasted into a step's reasoning, with field + line", async () => {
    await callTool("present_plan", {
      title: "Deploy pipeline",
      steps: [
        { description: "build", reasoning: "clean" },
        { description: "seed env", reasoning: `set the vars:\nAWS_ACCESS_KEY_ID=${FAKE_AWS_KEY}` },
      ],
      estimatedChanges: 2,
    });
    const [artifact] = await ctx.store.getArtifacts();
    expect(artifact?.type).toBe("plan");
    expect(artifact?.secretWarnings).toEqual([
      { pattern: "AKIA", label: "AWS access key id", field: "steps[1].reasoning", line: 2 },
    ]);
    expect(JSON.stringify(artifact!.secretWarnings)).not.toContain(FAKE_AWS_KEY);
    const warning = ctx.broadcasts.find((b) => b.type === "secret_warning");
    expect(warning?.labels).toEqual(["AWS access key id"]);
  });

  it("stores NO secretWarnings on a clean plan", async () => {
    await callTool("present_plan", {
      title: "Refactor",
      steps: [{ description: "extract helper", reasoning: "reuse" }],
      estimatedChanges: 1,
    });
    const [artifact] = await ctx.store.getArtifacts();
    expect(artifact).toBeDefined();
    expect("secretWarnings" in artifact!).toBe(false);
    expect(ctx.broadcasts.find((b) => b.type === "secret_warning")).toBeUndefined();
  });
});

describe("#160 — present_spec persists secretWarnings", () => {
  it("flags a secret pasted into the design notes", async () => {
    await callTool("present_spec", {
      title: "Auth spec",
      objective: "ship login",
      requirements: [
        { id: "REQ-1", statement: "users log in", rationale: "core", acceptanceCriteria: ["works"] },
      ],
      design: `example config:\ntoken: ghp_abcdefghijklmnopqrst1234`,
    });
    const [artifact] = await ctx.store.getArtifacts();
    expect(artifact?.type).toBe("spec");
    expect(artifact?.secretWarnings).toEqual([
      { pattern: "ghp_", label: "GitHub personal access token", field: "design", line: 2 },
    ]);
  });

  it("stores NO secretWarnings on a clean spec", async () => {
    await callTool("present_spec", {
      title: "Docs spec",
      objective: "improve docs",
      requirements: [
        { id: "REQ-1", statement: "readme is current", rationale: "onboarding", acceptanceCriteria: ["reads well"] },
      ],
    });
    const [artifact] = await ctx.store.getArtifacts();
    expect(artifact).toBeDefined();
    expect("secretWarnings" in artifact!).toBe(false);
  });
});

describe("#160 — present_options persists secretWarnings", () => {
  it("flags a secret pasted into an option description", async () => {
    await callTool("present_options", {
      context: "Which auth flow?",
      options: [
        { id: "a", title: "OAuth", description: "standard", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
        { id: "b", title: "Hardcode", description: `just use\nkey ${FAKE_AWS_KEY} inline`, pros: [], cons: [], effort: "low", risk: "high", recommendation: false },
      ],
    });
    const [artifact] = await ctx.store.getArtifacts();
    expect(artifact?.type).toBe("decision");
    expect(artifact?.secretWarnings).toEqual([
      { pattern: "AKIA", label: "AWS access key id", field: "options[1].description", line: 2 },
    ]);
    expect(JSON.stringify(artifact!.secretWarnings)).not.toContain(FAKE_AWS_KEY);
  });

  it("stores NO secretWarnings on a clean decision", async () => {
    await callTool("present_options", {
      context: "Which cache?",
      options: [
        { id: "a", title: "Redis", description: "external", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
        { id: "b", title: "In-proc", description: "simple", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
      ],
    });
    const [artifact] = await ctx.store.getArtifacts();
    expect(artifact).toBeDefined();
    expect("secretWarnings" in artifact!).toBe(false);
  });
});

describe("#160 — log_reasoning persists secretWarnings (reasoning IS an artifact)", () => {
  it("flags a secret pasted into the reasoning prose", async () => {
    await callTool("log_reasoning", {
      action: "configure client",
      reasoning: `re-using the existing credential:\nsk-abcdefghijklmnopqrstuvEXAMPLE`,
      confidence: "high",
    });
    const [artifact] = await ctx.store.getArtifacts();
    expect(artifact?.type).toBe("reasoning");
    expect(artifact?.secretWarnings).toEqual([
      { pattern: "sk-", label: "OpenAI / Anthropic-shape API key", field: "reasoning", line: 2 },
    ]);
  });

  it("stores NO secretWarnings on clean reasoning", async () => {
    await callTool("log_reasoning", {
      action: "pick a pattern",
      reasoning: "debounce beats throttle here",
      confidence: "high",
    });
    const [artifact] = await ctx.store.getArtifacts();
    expect(artifact).toBeDefined();
    expect("secretWarnings" in artifact!).toBe(false);
  });
});
