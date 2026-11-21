import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Artifact, Comment, HtmlAnchor } from "@deeppairing/shared";
import { coercePageContent, PAGE_HTML_MAX_BYTES } from "@deeppairing/shared";
import { SimpleMarkdown } from "../SimpleMarkdown";
import { ConceptBadge } from "../ConceptBadge";
import { PrototypeFrame, type FrameAnnotation } from "../PrototypeFrame";
import { CommentThread } from "../CommentThread";
import { ArtifactStatusActions } from "./ArtifactStatusActions";
import { useChainComments } from "../../hooks/useChainComments";
import { useReplayStore } from "../../stores/replay";
import { reviewLifecycle } from "../../lib/reviewLifecycle";
import { ANNOTATOR_SCRIPT } from "../../lib/pageAnnotator";
import { sanitizePageHtml } from "../../lib/pageSanitize";
import { acceptAnchorMessage, acceptPinsStatus, isReadyMessage } from "../../lib/pageAnchorMessages";
import { htmlAnchorKindLabel, isPageListedComment, sameHtmlAnchor } from "../../lib/htmlAnchorDisplay";

/** Module-level so PrototypeFrame's memo sees one stable object. */
const PAGE_ANNOTATION: FrameAnnotation = { script: ANNOTATOR_SCRIPT, sanitize: sanitizePageHtml };

/** True while the reviewer is typing in a control of the companion itself
 *  (not the page frame): a frame message must never move focus out of it. */
function parentControlFocused(frame: HTMLIFrameElement | null): boolean {
  const el = typeof document !== "undefined" ? document.activeElement : null;
  if (!el || el === frame || el === document.body) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "textarea" || tag === "input" || tag === "select" || (el as HTMLElement).isContentEditable === true;
}

/** The root comments that point at a spot on the page, oldest first: their
 *  order is the pin numbering. */
export function anchoredPageComments(comments: Comment[]): Comment[] {
  return comments
    .filter((c) => isPageListedComment("page", c))
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function AnchorContext({ anchor }: { anchor: HtmlAnchor }) {
  const quote = anchor.quote.trim();
  return (
    <div className="space-y-0.5 text-2xs text-text-muted" data-testid="page-anchor-context">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="px-1.5 py-0.5 rounded bg-surface-elevated text-text-secondary">{htmlAnchorKindLabel(anchor.kind)}</span>
        {quote ? (
          <span className="text-text-primary italic break-words">“{quote}”</span>
        ) : (
          <code className="font-mono break-all">{anchor.locator}</code>
        )}
      </div>
      {anchor.table && (anchor.table.row || anchor.table.col) && (
        <div>
          {anchor.table.row && <>Row <span className="text-text-secondary">{anchor.table.row}</span></>}
          {anchor.table.row && anchor.table.col && " · "}
          {anchor.table.col && <>Column <span className="text-text-secondary">{anchor.table.col}</span></>}
        </div>
      )}
      {anchor.nodeId && <div>Node <code className="font-mono">{anchor.nodeId}</code></div>}
      {anchor.href && <div className="break-all">Link to <code className="font-mono">{anchor.href}</code></div>}
      {quote && <div className="break-all">at <code className="font-mono">{anchor.locator}</code></div>}
    </div>
  );
}

/**
 * #680 — viewer for `page` artifacts: an agent-authored HTML page presented
 * for review.
 *
 * Isolation is PrototypeFrame's, reused rather than copied: an opaque-origin
 * sandbox (never `allow-same-origin`) plus an injected no-network CSP. The cap
 * is the page cap (2 MB), not the 512 KB prototype-visual cap.
 *
 * Slice 2 — annotation. Our annotator script runs first in the frame. Before
 * Run the agent markup is sanitised (scripts, on* handlers, javascript: URLs,
 * meta refresh removed) and a nonce CSP lets only the annotator execute; after
 * Run the full page runs beside it. The human clicks an element, selects text,
 * or clicks a table cell, Mermaid node or link; the frame posts an anchor; this
 * component accepts it only from its own iframe and only if it parses against
 * the shared schema, then opens the composer pre-targeted at that spot. A
 * comment exists only when the human submits it. Anchored comments come back
 * down to the frame as numbered pins; clicking one in the list focuses its pin,
 * and an anchor the frame can't find in this version says so.
 *
 * The footer is the standard ArtifactStatusActions: Respond / Ask, Request
 * changes, Reject (with the "name the pattern" capture, so a reject feeds
 * rejection memory) and Approve.
 */
export function PageArtifact({ artifact }: { artifact: Artifact }) {
  const page = coercePageContent(artifact.content);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const replayActive = useReplayStore((s) => s.active);
  const lifecycle = reviewLifecycle(artifact.status, replayActive);
  const readOnly = lifecycle === "closed" || lifecycle === "frozen";

  const comments = useChainComments(artifact.id);
  const anchored = useMemo(() => anchoredPageComments(comments), [comments]);
  const anchors = useMemo(() => anchored.map((c) => c.target.htmlAnchor as HtmlAnchor), [anchored]);

  const [draft, setDraft] = useState<HtmlAnchor | null>(null);
  const [openNonce, setOpenNonce] = useState(0);
  const [found, setFound] = useState<boolean[] | null>(null);
  const [running, setRunning] = useState(false);
  const [annotate, setAnnotate] = useState(true);

  const postToFrame = useCallback((msg: unknown) => {
    // "*" — the frame's origin is opaque ("null"); nothing sent here is secret
    // (anchors the human already made on this page, never comment text).
    iframeRef.current?.contentWindow?.postMessage(msg, "*");
  }, []);
  const sendPins = useCallback(() => postToFrame({ dp: "pins", anchors }), [postToFrame, anchors]);
  const sendMode = useCallback(() => postToFrame({ dp: "mode", annotate: !running || annotate }), [postToFrame, running, annotate]);

  // Keep the latest senders and the EFFECTIVE pointing mode in refs so the one
  // message listener never goes stale.
  const sendersRef = useRef({ sendPins, sendMode });
  sendersRef.current = { sendPins, sendMode };
  const pointingRef = useRef(true);
  pointingRef.current = !running || annotate;

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const frame = iframeRef.current?.contentWindow;
      const anchor = acceptAnchorMessage(event, frame);
      if (anchor) {
        // Pointing is off (clicks belong to the page), the artifact is
        // read-only, or the reviewer is typing in a companion control: drop it.
        // An anchor only ever opens the composer; submitting stays explicit.
        if (readOnly || !pointingRef.current || parentControlFocused(iframeRef.current)) return;
        setDraft({ ...anchor, version: artifact.version });
        setOpenNonce((n) => n + 1);
        return;
      }
      if (isReadyMessage(event, frame)) {
        sendersRef.current.sendMode();
        sendersRef.current.sendPins();
        return;
      }
      const status = acceptPinsStatus(event, frame);
      if (status) setFound(status);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [artifact.version, readOnly]);

  // Re-send pins whenever the anchored comments change, and the mode whenever it does.
  useEffect(() => {
    sendPins();
  }, [sendPins]);
  useEffect(() => {
    sendMode();
  }, [sendMode]);
  // A remounted frame (Run) reports fresh pin status after its "ready".
  useEffect(() => {
    setFound(null);
  }, [running]);

  const onRunningChange = useCallback((r: boolean) => setRunning(r), []);

  const focusComment = (index: number) => {
    const anchor = anchors[index];
    if (!anchor) return;
    postToFrame({ dp: "focus", index });
    if (!readOnly) {
      setDraft({ ...anchor, version: artifact.version });
      setOpenNonce((n) => n + 1);
    }
  };

  const draftComments = draft
    ? comments.filter((c) => {
        if (sameHtmlAnchor(c.target.htmlAnchor, draft)) return true;
        // Replies thread under their anchored root.
        const root = anchored.find((r) => r.id === c.parentCommentId);
        return !!root && sameHtmlAnchor(root.target.htmlAnchor, draft);
      })
    : [];

  return (
    <div className="space-y-3" data-testid="page-artifact">
      {page.summary && (
        <div className="px-4 py-3 bg-accent-blue-dim/20 border border-accent-blue/20 rounded-lg">
          <SimpleMarkdown text={page.summary} className="prose-field text-sm text-text-primary space-y-2" />
        </div>
      )}
      {(page.sourcePath || page.concept) && (
        <div className="flex flex-wrap items-center gap-2 text-2xs text-text-muted">
          {page.concept && <ConceptBadge name={page.concept.name} explanation={page.concept.oneLineExplanation} />}
          {page.sourcePath && (
            <span>
              From <code className="font-mono text-text-secondary">{page.sourcePath}</code>
            </span>
          )}
        </div>
      )}
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2 text-2xs text-text-muted">
          <span>Click anything on the page, or select text, to comment on that spot.</span>
          {running && (
            <button
              type="button"
              onClick={() => setAnnotate((a) => !a)}
              aria-pressed={annotate}
              className="px-1.5 py-0.5 rounded border border-border-default hover:bg-surface-elevated text-text-secondary"
              title={annotate ? "Clicks point at the page. Switch to let clicks reach the page's own controls." : "Clicks reach the page's own controls. Switch back to point at things."}
            >
              {annotate ? "Pointing: on" : "Pointing: off"}
            </button>
          )}
        </div>
      )}
      <PrototypeFrame
        html={page.html}
        maxBytes={PAGE_HTML_MAX_BYTES}
        staticFirst
        noun="page"
        frameClassName="w-full h-[70vh] min-h-[420px] rounded border border-border-default bg-white"
        annotation={PAGE_ANNOTATION}
        iframeRef={iframeRef}
        onRunningChange={onRunningChange}
      />

      {draft && !readOnly && (
        <div
          className="p-3 rounded-lg border border-accent-blue/30 bg-surface-elevated space-y-2"
          data-testid="page-anchor-composer"
        >
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <AnchorContext anchor={draft} />
            </div>
            <button
              type="button"
              onClick={() => setDraft(null)}
              className="text-2xs text-text-muted hover:text-text-secondary"
            >
              Close
            </button>
          </div>
          <CommentThread
            key={openNonce}
            artifactId={artifact.id}
            comments={draftComments}
            target={{ htmlAnchor: draft }}
            roomy
            focusOnOpen
            placeholder="Comment on this spot… (⌘⏎ to send)"
            textareaLabel="Comment on the selected spot"
            secondarySubmitLabel="Ask"
            secondarySubmitTitle="Post as a question about this spot — the agent owes you an answer"
          />
        </div>
      )}

      {anchored.length > 0 && (
        <div className="space-y-1.5" data-testid="page-annotations">
          <h3 className="text-2xs font-semibold text-text-muted uppercase tracking-wide">On the page</h3>
          <ol className="space-y-1.5">
            {anchored.map((c, i) => {
              const anchor = c.target.htmlAnchor as HtmlAnchor;
              const missing = found?.[i] === false;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => focusComment(i)}
                    className="w-full text-left flex gap-2 p-2 rounded border border-border-default hover:bg-surface-elevated"
                    data-testid="page-annotation"
                  >
                    <span className="shrink-0 w-5 h-5 rounded-full bg-accent-amber text-[11px] font-semibold text-black flex items-center justify-center">
                      {i + 1}
                    </span>
                    <span className="flex-1 min-w-0 space-y-1">
                      <AnchorContext anchor={anchor} />
                      {missing && (
                        <span className="block text-2xs text-accent-amber" data-testid="page-anchor-missing">
                          Not found in this version
                        </span>
                      )}
                      <span className="block text-xs text-text-primary line-clamp-3">{c.content}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      )}
      <ArtifactStatusActions artifact={artifact} />
    </div>
  );
}
