/**
 * #714 gap 11 — entry for `/mermaid-renderer.html`, the isolated Mermaid
 * renderer frame. It renders one request at a time (Mermaid serializes
 * internally) and replies to the parent only. It holds no companion state:
 * the frame is an opaque-origin sandbox and the daemon never injects the
 * bearer token into this document.
 */
import mermaid from "mermaid";
import { handleRendererMessage } from "./core";
import type { MermaidRendererMessage } from "../lib/mermaidRendererProtocol";

function post(msg: MermaidRendererMessage): void {
  // The parent is the companion; an opaque-origin frame can't name its origin.
  window.parent.postMessage(msg, "*");
}

function cleanup(id: string): void {
  document.getElementById(`d${id}`)?.remove();
  document.getElementById(id)?.remove();
}

window.addEventListener("message", (event: MessageEvent) => {
  void handleRendererMessage(event.data, event.source === window.parent, mermaid, cleanup).then((reply) => {
    if (reply) post(reply);
  });
});

post({ type: "dp-mermaid-ready" });
