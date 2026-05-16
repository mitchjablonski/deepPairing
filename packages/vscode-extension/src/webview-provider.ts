import * as vscode from "vscode";
import WebSocket from "ws";
import * as fs from "fs";
import * as path from "path";

/**
 * Provides the deepPairing companion UI as a VS Code webview sidebar.
 *
 * Architecture:
 * - Loads the built React app HTML into the webview
 * - Bridges WebSocket messages between the webview and the deepPairing daemon
 * - Discovers the daemon port from .deeppairing/daemon.json
 * - Shows VS Code notifications when decisions/plans arrive
 */
export class DeepPairingViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private ws?: WebSocket;
  private serverPort = 3847;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  /** Set when the user/VS Code has asked us to disconnect — suppresses auto-reconnect. */
  private disposed = false;
  /** Watches each workspace's .deeppairing/daemon.json so we re-discover after activation. */
  private daemonWatchers: vscode.FileSystemWatcher[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    // Discover server port
    this.discoverPort();

    // Watch each workspace's daemon.json so we pick up daemons that start
    // after the extension activates, or switch workspaces with different daemons.
    this.watchDaemonFiles(webviewView.webview);

    // Set up message bridge
    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.type === "dp:ready") {
        this.disposed = false;
        this.connectToServer(webviewView.webview);
      } else if (msg.type === "dp:disconnect") {
        this.disconnectFromServer();
      }
    });

    webviewView.onDidDispose(() => {
      this.disconnectFromServer();
      for (const w of this.daemonWatchers) w.dispose();
      this.daemonWatchers = [];
    });

    // Load the webview HTML
    webviewView.webview.html = this.getHtml(webviewView.webview);
  }

  private discoverPort(): void {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;

    // Prefer the folder whose daemon.json was written most recently — if the
    // user has multiple projects open with different daemons, the freshest one
    // is the one they're actively working on.
    let best: { port: number; mtime: number } | null = null;
    for (const folder of workspaceFolders) {
      const daemonFile = path.join(folder.uri.fsPath, ".deeppairing", "daemon.json");
      try {
        if (!fs.existsSync(daemonFile)) continue;
        const stat = fs.statSync(daemonFile);
        const info = JSON.parse(fs.readFileSync(daemonFile, "utf-8"));
        if (typeof info?.port !== "number" || info.port <= 0) continue;
        if (!best || stat.mtimeMs > best.mtime) {
          best = { port: info.port, mtime: stat.mtimeMs };
        }
      } catch { /* skip */ }
    }
    if (best) this.serverPort = best.port;
  }

  private watchDaemonFiles(webview: vscode.Webview): void {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;

    for (const folder of workspaceFolders) {
      const pattern = new vscode.RelativePattern(folder, ".deeppairing/daemon.json");
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      const onChange = () => {
        const previousPort = this.serverPort;
        this.discoverPort();
        if (this.serverPort !== previousPort) {
          // Daemon moved — reconnect on the new port.
          this.disconnectFromServer();
          this.disposed = false;
          this.connectToServer(webview);
        }
      };
      watcher.onDidCreate(onChange);
      watcher.onDidChange(onChange);
      this.daemonWatchers.push(watcher);
    }
  }

  private connectToServer(webview: vscode.Webview): void {
    if (this.ws && this.ws.readyState <= 1) return;

    try {
      // HH5 — fetch the daemon's projectHash so the WS upgrade carries
      // the GG2 gate parameter. Pre-HH5 the extension opened the WS
      // with no projectHash query and the daemon accepted via the
      // back-compat path — same gap that HH1 closed for the browser
      // path. Fetch is fire-and-forget; if it 404s (daemon down or
      // pre-GG2 daemon) we fall through to the unhashed connect, same
      // back-compat behavior. The actual WS open happens inside the
      // `.then` so the hash is on the URL when the upgrade fires.
      void fetch(`http://localhost:${this.serverPort}/api/daemon-info`)
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null)
        .then((info: any) => {
          const projectHash = typeof info?.projectHash === "string" ? info.projectHash : null;
          const url = projectHash
            ? `ws://localhost:${this.serverPort}/ws?projectHash=${encodeURIComponent(projectHash)}`
            : `ws://localhost:${this.serverPort}/ws`;
          this.openWebSocket(webview, url);
        });
      return;
    } catch (e) {
      // Outer try guards against synchronous fetch errors (very rare in node).
      console.error("[deepPairing] WS connect setup failed:", e);
      return;
    }
  }

  private openWebSocket(webview: vscode.Webview, url: string): void {
    if (this.ws && this.ws.readyState <= 1) return;
    try {
      this.ws = new WebSocket(url);

      this.ws.on("open", () => {
        this.reconnectAttempt = 0; // Reset backoff on success
        webview.postMessage({ type: "dp:connected" });
      });

      this.ws.on("message", (data) => {
        try {
          const parsed = JSON.parse(data.toString());
          webview.postMessage({ type: "dp:message", data: parsed });

          // Show VS Code notifications for decisions and plan reviews
          if (parsed.type === "decision_request") {
            vscode.window.showInformationMessage(
              `deepPairing: Decision needed — ${parsed.context ?? "choose an approach"}`,
              "Open Companion",
            ).then((action) => {
              if (action === "Open Companion") {
                vscode.commands.executeCommand("deeppairing.companion.focus");
              }
            });
          } else if (parsed.type === "plan_review_request") {
            vscode.window.showInformationMessage(
              `deepPairing: Plan review — ${parsed.title ?? "review implementation plan"}`,
              "Open Companion",
            ).then((action) => {
              if (action === "Open Companion") {
                vscode.commands.executeCommand("deeppairing.companion.focus");
              }
            });
          }
        } catch { /* ignore malformed */ }
      });

      this.ws.on("close", () => {
        webview.postMessage({ type: "dp:disconnected" });
        this.scheduleReconnect(webview);
      });

      this.ws.on("error", () => {
        this.ws?.close();
      });
    } catch {
      this.scheduleReconnect(webview);
    }
  }

  private scheduleReconnect(webview: vscode.Webview): void {
    if (this.disposed) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectAttempt++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt - 1), 30000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.disposed) return;
      this.connectToServer(webview);
    }, delay);
  }

  private disconnectFromServer(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
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

      // Add Content-Security-Policy for webview
      const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:; connect-src ws://localhost:* http://localhost:*;">`;
      html = html.replace("<head>", `<head>\n${csp}`);

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
