import { isChunkLoadError, getChunkRecoveryStatus, subscribeChunkRecovery } from "../lib/chunk-error";
import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props {
  fallback?: ReactNode;
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };
  private unsubscribeChunkRecovery: (() => void) | null = null;

  componentDidMount() {
    // #339 — the chunk-recovery copy below follows the handler's state
    // machine (probing → deferred | blocked | reload), so re-render on change.
    this.unsubscribeChunkRecovery = subscribeChunkRecovery(() => this.forceUpdate());
  }

  componentWillUnmount() {
    this.unsubscribeChunkRecovery?.();
    this.unsubscribeChunkRecovery = null;
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[deepPairing] UI error:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      // E5 — a failed dynamic import is a STALE-TAB problem, not a content
      // problem. It must never fall through to a caller's fallback (the
      // per-artifact one blamed "malformed content" in the field — sending
      // users and agents chasing the wrong suspect). Every boundary in the
      // app gets this branch for free.
      if (isChunkLoadError(this.state.error)) {
        // #339 — the same failure during a daemon OUTAGE is not skew: the code
        // could not be fetched because nothing was listening. The handler
        // (lib/chunk-error.ts) asks the origin and either reloads once, arms a
        // reload for the next reconnect, or is loop-guarded; say which, and
        // keep Reload available as the manual door.
        const status = getChunkRecoveryStatus();
        const copy = status === "deferred"
          ? {
              title: "This view couldn't load while the daemon was away",
              body: "The rest of the session is intact. Reconnecting checks the UI's origin again before reloading; reload manually if it is already back.",
            }
          : status === "probing"
            ? {
                title: "This view's code couldn't be fetched",
                body: "Checking whether the UI's origin can still answer. If it can, this tab reloads now; otherwise this view stays here until recovery is possible.",
              }
            : {
                title: "A new version of the UI was deployed",
                body: "This tab is holding the old build and can't load the new code. Reload to pick it up — your session and drafts are preserved.",
              };
        return (
          <div className="p-4 m-4 bg-surface-secondary border border-white/[0.08] rounded-lg text-center" data-testid="chunk-boundary" data-outage={status === "deferred" ? "true" : "false"} data-recovery={status}>
            <h3 className="text-sm font-semibold text-text-primary">{copy.title}</h3>
            <p className="text-xs text-text-secondary mt-1">{copy.body}</p>
            <button
              onClick={() => window.location.reload()}
              className="mt-3 px-3 py-1.5 bg-accent-blue-strong text-white text-xs rounded hover:bg-accent-blue/90 transition-colors press-scale"
            >
              Reload
            </button>
          </div>
        );
      }
      return this.props.fallback ?? (
        <div className="p-4 m-4 bg-accent-red-dim border border-accent-red/20 rounded-lg">
          <h3 className="text-sm font-bold text-accent-red">Something went wrong</h3>
          <p className="text-xs text-text-secondary mt-1 font-mono">{this.state.error?.message}</p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="mt-3 px-3 py-1.5 bg-surface-elevated text-text-secondary text-xs rounded
                       hover:bg-surface-hover transition-colors press-scale"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
