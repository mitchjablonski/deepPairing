import { useEffect, useRef, useState } from "react";
import { apiGet, apiBase } from "./lib/api";
import { ArtifactPanel } from "./components/ArtifactPanel";
import { IdleHome } from "./components/IdleHome";
import { SessionWrapCard } from "./components/SessionWrapCard";
import { computePending } from "./lib/pending";
import { useAgentRecentlyActive } from "./hooks/useAgentRecentlyActive";
import { WaitingForClaude } from "./components/WaitingForClaude";
import { TurnIndicator } from "./components/TurnIndicator";
import { PendingBanner } from "./components/PendingBanner";
import { KeyboardShortcutHelp } from "./components/KeyboardShortcutHelp";
import { MessageInput } from "./components/MessageInput";
import { AutonomySlider } from "./components/AutonomySlider";
import { CompoundingBadge } from "./components/CompoundingBadge";
import { CommandPalette } from "./components/CommandPalette";
import { QuickAskModal } from "./components/QuickAskModal";
import { SettingsSheet } from "./components/SettingsSheet";
import { ReplayScrubber } from "./components/ReplayScrubber";
import { ToastLayer } from "./components/ToastLayer";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { LedgerDrawer } from "./components/LedgerDrawer";
import { SessionBrowserModal } from "./components/SessionBrowserModal";
import { ProjectDecisionsModal } from "./components/ProjectDecisionsModal";
import { ConversationRail } from "./components/ConversationRail";
import { ProjectSwitcher } from "./components/ProjectSwitcher";
import { SkillLoadBanner } from "./components/SkillLoadBanner";
import { HookStatus } from "./components/HookStatus";
import { PreflightBlockLog } from "./components/PreflightBlockLog";
import { useArtifactStore } from "./stores/artifact";
import { useReplayStore } from "./stores/replay";
import { useConnectionStore } from "./stores/connection";
import { scrollToAnchor } from "./lib/comment-anchor";
import { countUnansweredQuestions } from "./lib/unanswered";
import { useOverlayStore } from "./stores/overlay";
import { usePollingWhenVisible } from "./hooks/usePollingWhenVisible";
import { useDocumentTitleBadge } from "./hooks/useDocumentTitleBadge";

function App() {
  const connected = useConnectionStore((s) => s.connected);
  const connect = useConnectionStore((s) => s.connect);
  const sessionId = useConnectionStore((s) => s.sessionId);
  const activeSessions = useConnectionStore((s) => s.activeSessions);
  const switchSession = useConnectionStore((s) => s.switchSession);
  const refreshSessions = useConnectionStore((s) => s.refreshSessions);
  // C2 review — "drafting" honesty: a heartbeat within the last 60s (a live
  // wrapper pings ≤30s via check_feedback polls). Primitive selector so the
  // shell doesn't re-render per heartbeat — it flips only around the minute
  // boundary, and the routing branch re-evaluates on other renders anyway.
  // D9 review — the render-time recency compute froze once the agent exited
  // (D6 bail suppresses idle re-renders); the shared hook re-fires at the
  // staleness boundary so the closing beat appears when the session wraps.
  const agentRecentlyActive = useAgentRecentlyActive();
  // C5 — no IdleHome/WaitingForClaude flash on refresh: skeleton until the
  // first `connected` payload lands, bounded by a grace timer so a dead
  // daemon still falls through to the real routing (IdleHome is then correct).
  const hydrated = useConnectionStore((s) => s.hydrated);
  const [hydrationGrace, setHydrationGrace] = useState(true);
  useEffect(() => {
    // Review: re-arm whenever hydration is pending (mount AND project switch,
    // which resets `hydrated`), so the skeleton covers both.
    if (hydrated) return;
    setHydrationGrace(true);
    const t = setTimeout(() => setHydrationGrace(false), 4000);
    return () => clearTimeout(t);
  }, [hydrated]);
  const showHydrationSkeleton = !hydrated && hydrationGrace;

  // C2 review — auto-bind an unbound tab when there's EXACTLY ONE active
  // session: an unbound composer posts to the daemon's default store (map
  // insertion order — possibly a dead session) while claiming Sent ✓.
  // Conservative single-session scope so multi-session global tabs keep
  // their aggregate view.
  useEffect(() => {
    const [onlySession] = activeSessions;
    if (connected && sessionId == null && activeSessions.length === 1 && onlySession) {
      switchSession(onlySession.sessionId);
    }
  }, [connected, sessionId, activeSessions, switchSession]);
  const hasArtifacts = useArtifactStore((s) => s.artifacts.length > 0);

  // U7 — at-rest signal on the Conversation button: how many human questions
  // are still awaiting the agent. Uses the SHARED predicate (lib/unanswered)
  // that ConversationRail's pill/filter/marker use, so the badge can't drift
  // from the rail. Without it the cross-artifact triage surface gave no hint.
  // C1 — select the derived NUMBER, not the comments record: the record gets
  // a new identity on every comment event, re-rendering the whole App shell;
  // a primitive selector only re-renders when the count actually changes.
  const unansweredCount = useArtifactStore((s) =>
    countUnansweredQuestions(Object.values(s.comments).flat()),
  );
  const [showHelp, setShowHelp] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showTaste, setShowTaste] = useState(false);
  // H1 — replay was UNREACHABLE with a live daemon: SessionBrowser only
  // mounted inside IdleHome (which renders when !connected — and then its
  // own /api/sessions fetch fails too). The palette opens it as an overlay.
  const [showSessions, setShowSessions] = useState(false);
  useEffect(() => {
    const open = () => setShowSessions(true);
    window.addEventListener("dp:open-sessions", open);
    return () => window.removeEventListener("dp:open-sessions", open);
  }, []);
  // #138 — project-wide decisions view. Opened from the header button and the
  // command palette (dp:open-decisions), same overlay pattern as the sessions
  // browser above.
  const [showDecisions, setShowDecisions] = useState(false);
  useEffect(() => {
    const open = () => setShowDecisions(true);
    window.addEventListener("dp:open-decisions", open);
    return () => window.removeEventListener("dp:open-decisions", open);
  }, []);
  // BB6 — when a PreflightBreadcrumb concept is clicked, open the drawer
  // straight to the ledger tab and highlight the matching row. Cleared on
  // close so a fresh open from the header button shows the default tab.
  const [tasteOpts, setTasteOpts] = useState<{ initialTab?: "ledger"; highlightConcept?: string }>({});
  // CC9 — single close callback so tasteOpts is reset on EVERY close
  // path (Esc, backdrop, drawer's own onClose). Pre-CC9 the Esc path at
  // line ~99 only flipped showTaste=false without clearing tasteOpts;
  // a subsequent reopen via the header button would render with the
  // stale highlight ring/initialTab from the previous deep-link.
  const closeTaste = () => {
    setShowTaste(false);
    setTasteOpts({});
  };
  // W1 — conversation rail visibility. Wired the same way as showTaste:
  // header button toggles, dp:open-conversation event lets toasts open it,
  // Esc closes via the drawer's own keydown.
  const [showConversation, setShowConversation] = useState(false);
  // U3 — themed "ask about this artifact" composer for the `q` shortcut.
  const [askArtifact, setAskArtifact] = useState<{ id: string; title: string } | null>(null);

  // UX4 — the global keydown handler is registered once (stable []), so it reads
  // "is any overlay open?" through this ref. While an overlay is open the
  // artifact shortcuts (j/k/a/r/q) must NOT act on the obscured artifact behind
  // it (e.g. `a` arming an approve on a hidden artifact). overlayCount covers
  // component-internal modals App can't see (FileViewer/RepairDecisionModal/
  // HookStatus) via the overlay-presence store; the booleans cover App-owned
  // overlays. Assigned in render (not an effect) so it's never a frame stale.
  // UM — every overlay now reports through useOverlayStore (via useModal /
  // useOverlayPresence), so the store count is the single source of truth. The
  // old hand-list (`showHelp || showPalette || …`) is gone — a new overlay can
  // no longer silently fail to suppress shortcuts by being forgotten here.
  const overlayCount = useOverlayStore((s) => s.count);
  const overlayOpenRef = useRef(false);
  overlayOpenRef.current = overlayCount > 0;

  // Mermaid resilience — sticky "reload" prompt when a lazy chunk fails to load
  // (daemon rebuilt/restarted → stale tab). See the hook for details.

  // B2 — "(2) Your turn — deepPairing" in the tab title while drafts wait.
  useDocumentTitleBadge();

  // Fetch active sessions on mount, auto-connect to the first one (or to the
  // session named in ?session=... — used by `node packages/mcp-server/dist/cli/init.js demo` to land
  // the user directly on the demo session).
  useEffect(() => {
    const init = async () => {
      refreshSessions();
      const requested = new URLSearchParams(window.location.search).get("session");
      try {
        const res = await apiGet(`${apiBase()}/api/active-sessions`);
        const data = await res.json();
        const sessions = data.sessions ?? [];
        if (requested && sessions.some((s: any) => s.sessionId === requested)) {
          connect(requested);
        } else if (sessions.length > 0) {
          // F6 (M1) — prefer a LIVE session: the daemon retains dead sessions
          // in insertion order (oldest first), so after any Claude restart a
          // plain sessions[0] bound the tab to a corpse — making the
          // cross-session no-op path the DEFAULT state, with composer
          // directives flowing into a store no agent reads.
          const live = sessions.find((s: { sessionId: string; live?: boolean }) => s.live !== false);
          connect((live ?? sessions[0]).sessionId);
        } else {
          connect(); // Fallback: global connection
        }
      } catch {
        connect();
      }
    };
    init();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only bind: connect/refreshSessions are stable store actions; re-binding on their identity would re-run the session bootstrap
  }, []);

  // PP3 — poll for new sessions only while the tab is visible AND connected
  // (was a bare 10s setInterval that fired forever, even hidden/disconnected).
  usePollingWhenVisible(refreshSessions, 10000, connected);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Skip ALL shortcuts when the user is typing in an editable surface.
      // Belt + suspenders: tag names cover <input>/<textarea>/<select>;
      // contenteditable covers rich-text or CodeMirror-style editors.
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable === true
      ) return;

      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        // H1 — palette results select behind the open rail otherwise.
        setShowConversation(false);
        e.preventDefault();
        setShowPalette((v) => !v);
        return;
      }
      if (e.key === "," && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setShowSettings((v) => !v);
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        setShowHelp((v) => !v);
      }
      if (e.key === "Escape") {
        setShowHelp(false);
        setShowPalette(false);
        setShowSettings(false);
        closeTaste(); // CC9 — also clears tasteOpts
        setShowConversation(false);
        setShowSessions(false);
        setShowDecisions(false);
        // F9 (L3) — replay is a MODE, and Escape is how modes end everywhere
        // else in the app; there was no keyboard exit at all.
        // Layered (review): overlay-registered surfaces get their own Esc
        // first; replay exits on the NEXT press even if focus escaped the
        // panel (useModal's stopPropagation covers the focused case).
        if (!overlayOpenRef.current) {
          // H1 review — park focus on the landmark here too (the scrubber's
          // Exit button does; the Escape path shouldn't differ).
          (document.querySelector("main") as HTMLElement | null)?.focus?.();
          useReplayStore.getState().exitReplay();
        }
      }

      // UX4 — beyond this point are the ARTIFACT shortcuts (j/k/a/r/q). Suppress
      // them while an overlay/drawer is open (the toggles + Escape above still
      // work) so they don't drive the artifact hidden behind it.
      if (overlayOpenRef.current) return;
      // E3 review — modifier chords are the browser's (Ctrl+J downloads,
      // Cmd+N new window…); a chord must never also drive artifact state.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const store = useArtifactStore.getState();

      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        // F9 review — during replay, match the sidebar's cursor filter so
        // j/k can't select artifacts the replayed frame hides.
        const replay = useReplayStore.getState();
        const visible = store.artifacts.filter(
          (a) =>
            a.status !== "superseded" &&
            (!replay.active || !replay.cursor || a.createdAt <= replay.cursor),
        );
        if (visible.length === 0) return;
        const currentIdx = visible.findIndex((a) => a.id === store.selectedArtifactId);
        const nextIdx = e.key === "j"
          ? Math.min(currentIdx + 1, visible.length - 1)
          : Math.max(currentIdx - 1, 0);
        const nextArtifact = visible[nextIdx];
        if (nextArtifact) store.selectArtifact(nextArtifact.id);
      }

      // E3 (L1) — `n`: next thing waiting on you. Same wrap-around cycle as
      // the TurnIndicator pill; at 15+ artifacts this is the velocity move.
      if (e.key === "n") {
        const pending = computePending(store.artifacts).drafts;
        if (pending.length === 0) return;
        e.preventDefault();
        const idx = pending.findIndex((a) => a.id === store.selectedArtifactId);
        const nextPending = pending[(idx + 1) % pending.length];
        if (nextPending) store.selectArtifact(nextPending.id);
      }

      if (e.key === "a" || e.key === "r") {
        // F9 (L3) — no review actions against a REPLAYED (historical) frame:
        // the rendered state may predate the live artifact, and the write
        // would hit the live store. j/k/n stay enabled (navigation is safe).
        if (useReplayStore.getState().active) return;
        const selected = store.artifacts.find((a) => a.id === store.selectedArtifactId);
        if (!selected || selected.status !== "draft") return;
        e.preventDefault();
        // Dispatch to the active artifact's action panel. The panel arms a
        // confirm affordance (countdown for approve, focus the comment
        // textarea for revise) — never commits silently on a single keystroke.
        window.dispatchEvent(
          new CustomEvent("dp:artifact-shortcut", {
            detail: { artifactId: selected.id, action: e.key === "a" ? "approve" : "revise" },
          }),
        );
      }

      if (e.key === "q") {
        // F9 review — q posts a COMMENT (QuickAskModal submit); same clamp
        // as a/r. "Navigation is safe" — q is not navigation.
        if (useReplayStore.getState().active) return;
        const selected = store.artifacts.find((a) => a.id === store.selectedArtifactId);
        if (!selected) return;
        e.preventDefault();
        // U3 — open the themed ask composer (setter is referentially stable).
        // Was window.prompt, a no-op inside the VS Code webview that embeds this
        // UI (and a jarring native dialog in the browser).
        setAskArtifact({ id: selected.id, title: selected.title });
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // O2: the PreflightBlockToast action dispatches this event to open the
  // Ledger drawer. Decoupled so the toast doesn't need a ref to App state.
  // BB6 — also accepts { initialTab, highlightConcept } in detail so the
  // PreflightBreadcrumb's "Considered:" rows can deep-link into the ledger.
  useEffect(() => {
    const openTaste = (evt: Event) => {
      const detail = (evt as CustomEvent).detail as
        | { initialTab?: "ledger"; highlightConcept?: string }
        | undefined;
      setTasteOpts(detail ?? {});
      setShowTaste(true);
    };
    window.addEventListener("dp:open-your-taste", openTaste);
    return () => window.removeEventListener("dp:open-your-taste", openTaste);
  }, []);

  // W1: same decoupling for the conversation rail. Toasts (or future
  // surfaces) can open it via window.dispatchEvent(new CustomEvent("dp:open-conversation")).
  useEffect(() => {
    const openConv = () => setShowConversation(true);
    window.addEventListener("dp:open-conversation", openConv);
    return () => window.removeEventListener("dp:open-conversation", openConv);
  }, []);

  // O7: question-answered toast's "Jump to answer" action selects the
  // artifact the answer belongs to, scrolling it into view.
  // X10: when the dispatcher carries a comment anchor (filePath+line, step,
  // or finding), follow up with a scroll-to-anchor on the next tick so the
  // artifact has rendered before we query the DOM.
  useEffect(() => {
    const focus = (evt: Event) => {
      const detail = (evt as CustomEvent).detail as
        | { artifactId?: string; anchorKey?: string }
        | undefined;
      if (!detail?.artifactId) return;
      // H1 — a jump must CLOSE the overlay that covers its target: every
      // rail row's jump landed behind the rail's full-screen backdrop
      // (nothing visibly happened until Esc). LedgerDrawer already got
      // this right; the rail's dispatches route through here.
      setShowConversation(false);
      useArtifactStore.getState().selectArtifact(detail.artifactId);
      if (detail.anchorKey) {
        // requestAnimationFrame waits one paint — usually enough for the
        // artifact panel to swap. If the element still isn't there, try
        // a couple more times before giving up; the artifact may be
        // mounting async (suspense, dynamic imports, etc.).
        const tryScroll = (retries: number) => {
          if (scrollToAnchor(detail.artifactId!, detail.anchorKey!)) return;
          if (retries > 0) requestAnimationFrame(() => tryScroll(retries - 1));
        };
        requestAnimationFrame(() => tryScroll(2));
      }
    };
    window.addEventListener("dp:focus-artifact", focus);
    return () => window.removeEventListener("dp:focus-artifact", focus);
  }, []);

  return (
    <div className="h-screen bg-surface-primary text-text-primary flex flex-col">
      {/* O6: surfaces when the pairing-protocol skill isn't active so the
          plugin-install path doesn't fail silently. Dismissible; auto-hides
          once any artifact arrives. */}
      <SkillLoadBanner />

      {/* Header — pared back to the essentials. Low-frequency chrome
          (theme, font size, content width, editor picker, export) lives in
          the Settings sheet (⌘,). Quick actions live in the Command palette (⌘K). */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border-default bg-surface-secondary">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-sm font-bold shrink-0">deepPairing</h1>
          <ProjectSwitcher />
          <TurnIndicator />
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <CompoundingBadge onOpen={() => window.dispatchEvent(new CustomEvent("dp:open-your-taste"))} />
          <AutonomySlider />
          <span className="text-2xs text-text-muted mx-1">·</span>
          <button
            onClick={() => {
              // CC3 — when the user is on the cold-start IdleHome (no
              // artifacts yet), the home view's primary tab is already
              // the ledger. The header button used to land on the
              // "Stances" tab instead — so clicking the most ledger-
              // shaped affordance during idle took users to a different
              // surface than the one they were already looking at. Now
              // the button respects the surface the user came from:
              // idle → ledger tab, mid-session → default (stances).
              setTasteOpts(hasArtifacts ? {} : { initialTab: "ledger" });
              setShowTaste(true);
            }}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-2xs text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors"
            title="Your cross-project taste from the Philosophy Ledger"
            aria-label="Open the Ledger"
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
              <path d="M6 1.5c2.5 0 4.5 2 4.5 4.5 0 1.5-.8 2.8-2 3.5" />
              <circle cx="6" cy="9.5" r="1" fill="currentColor" />
              <path d="M6 1.5v2M1.5 6h2M10.5 6h-2" />
            </svg>
            <span className="hidden min-[700px]:inline">Ledger</span>
          </button>
          <span className="text-2xs text-text-muted mx-1">·</span>
          <button
            onClick={() => setShowConversation(true)}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-2xs text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors"
            title="Conversation — every comment + reply across artifacts"
            aria-label="Open conversation rail"
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 3.5h8v4H6.5L4.5 9.5V7.5H2V3.5Z" />
            </svg>
            <span className="hidden min-[700px]:inline">Conversation</span>
            {unansweredCount > 0 && (
              <span
                className="ml-0.5 min-w-[15px] h-[15px] px-1 inline-flex items-center justify-center rounded-full bg-accent-blue-strong text-white text-[9px] font-semibold leading-none"
                aria-label={`${unansweredCount} unanswered question${unansweredCount === 1 ? "" : "s"}`}
              >
                {unansweredCount}
              </span>
            )}
          </button>
          <span className="text-2xs text-text-muted mx-1">·</span>
          {/* #138 — project-wide decisions view: every decision across all
              sessions, in one place. */}
          <button
            onClick={() => setShowDecisions(true)}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-2xs text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors"
            title="Decisions — every choice made across all sessions of this project"
            aria-label="Open project decisions"
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 3.5h8M2 6h8M2 8.5h5" />
            </svg>
            <span className="hidden min-[700px]:inline">Decisions</span>
          </button>
          <span className="text-2xs text-text-muted mx-1">·</span>
          <PreflightBlockLog />
          <span className="text-2xs text-text-muted mx-1">·</span>
          <HookStatus />
          <span className="text-2xs text-text-muted mx-1">·</span>
          <button
            onClick={() => setShowPalette(true)}
            className="hidden min-[700px]:inline-flex items-center gap-1 px-2 py-0.5 rounded text-2xs text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors"
            title="Command palette (⌘K)"
          >
            <span>Search</span>
            <kbd className="font-mono bg-surface-elevated px-1 rounded text-[9px]">⌘K</kbd>
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="p-1 rounded hover:bg-surface-hover text-text-muted hover:text-text-secondary transition-colors"
            title="Settings (⌘,)"
            aria-label="Open settings"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
              <circle cx="7" cy="7" r="2" />
              <path d="M7 1v2M7 11v2M1 7h2M11 7h2M2.8 2.8l1.4 1.4M9.8 9.8l1.4 1.4M2.8 11.2l1.4-1.4M9.8 4.2l1.4-1.4" />
            </svg>
          </button>
          <button
            onClick={() => setShowHelp(true)}
            className="px-1.5 py-0.5 rounded text-2xs text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors"
            title="Keyboard shortcuts (?)"
            aria-label="Show keyboard shortcuts"
          >
            <kbd className="font-mono">?</kbd>
          </button>
        </div>
      </div>

      {/* Session bar — always visible */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border-default bg-surface-secondary overflow-x-auto shrink-0">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" className="shrink-0 text-text-muted mr-0.5">
          <rect x="1" y="2" width="4" height="3.5" rx="0.5" />
          <rect x="7" y="2" width="4" height="3.5" rx="0.5" />
          <rect x="1" y="7" width="4" height="3" rx="0.5" />
          <rect x="7" y="7" width="4" height="3" rx="0.5" />
        </svg>
        {activeSessions.length === 0 ? (
          <span className="text-2xs text-text-muted">No active sessions — start a Claude Code conversation with deepPairing</span>
        ) : (
          activeSessions.map((s, i) => {
            const isActive = sessionId === s.sessionId;
            const label = s.title && s.title !== s.sessionId
              ? s.title
              : s.project
                ? s.project
                : `Session ${i + 1}`;
            return (
              <button
                key={s.sessionId}
                onClick={() => switchSession(s.sessionId)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-2xs transition-all duration-[180ms] shrink-0 press-scale ${
                  isActive
                    ? "bg-accent-blue-dim text-accent-blue font-medium border border-accent-blue/20"
                    : "text-text-secondary hover:text-text-primary hover:bg-surface-hover border border-transparent"
                }`}
                title={`${s.sessionId}${s.project ? `\nProject: ${s.project}` : ""}\nArtifacts: ${s.artifactCount}${s.live === false ? "\nAgent exited — history readable" : ""}`}
              >
                {/* D8 (M8) — honest dots: green only while the wrapper is
                    REGISTERED; an exited session's history stays readable but
                    stops pretending to be live. Old daemons omit `live` —
                    treat undefined as live (no false alarms on mixed versions). */}
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.live === false ? "bg-text-muted/50" : isActive ? "bg-accent-blue-strong animate-pulse" : "bg-accent-green"}`} />
                <span className="truncate max-w-40">{label}</span>
                {s.artifactCount > 0 && (
                  <span className="text-[9px] bg-surface-elevated px-1 py-0.5 rounded opacity-70">{s.artifactCount}</span>
                )}
              </button>
            );
          })
        )}
      </div>

      {/* Disconnected warning — escalates (D8/H4): a blip and a dead daemon
          looked identical forever; past 60s the pair needs to know to act. */}
      {!connected && <DisconnectBanner />}

      {/* Replay scrubber — only renders when replay mode is active */}
      <ReplayScrubber />

      {/* O3: the sticky "Accept All" ReviewGate is gone — it read as
          autonomous-agent chrome, not pairing. Bulk approve still lives in
          the Command palette for keyboard users who want it. The per-artifact
          review happens inside ArtifactStatusActions. */}
      {/* Pending decision/plan banner */}
      <PendingBanner />

      {/* Main content.
          III10 — when the WS is connected but no wrapper has registered a
          session, render WaitingForClaude (with explicit project root +
          "try this" hint) instead of IdleHome's empty Ledger panel.
          Pre-III10 a fresh-install user who ran `init` but hadn't yet
          launched Claude saw an empty "Your Ledger" panel with zero
          entries and no indication that the agent wasn't connected.
          The session bar's "No active sessions" hint was below threshold.
          Now the main surface is a directed "do this next" affordance. */}
      {/* IV9 — demo session "next step" CTA. When the active session is
          a scripted demo (sessionId starts with `demo_` per daemon.ts:407),
          surface a one-line card pointing the user at the Claude Code
          plugin install command. The demo fires the rejection-block toast
          in ~5s and then leaves the user with a populated companion UI
          but no obvious "what's next." This card closes the loop. Only
          renders when a demo session is active AND has at least one
          artifact — i.e., the demo has actually fired. */}
      {connected && sessionId?.startsWith("demo_") && hasArtifacts && (
        <div className="px-3 py-2 bg-accent-blue-dim/30 border-b border-accent-blue/20 text-2xs flex items-center gap-2 shrink-0">
          <span className="text-accent-blue font-medium">✓ Demo fired.</span>
          <span className="text-text-secondary">Next: connect Claude Code in your real project →</span>
          <code className="bg-surface-elevated px-1.5 py-0.5 rounded text-text-primary font-mono">
            claude --plugin-dir /path/to/deeppairing/claude-plugin
          </code>
        </div>
      )}

      {/* D9 (H3) — closing beat: the bound session's wrapper exited (M8 live
          flag), the agent is quiet, and artifacts exist to recap. Renders
          above the panel so the session's work stays browsable below it. */}
      {hasArtifacts && !agentRecentlyActive && sessionId != null &&
        activeSessions.find((s) => s.sessionId === sessionId)?.live === false && (
          // D9 review — the card reads unvalidated content casts; a malformed
          // artifact must not blank the whole shell.
          <ErrorBoundary fallback={null}>
            <SessionWrapCard sessionId={sessionId} />
          </ErrorBoundary>
        )}

      {/* H1 (a11y) — a real <main> landmark, focusable-by-script so
          teardown paths (scrubber exit) can park focus somewhere stable. */}
      <main className="flex-1 min-h-0 focus:outline-none" tabIndex={-1}>
        <ErrorBoundary fallback={
          <div className="flex items-center justify-center h-full p-8 text-text-muted text-sm">
            Failed to render — try selecting a different artifact
          </div>
        }>
          {showHydrationSkeleton
            ? <HydrationSkeleton />
            : hasArtifacts
            ? <ArtifactPanel />
            : connected && activeSessions.length > 0 && agentRecentlyActive
              // C2 — a LIVE session with no artifacts yet is the opening beat
              // of every pairing session; pre-C2 it showed IdleHome (a
              // retrospective ledger browser) — misdirection during the first
              // wait. "Drafting" requires a RECENT heartbeat (review catch:
              // /api/active-sessions retains unregistered sessions, so the
              // list alone would claim "Claude is working" forever after it
              // exited — the same unfalsifiable claim C2 removed from the
              // TurnIndicator).
              ? <div className="p-5"><WaitingForClaude variant="drafting" /></div>
              : connected
                ? <div className="p-5"><WaitingForClaude /></div>
                : <IdleHome />}
        </ErrorBoundary>
      </main>

      {/* Free-form message to agent. C2 — also shown during the live
          pre-first-artifact wait: that's exactly when a nudge matters, and it
          was the one moment you couldn't send one. Requires a BOUND sessionId
          (review catch: an unbound tab's message routes to the daemon's
          default store — possibly a dead session — while the UI says Sent ✓). */}
      {/* H1 — the `hasArtifacts ||` arm BYPASSED the bound-session
          requirement the comment above claims: an unbound aggregate tab
          (>=2 sessions; C2 auto-bind skips that case) rendered the composer
          and a send landed in the daemon's default store — the OLDEST
          session, possibly dead — while flashing Sent. Bound tabs and the
          single-session auto-bind are unchanged; unbound-with-sessions gets
          an honest picker hint instead. */}
      {sessionId != null
        ? (hasArtifacts || (connected && activeSessions.length > 0)) && <MessageInput />
        : connected && activeSessions.length > 1 && (
            <div className="px-3 py-2 border-t border-border-default text-xs text-text-muted">
              {activeSessions.length} sessions active — pick one in the session bar to message its agent.
            </div>
          )}

      {/* H1 — past-sessions browser (replay's front door for connected tabs). */}
      {showSessions && <SessionBrowserModal onClose={() => setShowSessions(false)} />}

      {/* #138 — project-wide decisions view (read-only, all sessions). */}
      {showDecisions && <ProjectDecisionsModal onClose={() => setShowDecisions(false)} />}

      {/* Command palette */}
      {showPalette && <CommandPalette onClose={() => setShowPalette(false)} />}

      {/* Settings sheet */}
      {showSettings && <SettingsSheet onClose={() => setShowSettings(false)} />}

      {/* Keyboard shortcut help overlay */}
      {showHelp && <KeyboardShortcutHelp onClose={() => setShowHelp(false)} />}

      {/* Ledger drawer — the cross-project Philosophy Ledger, read-only */}
      {showTaste && (
        <LedgerDrawer
          initialTab={tasteOpts.initialTab}
          highlightConcept={tasteOpts.highlightConcept}
          onClose={closeTaste}
        />
      )}
      {showConversation && <ConversationRail onClose={() => setShowConversation(false)} />}

      {/* U3 — themed "ask the agent about this artifact" composer (q shortcut) */}
      {askArtifact && (
        <QuickAskModal
          artifactTitle={askArtifact.title}
          onSubmit={(q) =>
            useArtifactStore.getState().submitComment(askArtifact.id, q, undefined, { intent: "question" })
          }
          onClose={() => setAskArtifact(null)}
        />
      )}

      {/* Ephemeral toast stack — pre-flight blocks, etc. */}
      <ToastLayer />
    </div>
  );
}

export default App;


/** C5 — lightweight placeholder while the first WS `connected` payload loads.
 *  Prevents a mid-session refresh from flashing the ledger/onboarding surfaces
 *  before snapping to the artifact panel. */
function HydrationSkeleton() {
  return (
    <div className="p-5 space-y-3 animate-pulse" role="status" aria-label="Loading session">
      <div className="h-4 w-48 rounded bg-surface-elevated" />
      <div className="h-24 rounded bg-surface-elevated" />
      <div className="h-24 rounded bg-surface-elevated/70" />
      <div className="h-24 rounded bg-surface-elevated/40" />
    </div>
  );
}

/**
 * D8 (H4) — escalating disconnect banner. Under 60s: a blip, keep calm.
 * Past 60s: the daemon is probably down — say so and hand over the doctor
 * command (the daemon-reliability rule: surface failures loudly, give a
 * recovery command).
 */
function DisconnectBanner() {
  const disconnectedSince = useConnectionStore((s) => s.disconnectedSince);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  const outageMs = disconnectedSince ? now - disconnectedSince : 0;
  const prolonged = outageMs >= 60_000;
  return (
    <div className="px-3 py-1.5 bg-accent-red-dim/30 border-b border-accent-red/15 text-center" role="status">
      {prolonged ? (
        <span className="text-2xs text-accent-red">
          Still disconnected after {Math.round(outageMs / 60_000)} min — the daemon may be down. Run{" "}
          <code className="bg-surface-elevated px-1 py-0.5 rounded">node packages/mcp-server/dist/cli/init.js doctor --fix</code> in the project, then reload.
        </span>
      ) : (
        <span className="text-2xs text-accent-red">
          Disconnected from server — reconnecting...
        </span>
      )}
    </div>
  );
}
