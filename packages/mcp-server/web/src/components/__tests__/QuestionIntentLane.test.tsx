/**
 * The DEAD QUESTION LANE (context-bank rider).
 *
 * A dry-run over the author's real data found 12 human comments across 9
 * sessions and NOT ONE carrying `intent`. Two of them are literal questions —
 * "Why does auth verify happen before the cache check?" — posted through the
 * diagram REGION composer. Since `collectUnansweredQuestions` keys entirely on
 * `intent === "question"`, the whole unanswered-question lane (check_feedback's
 * owed-questions queue, the AskTrigger badges, the context bank's needs-you
 * signal) was structurally empty.
 *
 * The plumbing was never broken: the POST body carries `intent`
 * (stores/artifact.ts), the route destructures it (http/routes.ts), and the
 * store persists it (file-store.ts). The gap was that the composers people
 * actually use had NO WAY to say "this is a question" — the Ask button renders
 * only when a caller passes `secondarySubmitLabel`, and the three
 * highest-traffic threads didn't.
 *
 * These tests pin both halves: the mechanism (Ask ⇒ intent) and the wiring (the
 * three call sites opt in).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommentThread } from "../CommentThread";
import { useArtifactStore } from "../../stores/artifact";

beforeEach(() => {
  useArtifactStore.getState().reset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});

describe("the question lane — mechanism", () => {
  it("the Ask button posts intent: 'question'", async () => {
    render(<CommentThread artifactId="art_1" comments={[]} secondarySubmitLabel="Ask" />);
    await userEvent.type(screen.getByPlaceholderText(/Add a comment/i), "Why does auth verify before the cache check?");
    await userEvent.click(screen.getByRole("button", { name: /^Ask$/ }));

    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.intent).toBe("question");
    expect(body.content).toBe("Why does auth verify before the cache check?");
  });

  it("the primary Send button still posts a plain comment (no intent)", async () => {
    render(<CommentThread artifactId="art_1" comments={[]} secondarySubmitLabel="Ask" />);
    await userEvent.type(screen.getByPlaceholderText(/Add a comment/i), "looks good");
    await userEvent.click(screen.getByRole("button", { name: /^Send$/ }));

    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.intent).toBeUndefined();
  });

  it("WITHOUT secondarySubmitLabel there is no way to say 'question' — the bug", async () => {
    render(<CommentThread artifactId="art_1" comments={[]} />);
    expect(screen.queryByRole("button", { name: /^Ask$/ })).not.toBeInTheDocument();
  });
});

describe("the question lane — the three composers that had no Ask affordance", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const componentsDir = path.resolve(here, "..");
  const read = (rel: string) => fs.readFileSync(path.join(componentsDir, rel), "utf-8");

  // A source-level drift guard rather than a render test: ArtifactPanel and
  // DiagramRegionLayer both pull in the whole artifact-rendering stack, and the
  // thing that regresses here is a deleted PROP, which the source pins exactly.
  it.each([
    ["ArtifactPanel.tsx", "the main per-artifact thread"],
    ["DiagramRegionLayer.tsx", "the diagram region composer (where the real questions landed)"],
    [path.join("decision", "DecisionGeneralComments.tsx"), "the decision card's thread"],
  ])("%s passes secondarySubmitLabel so its thread can ask (%s)", (file) => {
    expect(read(file)).toContain('secondarySubmitLabel="Ask"');
  });
});
