import { AnalysisInputs, hasAnalysisInput } from "./analysisInputs";
import { MliaAnalysisMode, MliaAnalysisOptions, MliaCheckPerformanceResult } from "./pythonRuntime";
import type { EulaDecision } from "./eula";
import { eulaAcceptanceRequiredMessage } from "./analysisErrors";

const showLogAction = "Show Log";

export interface CheckPerformanceOptions {
  targetProfile?: string;
  analysisOptions: MliaAnalysisOptions;
  analysisInputs: AnalysisInputs;
  analysisMode: MliaAnalysisMode;
  authorizeEula: (targetProfile: string, mode: MliaAnalysisMode) => Promise<EulaDecision>;
  showMissingTargetProfile: () => Promise<void>;
  runMliaCheckPerformance: (
    analysisInputs: AnalysisInputs,
    targetProfile: string,
    analysisOptions: MliaAnalysisOptions,
    acceptEula: boolean,
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

  let consent: EulaDecision;
  try {
    consent = await options.authorizeEula(options.targetProfile, options.analysisMode);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.log(`ERROR: ${message}`);
    const selection = await options.showErrorMessage(`Unable to start MLIA analysis: ${message}`, showLogAction);
    if (selection === showLogAction) {
      options.showLog();
    }
    return;
  }
  if (!consent.proceed) {
    await options.showErrorMessage(eulaAcceptanceRequiredMessage);
    return;
  }

  const result = await options.runMliaCheckPerformance(
    options.analysisInputs,
    options.targetProfile,
    options.analysisOptions,
    consent.acceptEula,
  );
  if (!result.ok) {
    options.log(`ERROR: ${result.message}`);
    const selection = await options.showErrorMessage("Failed to run MLIA analysis.", showLogAction);
    if (selection === showLogAction) {
      options.showLog();
    }
  }
}
