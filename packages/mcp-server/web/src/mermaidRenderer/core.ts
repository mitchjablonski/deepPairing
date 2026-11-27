/**
 * #714 gap 11 — the renderer frame's logic, separated from its window wiring
 * (main.ts) so it can be tested with a fake Mermaid.
 *
 * Defense in depth on top of the frame's isolation (opaque origin, no-network
 * CSP): `securityLevel: "strict"` (Mermaid's DOMPurify pass, no click
 * callbacks), `htmlLabels: false` (SVG text labels, no foreignObject HTML),
 * and a `secure` list that stops `%%{init}%%` directives / front matter from
 * changing the theme CSS, theme variables, label mode, flowchart config or
 * fonts.
 */
import {
  MermaidRenderRequestSchema, clipError, type MermaidRendererMessage,
} from "../lib/mermaidRendererProtocol";

/** Mermaid's default `secure` keys, plus the ones agent directives could use
 *  to smuggle CSS (themeCSS → a live <style>) or re-enable HTML labels. */
export const MERMAID_RENDERER_SECURE_KEYS = [
  "secure", "securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering", "maxEdges",
  "themeCSS", "themeVariables", "htmlLabels", "flowchart", "fontFamily", "altFontFamily",
] as const;

export function rendererConfig(theme: "light" | "dark") {
  return {
    startOnLoad: false,
    securityLevel: "strict" as const,
    suppressErrorRendering: true,
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    fontFamily: "system-ui, -apple-system, sans-serif",
    theme: theme === "light" ? ("default" as const) : ("dark" as const),
    secure: [...MERMAID_RENDERER_SECURE_KEYS],
  };
}

/** The slice of Mermaid the renderer uses. */
export interface MermaidLike {
  initialize(config: ReturnType<typeof rendererConfig>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

/**
 * Handle one incoming message. Returns the reply to post, or null when the
 * message is not from the parent or not a valid request (ignored silently).
 */
export async function handleRendererMessage(
  data: unknown,
  fromParent: boolean,
  mermaid: MermaidLike,
  cleanup: (id: string) => void = () => {},
): Promise<MermaidRendererMessage | null> {
  if (!fromParent) return null;
  const parsed = MermaidRenderRequestSchema.safeParse(data);
  if (!parsed.success) return null;
  const { reqId, id, source, theme } = parsed.data;
  try {
    mermaid.initialize(rendererConfig(theme));
    const { svg } = await mermaid.render(id, source);
    if (typeof svg !== "string") throw new Error("renderer returned no SVG");
    return { type: "dp-mermaid-result", reqId, svg };
  } catch (err) {
    return { type: "dp-mermaid-error", reqId, error: clipError(err) };
  } finally {
    cleanup(id);
  }
}
