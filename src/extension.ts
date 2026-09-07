import * as vscode from "vscode";

import { AnalysisInputs } from "./analysisInputs";
import { Analysis, AnalysisStore } from "./analysisStore";
import {
  AnalysisPanelManager,
  registerAnalysisPanelSerializer,
} from "./analysisPanels";
import {
  cancelAnalysis,
  deleteAnalysis,
  startAnalysis,
} from "./analysisLifecycle";
import { checkPerformance } from "./checkPerformance";
import { CurrentAnalysisViewProvider } from "./currentAnalysisView";
import {
  classifyManagedEnvironment,
  inspectManagedPath,
} from "./environmentState";
import { NewAnalysisState, NewAnalysisViewProvider } from "./newAnalysisView";
import { buildOverlayCatalog } from "./overlayCatalog";
import {
  emptyModelExplorerOverlayCatalog,
  selectionForModelExplorerIntent,
} from "./overlaySynchronization";
import { findMappedNodeForEntity } from "./modelExplorerWebview";
import {
  getPythonRuntimeDir,
  MliaAnalysisMode,
  MliaAnalysisOptions,
  MliaTarget,
  refreshPythonRuntime,
  RunningCommand,
  startMliaCheckPerformance,
} from "./pythonRuntime";
import {
  activateAnalysis,
  activateAnalysisCommand,
} from "./analysisActivation";
import { AnalysesTreeProvider, AnalysisTreeItem } from "./sidebarViews";
import { SourceAnnotationIndex } from "./sourceAnnotations";
import {
  SourceCodeLensAction,
  sourceCodeLensCommand,
  SourceCodeLensProducer,
  sourceOverlayActionCommand,
} from "./sourceCodeLens";
import { SourceDecorationManager } from "./sourceDecorations";
import { SourceVisibilityController } from "./sourceVisibility";
import {
  executeSourceOverlayAction,
  SourceOverlayActionController,
} from "./sourceOverlayActions";
import {
  EntityContext,
  resolveCodeStackLocation,
  sourceRevealPlan,
  sourceViewColumn,
  TransientSourceLineBorder,
} from "./sourceNavigation";
import { SourceEntityReference } from "./sourceLines";
import { getManagedUvPath } from "./uvBootstrap";

const outputChannel = vscode.window.createOutputChannel("MLIA", { log: true });
const targetsCacheKey = "mlia.targets";
const obsoleteTargetProfileGroupsCacheKey = "mlia.targetProfileGroups";
const versionCacheKey = "mlia.version";
const analysisInputsStateKey = "mlia.analysisInputs";
const targetProfileSetting = "targetProfile";
const configFileContentsSetting = "configFileContents";
const extraCommandLineArgsSetting = "extraCommandLineArgs";
const syncModelExplorerSelectionToCodeSetting = "syncModelExplorerSelectionToCode";
const autoOpenModelExplorerSetting = "autoOpenModelExplorer";
const showCodeLensSetting = "showCodeLens";
const showHeatmapSetting = "showHeatmap";
const sourceNavigationBorderDurationMs = 1_500;
const openCurrentModelExplorerCommandId = "vscode-mlia.openCurrentModelExplorer";
const currentAnalysisCanOpenModelExplorerContext = "mlia.currentAnalysisCanOpenModelExplorer";
const environmentRefreshingContext = "mlia.environmentRefreshing";
const defaultAnalysisMode: MliaAnalysisMode = "estimation";
const defaultAnalysisOptions: MliaAnalysisOptions = {
  performance: true,
  compatibility: false,
};

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const analysisStore = new AnalysisStore({
    globalStoragePath: context.globalStorageUri.fsPath,
    log: logLine,
  });
  const analysisStoreReady = analysisStore.load();
  const runningCommands = new Map<string, RunningCommand>();
  const analysesProvider = new AnalysesTreeProvider(analysisStore);
  let currentAnalysisInputs = storedAnalysisInputs(context);
  let newAnalysisState: NewAnalysisState = { kind: "starting" };
  let environmentRefreshInProgress = false;
  void context.globalState.update(obsoleteTargetProfileGroupsCacheKey, undefined);
  void vscode.commands.executeCommand("setContext", environmentRefreshingContext, false);

  const sourceAnnotations = new SourceAnnotationIndex({
    uriForFile: (file) => vscode.Uri.file(file).toString(),
    isFileAccessible: async (file) => {
      try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(file));
        return (stat.type & vscode.FileType.Directory) === 0;
      } catch {
        return false;
      }
    },
  });
  const decorationManager = new SourceDecorationManager<
    vscode.TextEditor,
    vscode.TextEditorDecorationType
  >(
    {
      editorUri: (editor) => editor.document.uri.toString(),
      editorLineCount: (editor) => editor.document.lineCount,
      createDecoration: (rgba) => vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: rgba,
      }),
      setDecoratedLines: (editor, decoration, lines) =>
        editor.setDecorations(
          decoration,
          lines.map((line) => new vscode.Range(line, 0, line, 0)),
        ),
      disposeDecoration: (decoration) => decoration.dispose(),
    },
    sourceAnnotations,
  );
  sourceAnnotations.updateSourceFileMap(getSourceFileMap());
  decorationManager.updateVisibleEditors(vscode.window.visibleTextEditors);

  const sourceNavigationBorderDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    border: "2px solid",
    borderColor: new vscode.ThemeColor("focusBorder"),
  });
  const sourceNavigationBorder = new TransientSourceLineBorder<
    vscode.TextEditor,
    vscode.Range,
    NodeJS.Timeout
  >(
    {
      setBorder: (editor, ranges) => editor.setDecorations(sourceNavigationBorderDecoration, ranges),
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancel: (timer) => clearTimeout(timer),
      disposeBorder: () => sourceNavigationBorderDecoration.dispose(),
    },
    sourceNavigationBorderDurationMs,
  );

  const panelManager = new AnalysisPanelManager({
    showLog: () => outputChannel.show(true),
    shouldSyncSelectionToCode: () => isSettingEnabled(syncModelExplorerSelectionToCodeSetting),
    showSelectedEntities: (entities, panel) =>
      void openCodeStackLocation(entities, panel, sourceNavigationBorder, sourceAnnotations),
    resolveAnalysis: async (analysisId) => {
      await analysisStoreReady;
      return analysisStore.get(analysisId);
    },
    overlayUserIntentChanged: (analysisId, intent) => {
      const analysis = analysisStore.get(analysisId);
      if (!analysis) {
        logLine(
          `Model Explorer to VS Code overlay synchronization failed: analysis ${analysisId} is unavailable.`,
        );
        return;
      }
      if (analysis.status !== "complete" || analysis.standardizedOutput === undefined) {
        logLine(
          `Model Explorer to VS Code overlay synchronization failed for analysis ${analysisId}: ` +
            `analysis status is ${analysis.status} and standardized output is ` +
            `${analysis.standardizedOutput === undefined ? "unavailable" : "available"}.`,
        );
        return;
      }
      const selection = selectionForModelExplorerIntent(
        intent,
        buildOverlayCatalog(analysis.standardizedOutput),
        analysis.modelExplorerOverlayCatalog ?? emptyModelExplorerOverlayCatalog(),
        (message) => logLine(
          `Model Explorer to VS Code overlay synchronization failed for analysis ${analysisId}: ${message}`,
        ),
      );
      void analysisStore.setOverlaySelection(analysisId, selection).then(
        (updated) => {
          if (!updated) {
            logLine(
              `Model Explorer to VS Code overlay synchronization was not applied for analysis ${analysisId}.`,
            );
          }
        },
        (error) => logLine(
          `Model Explorer to VS Code overlay synchronization failed for analysis ${analysisId}: ${errorMessage(error)}`,
        ),
      );
    },
    log: logLine,
  });
  const modelExplorerSerializer = registerAnalysisPanelSerializer(
    (viewType, serializer) => vscode.window.registerWebviewPanelSerializer(viewType, serializer),
    panelManager,
  );
  context.subscriptions.push(modelExplorerSerializer);
  const currentAnalysisProvider = new CurrentAnalysisViewProvider({
    currentAnalysis: () => analysisStore.currentAnalysis,
    annotations: sourceAnnotations,
    setOverlaySelection: (analysis, selection) => {
      void analysisStore.setOverlaySelection(analysis.id, selection);
    },
    isCodeLensEnabled: () => isSettingEnabled(showCodeLensSetting),
    isHeatmapEnabled: () => isSettingEnabled(showHeatmapSetting),
    openSettings: () => {
      void vscode.commands.executeCommand("vscode-mlia.openSettings");
    },
    openSourceFileMap: () => {
      void vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "@id:vscode-mlia.sourceFileMap",
      );
    },
    openSourceLocation: (location) => {
      void openSourceLocation(
        location.localFile,
        location.line,
        undefined,
        sourceNavigationBorder,
      );
    },
  });
  const sourceOverlayActions = new SourceOverlayActionController<Analysis, PreparedSourceLocation>(
    sourceAnnotations,
    {
      currentAnalysis: () => analysisStore.currentAnalysis,
      openAnalysis: async (analysis, entity) => {
        if (analysisStore.currentAnalysis !== analysis) {
          return false;
        }
        const node = mappedNodeForEntity(analysis, entity);
        return node ? panelManager.openForSelection(analysis, node, "focus") : false;
      },
      canSelectEntity: (analysis, entity) =>
        mappedNodeForEntity(analysis, entity) !== undefined,
      selectEntity: (analysis, entity) => selectMappedEntity(panelManager, analysis, entity),
      prepareSource: (_analysis, record) =>
        prepareSourceLocation(record.localFile, record.line),
      revealSource: (analysis, _record, prepared) =>
        revealPreparedSourceLocation(prepared, panelManager.viewColumn(analysis)),
    },
  );

  const sourceCodeLenses = new SourceCodeLensProducer(
    () => isSettingEnabled(showCodeLensSetting),
  );
  const sourceVisibility = new SourceVisibilityController({
    refreshCodeLenses: () => sourceCodeLenses.refresh(),
    setHeatmapEnabled: (enabled) => decorationManager.setEnabled(enabled),
    isHeatmapEnabled: () => isSettingEnabled(showHeatmapSetting),
  });
  sourceVisibility.initialize();

  const codeLensesChanged = new vscode.EventEmitter<void>();
  const codeLensRefreshSubscription = sourceCodeLenses.onDidRefresh(() => codeLensesChanged.fire());
  const sourceAnnotationsChanged = sourceAnnotations.subscribe(() => sourceCodeLenses.refresh());
  const codeLensProvider = vscode.languages.registerCodeLensProvider(
    { scheme: "file" },
    {
      onDidChangeCodeLenses: codeLensesChanged.event,
      provideCodeLenses: (document) => {
        const descriptors = sourceCodeLenses.provide(
          sourceAnnotations.sourceLineRecordsForUri(document.uri.toString()),
          analysisStore.currentAnalysis?.id,
          document.lineCount,
        );
        if (descriptors.length > 0) {
          logLine(`Providing ${descriptors.length} MLIA CodeLens item(s) for ${document.uri.toString()}`);
        }
        return descriptors.map((descriptor) =>
          new vscode.CodeLens(
            new vscode.Range(descriptor.line, 0, descriptor.line, 0),
            sourceCodeLensCommand(descriptor),
          )
        );
      },
    },
  );
  const setNewAnalysisState = (state: NewAnalysisState) => {
    newAnalysisState = state;
    newAnalysisProvider.setState(state);
  };
  const newAnalysisProvider = new NewAnalysisViewProvider({
    refreshEnvironment: () => {
      void vscode.commands.executeCommand("vscode-mlia.refreshPythonVenv");
    },
    runAnalysis: (targetProfile, analysisMode, analysisOptions, analysisInputs) =>
      void vscode.commands.executeCommand("vscode-mlia.checkPerformance", {
        targetProfile,
        analysisMode,
        analysisOptions,
        analysisInputs,
      } satisfies RunAnalysisCommandOptions),
    showLog: () => outputChannel.show(true),
    selectTargetProfile: (targetProfile) => {
      void vscode.workspace
        .getConfiguration("vscode-mlia")
        .update(targetProfileSetting, targetProfile || undefined, vscode.ConfigurationTarget.Global);
    },
    selectAnalysisMode: (analysisMode) => {
      if (newAnalysisState.kind === "ready") {
        const selected = selectedTargetProfile(
          newAnalysisState.targets,
          analysisMode,
          newAnalysisState.selectedTargetProfile,
        );
        setNewAnalysisState({
          ...newAnalysisState,
          analysisMode,
          selectedTargetProfile: selected,
          analysisOptions: supportedAnalysisOptions(
            newAnalysisState.targets,
            selected,
            analysisMode,
            newAnalysisState.analysisOptions,
          ),
        });
        void vscode.workspace
          .getConfiguration("vscode-mlia")
          .update(targetProfileSetting, selected, vscode.ConfigurationTarget.Global);
      }
    },
    selectAnalysisOptions: (analysisOptions) => {
      if (newAnalysisState.kind === "ready") {
        setNewAnalysisState({
          ...newAnalysisState,
          analysisOptions: supportedAnalysisOptions(
            newAnalysisState.targets,
            newAnalysisState.selectedTargetProfile,
            newAnalysisState.analysisMode,
            analysisOptions,
          ),
        });
      }
    },
    selectAnalysisInputs: (analysisInputs) => {
      currentAnalysisInputs = analysisInputs;
      if (newAnalysisState.kind === "ready") {
        newAnalysisState = { ...newAnalysisState, analysisInputs };
      }
      void context.workspaceState.update(analysisInputsStateKey, analysisInputs);
    },
    pickModelPath,
    pickProfilingDataPath,
  });
  newAnalysisProvider.setState(newAnalysisState);
  void initializeEnvironmentState(
    context,
    setNewAnalysisState,
    currentAnalysisInputs,
  );

  const updateCurrentAnalysisContext = (): void => {
    const current = analysisStore.currentAnalysis;
    void vscode.commands.executeCommand(
      "setContext",
      currentAnalysisCanOpenModelExplorerContext,
      current?.status === "complete" && current.artifacts !== undefined,
    );
  };
  const storeSubscription = analysisStore.subscribe(() => {
    analysesProvider.refresh();
    currentAnalysisProvider.refresh();
    updateCurrentAnalysisContext();
    for (const analysis of analysisStore.analyses) {
      panelManager.updateOverlaySelection(analysis);
    }
  });
  const visibleEditorsChanged = vscode.window.onDidChangeVisibleTextEditors((editors) => {
    decorationManager.updateVisibleEditors(editors);
  });
  const configurationChanged = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("vscode-mlia.sourceFileMap")) {
      sourceAnnotations.updateSourceFileMap(getSourceFileMap());
    }
    if (
      event.affectsConfiguration("vscode-mlia.targetProfile") &&
      newAnalysisState.kind === "ready"
    ) {
      const selected = selectedTargetProfile(
        newAnalysisState.targets,
        newAnalysisState.analysisMode,
      );
      setNewAnalysisState({
        ...newAnalysisState,
        selectedTargetProfile: selected,
        analysisOptions: supportedAnalysisOptions(
          newAnalysisState.targets,
          selected,
          newAnalysisState.analysisMode,
          newAnalysisState.analysisOptions,
        ),
      });
    }
    if (
      event.affectsConfiguration(`vscode-mlia.${showCodeLensSetting}`) ||
      event.affectsConfiguration(`vscode-mlia.${showHeatmapSetting}`)
    ) {
      currentAnalysisProvider.refresh();
    }
    sourceVisibility.configurationChanged(event);
  });

  const runEnvironmentRefresh = async (
    commandName: "refreshPythonVenv" | "forceRefreshPythonVenv",
    forceRecreateVenv = false,
  ): Promise<void> => {
    if (environmentRefreshInProgress) {
      return;
    }

    environmentRefreshInProgress = true;
    try {
      await vscode.commands.executeCommand("setContext", environmentRefreshingContext, true);
      await runLoggedCommand(
        commandName,
        () =>
          refreshPythonVenvCommand(
            context,
            setNewAnalysisState,
            currentAnalysisInputs,
            forceRecreateVenv,
          ),
      );
    } finally {
      environmentRefreshInProgress = false;
      await vscode.commands.executeCommand("setContext", environmentRefreshingContext, false);
    }
  };
  const refreshPythonVenv = vscode.commands.registerCommand(
    "vscode-mlia.refreshPythonVenv",
    () => runEnvironmentRefresh("refreshPythonVenv"),
  );
  const forceRefreshPythonVenv = vscode.commands.registerCommand(
    "vscode-mlia.forceRefreshPythonVenv",
    () => runEnvironmentRefresh("forceRefreshPythonVenv", true),
  );
  const showMliaInfoCommand = vscode.commands.registerCommand(
    "vscode-mlia.showMliaInfo",
    () => {
      const detail = newAnalysisState.kind === "ready"
        ? `Version: ${newAnalysisState.version}`
        : "Version information is unavailable. Refresh the MLIA environment to query it.";
      return vscode.window.showInformationMessage("MLIA information", { modal: true, detail });
    },
  );
  const openSettingsCommand = vscode.commands.registerCommand(
    "vscode-mlia.openSettings",
    () => vscode.commands.executeCommand("workbench.action.openSettings", "@ext:arm.vscode-mlia"),
  );
  const openCurrentModelExplorerCommand = vscode.commands.registerCommand(
    openCurrentModelExplorerCommandId,
    () => {
      const current = analysisStore.currentAnalysis;
      if (current?.status === "complete" && current.artifacts !== undefined) {
        void panelManager.open(current, "focus");
      }
    },
  );
  const checkPerformanceCommand = vscode.commands.registerCommand(
    "vscode-mlia.checkPerformance",
    (options?: RunAnalysisCommandOptions) =>
      runLoggedCommand("checkPerformance", () =>
        checkPerformanceCommandHandler(
          context,
          analysisStore,
          panelManager,
          runningCommands,
          currentAnalysisInputs,
          options,
        ),
      ),
  );
  const activateAnalysisRunCommand = vscode.commands.registerCommand(
    activateAnalysisCommand,
    (analysisId?: string) => activateAnalysis(analysisStore, panelManager, analysisId),
  );
  const executeSourceOverlayActionCommand = vscode.commands.registerCommand(
    sourceOverlayActionCommand,
    (action?: SourceCodeLensAction) => executeSourceOverlayAction(sourceOverlayActions, action),
  );
  const cancelAnalysisCommand = vscode.commands.registerCommand(
    "vscode-mlia.cancelAnalysis",
    async (item: AnalysisTreeItem) => {
      if (!item?.analysis) {
        return;
      }
      if (await cancelAnalysis(analysisStore, runningCommands, item.analysis.id)) {
        panelManager.showError(item.analysis.id, "Analysis cancelled.");
      } else {
        void vscode.window.showWarningMessage("This analysis is not controllable by the current extension host.");
      }
    },
  );
  const deleteAnalysisCommand = vscode.commands.registerCommand(
    "vscode-mlia.deleteAnalysis",
    async (item: AnalysisTreeItem) => {
      if (!item?.analysis) {
        return;
      }
      const outcome = await deleteAnalysis(analysisStore, panelManager, item.analysis.id);
      if (outcome.status === "removeFailed") {
        void vscode.window.showErrorMessage(
          `${outcome.reason} The analysis run remains available and can be reopened.`,
        );
      } else if (outcome.status === "notDeleted") {
        void vscode.window.showWarningMessage(outcome.reason);
      }
    },
  );
  const openAnalysisFolderCommand = vscode.commands.registerCommand(
    "vscode-mlia.openAnalysisFolder",
    async (item: AnalysisTreeItem) => {
      if (!item?.analysis) {
        return;
      }
      // openExternal opens the directory itself; revealFileInOS would select it
      // in its parent directory instead.
      await vscode.env.openExternal(vscode.Uri.file(item.analysis.analysisDir));
    },
  );
  const openAnalysesFolderCommand = vscode.commands.registerCommand(
    "vscode-mlia.openAnalysesFolder",
    async () => {
      const analysesRoot = await analysisStore.ensureAnalysesRoot();
      await vscode.env.openExternal(vscode.Uri.file(analysesRoot));
    },
  );
  const clearAllAnalysesCommand = vscode.commands.registerCommand(
    "vscode-mlia.clearAllAnalyses",
    () => clearAllAnalyses(analysisStore, panelManager),
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "mlia.newAnalysis",
      newAnalysisProvider,
    ),
    vscode.window.registerWebviewViewProvider("mlia.currentAnalysis", currentAnalysisProvider),
    vscode.window.registerTreeDataProvider("mlia.analyses", analysesProvider),
    refreshPythonVenv,
    forceRefreshPythonVenv,
    showMliaInfoCommand,
    openSettingsCommand,
    openCurrentModelExplorerCommand,
    checkPerformanceCommand,
    activateAnalysisRunCommand,
    executeSourceOverlayActionCommand,
    cancelAnalysisCommand,
    deleteAnalysisCommand,
    openAnalysisFolderCommand,
    openAnalysesFolderCommand,
    clearAllAnalysesCommand,
    visibleEditorsChanged,
    configurationChanged,
    storeSubscription,
    codeLensProvider,
    codeLensesChanged,
    codeLensRefreshSubscription,
    sourceAnnotationsChanged,
    sourceCodeLenses,
    currentAnalysisProvider,
    panelManager,
    sourceNavigationBorder,
    { dispose: () => decorationManager.dispose() },
    { dispose: () => sourceAnnotations.dispose() },
    outputChannel,
  );

  await analysisStoreReady;
  updateCurrentAnalysisContext();
}

export function deactivate(): void {}

async function clearAllAnalyses(
  analysisStore: AnalysisStore,
  panelManager: AnalysisPanelManager,
): Promise<void> {
  const confirmation = await vscode.window.showWarningMessage(
    "Delete all stored MLIA analysis runs? Running analyses owned by a live extension host will be kept.",
    { modal: true },
    "Clear All Analysis Runs",
  );
  if (confirmation !== "Clear All Analysis Runs") {
    return;
  }

  const outcome = await analysisStore.clearAll((analysis) => panelManager.close(analysis.id));
  if (outcome.skipped.length > 0) {
    const activeCount = outcome.skipped.filter(({ reason }) => reason.includes("live process")).length;
    const otherSkippedCount = outcome.skipped.length - activeCount;
    const details = [
      activeCount > 0
        ? `${activeCount} active analysis run${activeCount === 1 ? " was" : "s were"} kept.`
        : undefined,
      otherSkippedCount > 0
        ? `${otherSkippedCount} ${otherSkippedCount === 1 ? "analysis run directory was" : "analysis run directories were"} skipped.`
        : undefined,
    ].filter((detail): detail is string => detail !== undefined).join(" ");
    void vscode.window.showWarningMessage(
      `Deleted ${outcome.deletedIds.length} stored MLIA analysis run${outcome.deletedIds.length === 1 ? "" : "s"}. ${details}`,
    );
    return;
  }

  void vscode.window.showInformationMessage(
    `Deleted ${outcome.deletedIds.length} stored MLIA analysis run${outcome.deletedIds.length === 1 ? "" : "s"}.`,
  );
}

async function refreshPythonVenvCommand(
  context: vscode.ExtensionContext,
  setState: (state: NewAnalysisState) => void,
  analysisInputs: AnalysisInputs,
  forceRecreateVenv = false,
): Promise<void> {
  setState({ kind: "refreshing" });
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Refreshing MLIA Python venv",
      cancellable: false,
    },
    async (progress) =>
      refreshPythonRuntime({
        extensionPath: context.extensionPath,
        globalStoragePath: context.globalStorageUri.fsPath,
        forceRecreateVenv,
        log: logLine,
        progress: (message) => {
          progress.report({ message });
          setState({ kind: "refreshing", message });
        },
      }),
  );

  if (!result.ok) {
    setState({ kind: "failed", message: "MLIA environment refresh failed." });
    logLine(`ERROR: ${result.message}`);
    return;
  }

  setState({
    kind: "ready",
    version: result.version,
    targets: result.targets,
    selectedTargetProfile: selectedTargetProfile(result.targets, defaultAnalysisMode),
    analysisMode: defaultAnalysisMode,
    analysisOptions: defaultAnalysisOptions,
    analysisInputs,
  });
  await Promise.all([
    context.globalState.update(targetsCacheKey, result.targets),
    context.globalState.update(versionCacheKey, result.version),
  ]);
  const targetProfiles = result.targets.flatMap(({ profiles }) => profiles);
  logLine(`Cached ${targetProfiles.length} MLIA target profile(s): ${targetProfiles.join(", ")}`);

  if (result.status === "noTargetProfiles") {
    void vscode.window.showWarningMessage(
      `MLIA Python venv refreshed (${result.version}), but no MLIA target profiles were found.`,
    );
  }
}

async function initializeEnvironmentState(
  context: vscode.ExtensionContext,
  setState: (state: NewAnalysisState) => void,
  analysisInputs: AnalysisInputs,
): Promise<void> {
  const cachedVersion = context.globalState.get<string>(versionCacheKey);
  const cachedTargets = context.globalState.get<MliaTarget[]>(targetsCacheKey, []);
  const venvPath = vscode.Uri.file(`${getPythonRuntimeDir(context.globalStorageUri.fsPath)}/.venv`);
  const uvPath = vscode.Uri.file(getManagedUvPath(context.globalStorageUri.fsPath));
  const [venvInspection, uvInspection] = await Promise.all([
    inspectManagedPath(() => vscode.workspace.fs.stat(venvPath)),
    inspectManagedPath(() => vscode.workspace.fs.stat(uvPath)),
  ]);
  const environmentInspection = classifyManagedEnvironment(venvInspection, uvInspection);

  if (environmentInspection === "inspectionFailed") {
    for (const [label, inspection] of [
      ["managed Python environment", venvInspection],
      ["managed uv executable", uvInspection],
    ] as const) {
      if (inspection.kind === "error") {
        logLine(`ERROR: Unable to inspect ${label}: ${errorMessage(inspection.error)}`);
      }
    }
    setState({ kind: "failed", message: "The MLIA environment could not be inspected." });
    return;
  }
  if (environmentInspection === "setupRequired") {
    setState({ kind: "setupRequired" });
    return;
  }
  if (environmentInspection === "incomplete") {
    setState({ kind: "incomplete" });
    return;
  }

  setState(
    cachedVersion && cachedTargets.length > 0
      ? {
          kind: "ready",
          version: cachedVersion,
          targets: cachedTargets,
          selectedTargetProfile: selectedTargetProfile(cachedTargets, defaultAnalysisMode),
          analysisMode: defaultAnalysisMode,
          analysisOptions: defaultAnalysisOptions,
          analysisInputs,
        }
      : { kind: "available" },
  );
}

interface RunAnalysisCommandOptions {
  targetProfile?: string;
  analysisMode?: MliaAnalysisMode;
  analysisOptions?: MliaAnalysisOptions;
  analysisInputs?: AnalysisInputs;
}

async function checkPerformanceCommandHandler(
  context: vscode.ExtensionContext,
  analysisStore: AnalysisStore,
  panelManager: AnalysisPanelManager,
  runningCommands: Map<string, RunningCommand>,
  defaultAnalysisInputs: AnalysisInputs,
  options?: RunAnalysisCommandOptions,
): Promise<void> {
  await checkPerformance({
    targetProfile: options?.targetProfile ?? getTargetProfile(),
    analysisOptions: options?.analysisOptions ?? defaultAnalysisOptions,
    analysisInputs: options?.analysisInputs ?? defaultAnalysisInputs,
    showMissingTargetProfile: async () => {
      await vscode.window.showWarningMessage(
        "Select a target profile in the New Analysis view before running an analysis.",
      );
    },
    runMliaCheckPerformance: async (analysisInputs, selectedTargetProfile, analysisOptions) => {
      const result = await startAnalysis({
        store: analysisStore,
        panels: panelManager,
        runningCommands,
        modelPath: analysisInputs.modelPath,
        profilingDataPaths: analysisInputs.profilingDataPaths,
        targetProfile: selectedTargetProfile,
        analysisMode: options?.analysisMode ?? (
          analysisInputs.profilingDataPaths.length > 0 ? "profiling" : "estimation"
        ),
        analysisOptions,
        autoOpen: isSettingEnabled(autoOpenModelExplorerSetting),
        start: (analysis) => {
          const started = startMliaCheckPerformance({
            extensionPath: context.extensionPath,
            globalStoragePath: context.globalStorageUri.fsPath,
            modelPath: analysisInputs.modelPath,
            profilingDataPaths: analysisInputs.profilingDataPaths,
            targetProfile: selectedTargetProfile,
            analysisOptions,
            configContent: getConfigFileContents(),
            extraArgs: getExtraCommandLineArgs(),
            outputDir: analysis.analysisDir,
            log: logLine,
          });
          return {
            runtimeDir: started.runtimeDir,
            command: started.command,
            completion: started.completion.then((htmlPath) => ({
              htmlPath,
              standardizedOutputPath: started.standardizedOutputPath,
              entityNodeMappingsPath: started.entityNodeMappingsPath,
            })),
          };
        },
        synchronousFailureMessage: (message) => message,
        asynchronousFailureMessage: (message) => message,
        log: logLine,
      });

      if (!result.ok) {
        return {
          ok: false,
          kind: "unknown",
          runtimeDir: getPythonRuntimeDir(context.globalStorageUri.fsPath),
          stage: "checkPerformance",
          message: result.message,
        };
      }

      showMliaCheckPerformanceProgress(result.started.completion, selectedTargetProfile, analysisOptions);
      void result.settled;
      return { ok: true, runtimeDir: result.started.runtimeDir };
    },
    showErrorMessage: vscode.window.showErrorMessage.bind(vscode.window),
    showLog: () => outputChannel.show(true),
    log: logLine,
  });
}

interface SourceLineBorder {
  show: (editor: vscode.TextEditor, range: vscode.Range) => void;
}

async function openCodeStackLocation(
  entities: EntityContext[],
  modelExplorerPanel: vscode.WebviewPanel,
  sourceLineBorder: SourceLineBorder,
  sourceAnnotations: SourceAnnotationIndex,
): Promise<void> {
  const location = resolveCodeStackLocation(entities, ({ reason }) => {
    logLine(`Model Explorer source synchronization skipped: ${reason}.`);
  });
  if (!location) {
    return;
  }
  const mappedLocation = sourceAnnotations.mappedSourceLocation(location.file, location.line);
  await openSourceLocation(
    mappedLocation.localFile,
    mappedLocation.line,
    modelExplorerPanel.viewColumn,
    sourceLineBorder,
  );
}

interface PreparedSourceLocation {
  document: vscode.TextDocument;
  localPath: string;
  line: number;
}

async function prepareSourceLocation(
  localPath: string,
  line: number,
): Promise<PreparedSourceLocation | undefined> {
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(localPath));
    if (line < 1 || line > document.lineCount) {
      logLine(`Source location is outside the document: ${localPath}:${line}`);
      return undefined;
    }
    return { document, localPath, line };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logLine(`Failed to prepare source location ${localPath}:${line}: ${message}`);
    return undefined;
  }
}

async function openSourceLocation(
  localPath: string,
  line: number,
  modelExplorerViewColumn: vscode.ViewColumn | undefined,
  sourceLineBorder?: SourceLineBorder,
): Promise<boolean> {
  const prepared = await prepareSourceLocation(localPath, line);
  if (!prepared) {
    void vscode.window.showErrorMessage(`Failed to open source location ${localPath}:${line}.`);
    return false;
  }
  return revealPreparedSourceLocation(prepared, modelExplorerViewColumn, sourceLineBorder);
}

async function revealPreparedSourceLocation(
  prepared: PreparedSourceLocation,
  modelExplorerViewColumn: vscode.ViewColumn | undefined,
  sourceLineBorder?: SourceLineBorder,
): Promise<boolean> {
  const { document, localPath, line } = prepared;
  if (line < 1 || line > document.lineCount) {
    logLine(`Source location became invalid before reveal: ${localPath}:${line}`);
    return false;
  }
  const sourceUri = document.uri;
  const openTextTabs = vscode.window.tabGroups.all.flatMap((group) =>
    group.tabs.flatMap((tab) =>
      tab.input instanceof vscode.TabInputText
        ? [{ uri: tab.input.uri.toString(), viewColumn: group.viewColumn }]
        : [],
    ),
  );
  const targetViewColumn =
    sourceViewColumn(
      sourceUri.toString(),
      openTextTabs,
      vscode.window.tabGroups.all.map((group) => group.viewColumn),
      modelExplorerViewColumn,
    ) ?? vscode.ViewColumn.Beside;

  try {
    const lineIndex = line - 1;
    const plan = sourceRevealPlan(targetViewColumn, lineIndex, document.lineAt(lineIndex).text.length);
    const editor = await vscode.window.showTextDocument(document, plan.showOptions);
    const selectionStart = new vscode.Position(plan.selection.line, plan.selection.startCharacter);
    const selectionEnd = new vscode.Position(plan.selection.line, plan.selection.endCharacter);
    const selection = new vscode.Selection(selectionStart, selectionEnd);
    editor.selection = selection;
    editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    sourceLineBorder?.show(editor, selection);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logLine(`Failed to reveal source location ${localPath}:${line}: ${message}`);
    void vscode.window.showErrorMessage(`Failed to open source location ${localPath}:${line}.`);
    return false;
  }
}

function mappedNodeForEntity(analysis: Analysis, entity: SourceEntityReference) {
  return findMappedNodeForEntity(
    analysis.entityNodeMappings,
    entity.resultIndex,
    entity.entityId,
  );
}

async function selectMappedEntity(
  panelManager: AnalysisPanelManager,
  analysis: Analysis,
  entity: SourceEntityReference,
): Promise<boolean> {
  const node = mappedNodeForEntity(analysis, entity);
  return node ? panelManager.selectNode(analysis, node) : false;
}

function getSourceFileMap(): Record<string, string> {
  return vscode.workspace
    .getConfiguration("vscode-mlia")
    .get<Record<string, string>>("sourceFileMap", {});
}

function isSettingEnabled(setting: string): boolean {
  return vscode.workspace
    .getConfiguration("vscode-mlia")
    .get<boolean>(setting, true);
}

function showMliaCheckPerformanceProgress(
  completion: Promise<unknown>,
  targetProfile: string,
  analysisOptions: MliaAnalysisOptions,
): void {
  const analysisTypes = [
    analysisOptions.performance ? "performance" : undefined,
    analysisOptions.compatibility ? "compatibility" : undefined,
  ].filter((value): value is string => value !== undefined).join(" and ");
  void vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: `Running MLIA ${analysisTypes} analysis for ${targetProfile}`,
      cancellable: false,
    },
    async () => completion,
  );
}

function getTargetProfile(): string | undefined {
  return vscode.workspace
    .getConfiguration("vscode-mlia")
    .get<string>(targetProfileSetting) || undefined;
}

function getConfigFileContents(): string {
  return vscode.workspace
    .getConfiguration("vscode-mlia")
    .get<string>(configFileContentsSetting, "");
}

function getExtraCommandLineArgs(): string[] {
  return vscode.workspace
    .getConfiguration("vscode-mlia")
    .get<string[]>(extraCommandLineArgsSetting, []);
}

function selectedTargetProfile(
  targets: MliaTarget[],
  mode: MliaAnalysisMode,
  preferred?: string,
): string | undefined {
  const candidate = preferred ?? getTargetProfile();
  if (!candidate) {
    return undefined;
  }
  const target = targets.find(({ profiles }) => profiles.includes(candidate));
  return target?.backends.some((backend) => backend.capabilities[mode].length > 0)
    ? candidate
    : undefined;
}

function supportedAnalysisOptions(
  targets: MliaTarget[],
  targetProfile: string | undefined,
  mode: MliaAnalysisMode,
  requested: MliaAnalysisOptions,
): MliaAnalysisOptions {
  const target = targets.find(({ profiles }) =>
    targetProfile !== undefined && profiles.includes(targetProfile),
  );
  const categories = new Set(
    target?.backends.flatMap((backend) => backend.capabilities[mode]) ?? [],
  );
  const options = {
    performance: requested.performance && categories.has("performance"),
    compatibility: requested.compatibility && categories.has("compatibility"),
  };
  if (!options.performance && !options.compatibility && categories.has("performance")) {
    options.performance = true;
  }
  return options;
}

function storedAnalysisInputs(context: vscode.ExtensionContext): AnalysisInputs {
  const stored = context.workspaceState.get<Partial<AnalysisInputs>>(analysisInputsStateKey, {});
  return {
    modelPath: typeof stored.modelPath === "string" && stored.modelPath ? stored.modelPath : undefined,
    profilingDataPaths: Array.isArray(stored.profilingDataPaths)
      ? stored.profilingDataPaths.filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        )
      : [],
  };
}

async function pickModelPath(): Promise<string | undefined> {
  const selection = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    title: "Select a source model",
    openLabel: "Select",
    filters: {
      "Model files": ["tflite", "tosa", "vgf", "onnx", "pt2"],
      "All files": ["*"],
    },
  });
  return selection?.[0]?.fsPath;
}

async function pickProfilingDataPath(): Promise<string | undefined> {
  const selection = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: true,
    canSelectMany: false,
    title: "Select profiling data",
    openLabel: "Select",
  });
  return selection?.[0]?.fsPath;
}

async function runLoggedCommand(commandName: string, command: () => Promise<void>): Promise<void> {
  logLine(`Started ${commandName}`);
  try {
    await command();
    logLine(`Finished ${commandName}`);
  } catch (error) {
    logLine(`Failed ${commandName}`);
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logLine(message: string): void {
  outputChannel.appendLine(message);
}
