import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * #487 review — a lint-like guard so a NEW act path can't ship ungated.
 *
 * "Act calls" are found mechanically, not listed by hand:
 *   - every store action (web/src/stores/*.ts) that writes to the daemon —
 *     an `async` action whose body uses safeFetch / optimisticArtifactPatch or
 *     a POST/PUT/PATCH/DELETE — e.g. submitComment, updateArtifactStatus,
 *     resolveSuggestion, resolveDecision, submitRequest, renameArtifact…;
 *   - any literal `method: "POST" | "PUT" | "PATCH" | "DELETE"` in a component.
 * Every component file (web/src/components, comments stripped) that makes one
 * must consume the shared offline condition (`useOfflineReason`, #467/#477),
 * unless it is on the allowlist below with a reason.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const webSrc = path.resolve(here, "..", "..");

/** Not a person's act — so not gated. Keep this SHORT and justified. */
const ALLOWLIST: Record<string, string> = {
  // Automatic diagnostics: a diagram that failed to render reports itself.
  // Nobody clicks it; offline it simply fails quietly and the next render retries.
  "components/MermaidDiagram.tsx": "reportRenderFailure is automatic telemetry, not a user act",
};

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" ? [] : walk(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

function storeWriteActions(): string[] {
  const names = new Set<string>();
  for (const file of walk(path.join(webSrc, "stores"))) {
    const src = fs.readFileSync(file, "utf8");
    const acts = [...src.matchAll(/\n {2}(\w+): async \(/g)];
    acts.forEach((m, i) => {
      const body = src.slice(m.index!, i + 1 < acts.length ? acts[i + 1]!.index! : src.length);
      if (/safeFetch|optimisticArtifactPatch|method:\s*"(POST|PUT|PATCH|DELETE)"/.test(body)) names.add(m[1]!);
    });
  }
  return [...names].sort();
}

describe("#487 review — every component that makes an act call is offline-gated", () => {
  const actions = storeWriteActions();

  it("finds the known write actions (sanity: the scan isn't vacuous)", () => {
    for (const known of ["submitComment", "updateArtifactStatus", "resolveSuggestion", "resolveDecision", "submitRequest"]) {
      expect(actions).toContain(known);
    }
  });

  it("each act-calling component consumes useOfflineReason (or is allowlisted with a reason)", () => {
    const offenders: string[] = [];
    for (const file of walk(path.join(webSrc, "components"))) {
      const rel = path.relative(webSrc, file).split(path.sep).join("/");
      const src = stripComments(fs.readFileSync(file, "utf8"));
      const calls = actions.filter((a) => new RegExp(`\\b${a}\\s*\\(|\\bs\\.${a}\\b`).test(src));
      const writes = /method:\s*"(POST|PUT|PATCH|DELETE)"/.test(src);
      if ((calls.length || writes) && !src.includes("useOfflineReason") && !ALLOWLIST[rel]) {
        offenders.push(`${rel} → ${[...calls, ...(writes ? ["fetch write"] : [])].join(", ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the allowlist stays honest: every entry still exists and still makes an act call", () => {
    for (const rel of Object.keys(ALLOWLIST)) {
      const src = stripComments(fs.readFileSync(path.join(webSrc, rel), "utf8"));
      expect(actions.some((a) => new RegExp(`\\b${a}\\s*\\(|\\bs\\.${a}\\b`).test(src))).toBe(true);
    }
  });
});
