import { AnalysisInputs, hasAnalysisInput } from "./analysisInputs";
import { MliaAnalysisOptions, MliaCheckPerformanceResult } from "./pythonRuntime";

const showLogAction = "Show Log";

export interface CheckPerformanceOptions {
  targetProfile?: string;
  analysisOptions: MliaAnalysisOptions;
  analysisInputs: AnalysisInputs;
  showMissingTargetProfile: () => Promise<void>;
  runMliaCheckPerformance: (
    analysisInputs: AnalysisInputs,
    targetProfile: string,
    analysisOptions: MliaAnalysisOptions,
  ) => PromiseLike<MliaCheckPerformanceResult>;
  showErrorMessage: (message: string, ...items: string[]) => PromiseLike<string | undefined>;
  showLog: () => void;
  log: (message: string) => void;
}

export async function checkPerformance(options: CheckPerformanceOptions): Promise<void> {
  if (!options.analysisOptions.performance && !options.analysisOptions.compatibility) {
    return;
  }

  if (!hasAnalysisInput(options.analysisInputs)) {
    return;
  }

  if (!options.targetProfile) {
    await options.showMissingTargetProfile();
    return;
  }

  const result = await options.runMliaCheckPerformance(
    options.analysisInputs,
    options.targetProfile,
    options.analysisOptions,
  );
  if (!result.ok) {
    options.log(`ERROR: ${result.message}`);
    const selection = await options.showErrorMessage("Failed to run MLIA analysis.", showLogAction);
    if (selection === showLogAction) {
      options.showLog();
    }
  }
}
