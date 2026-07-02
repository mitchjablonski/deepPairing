/**
 * Vitest setup — registers jest-dom matchers so React Testing Library tests
 * can use .toBeInTheDocument() / .toBeDisabled() etc.
 */
import "@testing-library/jest-dom/vitest";

// React Testing Library's cleanup is automatic in vitest via its setup, but
// we also clear any window globals we add.
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
  // Reset our connection-store shim
  try {
    delete (window as any).__dpConnectionStore;
  } catch {}
});

// D9 — useDraft persists composer text to sessionStorage BY DESIGN; between
// tests that persistence is cross-test bleed (a draft typed in one test
// prefills the composer in the next). Isolate every test.
import { beforeEach as __dpBeforeEach } from "vitest";
__dpBeforeEach(() => {
  try { sessionStorage.clear(); } catch { /* no storage in this env */ }
});
