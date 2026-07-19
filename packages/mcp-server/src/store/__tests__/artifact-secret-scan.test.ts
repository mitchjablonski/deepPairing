import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileStore } from "../file-store.js";

/**
 * #162 — createArtifact scans artifact content for secret shapes AT THE STORE,
 * mirroring addComment.
 *
 * Pre-#162 the two persistence surfaces were asymmetric: comments were scanned
 * server-side inside FileStore.addComment (an un-suppressable choke point;
 * client-supplied warnings ignored), but artifact secretWarnings were computed
 * in the MCP tool handlers and passed INTO createArtifact, which trusted the
 * param and never re-scanned. A bearer-authed caller POSTing directly to
 * /api/internal/.../artifacts with a secret in `content` and no
 * `secretWarnings` persisted unwarned. Same-uid is the trust boundary, so this
 * is defense-in-depth parity, not an exploit fix: the store is now the
 * authoritative choke point on BOTH surfaces — it recomputes via
 * scanContentForSecrets (field path + line, never the value) and ignores
 * anything the caller claims.
 *
 * Fixture secret is AWS's documented example key, never a real credential.
 */
const FAKE_AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

let tmpDir: string;
let store: FileStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-art-secret-"));
  store = new FileStore(tmpDir, "s1");
});

afterEach(() => {
  store.dispose();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("#162 — createArtifact scans content for secret shapes (parity with addComment)", () => {
  it("PARITY: a secret in content with NO client-supplied warnings still persists secretWarnings", () => {
    // This is the direct-to-store path a bearer-authed caller can reach via
    // POST /api/internal/.../artifacts — no tool handler pre-scan in front.
    const artifact = store.createArtifact({
      id: "art_1",
      type: "code_change",
      title: "modify src/config.ts",
      content: {
        filePath: "src/config.ts",
        changeType: "modify",
        before: "const key = process.env.AWS_KEY;",
        after: `const key = "${FAKE_AWS_KEY}";`,
        reasoning: "hardcode for the demo",
      },
    });
    expect(artifact.secretWarnings).toEqual([
      { pattern: "AKIA", label: "AWS access key id", field: "after", line: 1 },
    ]);
    // The warning metadata must never carry the matched value itself.
    expect(JSON.stringify(artifact.secretWarnings)).not.toContain(FAKE_AWS_KEY);
  });

  it("FORGE-RESISTANCE: client-supplied bogus secretWarnings on clean content are NOT persisted", () => {
    // Simulates a direct internal-route POST whose body claims warnings the
    // content doesn't have (the route's body schema is .passthrough(), so the
    // key reaches the store). The store recomputes — bogus claims vanish.
    const artifact = store.createArtifact({
      id: "art_2",
      type: "research",
      title: "clean",
      content: { summary: "nothing secret here" },
      secretWarnings: [{ pattern: "AKIA", label: "AWS access key id", line: 1 }],
    } as never);
    expect("secretWarnings" in artifact).toBe(false);
  });

  it("clean content → key OMITTED (stored JSON byte-identical for clean artifacts)", () => {
    const artifact = store.createArtifact({
      id: "art_3",
      type: "research",
      title: "clean",
      content: { summary: "debounce beats throttle here" },
    });
    expect("secretWarnings" in artifact).toBe(false);
    store.forceFlush();
    const raw = fs.readFileSync(path.join(tmpDir, ".deeppairing", "sessions", "s1", "artifacts.json"), "utf8");
    expect(raw).not.toContain("secretWarnings");
  });

  it("locations come from the structured walk: field path + 1-based line, deduped per pattern", () => {
    const artifact = store.createArtifact({
      id: "art_4",
      type: "plan",
      title: "deploy",
      content: {
        steps: [
          { description: "build", reasoning: "clean" },
          { description: "seed env", reasoning: `set the vars:\nAWS_ACCESS_KEY_ID=${FAKE_AWS_KEY}` },
        ],
        estimatedChanges: 2,
      },
    });
    expect(artifact.secretWarnings).toEqual([
      { pattern: "AKIA", label: "AWS access key id", field: "steps[1].reasoning", line: 2 },
    ]);
  });

  it("SURVIVES A RELOAD: a fresh FileStore over the same dir still reads the warning", () => {
    store.createArtifact({
      id: "art_5",
      type: "reasoning",
      title: "r",
      content: { reasoning: `key: ${FAKE_AWS_KEY}` },
    });
    store.forceFlush();
    const rehydrated = new FileStore(tmpDir, "s1");
    const [artifact] = rehydrated.getArtifacts();
    expect(artifact?.secretWarnings?.map((w) => w.label)).toEqual(["AWS access key id"]);
    rehydrated.dispose();
  });
});

describe("#162 — updatePlanProgress re-scans (statusNote is the only post-create content mutation)", () => {
  const cleanPlan = () =>
    store.createArtifact({
      id: "art_p",
      type: "plan",
      title: "deploy",
      content: {
        steps: [{ description: "seed env", reasoning: "clean", status: "pending" }],
        estimatedChanges: 1,
      },
    });

  it("a secret pasted into a statusNote gains a warning", () => {
    cleanPlan();
    const updated = store.updatePlanProgress("art_p", [
      { stepIndex: 0, status: "done", statusNote: `used the key ${FAKE_AWS_KEY} directly` },
    ]);
    expect(updated?.secretWarnings).toEqual([
      { pattern: "AKIA", label: "AWS access key id", field: "steps[0].statusNote", line: 1 },
    ]);
    expect(JSON.stringify(updated?.secretWarnings)).not.toContain(FAKE_AWS_KEY);
  });

  it("overwriting the offending statusNote with clean text honestly clears the warning (key removed)", () => {
    cleanPlan();
    store.updatePlanProgress("art_p", [
      { stepIndex: 0, status: "in_progress", statusNote: `key ${FAKE_AWS_KEY}` },
    ]);
    const updated = store.updatePlanProgress("art_p", [
      { stepIndex: 0, status: "done", statusNote: "moved to env var" },
    ]);
    expect(updated).not.toBeNull();
    expect("secretWarnings" in updated!).toBe(false);
  });

  it("a clean progress update leaves a clean plan without the key (stored JSON unchanged)", () => {
    cleanPlan();
    const updated = store.updatePlanProgress("art_p", [{ stepIndex: 0, status: "done" }]);
    expect(updated).not.toBeNull();
    expect("secretWarnings" in updated!).toBe(false);
  });
});
