import { analysisInputDetails, analysisInputSummary } from "./analysisInputs";
import type { Analysis } from "./analysisStore";
import { analysisErrorMessage } from "./analysisErrors";

export interface AnalysisPresentation {
  inputSummary: string;
  mode: string;
  checks: string;
  status: string;
  treeDescription: string;
  tooltipDetails: string[];
  panelTitle: string;
}

export function analysisPresentation(analysis: Analysis): AnalysisPresentation {
  const inputSummary = analysisInputSummary(analysis);
  const mode = analysis.analysisMode === "profiling" ? "Profiling" : "Estimation";
  const checks = [
    analysis.analysisOptions.performance ? "Performance" : undefined,
    analysis.analysisOptions.compatibility ? "Compatibility" : undefined,
  ].filter((value): value is string => value !== undefined).join(" + ") || "No checks";
  const status = analysis.status[0].toUpperCase() + analysis.status.slice(1);

  return {
    inputSummary,
    mode,
    checks,
    status,
    treeDescription: `${mode} · ${checks} · ${analysis.targetProfile} · ${status}`,
    tooltipDetails: [
      ...analysisInputDetails(analysis),
      `Mode: ${mode}`,
      `Checks: ${checks}`,
      `Target profile: ${analysis.targetProfile}`,
      ...(analysis.error ? [`Details: ${analysisErrorMessage(analysis.error)}`] : []),
    ],
    panelTitle: `MLIA: ${inputSummary} · ${mode} · ${analysis.targetProfile}`,
  };
}
