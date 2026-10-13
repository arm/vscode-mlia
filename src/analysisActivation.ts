import { Analysis } from "./analysisStore";
import type { ModelExplorerFocusIntent } from "./modelExplorerWebview";

export const activateAnalysisCommand = "vscode-mlia.activateAnalysis";

export interface AnalysisActivationCommand {
  command: typeof activateAnalysisCommand;
  title: string;
  arguments: [string];
}

export interface AnalysisActivationStore {
  get: (id: string) => Analysis | undefined;
  setCurrent: (id: string) => Promise<boolean>;
}

export interface AnalysisActivationPanels {
  open: (analysis: Analysis, focus: ModelExplorerFocusIntent) => Promise<void>;
}

export function analysisActivationCommand(analysis: Analysis): AnalysisActivationCommand {
  return {
    command: activateAnalysisCommand,
    title: "Open Analysis Run and Set as Current",
    arguments: [analysis.id],
  };
}

export async function activateAnalysis(
  store: AnalysisActivationStore,
  panels: AnalysisActivationPanels,
  analysisId: string | undefined,
): Promise<boolean> {
  if (!analysisId || !(await store.setCurrent(analysisId))) {
    return false;
  }
  const analysis = store.get(analysisId);
  if (!analysis) {
    return false;
  }
  await panels.open(analysis, "preserve");
  return true;
}
