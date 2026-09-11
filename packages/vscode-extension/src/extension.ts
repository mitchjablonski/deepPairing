import * as vscode from "vscode";
import { DeepPairingViewProvider } from "./webview-provider";

// Experimental preview. Activation binds no session; the provider connects to
// whatever daemon the workspace reports. See ../README.md for the limitations.
export function activate(context: vscode.ExtensionContext) {
  const provider = new DeepPairingViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("deeppairing.companion", provider),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("deeppairing.openCompanion", () => {
      // Focus the sidebar view
      vscode.commands.executeCommand("deeppairing.companion.focus");
    }),
  );
}

export function deactivate() {}
