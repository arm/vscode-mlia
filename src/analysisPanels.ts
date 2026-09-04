import type * as vscode from "vscode";

import { analysisPresentation } from "./analysisPresentation";
import { Analysis } from "./analysisStore";
import {
  type AttachModelExplorerWebviewOptions,
  attachModelExplorerWebview,
  MODEL_EXPLORER_VIEW_TYPE,
  type ModelExplorerFocusIntent,
  ModelExplorerNodeReference,
  ModelExplorerWebview,
  type ModelExplorerWebviewOptions,
  openModelExplorerWebview,
  parseModelExplorerWebviewState,
} from "./modelExplorerWebview";
import { EntityContext } from "./sourceNavigation";
import { buildOverlayCatalog } from "./overlayCatalog";
import {
  emptyModelExplorerOverlayCatalog,
  ModelExplorerOverlayIntent,
  modelExplorerIntentForSelection,
} from "./overlaySynchronization";
import type { SourceOverlayOpenOutcome } from "./sourceOverlayActions";

export interface AnalysisPanelManagerOptions {
  showLog: () => void;
  shouldSyncSelectionToCode: () => boolean;
  showSelectedEntities: (entities: EntityContext[], panel: vscode.WebviewPanel) => void;
  resolveAnalysis: (analysisId: string) => Promise<Analysis | undefined>;
  overlayUserIntentChanged: (analysisId: string, intent: ModelExplorerOverlayIntent) => void;
  log?: (message: string) => void;
  createWebview?: (options: ModelExplorerWebviewOptions) => ModelExplorerWebview;
  attachWebview?: (
    panel: vscode.WebviewPanel,
    options: AttachModelExplorerWebviewOptions,
  ) => ModelExplorerWebview;
}

type AnalysisPanelState = "idle" | "loading" | "loaded" | "error" | "disposed";

interface ManagedAnalysisPanel {
  webview: ModelExplorerWebview;
  state: AnalysisPanelState;
  generation: number;
  overlayIntent?: ModelExplorerOverlayIntent;
}

export type RegisterWebviewPanelSerializer = typeof vscode.window.registerWebviewPanelSerializer;

export function registerAnalysisPanelSerializer(
  register: RegisterWebviewPanelSerializer,
  manager: AnalysisPanelManager,
): vscode.Disposable {
  return register(MODEL_EXPLORER_VIEW_TYPE, {
    deserializeWebviewPanel: async (panel, rawState) => {
      const state = parseModelExplorerWebviewState(rawState);
      if (!state) {
        panel.dispose();
        return;
      }
      await manager.restore(panel, state.analysisId);
    },
  });
}

export class AnalysisPanelManager implements vscode.Disposable {
  private readonly panels = new Map<string, ManagedAnalysisPanel>();
  private disposed = false;

  public constructor(private readonly options: AnalysisPanelManagerOptions) {}

  public openRunning(analysis: Analysis, focus: ModelExplorerFocusIntent): void {
    if (this.disposed) {
      return;
    }
    const existing = this.panels.get(analysis.id);
    if (existing) {
      existing.webview.panel.reveal(undefined, focus === "preserve");
      return;
    }
    this.createPanel(analysis, focus);
  }

  public async open(analysis: Analysis, focus: ModelExplorerFocusIntent): Promise<void> {
    try {
      await this.openPanel(analysis, focus);
    } catch {
      // Current-generation failures are already rendered by openPanel. Lifecycle
      // and analysis-tree callers must not replace that UI with a second error.
    }
  }

  public async openForSelection(
    analysis: Analysis,
    node: ModelExplorerNodeReference,
    focus: ModelExplorerFocusIntent,
  ): Promise<SourceOverlayOpenOutcome | false> {
    return this.openPanel(analysis, focus, node);
  }

  public async restore(panel: vscode.WebviewPanel, analysisId: string): Promise<void> {
    if (this.disposed) {
      panel.dispose();
      return;
    }

    const retained = this.panels.get(analysisId);
    if (retained) {
      this.options.log?.(
        `Discarding duplicate restored analysis panel: id=${analysisId}, ` +
          `retainedViewColumn=${retained.webview.panel.viewColumn ?? "unknown"}`,
      );
      panel.dispose();
      return;
    }

    const attachWebview = this.options.attachWebview ?? attachModelExplorerWebview;
    const webview = attachWebview(
      panel,
      this.attachmentOptions(
        analysisId,
        "MLIA Model Explorer",
        "Restoring MLIA Model Explorer...",
        panel,
      ),
    );
    const managed = this.manage(analysisId, webview);
    this.options.log?.(`Restoring analysis panel: id=${analysisId}`);

    let analysis: Analysis | undefined;
    try {
      analysis = await this.options.resolveAnalysis(analysisId);
    } catch (error) {
      if (this.isCurrentIdle(analysisId, managed)) {
        this.setError(
          managed,
          `Unable to restore this Model Explorer tab.\n\n${errorMessage(error)}`,
        );
      }
      return;
    }

    if (!this.isCurrentIdle(analysisId, managed)) {
      return;
    }
    if (!analysis) {
      this.setError(
        managed,
        "This Model Explorer tab could not be restored because the stored analysis is no longer available. " +
          "Close this tab or reopen an available analysis run from Analysis Runs.",
      );
      return;
    }

    managed.webview.panel.title = analysisTitle(analysis);
    if (analysis.status === "failed") {
      this.showFailedAnalysis(analysis, managed);
      return;
    }
    if (analysis.status !== "complete" || !analysis.artifacts) {
      const detail = analysis.error ? `\n\n${analysis.error}` : "";
      this.setError(
        managed,
        `This Model Explorer tab could not be restored because the analysis is ${analysis.status}.${detail}`,
      );
      return;
    }

    try {
      await this.loadPanel(analysis, managed);
    } catch {
      // The current-generation failure is already rendered by loadPanel.
    }
  }

  public async selectNode(
    analysis: Analysis,
    node: ModelExplorerNodeReference,
  ): Promise<boolean> {
    const managed = this.panels.get(analysis.id);
    if (managed?.state !== "loaded") {
      this.options.log?.(`Model Explorer node selection skipped: no loaded panel for analysis ${analysis.id}`);
      return false;
    }
    this.options.log?.(
      `Selecting Model Explorer node in pane 0: collection=${node.collectionLabel}, ` +
        `graph=${node.graphId}, node=${node.nodeId}`,
    );
    return managed.webview.selectNode(node);
  }

  public viewColumn(analysis: Analysis): vscode.ViewColumn | undefined {
    return this.panels.get(analysis.id)?.webview.panel.viewColumn;
  }

  public updateOverlaySelection(analysis: Analysis): void {
    const managed = this.panels.get(analysis.id);
    if (!managed || managed.state === "disposed") {
      return;
    }
    managed.overlayIntent = overlayIntent(analysis, this.options.log);
    if (managed.state === "loaded") {
      this.projectOverlayIntent(analysis.id, managed);
    }
  }

  public showError(analysisId: string, message: string): void {
    const managed = this.panels.get(analysisId);
    if (!managed || managed.state === "disposed") {
      return;
    }
    this.setError(managed, message);
  }

  public close(analysisId: string): void {
    const managed = this.panels.get(analysisId);
    if (!managed) {
      return;
    }
    managed.generation += 1;
    managed.state = "disposed";
    this.panels.delete(analysisId);
    managed.webview.panel.dispose();
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const panels = [...this.panels.values()];
    this.panels.clear();
    for (const managed of panels) {
      managed.generation += 1;
      managed.state = "disposed";
      managed.webview.panel.dispose();
    }
  }

  private async openPanel(
    analysis: Analysis,
    focus: ModelExplorerFocusIntent,
    initialSelection?: ModelExplorerNodeReference,
  ): Promise<SourceOverlayOpenOutcome | false> {
    this.options.log?.(`Analysis panel open requested: id=${analysis.id}, status=${analysis.status}`);
    const canOpen = analysis.status === "failed" ||
      (analysis.status === "complete" && analysis.artifacts !== undefined);
    if (this.disposed || !canOpen) {
      this.options.log?.(
        `Analysis panel open skipped: id=${analysis.id}, disposed=${this.disposed}, ` +
          `status=${analysis.status}, artifacts=${analysis.artifacts !== undefined}`,
      );
      return false;
    }

    const existing = this.panels.has(analysis.id);
    const managed = this.panels.get(analysis.id) ?? this.createPanel(analysis, focus);
    managed.webview.panel.title = analysisTitle(analysis);
    this.options.log?.(
      `Revealing analysis panel: id=${analysis.id}, existing=${existing}, state=${managed.state}, ` +
        `viewColumn=${managed.webview.panel.viewColumn ?? "unknown"}`,
    );
    managed.webview.panel.reveal(
      managed.webview.panel.viewColumn,
      focus === "preserve",
    );
    if (analysis.status === "failed") {
      if (!existing || managed.state !== "error") {
        this.showFailedAnalysis(analysis, managed);
      }
      return "ready";
    }
    if (managed.state === "loaded") {
      return "ready";
    }
    return this.loadPanel(analysis, managed, initialSelection);
  }

  private async loadPanel(
    analysis: Analysis,
    managed: ManagedAnalysisPanel,
    initialSelection?: ModelExplorerNodeReference,
  ): Promise<SourceOverlayOpenOutcome | false> {
    if (!analysis.artifacts || !this.isCurrent(analysis.id, managed)) {
      return false;
    }

    const generation = managed.generation + 1;
    managed.generation = generation;
    managed.state = "loading";
    managed.overlayIntent ??= overlayIntent(analysis, this.options.log);
    try {
      const prepared = await managed.webview.prepareModelExplorer(
        analysis.artifacts.htmlPath,
        analysis.artifacts.standardizedOutputPath,
        analysis.artifacts.entityNodeMappingsPath,
        initialSelection,
      );
      if (!this.isCurrentLoad(analysis.id, managed, generation)) {
        this.options.log?.(
          `Ignoring stale analysis panel load: id=${analysis.id}, generation=${generation}`,
        );
        return false;
      }
      const initialOverlayIntent = managed.overlayIntent ?? overlayIntent(analysis, this.options.log);
      this.options.log?.(
        `Initializing Model Explorer overlay for analysis ${analysis.id}: ${describeOverlayIntent(initialOverlayIntent)}`,
      );
      managed.webview.showPreparedModelExplorer(prepared, initialOverlayIntent);
      managed.state = "loaded";
      this.options.log?.(
        `Analysis panel content loaded: id=${analysis.id}, generation=${generation}, ` +
          `initialSelection=${initialSelection !== undefined}`,
      );
      return initialSelection ? "selected" : "ready";
    } catch (error) {
      if (!this.isCurrentLoad(analysis.id, managed, generation)) {
        this.options.log?.(
          `Ignoring stale analysis panel load failure: id=${analysis.id}, generation=${generation}`,
        );
        return false;
      }
      const message = errorMessage(error);
      this.setError(
        managed,
        `Failed to load Model Explorer.\n\n${message}`,
        { incrementGeneration: false },
      );
      this.options.log?.(
        `Analysis panel load failed: id=${analysis.id}, generation=${generation}: ${message}`,
      );
      throw error;
    }
  }

  private projectOverlayIntent(
    analysisId: string,
    managed: ManagedAnalysisPanel,
  ): void {
    const intent = managed.overlayIntent ?? { kind: "none" };
    this.options.log?.(
      `Projecting VS Code overlay to Model Explorer for analysis ${analysisId}: ${describeOverlayIntent(intent)}`,
    );
    void Promise.resolve(managed.webview.setOverlayIntent(intent)).then(
      (delivered) => {
        if (!delivered) {
          this.options.log?.(
            `Model Explorer overlay projection was not delivered for analysis ${analysisId}.`,
          );
        }
      },
      (error) => {
        this.options.log?.(
          `Model Explorer overlay projection failed for analysis ${analysisId}: ${errorMessage(error)}`,
        );
      },
    );
  }

  private isCurrent(
    analysisId: string,
    managed: ManagedAnalysisPanel,
  ): boolean {
    return !this.disposed && this.panels.get(analysisId) === managed;
  }

  private isCurrentIdle(
    analysisId: string,
    managed: ManagedAnalysisPanel,
  ): boolean {
    return this.isCurrent(analysisId, managed) && managed.state === "idle";
  }

  private isCurrentLoad(
    analysisId: string,
    managed: ManagedAnalysisPanel,
    generation: number,
  ): boolean {
    return (
      this.isCurrent(analysisId, managed) &&
      managed.state === "loading" &&
      managed.generation === generation
    );
  }

  private showFailedAnalysis(analysis: Analysis, managed: ManagedAnalysisPanel): void {
    this.setError(managed, failedAnalysisMessage(analysis), { showLog: false });
  }

  private setError(
    managed: ManagedAnalysisPanel,
    message: string,
    options: { incrementGeneration?: boolean; showLog?: boolean } = {},
  ): void {
    if (options.incrementGeneration ?? true) {
      managed.generation += 1;
    }
    managed.state = "error";
    managed.webview.showError(message, { showLog: options.showLog ?? true });
  }

  private createPanel(
    analysis: Analysis,
    focus: ModelExplorerFocusIntent,
  ): ManagedAnalysisPanel {
    const createWebview = this.options.createWebview ?? openModelExplorerWebview;
    let webview!: ModelExplorerWebview;
    webview = createWebview({
      ...this.attachmentOptions(analysis.id, analysisTitle(analysis), undefined, () => webview.panel),
      focus,
    });
    return this.manage(analysis.id, webview, overlayIntent(analysis, this.options.log));
  }

  private attachmentOptions(
    analysisId: string,
    title: string,
    loadingMessage: string | undefined,
    panel: vscode.WebviewPanel | (() => vscode.WebviewPanel),
  ): AttachModelExplorerWebviewOptions {
    return {
      analysisId,
      title,
      loadingMessage,
      showLog: this.options.showLog,
      showSelectedNode: (selection) => {
        if (!this.options.shouldSyncSelectionToCode()) {
          this.options.log?.(
            `Model Explorer source synchronization skipped for analysis ${analysisId}: ` +
              "selection-to-code synchronization is disabled.",
          );
          return;
        }
        this.options.log?.(
          `Resolving Model Explorer node ${selection.collectionLabel}/${selection.graphId}/${selection.nodeId} ` +
            `for analysis ${analysisId}.`,
        );
        const activePanel = typeof panel === "function" ? panel() : panel;
        this.options.showSelectedEntities(selection.entities, activePanel);
      },
      overlayUserIntentChanged: (intent) => {
        this.options.log?.(
          `Received Model Explorer user overlay for analysis ${analysisId}: ${describeOverlayIntent(intent)}`,
        );
        this.options.overlayUserIntentChanged(analysisId, intent);
      },
      ...(this.options.log ? { log: this.options.log } : {}),
    };
  }

  private manage(
    analysisId: string,
    webview: ModelExplorerWebview,
    initialOverlayIntent?: ModelExplorerOverlayIntent,
  ): ManagedAnalysisPanel {
    const managed: ManagedAnalysisPanel = {
      webview,
      state: "idle",
      generation: 0,
      overlayIntent: initialOverlayIntent,
    };
    this.panels.set(analysisId, managed);
    webview.panel.onDidDispose(() => {
      if (this.panels.get(analysisId) !== managed) {
        return;
      }
      managed.generation += 1;
      managed.state = "disposed";
      this.panels.delete(analysisId);
    });
    return managed;
  }
}

function overlayIntent(
  analysis: Analysis,
  log?: (message: string) => void,
): ModelExplorerOverlayIntent {
  if (analysis.status !== "complete") {
    return { kind: "none" };
  }
  const vscodeCatalog = analysis.standardizedOutput === undefined
    ? []
    : buildOverlayCatalog(analysis.standardizedOutput);
  return modelExplorerIntentForSelection(
    analysis.overlaySelection,
    vscodeCatalog,
    analysis.modelExplorerOverlayCatalog ?? emptyModelExplorerOverlayCatalog(),
    (message) => log?.(
      `VS Code to Model Explorer overlay synchronization failed for analysis ${analysis.id}: ${message}`,
    ),
  );
}

function describeOverlayIntent(intent: ModelExplorerOverlayIntent): string {
  return intent.kind === "none"
    ? "None"
    : JSON.stringify(intent.effectiveName);
}

function analysisTitle(analysis: Analysis): string {
  return analysisPresentation(analysis).panelTitle;
}

function failedAnalysisMessage(analysis: Analysis): string {
  return analysis.error ?? "No error details were stored for this analysis.";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
