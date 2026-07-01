import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LazyMotion, domAnimation } from "motion/react";
import "./index.css";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      {/* B5 — LazyMotion + `m.` components (ArtifactPanel, DecisionCard)
          instead of the full `motion` import: only the domAnimation feature
          set ships, cutting ~40kB gzip from the entry bundle. strict throws
          if a full `motion.` component sneaks back in. */}
      <LazyMotion features={domAnimation} strict>
        <App />
      </LazyMotion>
    </ErrorBoundary>
  </StrictMode>,
);
