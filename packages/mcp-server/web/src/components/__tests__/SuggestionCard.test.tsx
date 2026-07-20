import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SuggestionCard } from "../SuggestionCard";
import { useArtifactStore } from "../../stores/artifact";
import type { Comment } from "@deeppairing/shared";

beforeEach(() => {
  useArtifactStore.getState().reset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ comment: null }) }));
});

function mkSuggestion(over: Partial<NonNullable<Comment["suggestion"]>> = {}): Comment {
  return {
    id: "cmt_s",
    sessionId: "s1",
    target: { artifactId: "art_1", lineStart: 19, lineEnd: 19, filePath: "lib/upload.ts" },
    parentCommentId: null,
    author: "human",
    content: "returning null drops it",
    intent: "suggestion",
    suggestion: {
      originalText: "  throw new UploadFailedError();",
      replacementText: "  return null;",
      lineStart: 19,
      lineEnd: 19,
      state: "pending",
      ...over,
    },
    acknowledged: false,
    createdAt: new Date().toISOString(),
  };
}

describe("#172 SuggestionCard", () => {
  it("renders the header, a mini unified diff, and the PENDING pill", () => {
    render(<SuggestionCard comment={mkSuggestion()} replies={[]} />);
    expect(screen.getByText(/YOUR SUGGESTION/)).toBeInTheDocument();
    expect(screen.getByText(/lib\/upload\.ts:19/)).toBeInTheDocument();
    expect(screen.getByTestId("suggestion-state-pill")).toHaveTextContent("PENDING");
    // Both diff sides render.
    expect(screen.getByText(/throw new UploadFailedError/)).toBeInTheDocument();
    expect(screen.getByText(/return null/)).toBeInTheDocument();
  });

  it("APPLIED shows 'APPLIED IN vN ✓' and no action row", () => {
    render(<SuggestionCard comment={mkSuggestion({ state: "applied", appliedInVersion: 2 })} replies={[]} />);
    expect(screen.getByTestId("suggestion-state-pill")).toHaveTextContent("APPLIED IN v2 ✓");
    expect(screen.queryByRole("button", { name: /take the counter/i })).not.toBeInTheDocument();
  });

  it("COUNTERED shows Claude's reply and the negotiation action row", () => {
    const reply: Comment = {
      id: "cmt_r", sessionId: "s1",
      target: { artifactId: "art_1", lineStart: 19, lineEnd: 19 },
      parentCommentId: "cmt_s", author: "agent",
      content: "Returning null would silently drop the upload — attach the cause instead.",
      acknowledged: true, createdAt: new Date().toISOString(),
    };
    render(<SuggestionCard comment={mkSuggestion({ state: "countered", counter: { reason: "drops it" } })} replies={[reply]} />);
    expect(screen.getByTestId("suggestion-state-pill")).toHaveTextContent("COUNTERED");
    expect(screen.getByText(/silently drop the upload/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /take the counter/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /insist on mine/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reply/i })).toBeInTheDocument();
  });

  it("'Take the counter' POSTs { action: 'take_counter' } to the resolve route", async () => {
    const comment = mkSuggestion({ state: "countered", counter: { reason: "no" } });
    // resolveSuggestion looks the comment up in the store, so seed it there.
    useArtifactStore.getState().addComment(comment);
    render(<SuggestionCard comment={comment} replies={[]} />);
    await userEvent.click(screen.getByRole("button", { name: /take the counter/i }));
    const call = (fetch as any).mock.calls.find((c: any[]) => String(c[0]).includes("/suggestion"));
    expect(call).toBeTruthy();
    expect(String(call[0])).toMatch(/\/api\/comments\/cmt_s\/suggestion$/);
    expect(JSON.parse(call[1].body)).toEqual({ action: "take_counter" });
  });

  it("'Insist on mine' POSTs { action: 'insist' } — verbatim, no extra confirm", async () => {
    const comment = mkSuggestion({ state: "countered", counter: { reason: "no" } });
    useArtifactStore.getState().addComment(comment);
    render(<SuggestionCard comment={comment} replies={[]} />);
    await userEvent.click(screen.getByRole("button", { name: /insist on mine/i }));
    const call = (fetch as any).mock.calls.find((c: any[]) => String(c[0]).includes("/suggestion"));
    expect(JSON.parse(call[1].body)).toEqual({ action: "insist" });
  });
});
