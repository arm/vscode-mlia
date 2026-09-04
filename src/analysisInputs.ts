import * as path from "path";

export interface AnalysisInputs {
  modelPath?: string;
  profilingDataPaths: string[];
}

export function hasAnalysisInput(inputs: AnalysisInputs): boolean {
  return Boolean(inputs.modelPath || inputs.profilingDataPaths.some(Boolean));
}

export function analysisInputSummary(inputs: AnalysisInputs): string {
  const primaryInput = inputs.modelPath || inputs.profilingDataPaths.find(Boolean);
  return primaryInput ? path.basename(primaryInput) : "";
}

export function analysisInputDetails(inputs: AnalysisInputs): string[] {
  return [
    inputs.modelPath ? `Source model: ${inputs.modelPath}` : undefined,
    ...inputs.profilingDataPaths.map((value, index) =>
      `Profiling data${inputs.profilingDataPaths.length > 1 ? ` ${index + 1}` : ""}: ${value}`
    ),
  ].filter((value): value is string => value !== undefined);
}
