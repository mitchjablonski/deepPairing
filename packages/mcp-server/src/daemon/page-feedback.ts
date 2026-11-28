import type { Artifact, Comment, HtmlAnchor } from "@deeppairing/shared";
import type { FileStore } from "../store/file-store.js";
import { effectiveHumanResolution } from "../store/comment-resolution.js";
import { findPageSuccessor } from "./page-successor.js";

export const MAX_COMMENTS = 50;
export const MAX_RESPONSE_BYTES = 64 * 1024;

function pageMetadata({ id, version, status }: Artifact) {
  return { id, version, status };
}

type PageFeedbackNote = Pick<Comment, "id" | "content" | "intent" | "parentCommentId" | "followUp" | "ruleOut" | "humanResolvedAt">;
type PageFeedbackComment = PageFeedbackNote & { htmlAnchor: HtmlAnchor };

function noteFeedback(comment: Comment, humanResolvedAt: Comment["humanResolvedAt"]): PageFeedbackNote {
  const { id, content, intent, parentCommentId, followUp, ruleOut } = comment;
  return {
    id, content, parentCommentId,
    ...(intent !== undefined && { intent }),
    ...(followUp !== undefined && { followUp }),
    ...(ruleOut !== undefined && { ruleOut }),
    // #714 — the human resolved it themselves (page review queue); present
    // only while resolved, so other entries are unchanged.
    ...(humanResolvedAt ? { humanResolvedAt } : {}),
  };
}

interface PageFeedbackVerdict {
  status: "revised" | "rejected";
  at: string;
  commentId?: string;
  reason?: string;
  reasonTruncated?: true;
}

export interface StandalonePageFeedbackRead {
  sessionId: string;
  artifact: ReturnType<typeof pageMetadata>;
  successor?: ReturnType<typeof pageMetadata>;
  verdict?: PageFeedbackVerdict;
  notes: PageFeedbackNote[];
  omittedNotes: number;
  comments: PageFeedbackComment[];
  omittedComments: number;
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** Find the longest prefix that fits after JSON escaping, keeping surrogate pairs whole. */
function fitVerdictReason(result: StandalonePageFeedbackRead, verdict: PageFeedbackVerdict, reason: string): void {
  verdict.reason = reason;
  if (bytes(result) <= MAX_RESPONSE_BYTES) return;
  verdict.reasonTruncated = true;
  const wholeEnd = (end: number) =>
    end > 0 && /[\uD800-\uDBFF]/.test(reason[end - 1]!) && /[\uDC00-\uDFFF]/.test(reason[end] ?? "") ? end - 1 : end;
  let low = 0;
  let high = Math.min(reason.length, MAX_RESPONSE_BYTES);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    verdict.reason = reason.slice(0, wholeEnd(mid));
    if (bytes(result) <= MAX_RESPONSE_BYTES) low = mid;
    else high = mid - 1;
  }
  verdict.reason = reason.slice(0, wholeEnd(low));
  if (bytes(result) > MAX_RESPONSE_BYTES) delete verdict.reason;
}

export function readPageFeedback(
  store: Pick<FileStore, "getSessionId" | "getArtifacts" | "getComments" | "getCommentsForArtifact">,
  artifactId: string,
): StandalonePageFeedbackRead | "metadata_too_large" | undefined {
  const sessionId = store.getSessionId();
  const artifacts = store.getArtifacts();
  const page = artifacts.find((a) => a.id === artifactId && a.type === "page" && a.sessionId === sessionId);
  if (!page) return undefined;

  const successor = findPageSuccessor(page, artifacts);
  const event = page.statusHistory?.slice().reverse().find((entry) =>
    entry.status === "revised" || entry.status === "rejected" || entry.status === "approved" ||
    (entry.status === "obsolete" && "reason" in entry && entry.reason === "ui_dismiss_obsolete"));
  const verdict: PageFeedbackVerdict | undefined = event?.status === "revised" || event?.status === "rejected"
    ? { status: event.status, at: event.at }
    : undefined;
  let reasonComment: Comment | undefined;
  if (verdict && event?.feedbackCommentId) {
    const matches = store.getComments().filter((comment) => comment.id === event.feedbackCommentId);
    const comment = matches.length === 1 ? matches[0] : undefined;
    if (comment?.verdictFeedback === true && comment.sessionId === sessionId &&
      comment.target.artifactId === artifactId && comment.author === "human" &&
      !comment.target.htmlAnchor && (comment.intent === undefined || comment.intent === "comment") &&
      !comment.suggestion && !comment.ruleOut && comment.parentCommentId === null) {
      reasonComment = comment;
    }
  }

  const pending = store.getCommentsForArtifact(artifactId).filter((comment) =>
    comment.sessionId === sessionId && comment.author === "human" && !comment.acknowledged && comment.id !== reasonComment?.id);
  const effectiveResolution = effectiveHumanResolution(store.getComments(), artifacts);
  pending.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  const anchoredCount = pending.filter((comment) => comment.target.htmlAnchor).length;
  const result: StandalonePageFeedbackRead = {
    sessionId,
    artifact: pageMetadata(page),
    ...(successor && { successor: pageMetadata(successor) }),
    ...(verdict && { verdict }),
    notes: [],
    omittedNotes: pending.length - anchoredCount,
    comments: [],
    omittedComments: anchoredCount,
  };
  // Reserve the envelope and the verdict before either lane. Omission counts
  // only shrink, so this accounting stays conservative for every result.
  if (bytes(result) > MAX_RESPONSE_BYTES) return "metadata_too_large";
  if (verdict && reasonComment) {
    verdict.commentId = reasonComment.id;
    if (bytes(result) > MAX_RESPONSE_BYTES) delete verdict.commentId;
    fitVerdictReason(result, verdict, reasonComment.content);
    if (bytes(result) > MAX_RESPONSE_BYTES) delete verdict.reasonTruncated;
  }
  let responseBytes = bytes(result);
  let items = verdict ? 1 : 0;
  for (const comment of pending) {
    if (items === MAX_COMMENTS) break;
    if (comment.content.length > MAX_RESPONSE_BYTES - responseBytes) continue;
    const anchor = comment.target.htmlAnchor;
    const feedback = noteFeedback(comment, effectiveResolution(comment));
    const lane = anchor ? result.comments : result.notes;
    const item = anchor ? { ...feedback, htmlAnchor: anchor } : feedback;
    const added = bytes(item) + (lane.length ? 1 : 0);
    if (responseBytes + added > MAX_RESPONSE_BYTES) continue;
    if (anchor) result.comments.push({ ...feedback, htmlAnchor: anchor });
    else result.notes.push(feedback);
    items++;
    responseBytes += added;
  }
  result.omittedNotes -= result.notes.length;
  result.omittedComments -= result.comments.length;
  return result;
}
