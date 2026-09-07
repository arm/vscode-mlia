import * as assert from "assert";
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vm from "vm";
import { afterEach, describe, it } from "node:test";

import {
  addInitialOverlayIntentToGeneratedModelExplorerHtml,
  addInitialSelectionToGeneratedModelExplorerHtml,
  attachModelExplorerWebview,
  CreateWebviewPanel,
  findMappedEntities,
  findMappedNodeForEntity,
  MODEL_EXPLORER_VIEW_TYPE,
  openModelExplorerWebview,
  parseModelExplorerWebviewState,
  selectModelExplorerNode,
  SelectedModelExplorerNode,
} from "../modelExplorerWebview";

interface CapturedPanel {
  title: string;
  webview: {
    html: string;
    options: unknown;
    onDidReceiveMessage: (listener: (message: unknown) => void) => undefined;
    postMessage: (message: unknown) => PromiseLike<boolean>;
  };
  postedMessages: unknown[];
  receiveMessage: (message: unknown) => void;
  onDidDispose: () => undefined;
}

const tempDirs: string[] = [];

function createPanel(): CapturedPanel {
  let listener: ((message: unknown) => void) | undefined;
  const postedMessages: unknown[] = [];
  return {
    title: "",
    webview: {
      html: "",
      options: undefined,
      onDidReceiveMessage: (registeredListener) => {
        listener = registeredListener;
        return undefined;
      },
      postMessage: (message) => {
        postedMessages.push(message);
        return Promise.resolve(true);
      },
    },
    postedMessages,
    receiveMessage: (message) => listener?.(message),
    onDidDispose: () => undefined,
  };
}

function createWebviewFactory(panel: CapturedPanel) {
  const calls: Array<{
    viewType: string;
    title: string;
    showOptions: unknown;
    options: unknown;
  }> = [];

  const createWebviewPanel = ((
    viewType: string,
    title: string,
    showOptions: unknown,
    options: unknown,
  ) => {
    calls.push({ viewType, title, showOptions, options });
    return panel;
  }) as unknown as CreateWebviewPanel;

  return { calls, createWebviewPanel };
}

function generatedHostHtml(initialUiState: unknown = null): string {
  const data = {
    hostContractVersion: 1,
    graphCollections: [
      { label: "source", graphs: [{ id: "source-graph", nodes: [] }] },
    ],
    nodeData: [],
    initialUiState,
    selectedNodeData: [],
    visualizerConfig: {},
    message: null,
  };
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Generated Model Explorer</title>
    <script>window.modelExplorerBundleLoaded = true;</script>
    <script id="mlia-model-explorer-data" type="application/json">
      ${JSON.stringify(data)}
    </script>
  </head>
  <body>
    <div id="message"></div>
    <script>(() => {
      const dataElement = document.getElementById('mlia-model-explorer-data');
      const data = dataElement ? JSON.parse(dataElement.textContent || '{}') : {};
      const message = document.getElementById('message');
      if (data.message && message) {
        message.textContent = data.message;
        message.style.display = 'block';
      }

      const visualizer = document.createElement('model-explorer-visualizer');
      visualizer.graphCollections = data.graphCollections || [];
      visualizer.config = data.visualizerConfig || {};
      visualizer.selectedNodeData = data.selectedNodeData || [];
      visualizer.syncNodeDataOverlaySelection = true;
      if (data.initialUiState) {
        visualizer.initialUiState = data.initialUiState;
      }

      const addedNodeData = new Set();
      visualizer.addEventListener('modelGraphProcessed', () => addedNodeData.add('processed'));
      const host = document.getElementById('visualizer-host');
      (host || document.body).appendChild(visualizer);
    })();</script>
  </body>
</html>`;
}

function generatedHtmlFromCurrentBundler(): string | undefined {
  const repository =
    process.env.MLIA_MODEL_EXPLORER_REPO ??
    path.resolve(__dirname, "..", "..", "..", "mlia-model-explorer");
  const python =
    process.env.MLIA_MODEL_EXPLORER_PYTHON ??
    path.join(
      repository,
      "..",
      ".venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    );
  if (
    !existsSync(
      path.join(repository, "src", "mlia", "model_explorer", "bundler.py"),
    ) ||
    !existsSync(python)
  ) {
    return undefined;
  }

  const script = `
from mlia.model_explorer import bundler
bundler._visualizer_script = lambda: "window.currentBundlerVisualizer = true;"
data = {
    "hostContractVersion": bundler._HOST_CONTRACT_VERSION,
    "graphCollections": [
        {"label": "source", "graphs": [{"id": "source-graph", "nodes": []}]}
    ],
    "nodeDataProviderRuns": [],
    "initialUiState": None,
    "selectedNodeData": [],
    "visualizerConfig": {},
    "message": None,
    "manifest": {},
}
print(bundler._index_html(data), end="")
`;
  const completed = spawnSync(python, ["-c", script], {
    cwd: repository,
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONPATH: path.join(repository, "src"),
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (completed.status !== 0) {
    throw new Error(
      `Failed to generate current MLIA Model Explorer HTML: ${completed.stderr}`,
    );
  }
  return completed.stdout;
}

function scriptContentById(html: string, id: string): string {
  const pattern = new RegExp(
    `<script\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)<\\/script>`,
    "iu",
  );
  const match = pattern.exec(html);
  assert.ok(match, `missing script ${id}`);
  return match[1];
}

function generatedHostScript(html: string): string {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/giu)];
  const match = scripts.find((script) =>
    script[1].includes("document.createElement('model-explorer-visualizer')"),
  );
  assert.ok(match, "missing generated host script");
  return match[1];
}

function runVsCodeIntegration(
  html: string,
  delayedUpgrade = false,
  upgradeHasOverlayMethod = true,
) {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/giu)];
  const integration = scripts.find((script) =>
    script[1].includes("acquireVsCodeApi"),
  );
  assert.ok(integration, "missing VS Code integration script");
  const dataElement = {
    textContent: scriptContentById(html, "mlia-model-explorer-data"),
  };
  const postedMessages: unknown[] = [];
  const persistedStates: unknown[] = [];
  const selectedNodes: unknown[][] = [];
  const overlayIntents: unknown[] = [];
  let acquireCalls = 0;
  let selectionListener: ((event: { detail?: unknown }) => void) | undefined;
  let uiStateListener: ((event: { detail?: unknown }) => void) | undefined;
  let overlayListener: ((event: { detail?: unknown }) => void) | undefined;
  let messageListener: ((event: { data?: unknown }) => void) | undefined;
  let resolveDefinition: (() => void) | undefined;
  const definition = delayedUpgrade
    ? new Promise<void>((resolve) => {
        resolveDefinition = resolve;
      })
    : undefined;
  const visualizer: Record<string, unknown> & {
    addEventListener: (
      name: string,
      listener: (event: { detail?: unknown }) => void,
    ) => void;
    selectNode: (...args: unknown[]) => void;
    setNodeDataOverlayIntent?: (intent: unknown) => void;
  } = {
    addEventListener: (name, listener) => {
      if (name === "selectedNodeChanged") {
        selectionListener = listener;
      } else if (name === "uiStateChanged") {
        uiStateListener = listener;
      } else if (name === "nodeDataOverlayIntentChanged") {
        overlayListener = listener;
      }
    },
    selectNode: (...args) => selectedNodes.push(args),
  };
  const exposeOverlayMethod = () => {
    visualizer.setNodeDataOverlayIntent = (intent: unknown) =>
      overlayIntents.push(JSON.parse(JSON.stringify(intent)) as unknown);
  };
  if (!delayedUpgrade) {
    exposeOverlayMethod();
  }

  vm.runInNewContext(integration[1], {
    acquireVsCodeApi: () => {
      acquireCalls += 1;
      return {
        postMessage: (message: unknown) => postedMessages.push(message),
        setState: (state: unknown) =>
          persistedStates.push(JSON.parse(JSON.stringify(state)) as unknown),
      };
    },
    customElements: {
      whenDefined: () =>
        delayedUpgrade
          ? definition
          : {
              then: (listener: () => void) => {
                listener();
              },
            },
    },
    document: {
      getElementById: (id: string) =>
        id === "mlia-model-explorer-data" ? dataElement : null,
      querySelector: () => visualizer,
    },
    window: {
      addEventListener: (
        name: string,
        listener: (event: { data?: unknown }) => void,
      ) => {
        if (name === "message") {
          messageListener = listener;
        }
      },
    },
  });

  return {
    acquireCalls: () => acquireCalls,
    persistedStates,
    postedMessages,
    selectedNodes,
    overlayIntents,
    upgrade: async () => {
      if (upgradeHasOverlayMethod) {
        exposeOverlayMethod();
      }
      resolveDefinition?.();
      await Promise.resolve();
    },
    select: (detail: unknown) => selectionListener?.({ detail }),
    changeUiState: (detail: unknown) => uiStateListener?.({ detail }),
    changeOverlay: (detail: unknown) => overlayListener?.({ detail }),
    receive: (data: unknown) => messageListener?.({ data }),
  };
}

function runSimpleWebviewBridge(html: string) {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/giu)];
  const bridge = scripts.find((script) =>
    script[1].includes("acquireVsCodeApi"),
  );
  assert.ok(bridge, "missing VS Code bridge script");
  const persistedStates: unknown[] = [];
  const postedMessages: unknown[] = [];
  let acquireCalls = 0;
  vm.runInNewContext(bridge[1], {
    acquireVsCodeApi: () => {
      acquireCalls += 1;
      return {
        setState: (state: unknown) =>
          persistedStates.push(JSON.parse(JSON.stringify(state)) as unknown),
        postMessage: (message: unknown) => postedMessages.push(message),
      };
    },
    document: {
      getElementById: () => ({ addEventListener: () => undefined }),
    },
  });
  return { acquireCalls, persistedStates, postedMessages };
}

function runGeneratedHost(html: string) {
  const dataText = scriptContentById(html, "mlia-model-explorer-data");
  const events: string[] = [];
  let appendedState: unknown;
  const overlayIntents: unknown[] = [];
  const overlaySyncEnabledAtIntent: boolean[] = [];
  const visualizer = {
    initialUiState: undefined as unknown,
    syncNodeDataOverlaySelection: false,
    addEventListener: () => undefined,
    setNodeDataOverlayIntent: (intent: unknown) => {
      overlayIntents.push(JSON.parse(JSON.stringify(intent)) as unknown);
      overlaySyncEnabledAtIntent.push(
        Boolean(visualizer.syncNodeDataOverlaySelection),
      );
    },
  } as Record<string, unknown> & {
    initialUiState: unknown;
    syncNodeDataOverlaySelection: boolean;
    addEventListener: () => void;
    setNodeDataOverlayIntent: (intent: unknown) => void;
  };
  const dataElement = { textContent: dataText };
  vm.runInNewContext(generatedHostScript(html), {
    Set,
    console,
    document: {
      getElementById: (id: string) =>
        id === "mlia-model-explorer-data" ? dataElement : null,
      createElement: (tag: string) => {
        events.push(`create:${tag}`);
        return visualizer;
      },
      body: {
        appendChild: (element: typeof visualizer) => {
          events.push("append");
          appendedState = element.initialUiState;
        },
      },
    },
  });
  return {
    events,
    appendedState,
    visualizer,
    overlayIntents,
    overlaySyncEnabledAtIntent,
  };
}

async function writeArtifacts(standaloneHtml: string) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "vscode-mlia-webview-test-"),
  );
  tempDirs.push(root);
  const htmlPath = path.join(root, "model-explorer", "bundle", "index.html");
  const standardizedOutputPath = path.join(
    root,
    "model-explorer",
    "standardized-output.json",
  );
  const entityNodeMappingsPath = path.join(
    root,
    "model-explorer",
    "entity-node-mappings.json",
  );
  await fs.mkdir(path.dirname(htmlPath), { recursive: true });
  await fs.writeFile(htmlPath, standaloneHtml, "utf8");
  return { htmlPath, standardizedOutputPath, entityNodeMappingsPath };
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("findMappedNodeForEntity", () => {
  const mappings = {
    results: [
      {
        resultIndex: 0,
        mappings: [
          {
            entityId: "code_stack/model",
            node: {
              collectionLabel: "Source Model",
              graphId: "main",
              nodeId: "operator/7",
            },
          },
          {
            entityId: "code_stack/model",
            node: {
              collectionLabel: "code_stack",
              graphId: "stack",
              nodeId: "model.py:7___group___",
            },
          },
        ],
      },
      {
        resultIndex: 1,
        mappings: [
          {
            entityId: "code_stack/model",
            node: {
              collectionLabel: "code_stack",
              graphId: "other",
              nodeId: "other-node",
            },
          },
        ],
      },
    ],
  };

  it("prefers the code_stack mapping in the requested result", () => {
    assert.deepStrictEqual(
      findMappedNodeForEntity(mappings, 0, "code_stack/model"),
      {
        collectionLabel: "code_stack",
        graphId: "stack",
        nodeId: "model.py:7___group___",
      },
    );
    assert.deepStrictEqual(
      findMappedNodeForEntity(mappings, 1, "code_stack/model"),
      {
        collectionLabel: "code_stack",
        graphId: "other",
        nodeId: "other-node",
      },
    );
  });

  it("returns undefined when the entity has no mapping in the requested result", () => {
    assert.strictEqual(
      findMappedNodeForEntity(mappings, 2, "code_stack/model"),
      undefined,
    );
  });
});

describe("generated Model Explorer initialUiState integration", () => {
  it("merges the exact pane-zero graph and node before the generated host appends the visualizer", () => {
    const originalState = {
      paneStates: [
        {
          deepestExpandedGroupNodeIds: ["existing-group"],
          selectedNodeId: "old-node",
          selectedGraphId: "old-graph",
          selectedCollectionLabel: "old-collection",
          widthFraction: 0.4,
          selected: false,
          flattenLayers: true,
        },
        {
          deepestExpandedGroupNodeIds: [],
          selectedNodeId: "pane-one-node",
          selectedGraphId: "pane-one-graph",
          selectedCollectionLabel: "pane-one-collection",
          widthFraction: 0.6,
          selected: true,
        },
      ],
    };
    const selection = {
      collectionLabel: "code_stack",
      graphId: "code-stack-main",
      nodeId: "model.py:7___group___",
    };

    const transformed = addInitialSelectionToGeneratedModelExplorerHtml(
      generatedHostHtml(originalState),
      selection,
    );
    const runtime = runGeneratedHost(transformed);

    assert.deepStrictEqual(runtime.events, [
      "create:model-explorer-visualizer",
      "append",
    ]);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(runtime.appendedState)), {
      paneStates: [
        {
          deepestExpandedGroupNodeIds: ["existing-group"],
          selectedNodeId: selection.nodeId,
          selectedGraphId: selection.graphId,
          selectedCollectionLabel: selection.collectionLabel,
          widthFraction: 0.4,
          selected: true,
          flattenLayers: true,
        },
        {
          deepestExpandedGroupNodeIds: [],
          selectedNodeId: "pane-one-node",
          selectedGraphId: "pane-one-graph",
          selectedCollectionLabel: "pane-one-collection",
          widthFraction: 0.6,
          selected: false,
        },
      ],
    });
  });

  it("serializes arbitrary valid selection fields without terminating the host data script", () => {
    const selection = {
      collectionLabel: `collection</script><script>bad()</script>`,
      graphId: `graph"'&<>`,
      nodeId: `node\\\n\u2028</SCRIPT>`,
    };
    const transformed = addInitialSelectionToGeneratedModelExplorerHtml(
      generatedHostHtml(),
      selection,
    );
    const runtime = runGeneratedHost(transformed);
    const state = JSON.parse(JSON.stringify(runtime.appendedState)) as {
      paneStates: Array<{
        selectedCollectionLabel: string;
        selectedGraphId: string;
        selectedNodeId: string;
      }>;
    };

    assert.strictEqual(
      state.paneStates[0].selectedCollectionLabel,
      selection.collectionLabel,
    );
    assert.strictEqual(state.paneStates[0].selectedGraphId, selection.graphId);
    assert.strictEqual(state.paneStates[0].selectedNodeId, selection.nodeId);
  });

  it("applies both transformations to HTML emitted by the current bundler", (context) => {
    const html = generatedHtmlFromCurrentBundler();
    if (html === undefined) {
      context.skip(
        "The sibling mlia-model-explorer development environment is unavailable.",
      );
      return;
    }
    const selection = {
      collectionLabel: "source",
      graphId: "source-graph",
      nodeId: "selected-node",
    };
    const intent = { kind: "overlay", effectiveName: "total_cycles" } as const;

    const transformed = addInitialOverlayIntentToGeneratedModelExplorerHtml(
      addInitialSelectionToGeneratedModelExplorerHtml(html, selection),
      intent,
    );
    const runtime = runGeneratedHost(transformed);
    const data = JSON.parse(
      scriptContentById(transformed, "mlia-model-explorer-data"),
    ) as Record<string, unknown>;

    assert.deepStrictEqual(JSON.parse(JSON.stringify(runtime.appendedState)), {
      paneStates: [
        {
          deepestExpandedGroupNodeIds: [],
          selectedNodeId: selection.nodeId,
          selectedGraphId: selection.graphId,
          selectedCollectionLabel: selection.collectionLabel,
          widthFraction: 1,
          selected: true,
        },
      ],
    });
    assert.strictEqual(data.hostContractVersion, 1);
    assert.deepStrictEqual(data.mliaVsCodeInitialOverlayIntent, intent);
  });

  it("fails conservatively when the generated host contract is absent", () => {
    assert.throws(
      () =>
        addInitialSelectionToGeneratedModelExplorerHtml(
          `<script id="mlia-model-explorer-data" type="application/json">{}</script>`,
          { collectionLabel: "c", graphId: "g", nodeId: "n" },
        ),
      /host contract version undefined is not supported/,
    );
  });
});

describe("Model Explorer restoration state", () => {
  it("accepts only the supported version with a non-empty analysis id", () => {
    assert.deepStrictEqual(
      parseModelExplorerWebviewState({
        version: 1,
        analysisId: "analysis-a",
        ignored: true,
      }),
      { version: 1, analysisId: "analysis-a" },
    );
    for (const invalid of [
      undefined,
      null,
      [],
      {},
      { version: 2, analysisId: "analysis-a" },
      { version: 1 },
      { version: 1, analysisId: "" },
      { version: 1, analysisId: 7 },
    ]) {
      assert.strictEqual(parseModelExplorerWebviewState(invalid), undefined);
    }
  });

  it("adopts a supplied panel and persists minimal state on loading and error pages", () => {
    const panel = createPanel();
    const webview = attachModelExplorerWebview(panel as never, {
      analysisId: "analysis-a",
      title: "MLIA: profile",
      loadingMessage: "Restoring analysis run...",
      showLog: () => undefined,
    });

    assert.strictEqual(panel.title, "MLIA: profile");
    assert.deepStrictEqual(panel.webview.options, { enableScripts: true });
    assert.match(panel.webview.html, /Restoring analysis run\.\.\./);
    assert.deepStrictEqual(runSimpleWebviewBridge(panel.webview.html), {
      acquireCalls: 1,
      persistedStates: [{ version: 1, analysisId: "analysis-a" }],
      postedMessages: [],
    });

    webview.showError("The analysis run is unavailable.");
    assert.match(panel.webview.html, /The analysis run is unavailable\./);
    assert.deepStrictEqual(runSimpleWebviewBridge(panel.webview.html), {
      acquireCalls: 1,
      persistedStates: [{ version: 1, analysisId: "analysis-a" }],
      postedMessages: [],
    });
  });

  it("disposes the extension-side message listener with the panel", () => {
    let panelDisposalListener: (() => void) | undefined;
    let messageListenerDisposed = false;
    const panel = {
      title: "",
      webview: {
        html: "",
        options: undefined,
        onDidReceiveMessage: () => ({
          dispose: () => {
            messageListenerDisposed = true;
          },
        }),
        postMessage: async () => true,
      },
      onDidDispose: (listener: () => void) => {
        panelDisposalListener = listener;
        return { dispose: () => undefined };
      },
    };

    attachModelExplorerWebview(panel as never, {
      analysisId: "analysis",
      title: "MLIA",
      showLog: () => undefined,
    });
    assert.strictEqual(messageListenerDisposed, false);

    panelDisposalListener?.();
    assert.strictEqual(messageListenerDisposed, true);
  });

  it("loads Model Explorer content and reconnects messages on an adopted panel", async () => {
    const artifacts = await writeArtifacts(generatedHostHtml());
    await fs.writeFile(
      artifacts.standardizedOutputPath,
      JSON.stringify({ results: [] }),
      "utf8",
    );
    await fs.writeFile(
      artifacts.entityNodeMappingsPath,
      JSON.stringify({ results: [] }),
      "utf8",
    );
    const panel = createPanel();
    const selections: SelectedModelExplorerNode[] = [];
    const overlayIntents: unknown[] = [];
    const logs: string[] = [];
    let showLogCalls = 0;
    const webview = attachModelExplorerWebview(panel as never, {
      analysisId: "analysis-restored",
      title: "MLIA: restored",
      showLog: () => {
        showLogCalls += 1;
      },
      showSelectedNode: (selection) => selections.push(selection),
      overlayUserIntentChanged: (intent) => overlayIntents.push(intent),
      log: (message) => logs.push(message),
    });

    const page = await webview.prepareModelExplorer(
      artifacts.htmlPath,
      artifacts.standardizedOutputPath,
      artifacts.entityNodeMappingsPath,
    );
    webview.showPreparedModelExplorer(page);
    const bridge = runVsCodeIntegration(panel.webview.html);
    assert.strictEqual(bridge.acquireCalls(), 1);
    assert.deepStrictEqual(bridge.persistedStates, [
      { version: 1, analysisId: "analysis-restored" },
    ]);

    panel.receiveMessage({ command: "showLog" });
    panel.receiveMessage({
      command: "selectedNode",
      collectionLabel: "source",
      graphId: "main",
      nodeId: "node",
    });
    panel.receiveMessage({
      command: "selectedNode",
      collectionLabel: "source",
      graphId: "main",
    });
    panel.receiveMessage({
      command: "overlayUserIntentChanged",
      intent: { kind: "overlay", effectiveName: "total_cycles (cycles)" },
    });
    panel.receiveMessage({
      command: "overlayUserIntentChanged",
      intent: { kind: "overlay", effectiveName: "" },
    });
    panel.receiveMessage({
      command: "overlaySyncDiagnostic",
      message: "setNodeDataOverlayIntent failed: test failure",
    });
    panel.receiveMessage({
      command: "sourceSyncDiagnostic",
      message:
        "ignored selectedNodeChanged event with selectionSource sync for source/main/node",
    });
    assert.strictEqual(showLogCalls, 1);
    assert.deepStrictEqual(overlayIntents, [
      {
        kind: "overlay",
        effectiveName: "total_cycles (cycles)",
      },
    ]);
    assert.deepStrictEqual(logs, [
      "Received Model Explorer node selection source/main/node; 0 mapped MLIA entities.",
      "Model Explorer source synchronization: ignored a malformed node selection event.",
      "Model Explorer overlay synchronization: ignored a malformed user intent event.",
      "Model Explorer overlay synchronization: setNodeDataOverlayIntent failed: test failure",
      "Model Explorer source synchronization: ignored selectedNodeChanged event with selectionSource sync for source/main/node",
    ]);
    assert.deepStrictEqual(selections, [
      {
        collectionLabel: "source",
        graphId: "main",
        nodeId: "node",
        entities: [],
      },
    ]);
  });
});

describe("openModelExplorerWebview", () => {
  it("creates the Model Explorer panel with an initial loading page and explicit focus intent", () => {
    const panel = createPanel();
    const factory = createWebviewFactory(panel);

    openModelExplorerWebview({
      analysisId: "analysis",
      title: "MLIA Model Explorer",
      focus: "focus",
      showLog: () => undefined,
      createWebviewPanel: factory.createWebviewPanel,
      viewColumn: "beside" as never,
    });

    assert.deepStrictEqual(factory.calls, [
      {
        viewType: "mliaModelExplorer",
        title: "MLIA Model Explorer",
        showOptions: { viewColumn: "beside", preserveFocus: false },
        options: {
          enableScripts: true,
          retainContextWhenHidden: true,
        },
      },
    ]);
    assert.match(panel.webview.html, /role="status"/);
    assert.match(panel.webview.html, /class="spinner"/);
    assert.match(panel.webview.html, /Running MLIA performance check\.\.\./);
    assert.match(panel.webview.html, />Show Log<\/a>/);
  });

  it("creates a revealed Model Explorer panel without taking focus", () => {
    const panel = createPanel();
    const factory = createWebviewFactory(panel);

    openModelExplorerWebview({
      analysisId: "analysis",
      title: "MLIA Model Explorer",
      focus: "preserve",
      showLog: () => undefined,
      createWebviewPanel: factory.createWebviewPanel,
      viewColumn: "beside" as never,
    });

    assert.deepStrictEqual(factory.calls[0].showOptions, {
      viewColumn: "beside",
      preserveFocus: true,
    });
  });

  it("shows the output log when the loading page Show Log link posts a message", () => {
    let showLogCalled = false;
    const panel = createPanel();

    openModelExplorerWebview({
      analysisId: "analysis",
      title: "MLIA Model Explorer",
      focus: "focus",
      showLog: () => {
        showLogCalled = true;
      },
      createWebviewPanel: createWebviewFactory(panel).createWebviewPanel,
      viewColumn: "beside" as never,
    });

    panel.receiveMessage({ command: "showLog" });

    assert.strictEqual(showLogCalled, true);
  });

  it("prepares generated HTML with initialUiState and user-only selection integration", async () => {
    const artifacts = await writeArtifacts(generatedHostHtml());
    const entity = {
      id: "source_operator/operator/7",
      kind: "source_operator",
      name: "Conv2D",
    };
    const mappedStack = { id: "code_stack/model", kind: "code_stack" };
    const unmappedStack = { id: "code_stack/internal", kind: "code_stack" };
    await fs.writeFile(
      artifacts.standardizedOutputPath,
      JSON.stringify({
        schema_version: "1.2.0",
        results: [{ entities: [entity, mappedStack, unmappedStack] }],
      }),
      "utf8",
    );
    await fs.writeFile(
      artifacts.entityNodeMappingsPath,
      JSON.stringify({
        results: [
          {
            resultIndex: 0,
            mappings: [
              {
                node: {
                  collectionLabel: "Source Model",
                  graphId: "main",
                  nodeId: "operator/7",
                },
                entityId: entity.id,
              },
              {
                node: {
                  collectionLabel: "code_stack",
                  graphId: "code_stack-main",
                  nodeId: "model.py:7___group___",
                },
                entityId: mappedStack.id,
              },
            ],
          },
        ],
      }),
      "utf8",
    );

    const panel = createPanel();
    const selections: SelectedModelExplorerNode[] = [];
    const loadedOutputs: unknown[] = [];
    const webview = openModelExplorerWebview({
      analysisId: "analysis",
      title: "MLIA Model Explorer",
      focus: "focus",
      showLog: () => undefined,
      showSelectedNode: (selection) => selections.push(selection),
      standardizedOutputLoaded: (output) => loadedOutputs.push(output),
      createWebviewPanel: createWebviewFactory(panel).createWebviewPanel,
      viewColumn: "beside" as never,
    });

    const initialSelection = {
      collectionLabel: "code_stack",
      graphId: "code_stack-main",
      nodeId: "model.py:7___group___",
    };
    const prepared = await webview.prepareModelExplorer(
      artifacts.htmlPath,
      artifacts.standardizedOutputPath,
      artifacts.entityNodeMappingsPath,
      initialSelection,
    );
    assert.match(panel.webview.html, /Running MLIA performance check/);
    assert.deepStrictEqual(loadedOutputs, []);
    webview.showPreparedModelExplorer(prepared, {
      kind: "overlay",
      effectiveName: "total_cycles (cycles)",
    });
    assert.strictEqual(await webview.selectNode(initialSelection), true);
    assert.strictEqual(await webview.setOverlayIntent({ kind: "none" }), true);

    assert.deepStrictEqual(panel.postedMessages, [
      {
        command: "selectNode",
        collectionLabel: "code_stack",
        graphId: "code_stack-main",
        nodeId: "model.py:7___group___",
      },
      { command: "setOverlayIntent", intent: { kind: "none" } },
    ]);
    assert.strictEqual(panel.webview.html.includes("mlia-sync-to-code"), false);
    assert.strictEqual(panel.webview.html.includes("aria-pressed"), false);
    assert.strictEqual(panel.webview.html.includes("Sync to code"), false);
    assert.match(
      panel.webview.html,
      /<style id="vscode-mlia-model-explorer-styles">\s*body \{ padding: 0; \}\s*<\/style>/,
    );
    assert.ok(
      panel.webview.html.indexOf("vscode-mlia-model-explorer-styles") <
        panel.webview.html.toLowerCase().indexOf("</head>"),
    );
    assert.match(panel.webview.html, /selectedNodeChanged/);
    assert.strictEqual(panel.webview.html.includes("updateComplete"), false);
    assert.strictEqual(
      panel.webview.html.includes("customElements.whenDefined"),
      true,
    );

    const integration = runVsCodeIntegration(panel.webview.html, true);
    assert.strictEqual(integration.acquireCalls(), 1);
    assert.deepStrictEqual(integration.persistedStates, [
      { version: 1, analysisId: "analysis" },
    ]);
    assert.deepStrictEqual(integration.overlayIntents, []);
    integration.receive({
      command: "setOverlayIntent",
      intent: { kind: "none" },
    });
    assert.deepStrictEqual(integration.overlayIntents, []);
    await integration.upgrade();
    assert.deepStrictEqual(integration.overlayIntents, [{ kind: "none" }]);
    integration.select({
      selectionSource: "programmatic",
      collectionLabel: "code_stack",
      graphId: "code-stack-main",
      nodeId: "programmatic-node",
    });
    assert.deepStrictEqual(integration.postedMessages, []);
    integration.select({
      selectionSource: "user",
      collectionLabel: "code_stack",
      graphId: "code-stack-main",
      nodeId: "user-node",
    });
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(integration.postedMessages)),
      [
        {
          command: "selectedNode",
          collectionLabel: "code_stack",
          graphId: "code-stack-main",
          nodeId: "user-node",
        },
      ],
    );
    integration.changeUiState({
      paneStates: [
        {
          selectedCollectionLabel: "Source Model",
          selectedGraphId: "main",
          selected: true,
        },
        {
          selectedCollectionLabel: "code_stack",
          selectedGraphId: "code-stack-main",
          selected: false,
        },
      ],
    });
    integration.receive({
      command: "selectNode",
      collectionLabel: "code_stack",
      graphId: "code-stack-main",
      nodeId: "source-driven-node",
    });
    assert.deepStrictEqual(integration.selectedNodes, [
      ["source-driven-node", "code-stack-main", "code_stack", 1],
    ]);
    assert.deepStrictEqual(integration.overlayIntents, [{ kind: "none" }]);
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(integration.postedMessages)),
      [
        {
          command: "selectedNode",
          collectionLabel: "code_stack",
          graphId: "code-stack-main",
          nodeId: "user-node",
        },
      ],
    );
    integration.changeOverlay({
      kind: "overlay",
      effectiveName: "dram_read_bytes (bytes)",
    });
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(integration.postedMessages)).slice(-1),
      [
        {
          command: "overlayUserIntentChanged",
          intent: { kind: "overlay", effectiveName: "dram_read_bytes (bytes)" },
        },
      ],
    );
    const validMessageCount = integration.postedMessages.length;
    integration.changeOverlay({ kind: "overlay", effectiveName: "" });
    integration.receive({
      command: "setOverlayIntent",
      intent: { kind: "overlay", effectiveName: "" },
    });
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(integration.postedMessages)).slice(
        validMessageCount,
      ),
      [
        {
          command: "overlaySyncDiagnostic",
          message: "ignored a malformed nodeDataOverlayIntentChanged event",
        },
        {
          command: "overlaySyncDiagnostic",
          message: "ignored a malformed setOverlayIntent message",
        },
      ],
    );
    assert.deepStrictEqual(integration.overlayIntents, [{ kind: "none" }]);

    integration.select({
      selectionSource: "user",
      collectionLabel: "code_stack",
      graphId: "code-stack-main",
      node: { id: "nested-node-id-is-not-supported" },
    });
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(integration.postedMessages)).slice(-1),
      [
        {
          command: "sourceSyncDiagnostic",
          message:
            "ignored malformed user selectedNodeChanged event for code_stack/code-stack-main/<missing>",
        },
      ],
    );

    const runtime = runGeneratedHost(panel.webview.html);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(runtime.appendedState)), {
      paneStates: [
        {
          deepestExpandedGroupNodeIds: [],
          selectedNodeId: initialSelection.nodeId,
          selectedGraphId: initialSelection.graphId,
          selectedCollectionLabel: initialSelection.collectionLabel,
          widthFraction: 1,
          selected: true,
        },
      ],
    });
    assert.deepStrictEqual(runtime.overlayIntents, []);
    assert.strictEqual(runtime.visualizer.syncNodeDataOverlaySelection, true);
    assert.deepStrictEqual(
      JSON.parse(
        scriptContentById(panel.webview.html, "mlia-model-explorer-data"),
      ).mliaVsCodeInitialOverlayIntent,
      { kind: "overlay", effectiveName: "total_cycles (cycles)" },
    );
    assert.deepStrictEqual(loadedOutputs, [
      {
        schema_version: "1.2.0",
        results: [{ entities: [entity, mappedStack, unmappedStack] }],
      },
    ]);

    panel.receiveMessage({
      command: "selectedNode",
      collectionLabel: "Source Model",
      graphId: "main",
      nodeId: "operator/7",
    });
    assert.deepStrictEqual(selections, [
      {
        collectionLabel: "Source Model",
        graphId: "main",
        nodeId: "operator/7",
        entities: [
          {
            entity,
            resultEntities: [entity, mappedStack, unmappedStack],
            mappedCodeStackIds: new Set([mappedStack.id]),
          },
        ],
      },
    ]);
  });

  it("reports a missing overlay API after custom-element upgrade", async () => {
    const panel = createPanel();
    const webview = openModelExplorerWebview({
      analysisId: "analysis",
      title: "MLIA Model Explorer",
      focus: "focus",
      showLog: () => undefined,
      createWebviewPanel: createWebviewFactory(panel).createWebviewPanel,
      viewColumn: "beside" as never,
    });
    webview.showPreparedModelExplorer(
      {
        html: generatedHostHtml(),
        standardizedOutput: {},
        entityNodeMappings: {},
      },
      { kind: "overlay", effectiveName: "total_cycles (cycles)" },
    );

    const integration = runVsCodeIntegration(panel.webview.html, true, false);
    await integration.upgrade();

    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(integration.postedMessages)),
      [
        {
          command: "overlaySyncDiagnostic",
          message:
            "the Model Explorer custom element does not expose setNodeDataOverlayIntent",
        },
      ],
    );
  });

  it("does not commit prepared output until the manager-facing commit call", async () => {
    const artifacts = await writeArtifacts(generatedHostHtml());
    await fs.writeFile(
      artifacts.standardizedOutputPath,
      JSON.stringify({ value: "new" }),
      "utf8",
    );
    await fs.writeFile(
      artifacts.entityNodeMappingsPath,
      JSON.stringify({ results: [] }),
      "utf8",
    );
    const panel = createPanel();
    const loaded: unknown[] = [];
    const webview = openModelExplorerWebview({
      analysisId: "analysis",
      title: "MLIA Model Explorer",
      focus: "focus",
      showLog: () => undefined,
      standardizedOutputLoaded: (output) => loaded.push(output),
      createWebviewPanel: createWebviewFactory(panel).createWebviewPanel,
      viewColumn: "beside" as never,
    });

    const loadingPage = panel.webview.html;
    const prepared = await webview.prepareModelExplorer(
      artifacts.htmlPath,
      artifacts.standardizedOutputPath,
      artifacts.entityNodeMappingsPath,
    );
    assert.strictEqual(panel.webview.html, loadingPage);
    assert.deepStrictEqual(loaded, []);

    webview.showPreparedModelExplorer(prepared);
    assert.notStrictEqual(panel.webview.html, loadingPage);
    assert.deepStrictEqual(loaded, [{ value: "new" }]);
  });

  it("rejects selected preparation rather than fabricating a readiness fallback for an unknown host", async () => {
    const artifacts = await writeArtifacts(
      `<!doctype html><html><body></body></html>`,
    );
    await fs.writeFile(artifacts.standardizedOutputPath, "{}", "utf8");
    await fs.writeFile(artifacts.entityNodeMappingsPath, "{}", "utf8");
    const panel = createPanel();
    const webview = openModelExplorerWebview({
      analysisId: "analysis",
      title: "MLIA Model Explorer",
      focus: "focus",
      showLog: () => undefined,
      createWebviewPanel: createWebviewFactory(panel).createWebviewPanel,
      viewColumn: "beside" as never,
    });
    const loadingPage = panel.webview.html;

    await assert.rejects(
      webview.prepareModelExplorer(
        artifacts.htmlPath,
        artifacts.standardizedOutputPath,
        artifacts.entityNodeMappingsPath,
        { collectionLabel: "c", graphId: "g", nodeId: "n" },
      ),
      /host data script was not found uniquely/,
    );
    assert.strictEqual(panel.webview.html, loadingPage);
  });

  it("applies loaded-panel selections to the pane already showing the exact graph", () => {
    const calls: unknown[][] = [];
    selectModelExplorerNode(
      {
        selectNode: (...args) => calls.push(args),
      },
      {
        collectionLabel: "code_stack",
        graphId: "code-stack-main",
        nodeId: "model.py:7___group___",
      },
      [
        {
          selectedCollectionLabel: "Source Model",
          selectedGraphId: "main",
          selected: true,
        },
        {
          selectedCollectionLabel: "code_stack",
          selectedGraphId: "code-stack-main",
          selected: false,
        },
      ],
    );

    assert.deepStrictEqual(calls, [
      ["model.py:7___group___", "code-stack-main", "code_stack", 1],
    ]);
  });

  it("prefers the selected pane when both panes show the exact graph", () => {
    const calls: unknown[][] = [];
    selectModelExplorerNode(
      { selectNode: (...args) => calls.push(args) },
      { collectionLabel: "code_stack", graphId: "stack", nodeId: "node" },
      [
        { selectedCollectionLabel: "code_stack", selectedGraphId: "stack" },
        {
          selectedCollectionLabel: "code_stack",
          selectedGraphId: "stack",
          selected: true,
        },
      ],
    );

    assert.deepStrictEqual(calls, [["node", "stack", "code_stack", 1]]);
  });

  it("falls back to the selected pane, then pane zero", () => {
    const calls: unknown[][] = [];
    const visualizer = { selectNode: (...args: unknown[]) => calls.push(args) };
    const node = { collectionLabel: "code_stack", graphId: "stack", nodeId: "node" };

    selectModelExplorerNode(visualizer, node, [
      { selectedCollectionLabel: "Source Model", selectedGraphId: "main" },
      { selectedCollectionLabel: "Other", selectedGraphId: "other", selected: true },
    ]);
    selectModelExplorerNode(visualizer, node);

    assert.deepStrictEqual(calls, [
      ["node", "stack", "code_stack", 1],
      ["node", "stack", "code_stack", 0],
    ]);
  });

  it("can render a persisted error without offering the lost output log", () => {
    const panel = createPanel();
    const webview = openModelExplorerWebview({
      analysisId: "analysis",
      title: "MLIA Model Explorer",
      focus: "focus",
      showLog: () => undefined,
      createWebviewPanel: createWebviewFactory(panel).createWebviewPanel,
      viewColumn: "beside" as never,
    });

    webview.showError("Stored analysis failure.", { showLog: false });

    assert.match(panel.webview.html, /<main role="alert" aria-live="assertive">/);
    assert.match(panel.webview.html, /<h1>Error<\/h1>/);
    assert.match(panel.webview.html, /color: var\(--vscode-errorForeground, #f14c4c\)/);
    assert.match(panel.webview.html, /Stored analysis failure\./);
    assert.strictEqual(panel.webview.html.includes("MLIA Model Explorer"), false);
    assert.strictEqual(panel.webview.html.includes("Show Log"), false);
    assert.strictEqual(panel.webview.html.includes('command: "showLog"'), false);
  });

  it("escapes error messages and offers the output log", () => {
    let showLogCalled = false;
    const panel = createPanel();
    const webview = openModelExplorerWebview({
      analysisId: "analysis",
      title: "MLIA Model Explorer",
      focus: "focus",
      showLog: () => {
        showLogCalled = true;
      },
      createWebviewPanel: createWebviewFactory(panel).createWebviewPanel,
      viewColumn: "beside" as never,
    });

    webview.showError(`Failed <script>alert("x")</script> & retry`);
    assert.match(
      panel.webview.html,
      /Failed &lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; retry/,
    );
    assert.match(panel.webview.html, />Show Log<\/a>/);

    panel.receiveMessage({ command: "showLog" });
    assert.strictEqual(showLogCalled, true);
  });
});

describe("findMappedEntities", () => {
  it("maps an exact selected node back to its result-scoped entity", () => {
    const entity = { id: "source_operator/1", kind: "source_operator" };
    const output = { results: [{ entities: [entity] }] };
    const mappings = {
      results: [
        {
          resultIndex: 0,
          mappings: [
            {
              entityId: entity.id,
              node: {
                collectionLabel: "source",
                graphId: "main",
                nodeId: "op/1",
              },
            },
          ],
        },
      ],
    };

    assert.deepStrictEqual(
      findMappedEntities(output, mappings, {
        collectionLabel: "source",
        graphId: "main",
        nodeId: "op/1",
      }),
      [{ entity, resultEntities: [entity], mappedCodeStackIds: new Set() }],
    );
  });
});
