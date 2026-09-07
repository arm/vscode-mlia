import * as fs from "fs/promises";
import { createRequire } from "module";
import type * as vscode from "vscode";

import { ModelExplorerOverlayIntent } from "./overlaySynchronization";
import { EntityContext, mappedCodeStackEntityIds } from "./sourceNavigation";

export type CreateWebviewPanel = typeof vscode.window.createWebviewPanel;
export type ModelExplorerFocusIntent = "focus" | "preserve";

export const MODEL_EXPLORER_VIEW_TYPE = "mliaModelExplorer";
export const MODEL_EXPLORER_WEBVIEW_STATE_VERSION = 1;

export interface ModelExplorerWebviewState {
  version: 1;
  analysisId: string;
}

export function parseModelExplorerWebviewState(state: unknown): ModelExplorerWebviewState | undefined {
  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    return undefined;
  }
  const candidate = state as { version?: unknown; analysisId?: unknown };
  if (
    candidate.version !== MODEL_EXPLORER_WEBVIEW_STATE_VERSION ||
    typeof candidate.analysisId !== "string" ||
    candidate.analysisId.length === 0
  ) {
    return undefined;
  }
  return { version: MODEL_EXPLORER_WEBVIEW_STATE_VERSION, analysisId: candidate.analysisId };
}

export interface SelectedModelExplorerNode {
  collectionLabel: string;
  graphId: string;
  nodeId: string;
  entities: EntityContext[];
}

export interface ModelExplorerNodeReference {
  collectionLabel: string;
  graphId: string;
  nodeId: string;
}

export interface AttachModelExplorerWebviewOptions {
  analysisId: string;
  title: string;
  loadingMessage?: string;
  showLog: () => void;
  showSelectedNode?: (selection: SelectedModelExplorerNode) => void;
  standardizedOutputLoaded?: (standardizedOutput: unknown) => void;
  overlayUserIntentChanged?: (intent: ModelExplorerOverlayIntent) => void;
  log?: (message: string) => void;
}

export interface ModelExplorerWebviewOptions extends AttachModelExplorerWebviewOptions {
  focus: ModelExplorerFocusIntent;
  createWebviewPanel?: CreateWebviewPanel;
  viewColumn?: vscode.ViewColumn;
}

export interface PreparedModelExplorerPage {
  html: string;
  standardizedOutput: unknown;
  entityNodeMappings: unknown;
}

export interface ModelExplorerErrorOptions {
  showLog?: boolean;
}

export interface ModelExplorerWebview {
  panel: vscode.WebviewPanel;
  prepareModelExplorer: (
    htmlPath: string,
    standardizedOutputPath: string,
    entityNodeMappingsPath: string,
    initialSelection?: ModelExplorerNodeReference,
  ) => Promise<PreparedModelExplorerPage>;
  showPreparedModelExplorer: (
    prepared: PreparedModelExplorerPage,
    initialOverlayIntent?: ModelExplorerOverlayIntent,
  ) => void;
  showError: (message: string, options?: ModelExplorerErrorOptions) => void;
  selectNode: (node: ModelExplorerNodeReference) => PromiseLike<boolean>;
  setOverlayIntent: (intent: ModelExplorerOverlayIntent) => PromiseLike<boolean>;
}

export function openModelExplorerWebview(options: ModelExplorerWebviewOptions): ModelExplorerWebview {
  const createWebviewPanel = options.createWebviewPanel ?? loadVscode().window.createWebviewPanel;
  const viewColumn = options.viewColumn ?? loadVscode().ViewColumn.Beside;
  const panel = createWebviewPanel(
    MODEL_EXPLORER_VIEW_TYPE,
    options.title,
    { viewColumn, preserveFocus: options.focus === "preserve" },
    modelExplorerPanelOptions(),
  );
  return attachModelExplorerWebview(panel, options);
}

export function attachModelExplorerWebview(
  panel: vscode.WebviewPanel,
  options: AttachModelExplorerWebviewOptions,
): ModelExplorerWebview {
  const state: ModelExplorerWebviewState = {
    version: MODEL_EXPLORER_WEBVIEW_STATE_VERSION,
    analysisId: options.analysisId,
  };
  panel.title = options.title;
  panel.webview.options = modelExplorerWebviewOptions();

  let standardizedOutput: unknown = {};
  let entityNodeMappings: unknown = {};

  const messageSubscription = panel.webview.onDidReceiveMessage((message: unknown) => {
    if (isShowLogMessage(message)) {
      options.showLog();
    } else if (isOverlaySyncDiagnosticMessage(message)) {
      options.log?.(`Model Explorer overlay synchronization: ${message.message}`);
    } else if (isOverlayUserIntentChangedMessage(message)) {
      options.overlayUserIntentChanged?.(message.intent);
    } else if (isSourceSyncDiagnosticMessage(message)) {
      options.log?.(`Model Explorer source synchronization: ${message.message}`);
    } else if (messageCommand(message) === "overlayUserIntentChanged") {
      options.log?.("Model Explorer overlay synchronization: ignored a malformed user intent event.");
    } else if (isSelectedNodeMessage(message)) {
      const entities = findMappedEntities(standardizedOutput, entityNodeMappings, message);
      options.log?.(
        `Received Model Explorer node selection ${message.collectionLabel}/${message.graphId}/${message.nodeId}; ` +
          `${entities.length} mapped MLIA ${entities.length === 1 ? "entity" : "entities"}.`,
      );
      options.showSelectedNode?.({
        collectionLabel: message.collectionLabel,
        graphId: message.graphId,
        nodeId: message.nodeId,
        entities,
      });
    } else if (messageCommand(message) === "selectedNode") {
      options.log?.("Model Explorer source synchronization: ignored a malformed node selection event.");
    }
  });
  panel.onDidDispose(() => messageSubscription?.dispose());

  panel.webview.html = loadingHtml(
    state,
    options.loadingMessage ?? "Running MLIA performance check...",
  );

  return {
    panel,
    prepareModelExplorer: async (
      htmlPath,
      standardizedOutputPath,
      entityNodeMappingsPath,
      initialSelection,
    ) => {
      const [html, standardizedOutputText, entityNodeMappingsText] = await Promise.all([
        fs.readFile(htmlPath, "utf8"),
        fs.readFile(standardizedOutputPath, "utf8"),
        fs.readFile(entityNodeMappingsPath, "utf8"),
      ]);
      const preparedStandardizedOutput = JSON.parse(standardizedOutputText) as unknown;
      const preparedEntityNodeMappings = JSON.parse(entityNodeMappingsText) as unknown;
      return {
        html: initialSelection
          ? addInitialSelectionToGeneratedModelExplorerHtml(html, initialSelection)
          : html,
        standardizedOutput: preparedStandardizedOutput,
        entityNodeMappings: preparedEntityNodeMappings,
      };
    },
    showPreparedModelExplorer: (prepared, initialOverlayIntent = { kind: "none" }) => {
      standardizedOutput = prepared.standardizedOutput;
      entityNodeMappings = prepared.entityNodeMappings;
      options.standardizedOutputLoaded?.(standardizedOutput);
      panel.webview.html = addVsCodeIntegration(prepared.html, state, initialOverlayIntent);
    },
    showError: (message, errorOptions = {}) => {
      panel.webview.html = errorHtml(message, state, errorOptions.showLog ?? true);
    },
    selectNode: (node) =>
      panel.webview.postMessage({
        command: "selectNode",
        collectionLabel: node.collectionLabel,
        graphId: node.graphId,
        nodeId: node.nodeId,
      }),
    setOverlayIntent: (intent) =>
      panel.webview.postMessage({ command: "setOverlayIntent", intent }),
  };
}

function modelExplorerPanelOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
  return {
    enableScripts: true,
    retainContextWhenHidden: true,
  };
}

function modelExplorerWebviewOptions(): vscode.WebviewOptions {
  return { enableScripts: true };
}

export interface ModelExplorerVisualizer {
  selectNode: (
    nodeId: string,
    graphId: string,
    collectionLabel: string,
    paneIndex: number,
  ) => void;
}

export interface ModelExplorerPaneState {
  selectedGraphId?: unknown;
  selectedCollectionLabel?: unknown;
  selected?: unknown;
}

export function selectModelExplorerNode(
  visualizer: ModelExplorerVisualizer | null | undefined,
  node: ModelExplorerNodeReference,
  paneStates: readonly ModelExplorerPaneState[] = [],
): void {
  const matchingPaneIndexes = paneStates
    .map((pane, index) => ({ pane, index }))
    .filter(({ pane }) =>
      pane.selectedGraphId === node.graphId &&
      pane.selectedCollectionLabel === node.collectionLabel
    );
  const paneIndex =
    matchingPaneIndexes.find(({ pane }) => pane.selected === true)?.index ??
    matchingPaneIndexes[0]?.index ??
    paneStates.findIndex((pane) => pane.selected === true);
  visualizer?.selectNode(
    node.nodeId,
    node.graphId,
    node.collectionLabel,
    paneIndex >= 0 ? paneIndex : 0,
  );
}

function loadVscode(): typeof vscode {
  return createRequire(__filename)("vscode") as typeof vscode;
}

function messageCommand(message: unknown): unknown {
  return typeof message === "object" && message !== null
    ? (message as { command?: unknown }).command
    : undefined;
}

function isShowLogMessage(message: unknown): boolean {
  return messageCommand(message) === "showLog";
}

function isOverlaySyncDiagnosticMessage(message: unknown): message is {
  command: "overlaySyncDiagnostic";
  message: string;
} {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const candidate = message as { command?: unknown; message?: unknown };
  return candidate.command === "overlaySyncDiagnostic" &&
    typeof candidate.message === "string" && candidate.message.length > 0;
}

function isSourceSyncDiagnosticMessage(message: unknown): message is {
  command: "sourceSyncDiagnostic";
  message: string;
} {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const candidate = message as { command?: unknown; message?: unknown };
  return candidate.command === "sourceSyncDiagnostic" &&
    typeof candidate.message === "string" && candidate.message.length > 0;
}

function isOverlayUserIntentChangedMessage(message: unknown): message is {
  command: "overlayUserIntentChanged";
  intent: ModelExplorerOverlayIntent;
} {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const candidate = message as { command?: unknown; intent?: unknown };
  if (candidate.command !== "overlayUserIntentChanged") {
    return false;
  }
  const intent = candidate.intent;
  return typeof intent === "object" && intent !== null && (
    (intent as { kind?: unknown }).kind === "none" ||
    ((intent as { kind?: unknown; effectiveName?: unknown }).kind === "overlay" &&
      typeof (intent as { effectiveName?: unknown }).effectiveName === "string" &&
      (intent as { effectiveName: string }).effectiveName.length > 0)
  );
}

function isSelectedNodeMessage(message: unknown): message is {
  command: "selectedNode";
  collectionLabel: string;
  graphId: string;
  nodeId: string;
} {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const candidate = message as {
    command?: unknown;
    collectionLabel?: unknown;
    graphId?: unknown;
    nodeId?: unknown;
  };
  return (
    candidate.command === "selectedNode" &&
    typeof candidate.collectionLabel === "string" &&
    typeof candidate.graphId === "string" &&
    typeof candidate.nodeId === "string" &&
    candidate.nodeId.length > 0
  );
}

export function findMappedNodeForEntity(
  entityNodeMappings: unknown,
  resultIndex: number,
  entityId: string,
  preferredCollectionLabel = "code_stack",
): ModelExplorerNodeReference | undefined {
  if (typeof entityNodeMappings !== "object" || entityNodeMappings === null) {
    return undefined;
  }
  const mappingResults = (entityNodeMappings as { results?: unknown }).results;
  if (!Array.isArray(mappingResults)) {
    return undefined;
  }

  const candidates: ModelExplorerNodeReference[] = [];
  for (const rawResult of mappingResults) {
    if (typeof rawResult !== "object" || rawResult === null) {
      continue;
    }
    const result = rawResult as { resultIndex?: unknown; mappings?: unknown };
    if (result.resultIndex !== resultIndex || !Array.isArray(result.mappings)) {
      continue;
    }
    for (const rawMapping of result.mappings) {
      if (typeof rawMapping !== "object" || rawMapping === null) {
        continue;
      }
      const mapping = rawMapping as { entityId?: unknown; node?: unknown };
      if (mapping.entityId !== entityId || typeof mapping.node !== "object" || mapping.node === null) {
        continue;
      }
      const node = mapping.node as {
        collectionLabel?: unknown;
        graphId?: unknown;
        nodeId?: unknown;
      };
      if (
        typeof node.collectionLabel === "string" &&
        typeof node.graphId === "string" &&
        typeof node.nodeId === "string"
      ) {
        candidates.push({
          collectionLabel: node.collectionLabel,
          graphId: node.graphId,
          nodeId: node.nodeId,
        });
      }
    }
  }

  return (
    candidates.find(
      (candidate) => candidate.collectionLabel.toLowerCase() === preferredCollectionLabel.toLowerCase(),
    ) ?? candidates[0]
  );
}

export function findMappedEntities(
  standardizedOutput: unknown,
  entityNodeMappings: unknown,
  node: ModelExplorerNodeReference,
): EntityContext[] {
  if (
    typeof standardizedOutput !== "object" ||
    standardizedOutput === null ||
    typeof entityNodeMappings !== "object" ||
    entityNodeMappings === null
  ) {
    return [];
  }

  const outputResults = (standardizedOutput as { results?: unknown }).results;
  const mappingResults = (entityNodeMappings as { results?: unknown }).results;
  if (!Array.isArray(outputResults) || !Array.isArray(mappingResults)) {
    return [];
  }

  const entities: EntityContext[] = [];
  for (const resultMapping of mappingResults) {
    if (typeof resultMapping !== "object" || resultMapping === null) {
      continue;
    }
    const mappingResult = resultMapping as {
      resultIndex?: unknown;
      mappings?: unknown;
    };
    if (typeof mappingResult.resultIndex !== "number" || !Array.isArray(mappingResult.mappings)) {
      continue;
    }
    const outputResult = outputResults[mappingResult.resultIndex];
    if (typeof outputResult !== "object" || outputResult === null) {
      continue;
    }
    const resultEntities = (outputResult as { entities?: unknown }).entities;
    if (!Array.isArray(resultEntities)) {
      continue;
    }
    const entityById = new Map<string, unknown>();
    for (const entity of resultEntities) {
      if (typeof entity === "object" && entity !== null) {
        const entityId = (entity as { id?: unknown }).id;
        if (typeof entityId === "string") {
          entityById.set(entityId, entity);
        }
      }
    }

    const mappedCodeStackIds = mappedCodeStackEntityIds(resultEntities, mappingResult.mappings);

    for (const rawMapping of mappingResult.mappings) {
      if (typeof rawMapping !== "object" || rawMapping === null) {
        continue;
      }
      const mapping = rawMapping as { node?: unknown; entityId?: unknown };
      if (typeof mapping.node !== "object" || mapping.node === null) {
        continue;
      }
      const mappedNode = mapping.node as {
        collectionLabel?: unknown;
        graphId?: unknown;
        nodeId?: unknown;
      };
      if (
        mappedNode.collectionLabel === node.collectionLabel &&
        mappedNode.graphId === node.graphId &&
        mappedNode.nodeId === node.nodeId &&
        typeof mapping.entityId === "string"
      ) {
        const entity = entityById.get(mapping.entityId);
        if (
          entity !== undefined &&
          !entities.some(
            (context) => context.entity === entity && context.resultEntities === resultEntities,
          )
        ) {
          entities.push({ entity, resultEntities, mappedCodeStackIds });
        }
      }
    }
  }
  return entities;
}

// The generated host contract guarantees that data-backed visualizer inputs are
// installed before the custom element is connected. Embedders mutate only that
// documented data boundary instead of matching generated JavaScript statements.
const GENERATED_HOST_CONTRACT_VERSION = 1;

interface GeneratedHostData {
  hostContractVersion?: unknown;
  initialUiState?: unknown;
  [key: string]: unknown;
}

interface GeneratedHostDataDocument {
  data: GeneratedHostData;
  dataStart: number;
  dataEnd: number;
}

interface InitialPaneState {
  deepestExpandedGroupNodeIds: string[];
  selectedNodeId: string;
  selectedGraphId: string;
  selectedCollectionLabel: string;
  widthFraction: number;
  selected?: boolean;
  flattenLayers?: boolean;
  [key: string]: unknown;
}

export function addInitialSelectionToGeneratedModelExplorerHtml(
  html: string,
  selection: ModelExplorerNodeReference,
): string {
  const document = generatedHostDataDocument(html);
  document.data.initialUiState = mergeInitialSelection(
    document.data.initialUiState,
    selection,
  );
  return serializeGeneratedHostDataDocument(html, document);
}

export function addInitialOverlayIntentToGeneratedModelExplorerHtml(
  html: string,
  intent: ModelExplorerOverlayIntent,
): string {
  const document = generatedHostDataDocument(html);
  document.data.mliaVsCodeInitialOverlayIntent = intent;
  return serializeGeneratedHostDataDocument(html, document);
}

function generatedHostDataDocument(html: string): GeneratedHostDataDocument {
  const scriptPattern = /<script\b[^>]*\bid\s*=\s*(["'])mlia-model-explorer-data\1[^>]*>/giu;
  const scriptMatches = [...html.matchAll(scriptPattern)];
  if (scriptMatches.length !== 1 || scriptMatches[0].index === undefined) {
    throw new Error("Generated Model Explorer host data script was not found uniquely.");
  }

  const openTag = scriptMatches[0][0];
  const dataStart = scriptMatches[0].index + openTag.length;
  const dataEnd = html.toLowerCase().indexOf("</script>", dataStart);
  if (dataEnd < 0) {
    throw new Error("Generated Model Explorer host data script is not terminated.");
  }

  let data: GeneratedHostData;
  try {
    const parsed = JSON.parse(html.slice(dataStart, dataEnd)) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("host data is not an object");
    }
    data = parsed as GeneratedHostData;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Generated Model Explorer host data is invalid JSON: ${message}`);
  }

  if (data.hostContractVersion !== GENERATED_HOST_CONTRACT_VERSION) {
    throw new Error(
      `Generated Model Explorer host contract version ${String(data.hostContractVersion)} is not supported.`,
    );
  }
  return { data, dataStart, dataEnd };
}

function serializeGeneratedHostDataDocument(
  html: string,
  document: GeneratedHostDataDocument,
): string {
  const serialized = escapeScriptText(JSON.stringify(document.data));
  return `${html.slice(0, document.dataStart)}${serialized}${html.slice(document.dataEnd)}`;
}

function mergeInitialSelection(
  initialUiState: unknown,
  selection: ModelExplorerNodeReference,
): { paneStates: InitialPaneState[] } {
  const existingState =
    typeof initialUiState === "object" && initialUiState !== null
      ? initialUiState as { paneStates?: unknown }
      : undefined;
  const paneStates = Array.isArray(existingState?.paneStates)
    ? existingState.paneStates.map((pane) =>
        typeof pane === "object" && pane !== null && !Array.isArray(pane)
          ? { ...pane } as InitialPaneState
          : {} as InitialPaneState,
      )
    : [];
  const existingPane = paneStates[0] ?? {} as InitialPaneState;
  const widthFraction =
    typeof existingPane.widthFraction === "number" && Number.isFinite(existingPane.widthFraction)
      ? existingPane.widthFraction
      : paneStates.length > 1 ? 0.5 : 1;
  paneStates[0] = {
    ...existingPane,
    deepestExpandedGroupNodeIds: Array.isArray(existingPane.deepestExpandedGroupNodeIds)
      ? [...existingPane.deepestExpandedGroupNodeIds]
      : [],
    selectedNodeId: selection.nodeId,
    selectedGraphId: selection.graphId,
    selectedCollectionLabel: selection.collectionLabel,
    widthFraction,
    selected: true,
  };
  for (let index = 1; index < paneStates.length; index += 1) {
    paneStates[index] = { ...paneStates[index], selected: false };
  }
  return { paneStates };
}

function addVsCodeIntegration(
  html: string,
  state: ModelExplorerWebviewState,
  initialOverlayIntent: ModelExplorerOverlayIntent,
): string {
  const generatedHtml = addInitialOverlayIntentToGeneratedModelExplorerHtml(
    html,
    initialOverlayIntent,
  );
  const styledHtml = addModelExplorerWebviewStyles(generatedHtml);
  const integration = `<script>
    (() => {
      ${vscodeBridgeInitialization(state)}
      const selectModelExplorerNode = ${selectModelExplorerNode.toString()};
      const reportOverlaySyncFailure = (message) => {
        vscode.postMessage({ command: 'overlaySyncDiagnostic', message });
      };
      const visualizer = document.querySelector('model-explorer-visualizer');
      if (!visualizer) {
        reportOverlaySyncFailure('the model-explorer-visualizer element was not found');
      }
      const hostDataElement = document.getElementById('mlia-model-explorer-data');
      let hostData = {};
      if (!hostDataElement) {
        reportOverlaySyncFailure('the generated Model Explorer host data was not found');
      } else {
        try {
          hostData = JSON.parse(hostDataElement.textContent || '{}');
        } catch (error) {
          reportOverlaySyncFailure(
            'the generated Model Explorer host data could not be parsed: ' +
              String(error?.message || error),
          );
        }
      }
      let desiredOverlayIntent = hostData.mliaVsCodeInitialOverlayIntent;
      let latestPaneStates = Array.isArray(hostData.initialUiState?.paneStates)
        ? hostData.initialUiState.paneStates
        : [];
      let overlayApiDefined = false;
      const applyDesiredOverlayIntent = () => {
        if (!desiredOverlayIntent || !visualizer) {
          return;
        }
        if (typeof visualizer.setNodeDataOverlayIntent !== 'function') {
          if (overlayApiDefined) {
            reportOverlaySyncFailure(
              'the Model Explorer custom element does not expose setNodeDataOverlayIntent',
            );
          }
          return;
        }
        try {
          visualizer.setNodeDataOverlayIntent(desiredOverlayIntent);
        } catch (error) {
          reportOverlaySyncFailure(
            'setNodeDataOverlayIntent failed: ' + String(error?.message || error),
          );
        }
      };
      void customElements.whenDefined('model-explorer-visualizer').then(
        () => {
          overlayApiDefined = true;
          applyDesiredOverlayIntent();
        },
        (error) => reportOverlaySyncFailure(
          'the Model Explorer custom element failed to initialize: ' +
            String(error?.message || error),
        ),
      );
      window.addEventListener('message', (event) => {
        const message = event.data;
        if (
          message?.command === 'selectNode' &&
          typeof message.collectionLabel === 'string' &&
          typeof message.graphId === 'string' &&
          typeof message.nodeId === 'string'
        ) {
          selectModelExplorerNode(visualizer, message, latestPaneStates);
        } else if (message?.command === 'setOverlayIntent') {
          if (
            message.intent &&
            (message.intent.kind === 'none' ||
              (message.intent.kind === 'overlay' &&
                typeof message.intent.effectiveName === 'string' &&
                message.intent.effectiveName.length > 0))
          ) {
            desiredOverlayIntent = message.intent;
            applyDesiredOverlayIntent();
          } else {
            reportOverlaySyncFailure('ignored a malformed setOverlayIntent message');
          }
        }
      });
      visualizer?.addEventListener('uiStateChanged', (event) => {
        if (Array.isArray(event.detail?.paneStates)) {
          latestPaneStates = event.detail.paneStates;
        }
      });
      visualizer?.addEventListener('selectedNodeChanged', (event) => {
        if (event.detail?.selectionSource !== 'user') {
          return;
        }
        const collectionLabel = event.detail?.collectionLabel || event.detail?.node?.collectionLabel;
        const graphId = event.detail?.graphId || event.detail?.node?.graphId;
        const nodeId = event.detail?.nodeId;
        if (
          typeof collectionLabel !== 'string' ||
          typeof graphId !== 'string' ||
          typeof nodeId !== 'string' ||
          !nodeId
        ) {
          const identity = String(collectionLabel || '<missing>') + '/' +
            String(graphId || '<missing>') + '/' + String(nodeId || '<missing>');
          vscode.postMessage({
            command: 'sourceSyncDiagnostic',
            message: 'ignored malformed user selectedNodeChanged event for ' + identity,
          });
          return;
        }
        vscode.postMessage({
          command: 'selectedNode',
          collectionLabel,
          graphId,
          nodeId,
        });
      });
      visualizer?.addEventListener('nodeDataOverlayIntentChanged', (event) => {
        const intent = event.detail;
        if (
          intent &&
          (intent.kind === 'none' ||
            (intent.kind === 'overlay' &&
              typeof intent.effectiveName === 'string' &&
              intent.effectiveName.length > 0))
        ) {
          vscode.postMessage({ command: 'overlayUserIntentChanged', intent });
        } else {
          reportOverlaySyncFailure(
            'ignored a malformed nodeDataOverlayIntentChanged event',
          );
        }
      });
    })();
  </script>`;

  const bodyEnd = styledHtml.toLowerCase().lastIndexOf("</body>");
  return bodyEnd >= 0
    ? `${styledHtml.slice(0, bodyEnd)}${integration}${styledHtml.slice(bodyEnd)}`
    : `${styledHtml}${integration}`;
}

function addModelExplorerWebviewStyles(html: string): string {
  const styles = `<style id="vscode-mlia-model-explorer-styles">
    body { padding: 0; }
  </style>`;
  const headEnd = html.toLowerCase().lastIndexOf("</head>");
  return headEnd >= 0
    ? `${html.slice(0, headEnd)}${styles}${html.slice(headEnd)}`
    : `${styles}${html}`;
}

function escapeScriptText(value: string): string {
  return value.replace(/<\/script/giu, (match) => `<\\/${match.slice(2)}`);
}

function vscodeBridgeInitialization(state: ModelExplorerWebviewState): string {
  return `const vscode = acquireVsCodeApi();\n      vscode.setState(${escapeScriptText(JSON.stringify(state))});`;
}

function loadingHtml(state: ModelExplorerWebviewState, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      color-scheme: var(--vscode-color-scheme);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }

    body {
      min-height: 100vh;
      margin: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }

    main {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 24px;
    }

    .spinner {
      width: 18px;
      height: 18px;
      border: 2px solid var(--vscode-progressBar-background);
      border-right-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    p { margin: 0; }
    a { color: var(--vscode-textLink-foreground); text-decoration: none; }
    a:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <main role="status" aria-live="polite">
    <div class="spinner" aria-hidden="true"></div>
    <p>${escapeHtml(message)}</p>
    <a href="#" id="show-log">Show Log</a>
  </main>
  <script>
    ${vscodeBridgeInitialization(state)}
    document.getElementById("show-log")?.addEventListener("click", (event) => {
      event.preventDefault();
      vscode.postMessage({ command: "showLog" });
    });
  </script>
</body>
</html>`;
}

function errorHtml(
  message: string,
  state: ModelExplorerWebviewState,
  showLog: boolean,
): string {
  const showLogLink = showLog ? '<a href="#" id="show-log">Show Log</a>' : "";
  const showLogHandler = showLog
    ? `document.getElementById("show-log")?.addEventListener("click", (event) => {
      event.preventDefault();
      vscode.postMessage({ command: "showLog" });
    });`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      color-scheme: var(--vscode-color-scheme);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    body {
      min-height: 100vh;
      margin: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }

    main {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      max-width: min(720px, calc(100vw - 48px));
      padding: 24px;
      text-align: center;
    }

    h1 {
      margin: 0;
      color: var(--vscode-errorForeground, #f14c4c);
      font-size: 1.4rem;
    }

    p {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    a { color: var(--vscode-textLink-foreground); text-decoration: none; }
    a:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
  </style>
</head>
<body>
  <main role="alert" aria-live="assertive">
    <h1>Error</h1>
    <p>${escapeHtml(message)}</p>
    ${showLogLink}
  </main>
  <script>
    ${vscodeBridgeInitialization(state)}
    ${showLogHandler}
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return character;
    }
  });
}
