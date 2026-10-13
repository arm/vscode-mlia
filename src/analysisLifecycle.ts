import {
  Analysis,
  AnalysisArtifacts,
  AnalysisStore,
  DeleteAnalysisOutcome,
} from "./analysisStore";
import type { ModelExplorerFocusIntent } from "./modelExplorerWebview";
import type { MliaAnalysisMode, MliaAnalysisOptions } from "./pythonRuntime";

export interface StoppableAnalysis {
  stop: () => void;
}

export interface AnalysisPanelController {
  openRunning: (analysis: Analysis, focus: ModelExplorerFocusIntent) => void;
  open: (analysis: Analysis, focus: ModelExplorerFocusIntent) => Promise<void>;
  update: (analysis: Analysis) => Promise<void>;
  showError: (analysisId: string, message: string) => void;
  close: (analysisId: string) => void;
}

export interface StartedAnalysis {
  command: StoppableAnalysis;
  completion: Promise<AnalysisArtifacts>;
}

export interface StartAnalysisOptions<Started extends StartedAnalysis> {
  store: AnalysisStore;
  panels: AnalysisPanelController;
  runningCommands: Map<string, Started["command"]>;
  modelPath?: string;
  profilingDataPaths: string[];
  targetProfile: string;
  analysisMode: MliaAnalysisMode;
  analysisOptions: MliaAnalysisOptions;
  autoOpen: boolean;
  start: (analysis: Analysis) => Started;
  synchronousFailureMessage: (message: string) => string;
  asynchronousFailureMessage: (message: string) => string;
  log?: (message: string) => void;
}

export type StartAnalysisOutcome<Started extends StartedAnalysis> =
  | { ok: true; analysis: Analysis; started: Started; settled: Promise<boolean> }
  | { ok: false; analysis: Analysis; message: string };

export function beginAnalysis(
  panels: AnalysisPanelController,
  analysis: Analysis,
  autoOpen: boolean,
): void {
  if (autoOpen) {
    panels.openRunning(analysis, "focus");
  }
}

export async function completeAnalysis(
  store: AnalysisStore,
  panels: AnalysisPanelController,
  analysisId: string,
  artifacts: AnalysisArtifacts,
  autoOpen: boolean,
): Promise<boolean> {
  const completed = await store.complete(analysisId, artifacts);
  if (!completed) {
    return false;
  }
  if (autoOpen && store.currentAnalysis?.id === completed.id) {
    await panels.open(completed, "preserve");
  } else {
    await panels.update(completed);
  }
  return true;
}

export async function startAnalysis<Started extends StartedAnalysis>(
  options: StartAnalysisOptions<Started>,
): Promise<StartAnalysisOutcome<Started>> {
  const analysis = await options.store.allocateRunning(
    options.modelPath,
    options.targetProfile,
    undefined,
    options.profilingDataPaths,
    options.analysisMode,
    options.analysisOptions,
  );
  beginAnalysis(options.panels, analysis, options.autoOpen);

  let started: Started;
  try {
    started = options.start(analysis);
  } catch (error) {
    const message = errorMessage(error);
    await options.store.fail(analysis.id, message);
    options.panels.showError(analysis.id, options.synchronousFailureMessage(message));
    return { ok: false, analysis, message };
  }

  options.runningCommands.set(analysis.id, started.command);
  const settled = started.completion
    .then(async (artifacts) => {
      options.runningCommands.delete(analysis.id);
      return completeAnalysis(
        options.store,
        options.panels,
        analysis.id,
        artifacts,
        options.autoOpen,
      );
    })
    .catch(async (error: unknown) => {
      options.runningCommands.delete(analysis.id);
      if (options.store.get(analysis.id)?.status === "cancelled") {
        return false;
      }
      const message = errorMessage(error);
      try {
        if (await options.store.fail(analysis.id, message)) {
          options.panels.showError(analysis.id, options.asynchronousFailureMessage(message));
        }
      } catch (persistError) {
        options.log?.(`ERROR: Failed to persist analysis failure: ${errorMessage(persistError)}`);
      }
      return false;
    });

  return { ok: true, analysis, started, settled };
}

export async function cancelAnalysis(
  store: AnalysisStore,
  runningCommands: Map<string, StoppableAnalysis>,
  analysisId: string,
): Promise<boolean> {
  const analysis = store.get(analysisId);
  if (!analysis || !store.isControllable(analysis)) {
    return false;
  }
  if (!(await store.cancel(analysisId))) {
    return false;
  }
  runningCommands.get(analysisId)?.stop();
  runningCommands.delete(analysisId);
  return true;
}

export async function deleteAnalysis(
  store: AnalysisStore,
  panels: AnalysisPanelController,
  analysisId: string,
): Promise<DeleteAnalysisOutcome> {
  return store.delete(analysisId, (analysis) => panels.close(analysis.id));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
