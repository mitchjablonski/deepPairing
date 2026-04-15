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

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[deepPairing] UI error:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
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
