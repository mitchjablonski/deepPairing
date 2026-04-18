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
