import * as assert from "assert";
import { describe, it } from "node:test";
import * as vm from "vm";
import type * as vscode from "vscode";

import { EulaAcceptanceManager, EulaAgreement, requiredEula } from "../eula";
import { checkPerformance } from "../checkPerformance";
import { EulaPromptController, EulaPromptHost, renderEula } from "../eulaView";

function agreement(): EulaAgreement {
  return {
    definition: requiredEula("neural-technology", "estimation")!,
    text: "Terms line 1\nTerms line 2 <script>bad()</script> & \"quotes\"",
    packageVersion: "1.0.0",
  };
}

function fixture() {
  const calls: Array<{ type: string; title: string; show: unknown; options: unknown }> = [];
  const panels: Array<{
    panel: vscode.WebviewPanel;
    receive: (message: unknown) => void;
    close: () => void;
    disposed: () => boolean;
    listenerCount: () => number;
  }> = [];
  const host: EulaPromptHost = {
    viewColumn: 1,
    createWebviewPanel: (type, title, show, options) => {
      calls.push({ type, title, show, options });
      const messages = new Set<(message: unknown) => void>();
      const disposals = new Set<() => void>();
      let disposed = false;
      const close = () => {
        if (disposed) { return; }
        disposed = true;
        for (const callback of [...disposals]) { callback(); }
      };
      const panel = {
        webview: {
          html: "",
          onDidReceiveMessage: (listener: (message: unknown) => void) => {
            messages.add(listener);
            return { dispose: () => { messages.delete(listener); } };
          },
        },
        onDidDispose: (listener: () => void) => {
          disposals.add(listener);
          return { dispose: () => { disposals.delete(listener); } };
        },
        dispose: close,
      } as unknown as vscode.WebviewPanel;
      panels.push({
        panel, close, disposed: () => disposed,
        receive: (message) => { for (const callback of messages) { callback(message); } },
        listenerCount: () => messages.size + disposals.size,
      });
      return panel;
    },
  };
  return { calls, panels, controller: new EulaPromptController(host) };
}

describe("EULA prompt", () => {
  for (const action of ["cancel", "close"] as const) {
    it(`shows retry guidance through the full consent flow on ${action}`, async () => {
      const state = fixture();
      const messages: string[] = [];
      const manager = new EulaAcceptanceManager({
        readAcceptances: () => ({}),
        writeAcceptances: async () => { assert.fail("must not save acceptance"); },
        getPackageVersion: () => "1.0.0",
        loadText: async () => agreement().text,
        prompt: (value) => state.controller.show(value),
      });
      const checking = checkPerformance({
        targetProfile: "neural-technology",
        analysisMode: "estimation",
        analysisOptions: { performance: true, compatibility: false },
        analysisInputs: { modelPath: "model.tflite", profilingDataPaths: [] },
        authorizeEula: (profile, mode) => manager.authorize(profile, mode),
        runMliaCheckPerformance: async () => { throw new Error("must not launch"); },
        showMissingTargetProfile: async () => { assert.fail("profile supplied"); },
        showErrorMessage: async (message) => { messages.push(message); return undefined; },
        showLog: () => undefined,
        log: () => undefined,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(state.panels.length, 1);
      if (action === "close") {
        state.panels[0].close();
      } else {
        state.panels[0].receive({ command: "cancel" });
      }
      await checking;
      assert.deepStrictEqual(messages, [
        "EULA acceptance is required. Run the analysis again and accept the EULA to continue.",
      ]);
      assert.strictEqual(state.panels[0].listenerCount(), 0);
    });
  }

  it("displays escaped licence text with a restrictive CSP and explicit choices", () => {
    const html = renderEula(agreement(), "test-nonce");
    assert.match(html, /Terms line 1\nTerms line 2 &lt;script&gt;bad\(\)&lt;\/script&gt; &amp; &quot;quotes&quot;/);
    assert.doesNotMatch(html, /<script>bad\(\)/);
    assert.match(html, /default-src 'none'/);
    assert.match(html, /script-src 'nonce-test-nonce'/);
    assert.doesNotMatch(html, /unsafe-inline/);
    assert.match(html, />Accept and Run<\/button>/);
    assert.match(html, />Cancel<\/button>/);
    assert.match(html, /aria-label="Licence terms"/);
  });

  it("only posts acceptance after an actual accept-button click", () => {
    const html = renderEula(agreement(), "test-nonce");
    const script = /<script nonce="test-nonce">([\s\S]*?)<\/script>/.exec(html)?.[1];
    assert.ok(script);
    const messages: unknown[] = [];
    const buttons = new Map<string, { disabled: boolean; click?: () => void; addEventListener: (_event: string, listener: () => void) => void }>();
    for (const id of ["accept", "cancel"]) {
      const button = {
        disabled: false,
        click: undefined as (() => void) | undefined,
        addEventListener: (_event: string, listener: () => void) => { button.click = listener; },
      };
      buttons.set(id, button);
    }
    vm.runInNewContext(script, {
      acquireVsCodeApi: () => ({ postMessage: (message: unknown) => messages.push(message) }),
      document: { getElementById: (id: string) => buttons.get(id) },
    });
    assert.deepStrictEqual(messages, []);
    buttons.get("accept")!.click!();
    assert.strictEqual(JSON.stringify(messages), '[{"command":"accept"}]');
    assert.strictEqual(buttons.get("accept")!.disabled, true);
    assert.strictEqual(buttons.get("cancel")!.disabled, true);
  });

  for (const action of ["accept", "cancel", "close", "dispose"] as const) {
    it(`resolves ${action} correctly and removes all listeners`, async () => {
      const state = fixture();
      const result = state.controller.show(agreement());
      const panel = state.panels[0];
      assert.strictEqual(state.calls[0].type, "mliaEula");
      assert.deepStrictEqual(state.calls[0].show, { viewColumn: 1, preserveFocus: false });
      assert.deepStrictEqual(state.calls[0].options, {
        enableScripts: true, enableFindWidget: true, retainContextWhenHidden: true, localResourceRoots: [],
      });
      assert.match(panel.panel.webview.html, /Terms line 1/);
      let finished = false;
      void result.then(() => { finished = true; });
      panel.receive({ command: "unrelated" });
      panel.receive(null);
      panel.receive({ command: true });
      await Promise.resolve();
      assert.strictEqual(finished, false);
      if (action === "close") {
        panel.close();
      } else if (action === "dispose") {
        state.controller.dispose();
      } else {
        panel.receive({ command: action });
      }
      assert.strictEqual(await result, action === "accept");
      assert.strictEqual(panel.disposed(), true);
      assert.strictEqual(panel.listenerCount(), 0);
      panel.receive({ command: "accept" });
      assert.strictEqual(await result, action === "accept");
    });
  }

  it("does not open another prompt after the extension is disposed", async () => {
    const state = fixture();
    state.controller.dispose();
    assert.strictEqual(await state.controller.show(agreement()), false);
    assert.strictEqual(state.calls.length, 0);
  });
});
