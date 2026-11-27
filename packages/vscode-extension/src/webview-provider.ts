import * as vscode from "vscode";
import WebSocket from "ws";
import * as fs from "fs";
import * as path from "path";
import { DAEMON_ORIGIN_META, daemonOrigin, validDaemonPort, webviewHeadTags } from "./webview-csp";
import { DaemonBridge } from "./daemon-bridge";
import { chooseDaemonPort, type DaemonCandidate } from "./daemon-choice";

/**
 * Provides the deepPairing companion UI as a VS Code webview sidebar.
 *
 * Architecture:
 * - Loads the built React app HTML into the webview
 * - Bridges WebSocket messages between the webview and the deepPairing daemon
 * - Discovers the daemon port from .deeppairing/daemon.json
 * - Shows VS Code notifications when decisions/plans arrive
 *
 * Experimental preview. The supported workflow is Claude Code plus the browser
 * companion. See ../README.md for the known limitations.
 */
export class DeepPairingViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private serverPort = 3847;
  /** #727 — the port read from daemon.json, or null before one is found. Only
   *  a discovered port is ever allowed as a webview frame source. */
  private discoveredPort: number | null = null;
  /** The daemon WebSocket, bridged to the webview (see daemon-bridge.ts). */
  private readonly bridge: DaemonBridge;
  /** Watches each workspace's .deeppairing/daemon.json so we re-discover after activation. */
  private daemonWatchers: vscode.FileSystemWatcher[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {
    this.bridge = new DaemonBridge({
      createSocket: (url) => new WebSocket(url),
      resolveUrl: () => this.resolveWsUrl(),
      post: (msg) => { void this.view?.webview.postMessage(msg); },
      onDaemonMessage: (msg) => this.notify(msg),
    });
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this.view = webviewView;

    // Discover server port
    this.discoverPort();
    this.applyOptions(webviewView.webview);

    // Watch each workspace's daemon.json so we pick up daemons that start
    // after the extension activates, or switch workspaces with different daemons.
    this.watchDaemonFiles(webviewView.webview);

    // Set up message bridge. Every "dp:ready" (first load, a hide/show
    // reload, a rebuild after the daemon moved) reconnects so the daemon
    // replays its snapshot into the fresh document.
    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === "dp:ready") {
        this.bridge.ready();
      } else if (msg?.type === "dp:disconnect") {
        this.bridge.disconnect();
      }
    });

    webviewView.onDidDispose(() => {
      this.bridge.disconnect();
      for (const w of this.daemonWatchers) w.dispose();
      this.daemonWatchers = [];
    });

    // Load the webview HTML
    webviewView.webview.html = this.getHtml(webviewView.webview);
  }

  /** Webview options. #727 — `portMapping` for the daemon port is
   *  best-effort: VS Code applies it in the webview service worker's fetch
   *  handler, which likely misses the renderer frame's navigation and script
   *  loads. Remotely the frame works only when the port reaches the same local
   *  port (auto-forwarding, WSL2 localhost); otherwise diagrams fall back to
   *  source. WS traffic goes through the extension host already. */
  private applyOptions(webview: vscode.Webview): void {
    const port = validDaemonPort(this.discoveredPort);
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
      portMapping: port === null ? [] : [{ webviewPort: port, extensionHostPort: port }],
    };
  }

  // Port discovery reads .deeppairing/daemon.json directly. There is no
  // authenticated bootstrap and no token on the connection that follows.
  private discoverPort(): void {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;

    const candidates: DaemonCandidate[] = [];
    for (const folder of workspaceFolders) {
      const daemonFile = path.join(folder.uri.fsPath, ".deeppairing", "daemon.json");
      try {
        if (!fs.existsSync(daemonFile)) continue;
        const stat = fs.statSync(daemonFile);
        const info = JSON.parse(fs.readFileSync(daemonFile, "utf-8"));
        if (validDaemonPort(info?.port) === null) continue;
        candidates.push({ port: info.port, mtimeMs: stat.mtimeMs });
      } catch { /* skip */ }
    }
    // First discovery takes the freshest daemon.json; after that the current
    // daemon is kept while its file is fresh, so multi-root heartbeats don't
    // flip (and rebuild) the view every ~30 s. See daemon-choice.ts.
    const chosen = chooseDaemonPort(this.discoveredPort, candidates, Date.now());
    if (chosen !== null) {
      this.serverPort = chosen;
      this.discoveredPort = chosen;
    }
  }

  private watchDaemonFiles(webview: vscode.Webview): void {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;

    for (const folder of workspaceFolders) {
      const pattern = new vscode.RelativePattern(folder, ".deeppairing/daemon.json");
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      const onChange = () => {
        const previousOrigin = daemonOrigin(this.discoveredPort);
        this.discoverPort();
        if (daemonOrigin(this.discoveredPort) !== previousOrigin) {
          // Daemon moved (or appeared). The webview's CSP frame-src, port
          // mapping and daemon-origin meta name the old port, so rebuild the
          // document; its fresh "dp:ready" reconnects on the new port.
          this.bridge.disconnect();
          this.applyOptions(webview);
          webview.html = this.getHtml(webview);
        }
      };
      watcher.onDidCreate(onChange);
      watcher.onDidChange(onChange);
      watcher.onDidDelete(onChange);
      this.daemonWatchers.push(watcher);
    }
  }

  // HH5 — fetch the daemon's projectHash so the WS upgrade carries the GG2
  // gate parameter. If it fails (daemon down or pre-GG2 daemon) we fall
  // through to the unhashed connect, the same back-compat behavior.
  // The URL carries a project hash and no session id, so the webview receives
  // the project's stream rather than a session you selected.
  private async resolveWsUrl(): Promise<string> {
    const port = this.serverPort;
    const info: unknown = await fetch(`http://localhost:${port}/api/daemon-info`)
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
    const hash = (info as { projectHash?: unknown } | null)?.projectHash;
    return typeof hash === "string"
      ? `ws://localhost:${port}/ws?projectHash=${encodeURIComponent(hash)}`
      : `ws://localhost:${port}/ws`;
  }

  /** VS Code notifications for decisions and plan reviews. */
  private notify(parsed: Record<string, unknown>): void {
    const show = (text: string) => {
      vscode.window.showInformationMessage(text, "Open Companion").then((action) => {
        if (action === "Open Companion") {
          vscode.commands.executeCommand("deeppairing.companion.focus");
        }
      });
    };
    if (parsed.type === "decision_request") {
      show(`deepPairing: Decision needed — ${parsed.context ?? "choose an approach"}`);
    } else if (parsed.type === "plan_review_request") {
      show(`deepPairing: Plan review — ${parsed.title ?? "review implementation plan"}`);
    }
  }

  private getHtml(webview: vscode.Webview): string {
    // In development, point to the Vite dev server
    const isDev = process.env.DEEPPAIRING_DEV === "true";

    if (isDev) {
      return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${daemonOriginMetaTag(this.discoveredPort)}
  <title>deepPairing</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="http://localhost:3848/src/main.tsx"></script>
</body>
</html>`;
    }

    // Production: load built web UI assets
    const webDistPath = vscode.Uri.joinPath(this.extensionUri, "web-dist", "index.html");
    try {
      let html = fs.readFileSync(webDistPath.fsPath, "utf-8");
      const webDistUri = webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, "web-dist"),
      );

      // Rewrite asset paths to use VS Code webview URIs
      // Vite outputs paths like ./assets/xxx or /assets/xxx
      html = html.replace(/(href|src)="\.?\/?assets\//g, `$1="${webDistUri}/assets/`);
      html = html.replace(/(href|src)="\//g, `$1="${webDistUri}/`);

      // Content-Security-Policy for the webview, plus (#727) frame-src and the
      // daemon-origin meta for the Mermaid renderer frame, exact port only.
      html = html.replace("<head>", `<head>\n${webviewHeadTags(webview.cspSource, this.discoveredPort)}`);

      return html;
    } catch {
      return `<!DOCTYPE html>
<html lang="en">
<body style="color: #888; font-family: system-ui; padding: 20px;">
  <h3>deepPairing</h3>
  <p>Web UI not found. Build it first:</p>
  <code style="display:block;background:#1c1f2b;padding:8px;border-radius:6px;margin:8px 0;color:#4f7df7">cd packages/mcp-server && pnpm build</code>
  <p style="margin-top:12px">Or open the companion UI in your browser: <a href="http://localhost:${this.serverPort}">localhost:${this.serverPort}</a></p>
</body>
</html>`;
    }
  }
}

/** Dev mode has no CSP; it still needs the daemon-origin hint. */
function daemonOriginMetaTag(port: number | null): string {
  const origin = daemonOrigin(port);
  return origin ? `<meta name="${DAEMON_ORIGIN_META}" content="${origin}">` : "";
}
