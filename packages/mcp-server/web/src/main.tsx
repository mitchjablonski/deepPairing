import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { installPreloadErrorRecovery } from "./lib/chunk-error";
import { LazyMotion, domAnimation } from "motion/react";
import "./index.css";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";

// E5 — a stale tab's first re-hashed chunk import fails after a deploy;
// auto-reload once (loop-guarded) so the tab picks up the fresh index.html.
installPreloadErrorRecovery();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      {/* B5 — LazyMotion + `m.` components (ArtifactPanel, DecisionCard)
          instead of the full `motion` import: only the domAnimation feature
          set ships (~15-20kB gzip saved vs full motion; domAnimation itself
          is still statically imported here). strict throws if a full
          `motion.` component sneaks back in. */}
      <LazyMotion features={domAnimation} strict>
        <App />
      </LazyMotion>
    </ErrorBoundary>
  </StrictMode>,
);
