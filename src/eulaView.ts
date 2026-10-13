import { randomBytes } from "crypto";
import type * as vscode from "vscode";

import type { EulaAgreement } from "./eula";

export interface EulaPromptHost {
  createWebviewPanel: typeof vscode.window.createWebviewPanel;
  viewColumn: vscode.ViewColumn;
}

export class EulaPromptController implements vscode.Disposable {
  private readonly panels = new Set<vscode.WebviewPanel>();
  private disposed = false;

  public constructor(private readonly host: EulaPromptHost) {}

  public async show(agreement: EulaAgreement): Promise<boolean> {
    if (this.disposed) {
      return false;
    }
    const html = renderEula(agreement);
    const panel = this.host.createWebviewPanel(
      "mliaEula",
      "MLIA licence agreement",
      { viewColumn: this.host.viewColumn, preserveFocus: false },
      { enableScripts: true, enableFindWidget: true, retainContextWhenHidden: true, localResourceRoots: [] },
    );
    this.panels.add(panel);
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const subscriptions: vscode.Disposable[] = [];
      const finish = (accepted: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        subscriptions.forEach((subscription) => subscription.dispose());
        this.panels.delete(panel);
        panel.dispose();
        resolve(accepted);
      };
      subscriptions.push(
        panel.webview.onDidReceiveMessage((message: unknown) => {
          if (typeof message !== "object" || message === null) {
            return;
          }
          const command = (message as { command?: unknown }).command;
          if (command === "accept") {
            finish(true);
          } else if (command === "cancel") {
            finish(false);
          }
        }),
        panel.onDidDispose(() => finish(false)),
      );
      try {
        panel.webview.html = html;
      } catch (error) {
        subscriptions.forEach((subscription) => subscription.dispose());
        this.panels.delete(panel);
        settled = true;
        panel.dispose();
        reject(error);
      }
    });
  }

  public dispose(): void {
    this.disposed = true;
    for (const panel of [...this.panels]) {
      panel.dispose();
    }
  }
}

export function renderEula(agreement: EulaAgreement, nonce = randomBytes(18).toString("base64")): string {
  const safeNonce = escapeHtml(nonce);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'nonce-${safeNonce}'; script-src 'nonce-${safeNonce}';">
  <title>MLIA licence agreement</title>
  <style nonce="${safeNonce}">
    body { margin: 0; height: 100vh; display: flex; flex-direction: column; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    header, footer { padding: 16px 24px; flex: none; }
    header { border-bottom: 1px solid var(--vscode-panel-border); }
    h1 { margin: 0 0 10px; font-size: 1.4em; }
    p { margin: 6px 0; line-height: 1.5; }
    main { flex: 1; min-height: 0; overflow: auto; padding: 16px 24px; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; line-height: 1.6; font-family: inherit; }
    footer { border-top: 1px solid var(--vscode-panel-border); display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
    footer p { flex: 1; min-width: 200px; color: var(--vscode-descriptionForeground); }
    button { border: 1px solid var(--vscode-button-border, transparent); padding: 8px 14px; cursor: pointer; font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
    #cancel { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    #cancel:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button:disabled { opacity: 0.6; cursor: default; }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(agreement.definition.title)}</h1>
    <p>${escapeHtml(agreement.definition.packageName)} ${escapeHtml(agreement.packageVersion)}</p>
    <p>This analysis requires your acceptance of the following licence agreement before it can run.</p>
  </header>
  <main tabindex="0" aria-label="Licence terms"><pre>${escapeHtml(agreement.text)}</pre></main>
  <footer>
    <p>Acceptance is saved in the Accepted EULAs setting for this package version. Delete an entry or reset that setting to require acceptance again. Cancel or close this tab to leave the analysis unstarted.</p>
    <button type="button" id="cancel">Cancel</button>
    <button type="button" id="accept">Accept and Run</button>
  </footer>
  <script nonce="${safeNonce}">
    const vscode = acquireVsCodeApi();
    for (const command of ['accept', 'cancel']) {
      document.getElementById(command).addEventListener('click', () => {
        document.getElementById('accept').disabled = true;
        document.getElementById('cancel').disabled = true;
        vscode.postMessage({ command });
      });
    }
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
