import type * as vscode from "vscode";

import { analysisPresentation } from "./analysisPresentation";
import type { Analysis } from "./analysisStore";

export interface AnalysisProgressHost {
  ProgressLocation: Pick<typeof vscode.ProgressLocation, "Notification">;
  window: Pick<typeof vscode.window, "withProgress">;
}

export interface AnalysisProgressOptions {
  analysis: Analysis;
  completion: Promise<unknown>;
  cancel: (analysisId: string) => Promise<boolean>;
  reportError: (message: string) => void;
}

/** Keep a run-specific notification open until its lifecycle has settled. */
export async function showAnalysisProgress(
  host: AnalysisProgressHost,
  options: AnalysisProgressOptions,
): Promise<void> {
  const { analysis, completion } = options;
  const presentation = analysisPresentation(analysis);
  const title = `Running MLIA ${presentation.checks.toLowerCase()} analysis: ` +
    `${presentation.inputSummary} (${analysis.targetProfile})`;

  try {
    await host.window.withProgress(
      {
        location: host.ProgressLocation.Notification,
        title,
        cancellable: true,
      },
      async (progress, token) => {
        let finished = false;
        let cancellation: Promise<void> | undefined;
        const requestCancellation = (): void => {
          if (finished || cancellation) {
            return;
          }
          progress.report({ message: "Cancelling…" });
          cancellation = Promise.resolve()
            .then(() => options.cancel(analysis.id))
            .then(() => undefined)
            .catch((error: unknown) => {
              if (!finished) {
                progress.report({ message: "Cancellation failed; waiting for the analysis to finish." });
              }
              options.reportError(`Could not cancel MLIA analysis '${presentation.inputSummary}': ${errorMessage(error)}`);
            });
        };
        const subscription = token.onCancellationRequested(requestCancellation);
        if (token.isCancellationRequested) {
          requestCancellation();
        }
        try {
          // Cancellation requests do not finish the notification: wait for the
          // process and the persisted run state, including sidebar cancellation.
          await completion;
        } finally {
          finished = true;
          subscription.dispose();
          await cancellation;
        }
      },
    );
  } catch (error) {
    options.reportError(`MLIA progress notification failed: ${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
