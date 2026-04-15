import * as vscode from "vscode";
import WebSocket from "ws";
import * as fs from "fs";
import * as path from "path";

/**
 * Provides the deepPairing companion UI as a VS Code webview sidebar.
 *
 * Architecture:
 * - Loads the built React app HTML into the webview
 * - Bridges WebSocket messages between the webview and the deepPairing server
 * - Discovers the server port from .deeppairing/ directory or defaults to 3847
 */
export class DeepPairingViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private ws?: WebSocket;
  private serverPort = 3847;

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

    // Set up message bridge
    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.type === "dp:ready") {
        this.connectToServer(webviewView.webview);
      } else if (msg.type === "dp:disconnect") {
        this.disconnectFromServer();
      }
    });

    webviewView.onDidDispose(() => {
      this.disconnectFromServer();
    });

    // Load the webview HTML
    webviewView.webview.html = this.getHtml(webviewView.webview);
  }

  private discoverPort(): void {
    // Try to find the server port from workspace .deeppairing directory
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;

    for (const folder of workspaceFolders) {
      const portFile = path.join(folder.uri.fsPath, ".deeppairing", "server-port");
      try {
        if (fs.existsSync(portFile)) {
          const port = parseInt(fs.readFileSync(portFile, "utf-8").trim(), 10);
          if (port > 0) {
            this.serverPort = port;
            return;
          }
        }
      } catch { /* use default */ }
    }
  }

  private connectToServer(webview: vscode.Webview): void {
    if (this.ws && this.ws.readyState <= 1) return;

    try {
      this.ws = new WebSocket(`ws://localhost:${this.serverPort}/ws`);

      this.ws.on("open", () => {
        webview.postMessage({ type: "dp:connected" });
      });

      this.ws.on("message", (data) => {
        try {
          const parsed = JSON.parse(data.toString());
          webview.postMessage({ type: "dp:message", data: parsed });
        } catch { /* ignore malformed */ }
      });

      this.ws.on("close", () => {
        webview.postMessage({ type: "dp:disconnected" });
        // Reconnect after delay
        setTimeout(() => this.connectToServer(webview), 3000);
      });

      this.ws.on("error", () => {
        this.ws?.close();
      });
    } catch {
      // Server not running — retry later
      setTimeout(() => this.connectToServer(webview), 5000);
    }
  }

  private disconnectFromServer(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
  }

  private getHtml(webview: vscode.Webview): string {
    // In development, point to the Vite dev server
    // In production, load the built assets from the extension bundle
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

    // Production: load built assets
    // The web app should be built to a single HTML file for the extension
    const webDistPath = vscode.Uri.joinPath(this.extensionUri, "web-dist", "index.html");
    try {
      const html = fs.readFileSync(webDistPath.fsPath, "utf-8");
      // Rewrite asset paths to use webview URIs
      const webDistUri = webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, "web-dist"),
      );
      return html
        .replace(/href="\//g, `href="${webDistUri}/`)
        .replace(/src="\//g, `src="${webDistUri}/`);
    } catch {
      return `<!DOCTYPE html>
<html lang="en">
<body style="color: #888; font-family: system-ui; padding: 20px;">
  <h3>deepPairing</h3>
  <p>Web UI not found. Run <code>npx vite build</code> in the MCP server web directory first.</p>
  <p>Or start the companion UI at <a href="http://localhost:${this.serverPort}">localhost:${this.serverPort}</a></p>
</body>
</html>`;
    }
  }
}
