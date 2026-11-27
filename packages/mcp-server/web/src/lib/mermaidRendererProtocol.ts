/**
 * #714 gap 11 — the message protocol between the companion (parent) and the
 * isolated Mermaid renderer frame (`/mermaid-renderer.html`, a hidden
 * `sandbox="allow-scripts"` iframe at an opaque origin with a no-network CSP).
 * Both sides validate every message with these schemas and check
 * `event.source` before trusting it.
 */
import { z } from "zod";

/** Path the daemon serves the renderer document at. */
export const MERMAID_RENDERER_PATH = "/mermaid-renderer.html";

/** Bounds shared by both sides (the parent enforces tighter page caps). */
export const MERMAID_PROTOCOL_MAX_SOURCE = 20_000;
export const MERMAID_PROTOCOL_MAX_SVG = 1024 * 1024;
const MAX_ERROR = 300;

const reqId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const svgId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);

export const MermaidRenderRequestSchema = z.object({
  type: z.literal("dp-mermaid-render"),
  reqId,
  id: svgId,
  source: z.string().min(1).max(MERMAID_PROTOCOL_MAX_SOURCE),
  theme: z.enum(["light", "dark"]),
}).strict();
export type MermaidRenderRequest = z.infer<typeof MermaidRenderRequestSchema>;

export const MermaidRendererMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("dp-mermaid-ready") }).strict(),
  z.object({
    type: z.literal("dp-mermaid-result"),
    reqId,
    svg: z.string().max(MERMAID_PROTOCOL_MAX_SVG),
  }).strict(),
  z.object({
    type: z.literal("dp-mermaid-error"),
    reqId,
    error: z.string().max(MAX_ERROR),
  }).strict(),
]);
export type MermaidRendererMessage = z.infer<typeof MermaidRendererMessageSchema>;

export function clipError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.slice(0, MAX_ERROR);
}
