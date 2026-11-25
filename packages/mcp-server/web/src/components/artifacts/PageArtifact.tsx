import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
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
import {
  acceptAnchorMessage,
  acceptAnchorPoint,
  acceptPinClick,
  acceptPinHover,
  buildPinsMessage,
  type FramePoint,
  type PinStateValue,
  acceptAsksMessage,
  acceptChangesStatus,
  acceptOutlineActive,
  acceptOutlineMessage,
  acceptPinsStatus,
  askAnchor,
  buildChangesMessage,
  isReadyMessage,
  isTogglePointingMessage,
  type PageAsk,
  type PageOutlineMessage,
} from "../../lib/pageAnchorMessages";
import { PageOutline } from "./PageOutline";
import { PageAsksStrip } from "./PageAsksStrip";
import { usePageAskVersions } from "../../hooks/usePageAskVersions";
import { usePageLineage, usePageVersionDiff } from "../../hooks/usePageVersionDiff";
import { PageChangeLine, PageRemovedList } from "./PageChangeSummary";
import type { ChangeLocator } from "../../lib/pageVersionDiff";
import { isPageListedComment, sameHtmlAnchor } from "../../lib/htmlAnchorDisplay";
import { AnchorContext, PageReviewQueue, type QueueFilterChoice } from "./PageReviewQueue";
import {
  buildQueue,
  deriveCommentState,
  pinState,
  queueCounts,
  stateFilter,
  stateLabel,
  threadReplies,
} from "../../lib/pageReviewQueue";
import { commentPriorVersion } from "../../stores/artifact";
import { PageRuleOutControl } from "./PageRuleOutControl";
import { useRememberedRejections } from "../decision/NeverSuggestControl";
import { commentAnswersAsk, pageRuleOutKey } from "@deeppairing/shared";

/** #714 gap 7 — the review rail sits beside the frame once the panel is at
 *  least this wide (with the outline rail on the left, the frame keeps ~600px). */
export const REVIEW_RAIL_MIN_WIDTH = 1152;

/** Is the element at least `min` px wide? A container query in JS: the
 *  composer must exist exactly once (one draft writer, one focus target), so
 *  rail-vs-below can't be a CSS show/hide of two copies. No ResizeObserver
 *  (old engines, jsdom) → narrow, the layout that always fits. */
function useWideContainer(ref: RefObject<HTMLElement | null>, min: number): boolean {
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver !== "function") return;
    const check = () => setWide(el.getBoundingClientRect().width >= min);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, min]);
  return wide;
}

interface FrameBox {
  /** The iframe's box inside its wrapper (px). */
  top: number;
  left: number;
  width: number;
  height: number;
  wrapHeight: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** #714 gap 8 — where the narrow floating composer goes: next to the spot
 *  the reviewer clicked, on the side away from it (below a spot in the top
 *  half, above one in the bottom half), so the spot stays visible. Opened
 *  from the companion (no point): docked to the bottom of the frame, while
 *  the frame centres the spot. */
export function floatingComposerStyle(box: FrameBox, point: FramePoint | null): CSSProperties {
  const width = Math.min(448, Math.max(200, box.width - 16));
  const gap = 12;
  if (!point) {
    return {
      left: box.left + 8,
      width,
      bottom: box.wrapHeight - (box.top + box.height) + 8,
      maxHeight: Math.max(160, box.height * 0.45),
      overflowY: "auto",
    };
  }
  const y = clamp(point.y, 0, box.height);
  const x = clamp(point.x, 0, box.width);
  const left = box.left + clamp(x - 24, 8, Math.max(8, box.width - width - 8));
  if (y < box.height / 2) {
    return { left, width, top: box.top + y + gap, maxHeight: Math.max(160, box.height - y - gap - 8), overflowY: "auto" };
  }
  return { left, width, bottom: box.wrapHeight - (box.top + y) + gap, maxHeight: Math.max(160, y - gap - 8), overflowY: "auto" };
}

/** The hover preview's text: the comment, clipped. */
function snippet(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > 200 ? `${t.slice(0, 200)}…` : t;
}

/** Module-level so PrototypeFrame's memo sees one stable object. */
const PAGE_ANNOTATION: FrameAnnotation = { script: ANNOTATOR_SCRIPT, sanitize: sanitizePageHtml };
const NO_MARKS: ChangeLocator[] = [];

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
 * #714 gaps 7+8 — the anchored comments are a review queue (PageReviewQueue):
 * Open / Addressed / Orphaned filters with counts, honest per-comment states
 * (lib/pageReviewQueue), reply counts, and pins coloured by state. A pin's
 * badge in the frame is clickable (display-only: it highlights and reveals its
 * row here, never posts) and hovering it shows the comment's snippet, rendered
 * here from the store. The composer sits in the right-hand review rail on a
 * wide panel, or floats over the frame beside the clicked spot on a narrow
 * one, so the spot stays in view; Escape returns focus to the frame.
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
  const pinIds = useMemo(() => anchored.map((c) => c.id), [anchored]);
  // #714 gap 7 — pin colours. Derived WITHOUT the frame's found report (an
  // orphaned comment has no pin to colour), and keyed by value, so a
  // pins-status report never re-sends the pins (no feedback loop).
  const pinStatesKey = anchored.map((c) => pinState(deriveCommentState(c, threadReplies(c, comments), false))).join(",");
  const pinStates = useMemo(() => (pinStatesKey ? (pinStatesKey.split(",") as PinStateValue[]) : []), [pinStatesKey]);

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
  // #714 gaps 7+8 — the review queue and the composer beside its anchor.
  const queue = useMemo(
    () => buildQueue(anchored, comments, (c, i) => (found ? found[i] === false : serverOrphans.has(c.id))),
    [anchored, comments, found, serverOrphans],
  );
  const counts = useMemo(() => queueCounts(queue), [queue]);
  // null = automatic: Open while anything is open, else All.
  const [filterPick, setFilterPick] = useState<QueueFilterChoice | null>(null);
  const filter: QueueFilterChoice = filterPick ?? (counts.open > 0 ? "open" : "all");
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [reveal, setReveal] = useState({ nonce: 0, focus: false });
  const [hover, setHover] = useState<{ id: string; at: FramePoint } | null>(null);
  // Where in the frame the current draft's spot was clicked (frame viewport
  // px), for the narrow floating composer; null = opened from the companion.
  const [draftPoint, setDraftPoint] = useState<FramePoint | null>(null);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const containerRef = useRef<HTMLDivElement>(null);
  const wide = useWideContainer(containerRef, REVIEW_RAIL_MIN_WIDTH);
  const allArtifacts = useArtifactStore((s) => s.artifacts);
  // Where the iframe sits inside its wrapper, measured when something has to
  // be placed over it (the pin preview, the floating composer).
  const frameWrapRef = useRef<HTMLDivElement>(null);
  const [frameBox, setFrameBox] = useState<FrameBox | null>(null);
  useLayoutEffect(() => {
    if (!hover && !draft) return;
    const wrap = frameWrapRef.current;
    const f = iframeRef.current;
    if (!wrap || !f) {
      setFrameBox(null);
      return;
    }
    const w = wrap.getBoundingClientRect();
    const r = f.getBoundingClientRect();
    setFrameBox(
      r.height > 0 ? { top: r.top - w.top, left: r.left - w.left, width: r.width, height: r.height, wrapHeight: w.height } : null,
    );
  }, [hover, draft, draftPoint, wide, running]);
  const floatingStyle = useMemo(
    () => (draft && !wide && frameBox ? floatingComposerStyle(frameBox, draftPoint) : null),
    [draft, wide, frameBox, draftPoint],
  );
  // #714 gaps 4+5 — the page's outline and asks, as the frame reports them
  // (display-only hints: validated, rendered as text, never acted on alone).
  const [outline, setOutline] = useState<PageOutlineMessage | null>(null);
  const [activeSection, setActiveSection] = useState(-1);
  const [asks, setAsks] = useState<PageAsk[]>([]);
  const [pinAsks, setPinAsks] = useState<number[]>([]);
  useEffect(() => {
    setOutline(null);
    setActiveSection(-1);
    setAsks([]);
    setPinAsks([]);
  }, [artifact.id]);
  const [annotate, setAnnotate] = useState(true);

  // #714 gap 2 — what changed since the previous version: a block diff of the
  // two versions' PARSED text (DOMParser, inert; nothing runs), highlighted in
  // the frame behind a toggle that starts on for any version with a
  // predecessor. Removed blocks can't be shown in the frame; they're listed.
  // The base defaults to the immediate predecessor; the reviewer may pick any
  // earlier loaded version (the file watch can land several auto-saves
  // between two reviews).
  const lineage = usePageLineage(artifact);
  const [basePick, setBasePick] = useState<{ forId: string; baseId: string } | null>(null);
  const pickedBase = basePick && basePick.forId === artifact.id ? lineage.find((l) => l.artifact.id === basePick.baseId) : undefined;
  const baseEntry = pickedBase ?? lineage[0];
  const { changes: versionChanges, pending: changesPending } = usePageVersionDiff(artifact, baseEntry?.artifact);
  const marks = versionChanges?.diff.marks ?? NO_MARKS;
  const [showChanges, setShowChanges] = useState(true);
  const [changesFound, setChangesFound] = useState<boolean[] | null>(null);
  const [changeIndex, setChangeIndex] = useState(-1);
  useEffect(() => {
    setChangesFound(null);
    setChangeIndex(-1);
  }, [marks]);

  const postToFrame = useCallback((msg: unknown) => {
    // "*" — the frame's origin is opaque ("null"); nothing sent here is secret
    // (anchors the human already made on this page, never comment text).
    iframeRef.current?.contentWindow?.postMessage(msg, "*");
  }, []);
  // Anchors, colour states and comment ids, never comment text (the hover
  // preview is rendered here, from the store).
  const sendPins = useCallback(
    () => postToFrame(buildPinsMessage(anchors, pinStates, pinIds)),
    [postToFrame, anchors, pinStates, pinIds],
  );
  // #714 — pointing is the reviewer's choice before Run as well as after: a
  // page with no scripts never shows Run, and its own links, details and
  // CSS-only tabs work either way (the annotator lets native controls keep
  // their default action unless Alt/Option is held).
  // `scripts` tells the annotator whether the page's own scripts run (buttons
  // only have an action then).
  const sendMode = useCallback(() => postToFrame({ dp: "mode", annotate, scripts: running }), [postToFrame, annotate, running]);
  // Locators only (tag + clipped text + occurrence), each Zod-validated.
  const sendChanges = useCallback(
    () => postToFrame(buildChangesMessage(marks, showChanges && marks.length > 0)),
    [postToFrame, marks, showChanges],
  );

  // Keep the latest senders and the EFFECTIVE pointing mode in refs so the one
  // message listener never goes stale.
  const sendersRef = useRef({ sendPins, sendMode, sendChanges });
  sendersRef.current = { sendPins, sendMode, sendChanges };
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
        setDraftPoint(acceptAnchorPoint(event, frame));
        setExplicitOpen(false);
        setOpenNonce((n) => n + 1);
        setFrameFocusNonce((n) => n + 1);
        return;
      }
      if (isReadyMessage(event, frame)) {
        sendersRef.current.sendMode();
        sendersRef.current.sendPins();
        sendersRef.current.sendChanges();
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
      if (status) {
        setFound(status);
        return;
      }
      // #714 gap 7 — a pin clicked in the frame: scroll to and highlight its
      // comment in the queue. Display-only (nothing is posted or changed), and
      // ignored once the page's own scripts run (they could forge it), like
      // the other frame reports.
      const pinClick = acceptPinClick(event, frame);
      if (pinClick !== null) {
        if (runningRef.current) return;
        const entry = queueRef.current.find((e) => e.comment.id === pinClick);
        if (!entry) return;
        const bucket = stateFilter(entry.state);
        if (filterRef.current !== "all" && filterRef.current !== bucket) setFilterPick(bucket);
        setHighlightId(entry.comment.id);
        setReveal((r) => ({ nonce: r.nonce + 1, focus: frameOwnsFocusRef.current(element) }));
        return;
      }
      const pinHover = acceptPinHover(event, frame);
      if (pinHover) {
        if (runningRef.current) return;
        setHover(pinHover.id === null ? null : pinHover);
        return;
      }
      // #714 gaps 4+5 — outline, reading progress and asks follow the same
      // trust model as changes-status below: once the page's own scripts run
      // they could forge these, so they are ignored then and the last
      // pre-Run report stands.
      const reportedOutline = acceptOutlineMessage(event, frame);
      if (reportedOutline) {
        if (!runningRef.current) setOutline(reportedOutline);
        return;
      }
      const active = acceptOutlineActive(event, frame);
      if (active !== null) {
        if (!runningRef.current) setActiveSection(active);
        return;
      }
      const reportedAsks = acceptAsksMessage(event, frame);
      if (reportedAsks) {
        if (!runningRef.current) {
          setAsks(reportedAsks.asks);
          setPinAsks(reportedAsks.pinAsks);
        }
        return;
      }
      // Trust model: once the page's own scripts run they share the frame and
      // could forge this report, so it is ignored then; the companion's own
      // computed count stands.
      const changeStatus = acceptChangesStatus(event, frame);
      if (changeStatus && !runningRef.current) setChangesFound(changeStatus);
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
  useEffect(() => {
    sendChanges();
  }, [sendChanges]);
  // A remounted frame (Run) reports fresh pin status after its "ready".
  useEffect(() => {
    setFound(null);
    setChangesFound(null);
    setHover(null);
  }, [running]);
  useEffect(() => {
    setHighlightId(null);
    setHover(null);
    setFilterPick(null);
  }, [artifact.id]);

  // Frame-initiated focus: re-check ownership at the moment of moving it.
  useEffect(() => {
    if (!frameFocusNonce || !frameOwnsFocus(acceptingFrame.current)) return;
    // preventScroll: the composer sits beside the frame (rail) or over it near
    // the spot (floating), so focusing it must not scroll the spot away.
    composerBoxRef.current?.querySelector("textarea")?.focus?.({ preventScroll: true });
  }, [frameFocusNonce, frameOwnsFocus]);

  const onRunningChange = useCallback((r: boolean) => setRunning(r), []);

  /** Step to the next/previous change the frame could find (all of them until
   *  it reports) and scroll the frame to it. */
  const stepChange = (dir: 1 | -1) => {
    const n = marks.length;
    if (!n) return;
    for (let k = 1; k <= n; k++) {
      const i = (((changeIndex < 0 ? (dir === 1 ? -1 : 0) : changeIndex) + dir * k) % n + n) % n;
      if (changesFound && changesFound[i] === false) continue;
      setChangeIndex(i);
      postToFrame({ dp: "focus-change", index: i });
      return;
    }
  };
  const visibleHighlights = changesFound ? changesFound.filter(Boolean).length : marks.length;
  const totalCandidates = versionChanges ? versionChanges.diff.changeMarksTotal + versionChanges.diff.hintMarksTotal : 0;
  const summaryChanged =
    !!baseEntry && (coercePageContent(baseEntry.artifact.content).summary ?? "").trim() !== (page.summary ?? "").trim();
  // The revise reason, shown on the version it explains. A file-watch version's
  // reason is the watch's own boilerplate, said better by its notice.
  const reviseReason = artifact.version > 1 && !fileWatch.recorded ? artifact.agentReasoning?.trim() : "";

  const focusComment = (index: number) => {
    const anchor = anchors[index];
    if (!anchor) return;
    postToFrame({ dp: "focus", index });
    setHighlightId(anchored[index]?.id ?? null);
    if (!readOnly) {
      acceptingFrame.current = null;
      setDraftPoint(null);
      setDraft({ ...anchor, version: artifact.version });
      setExplicitOpen(true);
      setOpenNonce((n) => n + 1);
    }
  };

  // #714 gap 4 — per-section badges. The frame says which section each pin
  // and change mark sits in; the companion decides what counts: a comment the
  // reviewer hasn't resolved whose spot is on this version, a change mark from
  // its own diff. A report for a different pin/mark list is ignored until the
  // frame re-reports.
  const headings = outline?.headings ?? [];
  const sectionCounts = useMemo(() => {
    const n = outline?.headings.length ?? 0;
    const comments = new Array<number>(n).fill(0);
    const changes = new Array<number>(n).fill(0);
    if (!outline) return { comments, changes };
    if (outline.pins.length === anchored.length) {
      anchored.forEach((c, i) => {
        const s = outline.pins[i]!;
        // Only comments still OPEN in the review queue (#714 gap 7).
        if (s < 0 || queue[i]?.state.kind !== "open") return;
        comments[s] = (comments[s] ?? 0) + 1;
      });
    }
    if (outline.changes.length === marks.length) {
      outline.changes.forEach((s) => {
        if (s >= 0) changes[s] = (changes[s] ?? 0) + 1;
      });
    }
    return { comments, changes };
  }, [outline, anchored, queue, marks]);
  const jumpToHeading = (index: number) => {
    const h = headings[index];
    if (!h) return;
    setActiveSection(index);
    postToFrame({ dp: "focus-heading", index, locator: h.locator });
  };

  // #714 gap 5 — an ask is answered once a human comment on THIS version is
  // anchored to it (its locator or #id, or inside it — including a child
  // with its own id, which the frame resolves as pinAsks for a found pin).
  // Never by a comment the reviewer resolved or whose spot isn't on this
  // version. A comment from an EARLIER version counts only through ask
  // continuity: the same ask (same id) exists in that version and this one
  // with the same FULL text — both read from parsed HTML, never from the
  // frame's clipped display text — and the comment targeted it there. The
  // parse runs off the render path; until it lands, earlier answers don't
  // count yet (the ask shows open).
  const earlierVersionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const c of anchored) if (c.target.artifactId && c.target.artifactId !== artifact.id) ids.add(c.target.artifactId);
    return ids;
  }, [anchored, artifact.id]);
  const askVersions = useMemo(
    () => [artifact, ...lineage.map((l) => l.artifact).filter((a) => earlierVersionIds.has(a.id))],
    [artifact, lineage, earlierVersionIds],
  );
  const parsedAsks = usePageAskVersions(askVersions, asks.length > 0 && earlierVersionIds.size > 0);
  const askAnswered = useMemo(() => {
    const current = { artifactId: artifact.id, version: artifact.version };
    const pinsAligned = pinAsks.length === anchored.length;
    const currentParsed = parsedAsks(artifact.id);
    const earlierAsks = (versionId: string) => (versionId === artifact.id ? undefined : parsedAsks(versionId));
    return asks.map((ask, k) => {
      // Continuity compares the full-text hash from THIS version's parsed HTML.
      const fullHash = ask.id ? currentParsed?.find((p) => p.id === ask.id)?.fullHash : undefined;
      const ref = { ...ask, ...(fullHash ? { fullHash } : {}) };
      return anchored.some((c, i) => {
        if (found && found[i] === false) return false;
        // Only meaningful for a current-version comment (the shared helper
        // ignores it otherwise), and only for a pin the frame reported found.
        const insideByFrame = pinsAligned && pinAsks[i] === k && found?.[i] === true;
        return commentAnswersAsk(ref, c, current, { insideByFrame, earlierAsks });
      });
    });
  }, [asks, anchored, pinAsks, found, artifact.id, artifact.version, parsedAsks]);
  const jumpToAsk = (index: number) => {
    const ask = asks[index];
    if (ask) postToFrame({ dp: "focus-ask", index, locator: ask.locator });
  };
  /** Reply = the same flow as clicking the ask in the frame: the composer
   *  opens anchored to it (focused, since the reviewer asked for it). */
  const replyToAsk = (index: number) => {
    const ask = asks[index];
    const anchor = ask ? askAnchor(ask) : null;
    if (!ask || !anchor || readOnly) return;
    postToFrame({ dp: "focus-ask", index, locator: ask.locator });
    acceptingFrame.current = null;
    setDraftPoint(null);
    setDraft({ ...anchor, version: artifact.version });
    setExplicitOpen(true);
    setOpenNonce((n) => n + 1);
  };
  const outlineProps = {
    headings,
    commentCounts: sectionCounts.comments,
    changeCounts: showChanges ? sectionCounts.changes : [],
    active: activeSection,
    onJump: jumpToHeading,
  };

  const draftComments = draft
    ? comments.filter((c) => {
        if (sameHtmlAnchor(c.target.htmlAnchor, draft)) return true;
        // Replies thread under their anchored root.
        const root = anchored.find((r) => r.id === c.parentCommentId);
        return !!root && sameHtmlAnchor(root.target.htmlAnchor, draft);
      })
    : [];

  /** Close the composer; Escape (and Close) hand focus back to the frame so
   *  the reviewer can keep pointing. The typed text stays saved as a draft
   *  for that spot (useDraft), so reopening it restores the text. */
  const closeComposer = () => {
    setDraft(null);
    setDraftPoint(null);
    iframeRef.current?.focus?.();
  };
  const onComposerKeyDown = (e: ReactKeyboardEvent) => {
    // A nested control that handles its own Escape (Rule this out's confirm
    // step) marks it handled first; stopPropagation keeps the app-level
    // Escape handler from moving focus elsewhere.
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    closeComposer();
  };
  const composer =
    draft && !readOnly ? (
      <div
        className={`p-3 rounded-lg border border-accent-blue/30 bg-surface-elevated space-y-2 ${wide ? "" : "shadow-xl"}`}
        ref={composerBoxRef}
        role="group"
        aria-label="Comment composer"
        onKeyDown={onComposerKeyDown}
        data-testid="page-anchor-composer"
        data-placement={wide ? "rail" : floatingStyle ? "floating" : "below"}
      >
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <AnchorContext anchor={draft} />
          </div>
          <button
            type="button"
            onClick={closeComposer}
            title="Close (Esc) and return to the page"
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
          placeholder="Comment on this spot… (⌘⏎ to send, Esc to return to the page)"
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
    ) : null;
  const queueEl = (variant: "rail" | "below") => (
    <PageReviewQueue
      entries={queue}
      counts={counts}
      filter={filter}
      onFilter={setFilterPick}
      highlightId={highlightId}
      revealNonce={reveal.nonce}
      focusRow={reveal.focus}
      onSelect={focusComment}
      fromVersion={(c) => commentPriorVersion(allArtifacts, c, artifact.id)}
      liveStances={liveStances}
      variant={variant}
    />
  );
  const hoverEntry = hover ? queue.find((e) => e.comment.id === hover.id) : undefined;
  const hoverStyle: CSSProperties | undefined =
    hover && hoverEntry
      ? {
          left: Math.max(0, (frameBox?.left ?? 0) + Math.min(hover.at.x, Math.max(0, (frameBox?.width ?? 0) - 240))),
          top: (frameBox?.top ?? 0) + Math.max(0, Math.min(hover.at.y + 4, frameBox?.height ?? hover.at.y + 4)),
        }
      : undefined;

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
      {(reviseReason || fileWatch.recorded || baseEntry) && (
        <div
          className="px-3 py-2 rounded-lg border border-accent-violet/30 bg-accent-violet/5 space-y-1.5"
          data-testid="page-version-changes"
        >
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            {reviseReason && (
              <p className="text-xs text-text-primary" data-testid="page-revise-reason">
                <span className="font-semibold text-accent-violet">Why v{artifact.version}:</span> {reviseReason}
              </p>
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
          </div>
          {baseEntry && (
            <div className="flex flex-wrap items-center gap-2 text-2xs text-text-muted" data-testid="page-changes-bar">
              <button
                type="button"
                onClick={() => setShowChanges((v) => !v)}
                aria-pressed={showChanges}
                className="px-1.5 py-0.5 rounded border border-border-default hover:bg-surface-elevated text-text-secondary"
                title="Mark the blocks that are new, reworded or moved to another section since the version you compare with"
                data-testid="page-changes-toggle"
              >
                Changes since v{baseEntry.artifact.version}: {showChanges ? "on" : "off"}
              </button>
              {lineage.length > 1 && (
                <label className="inline-flex items-center gap-1">
                  <span>Compare with</span>
                  <select
                    aria-label="Compare with"
                    value={baseEntry.artifact.id}
                    onChange={(e) => setBasePick({ forId: artifact.id, baseId: e.target.value })}
                    className="bg-surface-elevated border border-border-default rounded px-1 py-0.5 text-text-secondary"
                    data-testid="page-compare-with"
                  >
                    {lineage.map((l) => (
                      <option key={l.artifact.id} value={l.artifact.id}>
                        v{l.artifact.version}
                        {l.autoSave ? " (auto-save)" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {changesPending && <span data-testid="page-changes-pending">Comparing…</span>}
              {versionChanges && showChanges && marks.length > 0 && (
                <span className="inline-flex items-center gap-1" data-testid="page-changes-nav">
                  <span data-testid="page-changes-count">
                    {visibleHighlights} {visibleHighlights === 1 ? "highlight" : "highlights"}
                    {changeIndex >= 0 && visibleHighlights > 0 ? ` (at ${changeIndex + 1})` : ""}
                  </span>
                  <span className="text-text-muted" data-testid="page-changes-breakdown">
                    ({versionChanges.diff.changeMarksTotal} {versionChanges.diff.changeMarksTotal === 1 ? "change" : "changes"}
                    {versionChanges.diff.hintMarksTotal > 0
                      ? ` · ${versionChanges.diff.hintMarksTotal} author ${versionChanges.diff.hintMarksTotal === 1 ? "hint" : "hints"}`
                      : ""}
                    {versionChanges.diff.unhighlightable > 0 ? ` · ${versionChanges.diff.unhighlightable} not highlightable` : ""}
                    {totalCandidates > marks.length ? `; showing ${marks.length} of ${totalCandidates}` : ""})
                  </span>
                  <button
                    type="button"
                    onClick={() => stepChange(-1)}
                    disabled={visibleHighlights === 0}
                    aria-label="Previous highlight"
                    className="px-1 rounded border border-border-default hover:bg-surface-elevated disabled:opacity-40"
                  >
                    ‹
                  </button>
                  <button
                    type="button"
                    onClick={() => stepChange(1)}
                    disabled={visibleHighlights === 0}
                    aria-label="Next highlight"
                    className="px-1 rounded border border-border-default hover:bg-surface-elevated disabled:opacity-40"
                  >
                    ›
                  </button>
                </span>
              )}
              {versionChanges && marks.length === 0 && versionChanges.diff.unhighlightable > 0 && (
                <span data-testid="page-changes-unhighlightable">
                  ({versionChanges.diff.unhighlightable} {versionChanges.diff.unhighlightable === 1 ? "change" : "changes"} not highlightable)
                </span>
              )}
              {versionChanges && <PageChangeLine summary={versionChanges.summary} truncated={versionChanges.diff.truncated} />}
              {summaryChanged && <span data-testid="page-summary-changed">The summary above was updated too.</span>}
            </div>
          )}
          {versionChanges && (versionChanges.summary.removed.length > 0 || versionChanges.summary.removedSections.length > 0) && (
            <details className="text-2xs" data-testid="page-changes-removed">
              <summary className="cursor-pointer text-text-muted">
                Removed since v{versionChanges.base.version} (not on the page any more)
              </summary>
              <div className="pt-1">
                <PageRemovedList summary={versionChanges.summary} />
              </div>
            </details>
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
      <PageAsksStrip asks={asks} answered={askAnswered} readOnly={readOnly} onJump={jumpToAsk} onReply={replyToAsk} />
      {/* #714 gap 4 — the outline: a sticky rail beside the frame when the
          panel is wide, a collapsible disclosure above it when narrow.
          #714 gaps 7+8 — the review rail (composer + comment queue) on the
          right once the panel is wide enough for both rails; narrower, the
          composer floats over the frame near its spot and the queue sits
          below. */}
      <div className="@container" ref={containerRef} data-review-layout={wide ? "rail" : "below"}>
        {headings.length > 0 && (
          <div className="@3xl:hidden mb-2">
            <PageOutline {...outlineProps} variant="disclosure" />
          </div>
        )}
        <div className="flex items-start gap-3">
          {headings.length > 0 && (
            <div className="hidden @3xl:block w-56 shrink-0 self-stretch">
              <PageOutline {...outlineProps} variant="rail" />
            </div>
          )}
          <div className="flex-1 min-w-0 relative" ref={frameWrapRef}>
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
            {hoverEntry && (
              <div
                role="tooltip"
                className="absolute z-20 pointer-events-none max-w-xs px-2 py-1.5 rounded border border-border-default bg-surface-elevated shadow-lg text-2xs space-y-0.5"
                style={hoverStyle}
                data-testid="page-pin-preview"
              >
                <div className="flex items-center gap-1.5 text-text-muted">
                  <span className="font-semibold text-text-secondary">#{hoverEntry.index + 1}</span>
                  <span>{stateLabel(hoverEntry.state).text}</span>
                  {hoverEntry.replies > 0 && (
                    <span>
                      · {hoverEntry.replies} {hoverEntry.replies === 1 ? "reply" : "replies"}
                    </span>
                  )}
                </div>
                <p className="text-text-primary line-clamp-3 break-words">{snippet(hoverEntry.comment.content)}</p>
              </div>
            )}
            {composer && !wide && floatingStyle && (
              <div className="absolute z-30" style={floatingStyle} data-testid="page-composer-floating">
                {composer}
              </div>
            )}
          </div>
          {wide && (
            <aside
              className="w-72 shrink-0 self-stretch"
              aria-label="Review"
              data-testid="page-review-rail"
            >
              <div className="sticky top-2 max-h-[calc(70vh+2rem)] overflow-y-auto space-y-3 pr-0.5">
                {composer}
                {queueEl("rail")}
              </div>
            </aside>
          )}
        </div>
        {/* Narrow, with no room measured to float it (the frame hasn't laid
            out): the composer falls back to just under the frame. */}
        {composer && !wide && !floatingStyle && <div className="mt-2">{composer}</div>}
      </div>

      {!wide && queueEl("below")}
      <ArtifactStatusActions artifact={artifact} />
    </div>
  );
}
