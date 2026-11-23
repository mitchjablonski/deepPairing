import type { Artifact, Comment, HtmlAnchor } from "@deeppairing/shared";
import type { FileStore } from "../store/file-store.js";
import { findPageSuccessor } from "./page-successor.js";

const MAX_COMMENTS = 50;
const MAX_RESPONSE_BYTES = 64 * 1024;

function pageMetadata({ id, version, status }: Artifact) {
  return { id, version, status };
}

type PageFeedbackComment = Pick<Comment, "id" | "content" | "intent" | "parentCommentId" | "followUp" | "ruleOut"> & {
  htmlAnchor: HtmlAnchor;
};

function commentFeedback(comment: Comment, htmlAnchor: HtmlAnchor): PageFeedbackComment {
  const { id, content, intent, parentCommentId, followUp, ruleOut } = comment;
  return {
    id, content, parentCommentId, htmlAnchor,
    ...(intent !== undefined && { intent }),
    ...(followUp !== undefined && { followUp }),
    ...(ruleOut !== undefined && { ruleOut }),
  };
}

export interface StandalonePageFeedbackRead {
  sessionId: string;
  artifact: ReturnType<typeof pageMetadata>;
  successor?: ReturnType<typeof pageMetadata>;
  comments: PageFeedbackComment[];
  omittedComments: number;
}

export function readPageFeedback(
  store: FileStore,
  artifactId: string,
): StandalonePageFeedbackRead | "metadata_too_large" | undefined {
  const sessionId = store.getSessionId();
  const artifacts = store.getArtifacts();
  const page = artifacts.find((a) => a.id === artifactId && a.type === "page" && a.sessionId === sessionId);
  if (!page) return undefined;

  const successor = findPageSuccessor(page, artifacts);
  const pending = store.getCommentsForArtifact(artifactId).flatMap((comment) => {
    const anchor = comment.target.htmlAnchor;
    if (comment.sessionId !== sessionId || comment.author !== "human" || comment.acknowledged || !anchor) return [];
    return [{ comment, anchor }];
  });
  pending.sort((a, b) => b.comment.createdAt.localeCompare(a.comment.createdAt) || a.comment.id.localeCompare(b.comment.id));

  const result: StandalonePageFeedbackRead = {
    sessionId,
    artifact: pageMetadata(page),
    ...(successor && { successor: pageMetadata(successor) }),
    comments: [],
    omittedComments: pending.length,
  };
  // Reserve the full JSON envelope. The omission count can only shrink.
  let responseBytes = Buffer.byteLength(JSON.stringify(result));
  if (responseBytes > MAX_RESPONSE_BYTES) return "metadata_too_large";
  for (const { comment, anchor } of pending) {
    if (result.comments.length === MAX_COMMENTS) break;
    if (comment.content.length > MAX_RESPONSE_BYTES - responseBytes) continue;
    const feedback = commentFeedback(comment, anchor);
    const addedBytes = Buffer.byteLength(JSON.stringify(feedback)) + (result.comments.length ? 1 : 0);
    if (responseBytes + addedBytes > MAX_RESPONSE_BYTES) continue;
    result.comments.push(feedback);
    responseBytes += addedBytes;
  }
  result.omittedComments -= result.comments.length;
  return result;
}
