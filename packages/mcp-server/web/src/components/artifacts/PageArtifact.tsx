import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Artifact, Comment, HtmlAnchor } from "@deeppairing/shared";
import { coercePageContent, PAGE_HTML_MAX_BYTES, readFileWatch } from "@deeppairing/shared";
import { SimpleMarkdown } from "../SimpleMarkdown";
import { ConceptBadge } from "../ConceptBadge";
import { PrototypeFrame, type FrameAnnotation } from "../PrototypeFrame";
import { CommentThread } from "../CommentThread";
import { ArtifactStatusActions } from "./ArtifactStatusActions";
import { useChainComments } from "../../hooks/useChainComments";
import { useReplayStore } from "../../stores/replay";
import { useArtifactStore } from "../../stores/artifact";
import { reviewLifecycle } from "../../lib/reviewLifecycle";
import { ANNOTATOR_SCRIPT } from "../../lib/pageAnnotator";
import { sanitizePageHtml } from "../../lib/pageSanitize";
import { acceptAnchorMessage, acceptPinsStatus, isReadyMessage, isTogglePointingMessage } from "../../lib/pageAnchorMessages";
import { htmlAnchorKindLabel, isPageListedComment, sameHtmlAnchor } from "../../lib/htmlAnchorDisplay";
import { PageRuleOutControl } from "./PageRuleOutControl";
import { useRememberedRejections } from "../decision/NeverSuggestControl";
import { pageRuleOutKey } from "@deeppairing/shared";

/** Module-level so PrototypeFrame's memo sees one stable object. */
const PAGE_ANNOTATION: FrameAnnotation = { script: ANNOTATOR_SCRIPT, sanitize: sanitizePageHtml };

/** #714 — the pointing toggle's shortcut, as shown on this platform. */
function pointingShortcutLabel(): string {
  const platform = typeof navigator !== "undefined" ? navigator.platform || "" : "";
  return /Mac|iPhone|iPad|iPod/.test(platform) ? "⌘I" : "Ctrl+I";
}

/** #714 — Cmd/Ctrl+I (no Alt/Shift): not bound anywhere else in the companion. */
export function isPointingShortcut(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === "i" || e.key === "I");
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
 * Slice 4 — with a spot selected, "Rule this out" (PageRuleOutControl) records
 * the spot's text as a rejected stance with your reason; the page stays under
 * review and the gate refuses later pages containing that text.
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

  // #680 slice 3 — what the daemon's file watch did with this version.
  const fileWatch = readFileWatch(artifact.fileWatch);
  const serverOrphans = useMemo(
    () => new Set((readFileWatch(artifact.fileWatch).recorded?.orphaned ?? []).map((o) => o.commentId)),
    [artifact.fileWatch],
  );
  const comments = useChainComments(artifact.id);
  // #680 slice 4 — "Ruled out" reflects the LIVE stance (GET /api/memory, kept
  // fresh by ledger writes), not just the comment marker: a stance retired in
  // the Ledger stops showing as ruled out, and the spot can be ruled out again.
  // Any live row with exactly this phrase counts, including one a later
  // ordinary rejection widened (origin dropped): every stance is matched
  // forward against page body text, so a page still containing the phrase is
  // refused either way — "Ruled out" stays true.
  const owner = useArtifactStore((s) => s.owningSession(artifact.id));
  const { rows: rememberedRows, remember } = useRememberedRejections(owner);
  const liveStances = useMemo(() => new Set(rememberedRows.map((r) => r.description)), [rememberedRows]);
  const anchored = useMemo(() => anchoredPageComments(comments), [comments]);
  const anchors = useMemo(() => anchored.map((c) => c.target.htmlAnchor as HtmlAnchor), [anchored]);

  const [draft, setDraft] = useState<HtmlAnchor | null>(null);
  const [openNonce, setOpenNonce] = useState(0);
  // Who opened the composer: an explicit parent action (a pin in the list)
  // focuses it on mount; a frame-initiated open is focused only after a fresh
  // ownership check (frameFocusNonce below).
  const [explicitOpen, setExplicitOpen] = useState(false);
  const acceptingFrame = useRef<HTMLIFrameElement | null>(null);
  const [frameFocusNonce, setFrameFocusNonce] = useState(0);
  const composerBoxRef = useRef<HTMLDivElement>(null);
  const artifactIdRef = useRef(artifact.id);
  artifactIdRef.current = artifact.id;

  /** A frame-initiated action may touch focus only while the reviewer is
   *  actually in THIS page's frame: the iframe is connected, owns focus in the
   *  companion document, is not inside an exiting (inert) pane, and this page
   *  is still the selected artifact. */
  const frameOwnsFocus = useCallback((f: HTMLIFrameElement | null): boolean => {
    if (!f || f !== iframeRef.current || !f.isConnected || document.activeElement !== f) return false;
    if (f.closest("[inert]")) return false;
    const selected = useArtifactStore.getState().selectedArtifactId;
    return selected === artifactIdRef.current;
  }, []);
  const frameOwnsFocusRef = useRef(frameOwnsFocus);
  frameOwnsFocusRef.current = frameOwnsFocus;
  const [found, setFound] = useState<boolean[] | null>(null);
  const [running, setRunning] = useState(false);
  const [annotate, setAnnotate] = useState(true);

  const postToFrame = useCallback((msg: unknown) => {
    // "*" — the frame's origin is opaque ("null"); nothing sent here is secret
    // (anchors the human already made on this page, never comment text).
    iframeRef.current?.contentWindow?.postMessage(msg, "*");
  }, []);
  const sendPins = useCallback(() => postToFrame({ dp: "pins", anchors }), [postToFrame, anchors]);
  // #714 — pointing is the reviewer's choice before Run as well as after: a
  // page with no scripts never shows Run, and its own links, details and
  // CSS-only tabs work either way (the annotator lets native controls keep
  // their default action unless Alt/Option is held).
  // `scripts` tells the annotator whether the page's own scripts run (buttons
  // only have an action then).
  const sendMode = useCallback(() => postToFrame({ dp: "mode", annotate, scripts: running }), [postToFrame, annotate, running]);

  // Keep the latest senders and the EFFECTIVE pointing mode in refs so the one
  // message listener never goes stale.
  const sendersRef = useRef({ sendPins, sendMode });
  sendersRef.current = { sendPins, sendMode };
  const pointingRef = useRef(true);
  pointingRef.current = annotate;
  const runningRef = useRef(running);
  runningRef.current = running;
  const rootRef = useRef<HTMLDivElement>(null);
  const hintId = useId();

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const element = iframeRef.current;
      const frame = element?.contentWindow;
      const anchor = acceptAnchorMessage(event, frame);
      if (anchor) {
        // Pointing is off (clicks belong to the page), the artifact is
        // read-only, or the reviewer is typing in a companion control: drop it.
        // An anchor only ever opens the composer; submitting stays explicit.
        // Dropped when pointing is off (clicks belong to the page), the page is
        // read-only, or the reviewer is not in this frame right now (typing in
        // or focused on a companion control, another pane, an exiting pane). An
        // anchor only ever opens the composer; submitting stays explicit.
        if (readOnly || !pointingRef.current || !frameOwnsFocusRef.current(element)) return;
        acceptingFrame.current = element;
        setDraft({ ...anchor, version: artifact.version });
        setExplicitOpen(false);
        setOpenNonce((n) => n + 1);
        setFrameFocusNonce((n) => n + 1);
        return;
      }
      if (isReadyMessage(event, frame)) {
        sendersRef.current.sendMode();
        sendersRef.current.sendPins();
        return;
      }
      if (isTogglePointingMessage(event, frame)) {
        // The shortcut pressed inside the frame: honoured only from the
        // trusted pre-Run document (after Run agent script shares the frame's
        // identity and could flip it) and only while the reviewer is actually
        // in THIS page's frame. After Run the toggle and the companion-level
        // shortcut still work.
        if (!readOnly && !runningRef.current && frameOwnsFocusRef.current(element)) setAnnotate((a) => !a);
        return;
      }
      const status = acceptPinsStatus(event, frame);
      if (status) setFound(status);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [artifact.version, readOnly]);

  // #714 — Cmd/Ctrl+I toggles pointing from anywhere in the companion while
  // this page is the selected artifact (and not in an exiting, inert pane).
  useEffect(() => {
    if (readOnly) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.repeat || !isPointingShortcut(e)) return;
      // Never while typing: the reviewer's own text fields keep the chord.
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable === true) return;
      const root = rootRef.current;
      if (!root || !root.isConnected || root.closest("[inert]")) return;
      if (useArtifactStore.getState().selectedArtifactId !== artifactIdRef.current) return;
      e.preventDefault();
      setAnnotate((a) => !a);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [readOnly]);

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

  // Frame-initiated focus: re-check ownership at the moment of moving it.
  useEffect(() => {
    if (!frameFocusNonce || !frameOwnsFocus(acceptingFrame.current)) return;
    composerBoxRef.current?.querySelector("textarea")?.focus?.();
  }, [frameFocusNonce, frameOwnsFocus]);

  const onRunningChange = useCallback((r: boolean) => setRunning(r), []);

  const focusComment = (index: number) => {
    const anchor = anchors[index];
    if (!anchor) return;
    postToFrame({ dp: "focus", index });
    if (!readOnly) {
      acceptingFrame.current = null;
      setDraft({ ...anchor, version: artifact.version });
      setExplicitOpen(true);
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
    <div className="space-y-3" data-testid="page-artifact" ref={rootRef}>
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
      {fileWatch.recorded && (
        <div className="text-2xs text-text-muted" data-testid="page-file-recorded">
          Recorded automatically from <code className="font-mono text-text-secondary">{fileWatch.recorded.sourcePath}</code> after
          a save, replacing v{fileWatch.recorded.fromVersion}.
          {fileWatch.recorded.orphaned.length + (fileWatch.recorded.orphanedOverflow ?? 0) > 0 && (
            <> {fileWatch.recorded.orphaned.length + (fileWatch.recorded.orphanedOverflow ?? 0)} earlier comment(s) point at text that is no longer on the page.</>
          )}
        </div>
      )}
      {fileWatch.refused && !readOnly && (
        <div
          className="px-3 py-2 rounded-lg border border-accent-amber/40 bg-accent-amber/10 text-xs text-text-primary"
          role="status"
          data-testid="page-file-refused"
        >
          A later save to{" "}
          <code className="font-mono">{fileWatch.refused.sourcePath}</code>
          {fileWatch.refused.cause === "gate"
            ? <> was not recorded: {fileWatch.refused.message}. You are still looking at v{artifact.version}.</>
            : <> could not be recorded: {fileWatch.refused.message}. You are still looking at v{artifact.version}.</>}
        </div>
      )}
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2 text-2xs text-text-muted" data-testid="page-pointing-bar">
          <button
            type="button"
            onClick={() => setAnnotate((a) => !a)}
            aria-pressed={annotate}
            aria-describedby={hintId}
            aria-keyshortcuts="Control+I Meta+I"
            className="px-1.5 py-0.5 rounded border border-border-default hover:bg-surface-elevated text-text-secondary"
            title={
              (annotate
                ? `Clicks point at the page (${pointingShortcutLabel()} to switch). Hold ⌘/Ctrl to let one click through; switch off to let every click reach the page.`
                : `Clicks reach the page (${pointingShortcutLabel()} to switch). Switch on to point at things.`) +
              ` After Run, use this toggle or press ${pointingShortcutLabel()} outside the page.`
            }
          >
            {annotate ? "Pointing: on" : "Pointing: off"}
            <kbd className="ml-1 font-mono text-[9px] text-text-muted">{pointingShortcutLabel()}</kbd>
          </button>
          <span id={hintId} data-testid="page-pointing-hint">
            {annotate
              ? "Click anything on the page, or select text, to comment on that spot. In-page links, summaries, radio/checkbox tabs and form fields still work — Alt/Option-click to comment on one."
              : "Pointing is off: clicks go to the page. Turn it on to comment on a spot."}
            {running && ` Scripts are running: to switch pointing, use this toggle or press ${pointingShortcutLabel()} outside the page.`}
          </span>
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
          ref={composerBoxRef}
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
            focusOnOpen={explicitOpen}
            placeholder="Comment on this spot… (⌘⏎ to send)"
            textareaLabel="Comment on the selected spot"
            secondarySubmitLabel="Ask"
            secondarySubmitTitle="Post as a question about this spot — the agent owes you an answer"
          />
          {/* #680 slice 4 — record this spot's text as a rejected stance. Inline
              under the composer (never over it); opens its own confirm step. */}
          <div className="flex justify-end" data-testid="page-rule-out">
            <PageRuleOutControl
              key={openNonce}
              artifactId={artifact.id}
              anchor={draft}
              ruledOut={(() => {
                const phrase = pageRuleOutKey(draft.quote);
                return phrase && liveStances.has(phrase) ? phrase : undefined;
              })()}
              onRecorded={(description) => remember({ description, sourceArtifactId: artifact.id })}
            />
          </div>
        </div>
      )}

      {anchored.length > 0 && (
        <div className="space-y-1.5" data-testid="page-annotations">
          <h3 className="text-2xs font-semibold text-text-muted uppercase tracking-wide">On the page</h3>
          <ol className="space-y-1.5">
            {anchored.map((c, i) => {
              const anchor = c.target.htmlAnchor as HtmlAnchor;
              // The frame's live re-find decides once it reports; until then (or
              // if the frame never loads) the server's file-watch re-anchoring
              // marks the comments whose text is gone from this version.
              const missing = found ? found[i] === false : serverOrphans.has(c.id);
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
                      {c.ruleOut && liveStances.has(c.ruleOut.description) && (
                        <span className="block text-2xs text-accent-red" data-testid="page-annotation-ruled-out">
                          Ruled out: Claude won't present a page that still contains “{c.ruleOut.description}”
                        </span>
                      )}
                      {c.ruleOut && !liveStances.has(c.ruleOut.description) && (
                        <span className="block text-2xs text-text-muted" data-testid="page-annotation-ruled-out-retired">
                          Was ruled out; that stance has since been retired
                        </span>
                      )}
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
