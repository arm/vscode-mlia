import * as assert from "assert";
import { describe, it } from "node:test";
import type * as vscode from "vscode";

import { Analysis } from "../analysisStore";
import {
  AnalysisPanelManager,
  registerAnalysisPanelSerializer,
} from "../analysisPanels";
import {
  AttachModelExplorerWebviewOptions,
  MODEL_EXPLORER_VIEW_TYPE,
  ModelExplorerErrorOptions,
  ModelExplorerNodeReference,
  ModelExplorerWebview,
  ModelExplorerWebviewOptions,
  PreparedModelExplorerPage,
} from "../modelExplorerWebview";
import {
  ModelExplorerOverlayIntent,
  parseModelExplorerOverlayManifest,
} from "../overlaySynchronization";

function analysis(id = "analysis"): Analysis {
  return {
    id,
    modelPath: "model.tflite",
    profilingDataPaths: [],
    targetProfile: "ethos-u55",
    analysisMode: "estimation",
    analysisOptions: { performance: true, compatibility: false },
    status: "complete",
    startedAt: new Date(0),
    analysisDir: "C:/analysis-runs/analysis",
    artifacts: {
      htmlPath: "model-explorer.html",
      standardizedOutputPath: "standardized-output.json",
      entityNodeMappingsPath: "entity-node-mappings.json",
    },
  };
}

function failedAnalysis(id = "analysis"): Analysis {
  return {
    ...analysis(id),
    status: "failed",
    artifacts: undefined,
    error: "Stored MLIA failure details.",
  };
}

function synchronizedAnalysis(id = "analysis"): Analysis {
  const value = analysis(id);
  const overlay = {
    resultIndex: 0,
    resultKind: "performance",
    category: "metric" as const,
    name: "total_cycles",
    unit: "cycles",
    breakdownQualifiers: {},
    metricQualifiers: {},
  };
  return {
    ...value,
    standardizedOutput: {
      results: [{
        kind: "performance",
        breakdowns: [{
          entity_id: "code_stack/model",
          metrics: [{ name: "total_cycles", unit: "cycles", value: 1, qualifiers: {} }],
          qualifiers: {},
        }],
      }],
    },
    modelExplorerOverlayCatalog: parseModelExplorerOverlayManifest(JSON.stringify({
      nodeDataOverlayKeysAndDisplayNames: [{
        overlayKey: overlay,
        displayName: "total_cycles (cycles)",
      }],
    })),
    overlaySelection: { kind: "overlay", overlay },
  };
}

function node(nodeId = "model.py:7___group___"): ModelExplorerNodeReference {
  return {
    collectionLabel: "code_stack",
    graphId: "code-stack",
    nodeId,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

interface PrepareCall {
  args: [
    string,
    string,
    string,
    ModelExplorerNodeReference | undefined,
  ];
  completion: Deferred<PreparedModelExplorerPage>;
  webviewIndex: number;
}

function prepared(marker: string): PreparedModelExplorerPage {
  return {
    html: `<html>${marker}</html>`,
    standardizedOutput: { marker },
    entityNodeMappings: { marker },
  };
}

function fixture() {
  const openOptions: ModelExplorerWebviewOptions[] = [];
  const prepareCalls: PrepareCall[] = [];
  const commits: Array<{
    webviewIndex: number;
    page: PreparedModelExplorerPage;
    overlayIntent: ModelExplorerOverlayIntent | undefined;
  }> = [];
  const errors: Array<{ webviewIndex: number; message: string }> = [];
  const errorShowLog: boolean[] = [];
  const selected: ModelExplorerNodeReference[] = [];
  const overlayIntents: ModelExplorerOverlayIntent[] = [];
  const userOverlayIntents: Array<{ analysisId: string; intent: ModelExplorerOverlayIntent }> = [];
  const logs: string[] = [];
  const shownSelections: unknown[][] = [];
  const reveals: unknown[][] = [];
  const disposeListeners: Array<() => void> = [];
  const webviews: ModelExplorerWebview[] = [];
  let syncSelectionToCode = true;

  const manager = new AnalysisPanelManager({
    showLog: () => undefined,
    shouldSyncSelectionToCode: () => syncSelectionToCode,
    showSelectedEntities: (entities) => shownSelections.push(entities),
    resolveAnalysis: async () => undefined,
    overlayUserIntentChanged: (analysisId, intent) => {
      userOverlayIntents.push({ analysisId, intent });
    },
    log: (message) => logs.push(message),
    createWebview: (options) => {
      const webviewIndex = webviews.length;
      openOptions.push(options);
      let disposeListener: () => void = () => undefined;
      const webview = {
        panel: {
          viewColumn: 2,
          reveal: (...args: unknown[]) => reveals.push(args),
          dispose: () => disposeListener(),
          onDidDispose: (listener: () => void) => {
            disposeListener = listener;
            disposeListeners[webviewIndex] = listener;
            return { dispose: () => undefined };
          },
        },
        prepareModelExplorer: (
          htmlPath: string,
          standardizedOutputPath: string,
          entityNodeMappingsPath: string,
          initialSelection?: ModelExplorerNodeReference,
        ) => {
          const completion = deferred<PreparedModelExplorerPage>();
          prepareCalls.push({
            args: [
              htmlPath,
              standardizedOutputPath,
              entityNodeMappingsPath,
              initialSelection,
            ],
            completion,
            webviewIndex,
          });
          return completion.promise;
        },
        showPreparedModelExplorer: (
          page: PreparedModelExplorerPage,
          overlayIntent?: ModelExplorerOverlayIntent,
        ) => {
          commits.push({ webviewIndex, page, overlayIntent });
        },
        showError: (message: string, options: ModelExplorerErrorOptions = {}) => {
          errors.push({ webviewIndex, message });
          errorShowLog.push(options.showLog ?? true);
        },
        selectNode: async (selection: ModelExplorerNodeReference) => {
          selected.push(selection);
          return true;
        },
        setOverlayIntent: async (intent: ModelExplorerOverlayIntent) => {
          overlayIntents.push(intent);
          return true;
        },
      } as unknown as ModelExplorerWebview;
      webviews.push(webview);
      return webview;
    },
  });

  return {
    manager,
    openOptions,
    prepareCalls,
    commits,
    errors,
    errorShowLog,
    selected,
    overlayIntents,
    userOverlayIntents,
    logs,
    shownSelections,
    setSyncSelectionToCode: (enabled: boolean) => {
      syncSelectionToCode = enabled;
    },
    reveals,
    disposeListeners,
    webviews,
  };
}

function resolveCall(state: ReturnType<typeof fixture>, index: number, marker = `load-${index}`): void {
  state.prepareCalls[index].completion.resolve(prepared(marker));
}

describe("AnalysisPanelManager", () => {
  it("does not create or reveal a panel when an error is reported before one exists", () => {
    const state = fixture();

    state.manager.showError("missing-analysis", "analysis failed");

    assert.deepStrictEqual(state.openOptions, []);
    assert.deepStrictEqual(state.reveals, []);
    assert.deepStrictEqual(state.errors, []);
  });

  it("opens failed analyses with their stored error without preparing artifacts", async () => {
    const state = fixture();
    const failed = failedAnalysis();

    await state.manager.open(failed, "preserve");

    assert.strictEqual(state.openOptions.length, 1);
    assert.strictEqual(state.prepareCalls.length, 0);
    assert.deepStrictEqual(state.reveals, [[2, true]]);
    assert.deepStrictEqual(state.errors, [{
      webviewIndex: 0,
      message: "Stored MLIA failure details.",
    }]);
    assert.deepStrictEqual(state.errorShowLog, [false]);
  });

  it("reopens a closed failed-analysis panel using the same stored error", async () => {
    const state = fixture();
    const failed = failedAnalysis();

    await state.manager.open(failed, "focus");
    state.manager.close(failed.id);
    await state.manager.open(failed, "focus");

    assert.strictEqual(state.openOptions.length, 2);
    assert.strictEqual(state.prepareCalls.length, 0);
    assert.deepStrictEqual(state.errors.map(({ message }) => message), [
      "Stored MLIA failure details.",
      "Stored MLIA failure details.",
    ]);
    assert.deepStrictEqual(state.errorShowLog, [false, false]);
  });

  it("preserves the live error and Show Log link when a just-failed panel is activated", async () => {
    const state = fixture();
    const running = { ...analysis(), status: "running" as const, artifacts: undefined };
    const failed = failedAnalysis();

    state.manager.openRunning(running, "focus");
    state.manager.showError(running.id, "Failure from this run.");
    await state.manager.open(failed, "focus");

    assert.deepStrictEqual(state.errors, [{
      webviewIndex: 0,
      message: "Failure from this run.",
    }]);
    assert.deepStrictEqual(state.errorShowLog, [true]);
  });

  it("does not report overlay synchronization failures for incomplete analyses", () => {
    const state = fixture();
    const running = { ...analysis(), status: "running" as const, artifacts: undefined };

    state.manager.openRunning(running, "focus");

    assert.strictEqual(
      state.logs.some((message) => message.includes("overlay synchronization failed")),
      false,
    );
  });

  it("reveals an already loaded panel with the requested focus intent without reloading", async () => {
    const state = fixture();
    const current = analysis();

    const first = state.manager.open(current, "focus");
    resolveCall(state, 0);
    await first;
    await state.manager.open(current, "preserve");

    assert.strictEqual(state.openOptions.length, 1);
    assert.strictEqual(state.openOptions[0].focus, "focus");
    assert.strictEqual(state.prepareCalls.length, 1);
    assert.deepStrictEqual(state.prepareCalls[0].args, [
      "model-explorer.html",
      "standardized-output.json",
      "entity-node-mappings.json",
      undefined,
    ]);
    assert.deepStrictEqual(state.commits[0].overlayIntent, { kind: "none" });
    assert.strictEqual(state.commits.length, 1);
    assert.deepStrictEqual(state.reveals, [[2, false], [2, true]]);
  });

  it("commits the latest overlay intent after a loading-time change and posts later projections", async () => {
    const state = fixture();
    const current = synchronizedAnalysis();
    const opening = state.manager.open(current, "focus");
    const cleared: Analysis = { ...current, overlaySelection: { kind: "none" } };

    state.manager.updateOverlaySelection(cleared);
    assert.deepStrictEqual(state.overlayIntents, []);
    resolveCall(state, 0);
    await opening;

    assert.deepStrictEqual(state.commits[0].overlayIntent, { kind: "none" });
    state.manager.updateOverlaySelection(current);
    assert.deepStrictEqual(state.overlayIntents, [{
      kind: "overlay",
      effectiveName: "total_cycles (cycles)",
    }]);

    state.openOptions[0].overlayUserIntentChanged?.({
      kind: "overlay",
      effectiveName: "total_cycles (cycles)",
    });
    assert.deepStrictEqual(state.userOverlayIntents, [{
      analysisId: current.id,
      intent: { kind: "overlay", effectiveName: "total_cycles (cycles)" },
    }]);
  });

  it("logs mapping and webview delivery failures for overlay projections", async () => {
    const state = fixture();
    const current = synchronizedAnalysis();
    const opening = state.manager.open(current, "focus");
    resolveCall(state, 0);
    await opening;

    state.webviews[0].setOverlayIntent = async () => false;
    state.manager.updateOverlaySelection(current);
    await Promise.resolve();

    assert.ok(state.logs.some((message) =>
      message.includes("overlay projection was not delivered") && message.includes(current.id)
    ));

    const selected = current.overlaySelection;
    assert.ok(selected?.kind === "overlay");
    const unmatched: Analysis = {
      ...current,
      overlaySelection: {
        kind: "overlay",
        overlay: { ...selected.overlay, name: "missing_overlay" },
      },
    };
    state.manager.updateOverlaySelection(unmatched);

    assert.ok(state.logs.some((message) =>
      message.includes("VS Code to Model Explorer overlay synchronization failed") &&
      message.includes("missing_overlay")
    ));
  });

  it("creates and reveals a descriptively titled panel without taking focus when requested", async () => {
    const state = fixture();
    const current: Analysis = {
      ...analysis(),
      modelPath: "C:/models/output_tag0.tosa.vgf",
      profilingDataPaths: ["C:/captures/run-42"],
      targetProfile: "neural-technology",
      analysisMode: "profiling",
      analysisOptions: { performance: true, compatibility: false },
    };

    const opening = state.manager.open(current, "preserve");
    resolveCall(state, 0);
    await opening;

    assert.strictEqual(state.openOptions.length, 1);
    assert.strictEqual(state.openOptions[0].focus, "preserve");
    assert.strictEqual(
      state.openOptions[0].title,
      "MLIA: output_tag0.tosa.vgf · Profiling · neural-technology",
    );
    assert.deepStrictEqual(state.reveals, [[2, true]]);
  });

  it("reads the selection-sync setting for every user selection from an existing panel", () => {
    const state = fixture();
    const running = { ...analysis(), status: "running" as const, artifacts: undefined };
    state.manager.openRunning(running, "focus");
    const selectedNode = {
      collectionLabel: "code_stack",
      graphId: "code-stack",
      nodeId: "node",
      entities: [],
    };

    state.setSyncSelectionToCode(false);
    state.openOptions[0].showSelectedNode?.(selectedNode);
    assert.deepStrictEqual(state.shownSelections, []);

    state.setSyncSelectionToCode(true);
    state.openOptions[0].showSelectedNode?.(selectedNode);
    assert.deepStrictEqual(state.shownSelections, [[]]);

    state.setSyncSelectionToCode(false);
    state.openOptions[0].showSelectedNode?.(selectedNode);
    assert.deepStrictEqual(state.shownSelections, [[]]);
    assert.deepStrictEqual(state.logs.slice(-3), [
      "Model Explorer source synchronization skipped for analysis analysis: " +
        "selection-to-code synchronization is disabled.",
      "Resolving Model Explorer node code_stack/code-stack/node for analysis analysis.",
      "Model Explorer source synchronization skipped for analysis analysis: " +
        "selection-to-code synchronization is disabled.",
    ]);
  });

  it("uses postMessage selection for an existing loaded panel", async () => {
    const state = fixture();
    const current = analysis();
    const selection = node();
    const loading = state.manager.open(current, "focus");
    resolveCall(state, 0);
    await loading;

    assert.strictEqual(await state.manager.openForSelection(current, selection, "focus"), "ready");
    assert.strictEqual(state.prepareCalls.length, 1);
    assert.strictEqual(await state.manager.selectNode(current, selection), true);
    assert.deepStrictEqual(state.selected, [selection]);
  });

  it("commits an initial selection for a newly created panel", async () => {
    const state = fixture();
    const current = analysis();
    const selection = node("new-node");

    const opening = state.manager.openForSelection(current, selection, "focus");
    assert.deepStrictEqual(state.prepareCalls[0].args[3], selection);
    resolveCall(state, 0, "selected");

    assert.strictEqual(await opening, "selected");
    assert.deepStrictEqual(state.commits.map(({ page }) => page.html), ["<html>selected</html>"]);
    assert.deepStrictEqual(state.selected, []);
  });

  it("treats a running panel as idle and embeds selection on completion", async () => {
    const state = fixture();
    const running = { ...analysis(), status: "running" as const, artifacts: undefined };
    const completed = analysis();
    const selection = node();

    state.manager.openRunning(running, "focus");
    const opening = state.manager.openForSelection(completed, selection, "focus");
    assert.strictEqual(state.openOptions.length, 1);
    assert.deepStrictEqual(state.prepareCalls[0].args[3], selection);
    resolveCall(state, 0);
    assert.strictEqual(await opening, "selected");
  });

  it("lets a CodeLens selected load supersede an automatic no-selection load", async () => {
    const state = fixture();
    const current = analysis();
    const selection = node("latest-selection");

    const automatic = state.manager.open(current, "focus");
    const selected = state.manager.openForSelection(current, selection, "focus");
    assert.strictEqual(state.prepareCalls.length, 2);

    resolveCall(state, 0, "stale-automatic");
    await automatic;
    assert.strictEqual(state.commits.length, 0);

    resolveCall(state, 1, "selected-page");
    assert.strictEqual(await selected, "selected");
    assert.deepStrictEqual(state.commits.map(({ page }) => page.html), ["<html>selected-page</html>"]);
  });

  it("makes the latest of two competing initial selections win deterministically", async () => {
    const state = fixture();
    const current = analysis();
    const firstSelection = node("first");
    const secondSelection = node("second");

    const first = state.manager.openForSelection(current, firstSelection, "focus");
    const second = state.manager.openForSelection(current, secondSelection, "focus");
    resolveCall(state, 1, "second");
    assert.strictEqual(await second, "selected");
    resolveCall(state, 0, "first");
    assert.strictEqual(await first, false);

    assert.deepStrictEqual(state.prepareCalls.map(({ args }) => args[3]), [firstSelection, secondSelection]);
    assert.deepStrictEqual(state.commits.map(({ page }) => page.html), ["<html>second</html>"]);
  });

  it("does not let completion overwrite an error shown during loading", async () => {
    const state = fixture();
    const current = analysis();

    const loading = state.manager.openForSelection(current, node(), "focus");
    state.manager.showError(current.id, "analysis failed");
    resolveCall(state, 0, "stale-success");

    assert.strictEqual(await loading, false);
    assert.deepStrictEqual(state.errors, [{ webviewIndex: 0, message: "analysis failed" }]);
    assert.deepStrictEqual(state.commits, []);
  });

  it("does not let completion mutate a panel closed during loading", async () => {
    const state = fixture();
    const current = analysis();

    const loading = state.manager.openForSelection(current, node(), "focus");
    state.manager.close(current.id);
    resolveCall(state, 0, "stale-success");

    assert.strictEqual(await loading, false);
    assert.deepStrictEqual(state.commits, []);
    assert.strictEqual(await state.manager.selectNode(current, node()), false);
  });

  it("does not let completion mutate manager state after manager disposal", async () => {
    const state = fixture();
    const current = analysis();

    const loading = state.manager.openForSelection(current, node(), "focus");
    state.manager.dispose();
    resolveCall(state, 0, "stale-success");

    assert.strictEqual(await loading, false);
    assert.deepStrictEqual(state.commits, []);
    assert.strictEqual(
      await state.manager.openForSelection(current, node("after-dispose"), "focus"),
      false,
    );
  });

  it("ignores a stale disposal callback after a replacement panel is created", async () => {
    const state = fixture();
    const current = analysis();

    const first = state.manager.open(current, "focus");
    resolveCall(state, 0, "first");
    await first;
    state.manager.close(current.id);

    const replacement = state.manager.open(current, "focus");
    resolveCall(state, 1, "replacement");
    await replacement;
    state.disposeListeners[0]();
    await state.manager.open(current, "focus");

    assert.strictEqual(state.webviews.length, 2);
    assert.strictEqual(state.prepareCalls.length, 2);
    assert.deepStrictEqual(state.commits.map(({ page }) => page.html), [
      "<html>first</html>",
      "<html>replacement</html>",
    ]);
  });

  it("shows a current load failure and lets lifecycle callers retry deliberately", async () => {
    const state = fixture();
    const current = analysis();

    const failed = state.manager.open(current, "focus");
    state.prepareCalls[0].completion.reject(new Error(`read <failed> & "stopped"`));
    await failed;

    assert.deepStrictEqual(state.errors, [{
      webviewIndex: 0,
      message: `Failed to load Model Explorer.\n\nread <failed> & "stopped"`,
    }]);
    assert.strictEqual(state.commits.length, 0);

    const retry = state.manager.openForSelection(current, node("retry"), "focus");
    resolveCall(state, 1, "retry-success");
    assert.strictEqual(await retry, "selected");
    assert.deepStrictEqual(state.commits.map(({ page }) => page.html), ["<html>retry-success</html>"]);
    assert.strictEqual(state.errors.length, 1);
  });

  it("swallows a stale load failure after a newer generation wins", async () => {
    const state = fixture();
    const current = analysis();

    const stale = state.manager.openForSelection(current, node("stale"), "focus");
    const winner = state.manager.openForSelection(current, node("winner"), "focus");
    resolveCall(state, 1, "winner");
    assert.strictEqual(await winner, "selected");
    state.prepareCalls[0].completion.reject(new Error("stale failure"));
    assert.strictEqual(await stale, false);
    assert.deepStrictEqual(state.commits.map(({ page }) => page.html), ["<html>winner</html>"]);
    assert.deepStrictEqual(state.errors, []);
  });
});

interface RestorablePanel {
  readonly panel: vscode.WebviewPanel;
  readonly reveals: unknown[][];
  disposed: () => number;
}

function restorablePanel(viewColumn = 3): RestorablePanel {
  const reveals: unknown[][] = [];
  let disposeListener: () => void = () => undefined;
  let disposeCalls = 0;
  const panel = {
    title: "Restored panel",
    viewColumn,
    reveal: (...args: unknown[]) => reveals.push(args),
    dispose: () => {
      disposeCalls += 1;
      disposeListener();
    },
    onDidDispose: (listener: () => void) => {
      disposeListener = listener;
      return { dispose: () => undefined };
    },
  } as unknown as vscode.WebviewPanel;
  return { panel, reveals, disposed: () => disposeCalls };
}

function restorationFixture(
  resolveAnalysis: (analysisId: string) => Promise<Analysis | undefined>,
) {
  const createOptions: ModelExplorerWebviewOptions[] = [];
  const attachCalls: Array<{
    panel: vscode.WebviewPanel;
    options: AttachModelExplorerWebviewOptions;
  }> = [];
  const prepareCalls: PrepareCall[] = [];
  const commits: Array<{
    webviewIndex: number;
    page: PreparedModelExplorerPage;
    overlayIntent: ModelExplorerOverlayIntent | undefined;
  }> = [];
  const errors: Array<{ webviewIndex: number; message: string }> = [];
  const errorShowLog: boolean[] = [];
  const createdPanels: RestorablePanel[] = [];
  let webviewCount = 0;

  const makeWebview = (panel: vscode.WebviewPanel): ModelExplorerWebview => {
    const webviewIndex = webviewCount;
    webviewCount += 1;
    return {
      panel,
      prepareModelExplorer: (
        htmlPath,
        standardizedOutputPath,
        entityNodeMappingsPath,
        initialSelection,
      ) => {
        const completion = deferred<PreparedModelExplorerPage>();
        prepareCalls.push({
          args: [
            htmlPath,
            standardizedOutputPath,
            entityNodeMappingsPath,
            initialSelection,
          ],
          completion,
          webviewIndex,
        });
        return completion.promise;
      },
      showPreparedModelExplorer: (page, overlayIntent) =>
        commits.push({ webviewIndex, page, overlayIntent }),
      showError: (message, options: ModelExplorerErrorOptions = {}) => {
        errors.push({ webviewIndex, message });
        errorShowLog.push(options.showLog ?? true);
      },
      selectNode: async () => true,
      setOverlayIntent: async () => true,
    };
  };

  const manager = new AnalysisPanelManager({
    showLog: () => undefined,
    shouldSyncSelectionToCode: () => true,
    showSelectedEntities: () => undefined,
    resolveAnalysis,
    overlayUserIntentChanged: () => undefined,
    createWebview: (options) => {
      createOptions.push(options);
      const created = restorablePanel(2);
      createdPanels.push(created);
      return makeWebview(created.panel);
    },
    attachWebview: (panel, options) => {
      attachCalls.push({ panel, options });
      return makeWebview(panel);
    },
  });

  return {
    manager,
    createOptions,
    attachCalls,
    prepareCalls,
    commits,
    errors,
    errorShowLog,
    createdPanels,
  };
}

function waitForMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("AnalysisPanelManager restoration", () => {
  it("registers the serializer and disposes panels with invalid or unsupported state", async () => {
    let registeredViewType: string | undefined;
    let serializer: vscode.WebviewPanelSerializer | undefined;
    const disposable = { dispose: () => undefined };
    const restored: Array<{ panel: vscode.WebviewPanel; analysisId: string }> = [];
    const manager = {
      restore: async (panel: vscode.WebviewPanel, analysisId: string) => {
        restored.push({ panel, analysisId });
      },
    } as AnalysisPanelManager;

    const result = registerAnalysisPanelSerializer(
      ((viewType: string, registered: vscode.WebviewPanelSerializer) => {
        registeredViewType = viewType;
        serializer = registered;
        return disposable;
      }) as typeof vscode.window.registerWebviewPanelSerializer,
      manager,
    );

    assert.strictEqual(result, disposable);
    assert.strictEqual(registeredViewType, MODEL_EXPLORER_VIEW_TYPE);
    assert.ok(serializer);

    for (const invalidState of [
      undefined,
      null,
      {},
      { version: 2, analysisId: "analysis" },
      { version: 1, analysisId: "" },
    ]) {
      const invalidPanel = restorablePanel();
      await serializer.deserializeWebviewPanel(invalidPanel.panel, invalidState);
      assert.strictEqual(invalidPanel.disposed(), 1);
    }

    const validPanel = restorablePanel();
    await serializer.deserializeWebviewPanel(
      validPanel.panel,
      { version: 1, analysisId: "analysis-a" },
    );
    assert.deepStrictEqual(restored, [{ panel: validPanel.panel, analysisId: "analysis-a" }]);
  });

  it("adopts the supplied panel immediately and waits for store readiness before loading it", async () => {
    const ready = deferred<Analysis | undefined>();
    const state = restorationFixture(() => ready.promise);
    const supplied = restorablePanel();

    const restoring = state.manager.restore(supplied.panel, "analysis");

    assert.strictEqual(state.createOptions.length, 0);
    assert.strictEqual(state.attachCalls.length, 1);
    assert.strictEqual(state.attachCalls[0].panel, supplied.panel);
    assert.deepStrictEqual(state.attachCalls[0].options, {
      analysisId: "analysis",
      title: "MLIA Model Explorer",
      loadingMessage: "Restoring MLIA Model Explorer...",
      showLog: state.attachCalls[0].options.showLog,
      showSelectedNode: state.attachCalls[0].options.showSelectedNode,
      overlayUserIntentChanged: state.attachCalls[0].options.overlayUserIntentChanged,
    });
    assert.strictEqual(state.prepareCalls.length, 0);

    ready.resolve(analysis());
    await waitForMicrotasks();
    assert.strictEqual(supplied.panel.title, "MLIA: model.tflite · Estimation · ethos-u55");
    assert.strictEqual(state.prepareCalls.length, 1);
    assert.deepStrictEqual(state.prepareCalls[0].args, [
      "model-explorer.html",
      "standardized-output.json",
      "entity-node-mappings.json",
      undefined,
    ]);

    state.prepareCalls[0].completion.resolve(prepared("restored"));
    await restoring;
    assert.deepStrictEqual(state.commits.map(({ page }) => page.html), ["<html>restored</html>"]);
  });

  it("restores a panel with the analysis overlay intent instead of webview-state selection", async () => {
    const current = synchronizedAnalysis();
    const state = restorationFixture(async () => current);
    const supplied = restorablePanel();

    const restoring = state.manager.restore(supplied.panel, current.id);
    await waitForMicrotasks();
    state.prepareCalls[0].completion.resolve(prepared("restored-overlay"));
    await restoring;
    assert.deepStrictEqual(state.commits[0].overlayIntent, {
      kind: "overlay",
      effectiveName: "total_cycles (cycles)",
    });
  });

  it("renders a clear unavailable page for missing and unusable analyses", async () => {
    const missing = restorationFixture(async () => undefined);
    const missingPanel = restorablePanel();
    await missing.manager.restore(missingPanel.panel, "missing");
    assert.match(missing.errors[0].message, /stored analysis is no longer available/);

    const failedAnalysis: Analysis = {
      ...analysis("failed"),
      status: "failed",
      artifacts: undefined,
      error: "Stored artifacts were deleted.",
    };
    const unusable = restorationFixture(async () => failedAnalysis);
    const unusablePanel = restorablePanel();
    await unusable.manager.restore(unusablePanel.panel, failedAnalysis.id);
    assert.strictEqual(unusablePanel.panel.title, "MLIA: model.tflite · Estimation · ethos-u55");
    assert.strictEqual(
      unusable.errors[0].message,
      "Stored artifacts were deleted.",
    );
    assert.deepStrictEqual(unusable.errorShowLog, [false]);
  });

  it("renders running, interrupted, and cancelled analyses without preparing artifacts", async () => {
    for (const status of ["running", "interrupted", "cancelled"] as const) {
      const restoredAnalysis: Analysis = {
        ...analysis(status),
        status,
        artifacts: undefined,
        error: status === "interrupted" ? "The previous extension host stopped." : undefined,
      };
      const state = restorationFixture(async () => restoredAnalysis);
      const supplied = restorablePanel();

      await state.manager.restore(supplied.panel, restoredAnalysis.id);

      assert.strictEqual(supplied.panel.title, "MLIA: model.tflite · Estimation · ethos-u55");
      assert.strictEqual(state.prepareCalls.length, 0);
      assert.strictEqual(state.errors.length, 1);
      assert.match(state.errors[0].message, new RegExp(`analysis is ${status}`));
      if (status === "interrupted") {
        assert.match(state.errors[0].message, /previous extension host stopped/);
      }
    }
  });

  it("renders artifact preparation failures and allows a normal retry on the restored panel", async () => {
    const current = analysis();
    const state = restorationFixture(async () => current);
    const supplied = restorablePanel();

    const restoring = state.manager.restore(supplied.panel, current.id);
    await waitForMicrotasks();
    assert.strictEqual(state.prepareCalls.length, 1);

    state.prepareCalls[0].completion.reject(new Error("restored artifact is unreadable"));
    await restoring;

    assert.deepStrictEqual(state.errors, [{
      webviewIndex: 0,
      message: "Failed to load Model Explorer.\n\nrestored artifact is unreadable",
    }]);
    assert.strictEqual(state.commits.length, 0);

    const retry = state.manager.open(current, "focus");
    assert.strictEqual(state.createOptions.length, 0);
    assert.strictEqual(state.prepareCalls.length, 2);
    state.prepareCalls[1].completion.resolve(prepared("retry-after-restoration-error"));
    await retry;

    assert.deepStrictEqual(state.commits.map(({ page }) => page.html), [
      "<html>retry-after-restoration-error</html>",
    ]);
    assert.strictEqual(state.errors.length, 1);
  });

  it("retains the first restored panel and deterministically disposes duplicates", async () => {
    const ready = deferred<Analysis | undefined>();
    const state = restorationFixture(() => ready.promise);
    const retained = restorablePanel(2);
    const duplicate = restorablePanel(3);

    const first = state.manager.restore(retained.panel, "analysis");
    await state.manager.restore(duplicate.panel, "analysis");

    assert.strictEqual(state.attachCalls.length, 1);
    assert.strictEqual(state.attachCalls[0].panel, retained.panel);
    assert.strictEqual(retained.disposed(), 0);
    assert.strictEqual(duplicate.disposed(), 1);

    ready.resolve(analysis());
    await waitForMicrotasks();
    state.prepareCalls[0].completion.resolve(prepared("retained"));
    await first;
    assert.deepStrictEqual(state.commits.map(({ page }) => page.html), ["<html>retained</html>"]);
  });

  it("reuses a restored panel when a normal open races store readiness", async () => {
    const ready = deferred<Analysis | undefined>();
    const state = restorationFixture(() => ready.promise);
    const supplied = restorablePanel();
    const current = analysis();

    const restoring = state.manager.restore(supplied.panel, current.id);
    const opening = state.manager.open(current, "focus");

    assert.strictEqual(state.createOptions.length, 0);
    assert.strictEqual(state.attachCalls.length, 1);
    assert.deepStrictEqual(supplied.reveals, [[3, false]]);
    assert.strictEqual(state.prepareCalls.length, 1);

    ready.resolve(current);
    await waitForMicrotasks();
    assert.strictEqual(state.prepareCalls.length, 1);
    state.prepareCalls[0].completion.resolve(prepared("normal-open"));
    await Promise.all([restoring, opening]);
    assert.deepStrictEqual(state.commits.map(({ page }) => page.html), ["<html>normal-open</html>"]);
  });

  it("does not let rejected store readiness override a normal load on the adopted panel", async () => {
    const ready = deferred<Analysis | undefined>();
    const state = restorationFixture(() => ready.promise);
    const supplied = restorablePanel();
    const current = analysis();

    const restoring = state.manager.restore(supplied.panel, current.id);
    const opening = state.manager.open(current, "focus");

    assert.strictEqual(state.createOptions.length, 0);
    assert.strictEqual(state.attachCalls.length, 1);
    assert.strictEqual(state.attachCalls[0].panel, supplied.panel);
    assert.strictEqual(state.prepareCalls.length, 1);

    ready.reject(new Error("analysis store failed to load"));
    await restoring;

    assert.deepStrictEqual(state.errors, []);
    state.prepareCalls[0].completion.resolve(prepared("normal-load-after-readiness-failure"));
    await opening;

    assert.deepStrictEqual(state.commits.map(({ page }) => page.html), [
      "<html>normal-load-after-readiness-failure</html>",
    ]);
    assert.deepStrictEqual(state.errors, []);
  });

  it("keeps a normal panel when restoration later supplies a duplicate", async () => {
    const current = analysis();
    const state = restorationFixture(async () => current);
    const duplicate = restorablePanel(3);

    const opening = state.manager.open(current, "focus");
    assert.strictEqual(state.createOptions.length, 1);
    assert.strictEqual(state.prepareCalls.length, 1);

    await state.manager.restore(duplicate.panel, current.id);

    assert.strictEqual(state.attachCalls.length, 0);
    assert.strictEqual(state.createdPanels[0].disposed(), 0);
    assert.strictEqual(duplicate.disposed(), 1);

    state.prepareCalls[0].completion.resolve(prepared("normal-panel-retained"));
    await opening;

    assert.deepStrictEqual(state.commits.map(({ page }) => page.html), [
      "<html>normal-panel-retained</html>",
    ]);
    assert.deepStrictEqual(state.errors, []);
    assert.strictEqual(state.createdPanels.length, 1);
  });

  it("cleans up restored ownership on disposal so a later open creates a replacement", async () => {
    const ready = deferred<Analysis | undefined>();
    const state = restorationFixture(() => ready.promise);
    const supplied = restorablePanel();
    const current = analysis();

    const restoring = state.manager.restore(supplied.panel, current.id);
    supplied.panel.dispose();
    const opening = state.manager.open(current, "focus");

    assert.strictEqual(state.createOptions.length, 1);
    assert.strictEqual(state.prepareCalls.length, 1);
    ready.resolve(current);
    state.prepareCalls[0].completion.resolve(prepared("replacement"));
    await Promise.all([restoring, opening]);
    assert.deepStrictEqual(state.commits.map(({ page }) => page.html), ["<html>replacement</html>"]);
  });
});
