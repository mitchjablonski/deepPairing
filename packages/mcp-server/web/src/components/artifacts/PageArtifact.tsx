import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import type { Artifact, Comment, HtmlAnchor } from "@deeppairing/shared";
import { coercePageContent, PAGE_HTML_MAX_BYTES, PAGE_RENDER_ISSUES_VISUAL_ID, readFileWatch } from "@deeppairing/shared";
import { SimpleMarkdown } from "../SimpleMarkdown";
import { ConceptBadge } from "../ConceptBadge";
import { PrototypeFrame, type FrameAnnotation } from "../PrototypeFrame";
import { CommentThread } from "../CommentThread";
import { ArtifactStatusActions } from "./ArtifactStatusActions";
import { useChainComments } from "../../hooks/useChainComments";
import { useOfflineReason } from "../../hooks/useOfflineReason";
import { useReplayStore } from "../../stores/replay";
import { useArtifactStore } from "../../stores/artifact";
import { reviewLifecycle } from "../../lib/reviewLifecycle";
import { ANNOTATOR_SCRIPT, annotatorScript } from "../../lib/pageAnnotator";
import { sanitizePageHtml } from "../../lib/pageSanitize";
import { PAGE_MERMAID_PREPARE } from "../../lib/pageMermaid";
import {
  acceptAnchorMessage,
  acceptPinClick,
  acceptPinHover,
  buildPinsMessage,
  type FramePoint,
  type PinStateValue,
  acceptAsksMessage,
  acceptChangesStatus,
  acceptDiagnosticsReport,
  type PageDiagnostics,
  acceptOutlineActive,
  acceptOutlineMessage,
  acceptPinsStatusReport,
  askAnchor,
  buildChangesMessage,
  isReadyMessage,
  isTogglePointingMessage,
  acceptFrameKey,
  acceptKbdCursor,
  buildModeMessage,
  isKbdOffMessage,
  type PageKbdCursor,
  type PageAsk,
  type PageOutlineMessage,
} from "../../lib/pageAnchorMessages";
import { PageOutline } from "./PageOutline";
import { PageAsksStrip } from "./PageAsksStrip";
import { usePageAskVersions } from "../../hooks/usePageAskVersions";
import { usePageLineage, usePageVersionDiff } from "../../hooks/usePageVersionDiff";
import { PageChangeLine, PageRemovedList } from "./PageChangeSummary";
import type { ChangeLocator } from "../../lib/pageVersionDiff";
import { htmlAnchorKindLabel, isPageListedComment, sameHtmlAnchor } from "../../lib/htmlAnchorDisplay";
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
import { PageShortcutHelp } from "./PageShortcutHelp";
import { pageOptsIntoDark } from "../../lib/pageTheme";
import { resolveTheme, usePreferencesStore } from "../../stores/preferences";
import { PageRenderIssues } from "./PageRenderIssues";
import { diagnosticsAgentSummary, diagnosticsWakeKey, hasDiagnostics } from "../../lib/pageDiagnostics";
import { useRememberedRejections } from "../decision/NeverSuggestControl";
import { askTextHash, commentAnswersAsk, isEarlierVersionComment, pageRuleOutKey } from "@deeppairing/shared";

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
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
/** The hover preview's max width (Tailwind max-w-xs), for clamping it inside the frame. */
const PREVIEW_MAX_WIDTH = 320;

/** The hover preview's text: the comment, clipped. */
function snippet(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > 200 ? `${t.slice(0, 200)}…` : t;
}

/** #714 gap 12 — the render-issue report last posted per page artifact id:
 *  a new set of kinds/keys posts at once; a count-only change at most once a
 *  minute. The daemon decides what re-arms or wakes the agent (the kinds/keys
 *  set, at most once per page per five minutes). */
const reportedRenderIssues: Record<string, { key: string; text: string; at: number }> = {};
const RENDER_ISSUES_COUNT_REPOST_MS = 60_000;
/** How long a frame's diagnostics must hold still before they're reported. */
const RENDER_ISSUES_REPORT_DELAY_MS = 1500;
/** The longest a report waits from its first observation: a page whose errors
 *  keep recurring faster than the settle delay still reports (the latest
 *  coalesced counts) instead of resetting the timer forever. */
const RENDER_ISSUES_REPORT_MAX_WAIT_MS = 5000;

/** Module-level so PrototypeFrame's memo sees one stable object. */
const PAGE_ANNOTATION: FrameAnnotation = { script: ANNOTATOR_SCRIPT, scriptFor: annotatorScript, sanitize: sanitizePageHtml, prepare: PAGE_MERMAID_PREPARE };
const NO_MARKS: ChangeLocator[] = [];

/** #714 — the pointing toggle's shortcut, as shown on this platform. */
function pointingShortcutLabel(): string {
  const platform = typeof navigator !== "undefined" ? navigator.platform || "" : "";
  return /Mac|iPhone|iPad|iPod/.test(platform) ? "⌘I" : "Ctrl+I";
}

/** #714 gap 9 — a single-key page-review shortcut (C, ], [) is honoured in
 *  the companion only when no modifier is held, the reviewer isn't typing and
 *  no modal dialog is open. */
export function pageKeyTargetOk(e: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "target">): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const target = e.target as HTMLElement | null;
  const tag = target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable === true) return false;
  return !document.querySelector('[aria-modal="true"]');
}

/** #714 gap 13 — what the live region says for a keyboard-cursor move. */
export function kbdCursorAnnouncement(c: PageKbdCursor): string {
  if (c.index < 0 || c.total === 0) return "Comment mode: this page has no blocks to comment on. Press Escape to leave.";
  const text = c.text.trim();
  const pins = c.pins.length
    ? ` Has ${c.pins.length === 1 ? "comment" : "comments"} ${c.pins.map((p) => p + 1).join(", ")}.`
    : "";
  return `${c.kind[0]!.toUpperCase()}${c.kind.slice(1)}, ${c.index + 1} of ${c.total}${text ? `: ${text}` : ""}.${pins}`;
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
 * wide panel, or is docked directly below the frame on a narrow one (never
 * over the page's content), with the frame scrolling the spot near its bottom edge so
 * it stays in view; Escape returns focus to the frame.
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
  /** Identifies the anchored-comment list (the pin order the frame reports in). */
  const anchoredKey = useMemo(() => anchored.map((c) => c.id).join("\u0000"), [anchored]);
  /** The pin list's tag, sent with `pins` and echoed by the frame on every
   *  report computed from that list: a report is used for ask completion
   *  only when its key matches the list on screen, so a delete + add while a
   *  report is in flight can't be misattributed. */
  const pinsKey = useMemo(() => askTextHash(anchoredKey) ?? "0", [anchoredKey]);
  const anchors = useMemo(() => anchored.map((c) => c.target.htmlAnchor as HtmlAnchor), [anchored]);
  const pinIds = useMemo(() => anchored.map((c) => c.id), [anchored]);
  // #714 gap 7 — pin colours. Derived WITHOUT the frame's found report (an
  // orphaned comment has no pin to colour), and keyed by value, so a
  // pins-status report never re-sends the pins (no feedback loop).
  const storeArtifacts = useArtifactStore((s) => s.artifacts);
  const deriveOpts = useMemo(
    () => ({ revisionAt: (id: string) => storeArtifacts.find((a) => a.id === id)?.createdAt }),
    [storeArtifacts],
  );
  const pinStatesKey = anchored
    .map((c) => pinState(deriveCommentState(c, threadReplies(c, comments), false, deriveOpts)))
    .join(",");
  const pinStates = useMemo(() => (pinStatesKey ? (pinStatesKey.split(",") as PinStateValue[]) : []), [pinStatesKey]);

  const [draft, setDraft] = useState<HtmlAnchor | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
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
  // The frame's last found report, bound to the artifact and pin list it was
  // computed from: positional flags are used only while both still match, so
  // a delayed report after a delete / insert / reorder (or for another page)
  // can't mark the wrong comment Orphaned. Unmatched = not yet checked.
  const [foundReport, setFoundReport] = useState<{ forId: string; key: string; found: boolean[] } | null>(null);
  const found = foundReport && foundReport.forId === artifact.id && foundReport.key === pinsKey ? foundReport.found : null;
  const [running, setRunning] = useState(false);
  // #714 gaps 7+8 — the review queue and the composer beside its anchor.
  const queue = useMemo(
    () => buildQueue(anchored, comments, (c, i) => (found ? found[i] === false : serverOrphans.has(c.id)), deriveOpts),
    [anchored, comments, found, serverOrphans, deriveOpts],
  );
  const counts = useMemo(() => queueCounts(queue), [queue]);
  // null = automatic: Open while anything is open, else All.
  const [filterPick, setFilterPick] = useState<QueueFilterChoice | null>(null);
  const filter: QueueFilterChoice = filterPick ?? (counts.open > 0 ? "open" : "all");
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [reveal, setReveal] = useState({ nonce: 0, focus: false });
  const [hover, setHover] = useState<{ id: string; at: FramePoint } | null>(null);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const containerRef = useRef<HTMLDivElement>(null);
  const wide = useWideContainer(containerRef, REVIEW_RAIL_MIN_WIDTH);
  const wideRef = useRef(wide);
  wideRef.current = wide;
  // Where the iframe sits inside its wrapper, measured for the pin preview
  // and re-measured when the panel resizes.
  const frameWrapRef = useRef<HTMLDivElement>(null);
  const [frameBox, setFrameBox] = useState<FrameBox | null>(null);
  useLayoutEffect(() => {
    if (!hover) return;
    const wrap = frameWrapRef.current;
    const measure = () => {
      const f = iframeRef.current;
      if (!wrap || !f) return setFrameBox(null);
      const w = wrap.getBoundingClientRect();
      const r = f.getBoundingClientRect();
      setFrameBox({ top: r.top - w.top, left: r.left - w.left, width: r.width, height: r.height });
    };
    measure();
    if (!wrap || typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [hover, wide, running]);
  // #714 gaps 4+5 — the page's outline and asks, as the frame reports them
  // (display-only hints: validated, rendered as text, never acted on alone).
  const [outline, setOutline] = useState<PageOutlineMessage | null>(null);
  const [activeSection, setActiveSection] = useState(-1);
  const [asks, setAsks] = useState<PageAsk[]>([]);
  // Ask completion reads the frame's pre-Run reports only, each tagged with
  // the page and the anchored-comment list it describes: `pinAsks` (which
  // ask each pin sits in) and the pre-Run pin status. A live post-Run
  // pins-status (agent script shares the frame then) never mixes in; the
  // pin list itself keeps showing live status.
  const [pinAsks, setPinAsks] = useState<{ forId: string; key: string; list: number[] } | null>(null);
  const [askPinStatus, setAskPinStatus] = useState<{ forId: string; key: string; found: boolean[] } | null>(null);
  useEffect(() => {
    setOutline(null);
    setActiveSection(-1);
    setAsks([]);
    setPinAsks(null);
    setAskPinStatus(null);
  }, [artifact.id]);
  const [annotate, setAnnotate] = useState(true);
  // #714 gap 9 — keyboard comment mode (arrow/Tab between blocks in the
  // frame, Enter to comment). Only while pointing is on.
  const [kbd, setKbd] = useState(false);
  // Off once the page's own scripts run (#725): the cursor's block names are
  // ignored then (agent script could forge them), so the mode would be silent
  // for a screen reader while still taking the arrow keys.
  const kbdOn = kbd && annotate && !readOnly && !running;
  const kbdOnRef = useRef(kbdOn);
  kbdOnRef.current = kbdOn;
  // #714 gap 13 — the expanded (full-window) review, the shortcut popover,
  // and the screen-reader live region.
  const [expanded, setExpanded] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  /** Say something in the live region; repeating the same text alternates a
   *  trailing no-break space so it is announced again. */
  const announce = useCallback((text: string) => {
    setAnnouncement((prev) => (prev === text ? `${text}\u00a0` : text));
  }, []);
  // #714 gap 13 — the page's own content stays as authored: it renders dark
  // only when it says it supports dark AND the companion is dark.
  const themePref = usePreferencesStore((s) => s.theme);
  const companionDark = resolveTheme(themePref) === "dark";
  const optsIntoDark = useMemo(() => pageOptsIntoDark(page.html), [page.html]);
  const pageDark = companionDark && optsIntoDark;
  // #714 gap 12 — the frame's render diagnostics (script errors, assets that
  // didn't load, policy blocks), bound to the frame DOCUMENT that reported
  // them: PrototypeFrame mints an id per srcdoc, injects it into that
  // document's annotator and sets it on the iframe (data-dp-doc). Only
  // reports naming the id of the srcdoc the frame shows NOW are accepted.
  // srcDoc updates can reuse the iframe's WindowProxy, so the source check
  // alone would let an old document's queued ready or report through after a
  // revision; the expected id doesn't. A revision that leaves the document
  // live (a version-only change, unchanged srcdoc) keeps its report.
  const frameDocRef = useRef<string | null>(null);
  const [diagState, setDiagState] = useState<{ doc: string; id: string; diag: PageDiagnostics } | null>(null);
  const diagnostics = diagState && diagState.doc === frameDocRef.current && diagState.id === artifact.id ? diagState.diag : null;

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
  // Anchors, colour states, comment ids and the list's key (#714 gap 5: echoed
  // on every report computed from this list), never comment text (the hover
  // preview is rendered here, from the store).
  const sendPins = useCallback(
    () => postToFrame(buildPinsMessage(anchors, pinStates, pinIds, pinsKey)),
    [postToFrame, anchors, pinStates, pinIds, pinsKey],
  );
  // #714 — pointing is the reviewer's choice before Run as well as after: a
  // page with no scripts never shows Run, and its own links, details and
  // CSS-only tabs work either way (the annotator lets native controls keep
  // their default action unless Alt/Option is held).
  // `scripts` tells the annotator whether the page's own scripts run (buttons
  // only have an action then).
  const sendMode = useCallback(
    () => postToFrame(buildModeMessage({ annotate, scripts: running, kbd: kbdOn, dark: pageDark })),
    [postToFrame, annotate, running, kbdOn, pageDark],
  );
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
  /** #714 gap 9 — what a key forwarded from the frame does (set below). */
  const frameKeyRef = useRef<(key: "toggle-kbd" | "help" | "next" | "prev" | "escape") => void>(() => {});
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
      // #714 gap 9 — the reviewer left keyboard comment mode inside the page.
      // Turning it OFF is the safe direction, so it is honoured after Run too.
      // A no-op unless the mode is on (#725): a page script after Run can't
      // flood the live region with repeats.
      if (isKbdOffMessage(event, frame)) {
        if (!kbdOnRef.current) return;
        kbdOnRef.current = false;
        setKbd(false);
        announce("Comment mode off.");
        return;
      }
      // The keyboard cursor moved: announced in the live region. Display-only,
      // and ignored after Run (agent script could forge the text).
      const cursor = acceptKbdCursor(event, frame);
      if (cursor) {
        if (!runningRef.current) announce(kbdCursorAnnouncement(cursor));
        return;
      }
      // A single-key shortcut pressed inside the page (only sent before Run;
      // honoured only from the pre-Run document while the reviewer is in it).
      const key = acceptFrameKey(event, frame);
      if (key) {
        if (runningRef.current || !frameOwnsFocusRef.current(element)) return;
        frameKeyRef.current(key);
        return;
      }
      const status = acceptPinsStatusReport(event, frame);
      if (status) {
        setFoundReport({ forId: artifactIdRef.current, key: status.key ?? "", found: status.found });
        if (!runningRef.current) setAskPinStatus({ forId: artifactIdRef.current, key: status.key ?? "", found: status.found });
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
          setPinAsks({ forId: artifactIdRef.current, key: reportedAsks.key ?? "", list: reportedAsks.pinAsks });
        }
        return;
      }
      // Trust model: once the page's own scripts run they share the frame and
      // could forge this report, so it is ignored then; the companion's own
      // computed count stands.
      // #714 gap 12 — render diagnostics are accepted after Run too (that is
      // when script errors happen). Display-only: a passive banner (text) and
      // a bounded note to the agent about its own page; never an action.
      const diag = acceptDiagnosticsReport(event, frame);
      if (diag) {
        if (diag.doc === frameDocRef.current) setDiagState({ doc: diag.doc, id: artifactIdRef.current, diag: diag.diagnostics });
        return;
      }
      const changeStatus = acceptChangesStatus(event, frame);
      if (changeStatus && !runningRef.current) setChangesFound(changeStatus);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [artifact.version, readOnly, announce]);

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
    setFoundReport(null);
    setChangesFound(null);
    setHover(null);
  }, [running]);
  // #714 gap 12 — tell the agent (check_feedback) on the render-failure lane,
  // under the page's reserved visual id, once the report settles: a trailing
  // delay, bounded from the first observation (recurring errors can't starve
  // it), sending the latest coalesced summary. The pending report carries the
  // frame document it was observed on and is dropped if that document is no
  // longer current. Never from a read-only page (closed, or a replay).
  const offlineReason = useOfflineReason();
  const offline = offlineReason !== null;
  const pendingReportRef = useRef<{ doc: string; id: string; key: string; summary: string; firstAt: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  useEffect(() => () => {
    if (pendingReportRef.current) clearTimeout(pendingReportRef.current.timer);
    pendingReportRef.current = null;
  }, []);
  // The document the frame shows now: PrototypeFrame reports the id minted
  // for its current srcdoc whenever it changes (a new srcdoc or iframe, as at
  // Run, a Mermaid prepare landing or a theme flip, even without a render
  // here), from the commit that sets that srcdoc, so before the document can
  // post. The old document's report (banner, pending post) is dropped and its
  // late messages no longer match.
  const onDocChange = useCallback((doc: string | null) => {
    if (doc === frameDocRef.current) return;
    frameDocRef.current = doc;
    if (pendingReportRef.current) clearTimeout(pendingReportRef.current.timer);
    pendingReportRef.current = null;
    setDiagState(null);
  }, []);
  useEffect(() => {
    const drop = () => {
      if (pendingReportRef.current) clearTimeout(pendingReportRef.current.timer);
      pendingReportRef.current = null;
    };
    // Only a report from the CURRENT frame document, for this artifact.
    // Offline: hold the report (the latch below stays unset) and re-run on reconnect.
    if (offline) return drop();
    if (readOnly || !diagState || diagState.doc !== frameDocRef.current || diagState.id !== artifact.id || !hasDiagnostics(diagState.diag)) return drop();
    const doc = diagState.doc;
    const summary = diagnosticsAgentSummary(diagState.diag, { version: artifact.version, running });
    if (!summary) return drop();
    const id = artifact.id;
    const key = diagnosticsWakeKey(summary);
    const last = reportedRenderIssues[id];
    if (last && last.key === key && (last.text === summary || Date.now() - last.at < RENDER_ISSUES_COUNT_REPOST_MS)) return drop();
    const prev = pendingReportRef.current;
    const now = Date.now();
    const firstAt = prev && prev.doc === doc && prev.id === id ? prev.firstAt : now;
    drop();
    const fire = () => {
      const p = pendingReportRef.current;
      pendingReportRef.current = null;
      if (!p || p.doc !== frameDocRef.current || p.id !== artifactIdRef.current) return;
      reportedRenderIssues[p.id] = { key: p.key, text: p.summary, at: Date.now() };
      // No title: the daemon names the page from its own record.
      void useArtifactStore.getState().reportRenderFailure(p.id, PAGE_RENDER_ISSUES_VISUAL_ID, p.summary);
    };
    const delay = Math.max(0, Math.min(RENDER_ISSUES_REPORT_DELAY_MS, firstAt + RENDER_ISSUES_REPORT_MAX_WAIT_MS - now));
    pendingReportRef.current = { doc, id, key, summary, firstAt, timer: setTimeout(fire, delay) };
  }, [diagState, readOnly, running, artifact.id, artifact.version, offline]);
  useEffect(() => {
    setHighlightId(null);
    setHover(null);
    setFilterPick(null);
  }, [artifact.id]);

  // Frame-initiated focus: re-check ownership at the moment of moving it.
  // preventScroll, then (narrow) bring the docked composer into view with the
  // least scroll and ask the frame to put the spot near ITS bottom (next to the docked composer;
  // on a short pane, scrolling the composer into view can push the frame's top
  // off screen), so both the
  // spot and the composer are on screen. A scroll message never moves focus.
  useEffect(() => {
    if (!frameFocusNonce || !frameOwnsFocus(acceptingFrame.current)) return;
    composerBoxRef.current?.querySelector("textarea")?.focus?.({ preventScroll: true });
    if (!wideRef.current && draftRef.current) {
      composerBoxRef.current?.scrollIntoView?.({ block: "nearest" });
      const { version: _v, ...anchor } = draftRef.current;
      postToFrame({ dp: "focus", anchor, block: "end" });
    }
  }, [frameFocusNonce, frameOwnsFocus, postToFrame]);

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
    // Narrow: the composer docks below the frame, so the pin goes near the
    // frame's bottom edge, next to it, rather than its centre.
    postToFrame(wide ? { dp: "focus", index } : { dp: "focus", index, block: "end" });
    setHighlightId(anchored[index]?.id ?? null);
    if (!readOnly) {
      acceptingFrame.current = null;
      setDraft({ ...anchor, version: artifact.version });
      setExplicitOpen(true);
      setOpenNonce((n) => n + 1);
    }
  };

  // #714 gap 9 — step through the visible comments (] / [ and the queue's
  // ‹ › buttons): highlight the row, move focus to it (Enter opens its
  // thread), scroll the frame to its pin, and say where you are.
  const highlightRef = useRef(highlightId);
  highlightRef.current = highlightId;
  const stepComment = useCallback(
    (dir: 1 | -1) => {
      const list = queueRef.current;
      const f = filterRef.current;
      const visible = f === "all" ? list : list.filter((e) => stateFilter(e.state) === f);
      if (!visible.length) return;
      const at = visible.findIndex((e) => e.comment.id === highlightRef.current);
      const next = visible[at < 0 ? (dir === 1 ? 0 : visible.length - 1) : (at + dir + visible.length) % visible.length]!;
      setHighlightId(next.comment.id);
      setReveal((r) => ({ nonce: r.nonce + 1, focus: true }));
      if (!next.missing) postToFrame(wideRef.current ? { dp: "focus", index: next.index } : { dp: "focus", index: next.index, block: "end" });
      const anchor = next.comment.target.htmlAnchor as HtmlAnchor;
      const quote = anchor.quote.trim();
      announce(
        `Comment ${next.index + 1}, ${visible.indexOf(next) + 1} of ${visible.length}: ${stateLabel(next.state).text}. ` +
          `${htmlAnchorKindLabel(anchor.kind)}${quote ? ` “${quote.slice(0, 80)}”` : ""}. ${snippet(next.comment.content)}`,
      );
    },
    [postToFrame, announce],
  );

  /** Keyboard comment mode on/off. Turning it on also turns pointing on and
   *  moves focus into the frame, where the arrow keys now step blocks. */
  const toggleKbd = useCallback(() => {
    if (readOnly || running) return;
    const next = !(kbd && annotate);
    setKbd(next);
    if (next) {
      setAnnotate(true);
      iframeRef.current?.focus?.();
    }
    announce(
      next
        ? "Comment mode on. Arrow keys or Tab move between blocks, Enter comments, Escape leaves."
        : "Comment mode off.",
    );
  }, [readOnly, running, kbd, annotate, announce]);
  useEffect(() => {
    if (!annotate || running) setKbd(false);
  }, [annotate, running]);

  frameKeyRef.current = (key) => {
    if (key === "toggle-kbd") toggleKbd();
    else if (key === "help") setHelpOpen((o) => !o);
    else if (key === "next") stepComment(1);
    else if (key === "prev") stepComment(-1);
    else if (key === "escape") {
      if (helpOpen) setHelpOpen(false);
      else if (expanded) setExpanded(false);
    }
  };

  // #714 gap 9 — C, ] and [ in the companion while this page is selected
  // (never while typing, never with a modifier, never under a modal).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.repeat || !pageKeyTargetOk(e)) return;
      // C with Caps Lock (or Shift) is still C.
      const k = e.key === "C" ? "c" : e.key;
      if (k !== "c" && k !== "]" && k !== "[") return;
      const root = rootRef.current;
      if (!root || !root.isConnected || root.closest("[inert]")) return;
      if (useArtifactStore.getState().selectedArtifactId !== artifactIdRef.current) return;
      if (k === "c") {
        if (readOnly) return;
        e.preventDefault();
        toggleKbd();
        return;
      }
      e.preventDefault();
      stepComment(k === "]" ? 1 : -1);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [readOnly, toggleKbd, stepComment]);

  // #714 gap 13 — announce a comment you just posted on the page (a new
  // anchored root after the first render), and the pins this version can't
  // place once the frame reports them.
  const seenIds = useRef<{ forId: string; ids: Set<string> } | null>(null);
  useEffect(() => {
    const ids = new Set(anchored.map((c) => c.id));
    const before = seenIds.current?.forId === artifact.id ? seenIds.current.ids : null;
    seenIds.current = { forId: artifact.id, ids };
    // A different page (or the first render) is a baseline, not a post.
    if (!before) return;
    const fresh = anchored.filter((c) => !before.has(c.id));
    if (fresh.length === 1) {
      const i = anchored.indexOf(fresh[0]!);
      announce(`Comment ${i + 1} posted.`);
    } else if (fresh.length > 1) announce(`${fresh.length} comments added.`);
  }, [anchored, announce, artifact.id]);
  const missingCount = found ? found.filter((f) => !f).length : 0;
  useEffect(() => {
    if (missingCount > 0) {
      announce(`${missingCount} of ${anchored.length} ${anchored.length === 1 ? "comment's spot is" : "comments' spots are"} not on this version.`);
    }
    // Only when the count changes, not on every queue re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingCount]);

  /** #714 — Resolve / Reopen a plain comment from the queue, over the
   *  existing humanResolvedAt resolution. */
  const markQuestionResolved = useArtifactStore((s) => s.markQuestionResolved);
  const reopenComment = useArtifactStore((s) => s.reopenComment);
  const onResolve = useCallback(
    (commentId: string, resolve: boolean) => {
      // Offline: the buttons are disabled; never post from here either.
      if (offlineReason) return;
      const n = anchored.findIndex((c) => c.id === commentId) + 1;
      const op = resolve ? markQuestionResolved(commentId) : reopenComment(commentId);
      void op.then(
        () => announce(`Comment ${n} ${resolve ? "resolved" : "reopened"}.`),
        () => {},
      );
    },
    [anchored, markQuestionResolved, reopenComment, announce, offlineReason],
  );

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
  // The current version is parsed too whenever asks have comments: its
  // full-text hashes (continuity) and child ids (a comment on a child with its
  // own id, also after Run when the frame's reports are frozen).
  const parsedAsks = usePageAskVersions(askVersions, asks.length > 0 && anchored.length > 0);
  // #725 — also which comments answer an ask (no Resolve/Reopen on those).
  const { answered: askAnswered, answerIds: askAnswerIds } = useMemo(() => {
    const current = { artifactId: artifact.id, version: artifact.version };
    // The pre-Run reports, only when they describe this page's current pins.
    const scoped = <T extends { forId: string; key: string }>(r: T | null) =>
      r && r.forId === artifact.id && r.key === pinsKey ? r : null;
    const askPins = scoped(pinAsks)?.list ?? null;
    const preRunFound = scoped(askPinStatus)?.found ?? null;
    const pinsAligned = !!askPins && askPins.length === anchored.length;
    const currentParsed = parsedAsks(artifact.id);
    const earlierAsks = (versionId: string) => (versionId === artifact.id ? undefined : parsedAsks(versionId));
    const answerIds = new Set<string>();
    const answered = asks.map((ask, k) => {
      // Continuity compares the full-text hash from THIS version's parsed HTML.
      const parsed = ask.id ? currentParsed?.find((p) => p.id === ask.id) : undefined;
      const ref = {
        ...ask,
        ...(parsed?.fullHash ? { fullHash: parsed.fullHash } : {}),
        ...(parsed?.childIds ? { childIds: parsed.childIds } : {}),
      };
      let any = false;
      anchored.forEach((c, i) => {
        if (answersAsk(c, i)) {
          any = true;
          answerIds.add(c.id);
        }
      });
      return any;
      function answersAsk(c: Comment, i: number): boolean {
        // An earlier version's comment is judged only against its own source
        // version (ask continuity); whether its pin relocates in the current
        // view is irrelevant to it, as it is for check_feedback.
        if (isEarlierVersionComment(c, current)) return commentAnswersAsk(ref, c, current, { earlierAsks });
        // A current-version comment whose spot the (pre-Run) frame can't find
        // doesn't count; one it found inside this ask does.
        if (preRunFound && preRunFound[i] === false) return false;
        const insideByFrame = pinsAligned && askPins![i] === k && preRunFound?.[i] === true;
        return commentAnswersAsk(ref, c, current, { insideByFrame });
      }
    });
    return { answered, answerIds };
  }, [asks, anchored, pinsKey, pinAsks, askPinStatus, artifact.id, artifact.version, parsedAsks]);
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
        className="p-3 rounded-lg border border-accent-blue/30 bg-surface-elevated space-y-2"
        ref={composerBoxRef}
        role="group"
        aria-label="Comment composer"
        onKeyDown={onComposerKeyDown}
        data-testid="page-anchor-composer"
        data-placement={wide ? "rail" : "below"}
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
      fromVersion={(c) => commentPriorVersion(storeArtifacts, c, artifact.id)}
      liveStances={liveStances}
      variant={variant}
      onStep={stepComment}
      onResolve={readOnly ? undefined : onResolve}
      askAnswerIds={askAnswerIds}
      offlineReason={offlineReason}
    />
  );
  const hoverEntry = hover ? queue.find((e) => e.comment.id === hover.id) : undefined;
  const hoverStyle: CSSProperties | undefined =
    hover && hoverEntry
      ? {
          // Clamped by the preview's real max width so it never overflows the frame.
          left: (frameBox?.left ?? 0) + clamp(hover.at.x, 0, (frameBox?.width ?? 0) - PREVIEW_MAX_WIDTH),
          top: (frameBox?.top ?? 0) + clamp(hover.at.y + 4, 0, frameBox?.height ?? hover.at.y + 4),
          maxWidth: PREVIEW_MAX_WIDTH,
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
      {/* #714 gap 13 — the review area (toolbar, issues, asks, outline, frame,
          review column) can expand to fill the window. Same DOM nodes either
          way: the iframe never remounts (its Run state and scroll survive). */}
      <div
        className={expanded ? "fixed inset-0 z-40 overflow-y-auto overflow-x-hidden bg-surface-primary p-2 sm:p-3 space-y-3" : "space-y-3"}
        role={expanded ? "region" : undefined}
        aria-label={expanded ? `${artifact.title || "Page"} — expanded review` : undefined}
        data-testid="page-review-area"
        data-expanded={expanded ? "true" : "false"}
        onKeyDown={(e) => {
          if (!expanded || e.key !== "Escape" || e.defaultPrevented) return;
          e.preventDefault();
          e.stopPropagation();
          setExpanded(false);
        }}
      >
      <div className="flex flex-wrap items-center gap-2 text-2xs text-text-muted" data-testid="page-view-bar">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-pressed={expanded}
          title={expanded ? "Back to the normal view (Esc)" : "Fill the window with the page and its review"}
          className="px-1.5 py-0.5 rounded border border-border-default hover:bg-surface-elevated text-text-secondary pointer-coarse:min-h-11"
          data-testid="page-expand-toggle"
        >
          {expanded ? "Collapse" : "Expand"}
        </button>
        <PageShortcutHelp open={helpOpen} onOpenChange={setHelpOpen} />
        {companionDark && (
          <span data-testid="page-theme-note">
            {optsIntoDark ? "The page supports dark mode, so it's shown dark." : "The page is shown as authored (light)."}
          </span>
        )}
      </div>
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
          <button
            type="button"
            onClick={toggleKbd}
            disabled={running}
            aria-pressed={kbdOn}
            aria-keyshortcuts="C"
            title={
              running
                ? "Comment mode isn't available once the page's scripts run. Click or select text to comment."
                : "Comment without a mouse: arrow keys or Tab move between blocks in the page, Enter comments on one, Escape leaves (C)"
            }
            className="px-1.5 py-0.5 rounded border border-border-default hover:bg-surface-elevated text-text-secondary pointer-coarse:min-h-11 disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="page-kbd-toggle"
          >
            {kbdOn ? "Comment mode: on" : "Comment mode: off"}
            <kbd className="ml-1 font-mono text-[9px] text-text-muted">C</kbd>
          </button>
          <span id={hintId} data-testid="page-pointing-hint">
            {annotate
              ? "Click anything on the page, or select text, to comment on that spot. In-page links, summaries, radio/checkbox tabs and form fields still work — Alt/Option-click to comment on one."
              : "Pointing is off: clicks go to the page. Turn it on to comment on a spot."}
            {kbdOn && " Comment mode: arrow keys or Tab move between blocks, Enter comments, Escape leaves."}
            {running && ` Scripts are running: to switch pointing, use this toggle or press ${pointingShortcutLabel()} outside the page.`}
          </span>
        </div>
      )}
      <PageRenderIssues diagnostics={diagnostics} />
      <PageAsksStrip asks={asks} answered={askAnswered} readOnly={readOnly} onJump={jumpToAsk} onReply={replyToAsk} />
      {/* #714 gap 4 — the outline: a sticky rail beside the frame when the
          panel is wide, a collapsible disclosure above it when narrow.
          #714 gaps 7+8 — ONE review column (composer + queue), always the same
          DOM node so the composer never remounts (focus and draft survive a
          layout switch): a sticky right-hand rail when the panel is wide
          enough for both rails, else a full-width row directly below the
          frame. It is never drawn over the frame's content. */}
      <div className="@container" ref={containerRef} data-review-layout={wide ? "rail" : "below"}>
        {headings.length > 0 && (
          <div className="@3xl:hidden mb-2">
            <PageOutline {...outlineProps} variant="disclosure" />
          </div>
        )}
        <div
          className={`grid gap-3 items-start grid-cols-1 ${headings.length > 0 ? "@3xl:grid-cols-[14rem_minmax(0,1fr)]" : ""}`}
          style={wide ? { gridTemplateColumns: `${headings.length > 0 ? "14rem " : ""}minmax(0,1fr) 18rem` } : undefined}
          data-testid="page-review-grid"
        >
          {headings.length > 0 && (
            <div className="hidden @3xl:block self-stretch">
              <PageOutline {...outlineProps} variant="rail" />
            </div>
          )}
          <div className="min-w-0 relative" ref={frameWrapRef} data-testid="page-frame-box">
            <PrototypeFrame
              html={page.html}
              maxBytes={PAGE_HTML_MAX_BYTES}
              staticFirst
              noun="page"
              frameClassName={`w-full ${expanded ? "h-[calc(100dvh-8rem)] min-h-[320px]" : "h-[70vh] min-h-[320px] sm:min-h-[420px]"} rounded border border-border-default ${
                pageDark ? "bg-surface-secondary [color-scheme:dark]" : "bg-white [color-scheme:light]"
              }`}
              annotation={PAGE_ANNOTATION}
              iframeRef={iframeRef}
              onRunningChange={onRunningChange}
              onDocChange={onDocChange}
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
          </div>
          <div
            className={wide ? "sticky top-2 max-h-[calc(70vh+2rem)] overflow-y-auto space-y-3 pr-0.5" : "col-span-full space-y-3"}
            role={wide ? "complementary" : undefined}
            aria-label="Review"
            data-testid="page-review-column"
            data-placement={wide ? "rail" : "below"}
          >
            {composer}
            {queueEl(wide ? "rail" : "below")}
          </div>
        </div>
      </div>
      </div>
      {/* #714 gap 13 — one polite live region for the page review: keyboard
          cursor, queue position, posting and resolving, pins not found. */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="page-live-region">
        {announcement}
      </div>
      <ArtifactStatusActions artifact={artifact} />
    </div>
  );
}
