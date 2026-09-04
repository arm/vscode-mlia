import { randomBytes } from "crypto";
import * as vscode from "vscode";

import { analysisPresentation } from "./analysisPresentation";
import { Analysis } from "./analysisStore";
import { formatDisplayNumber } from "./numberFormatting";
import {
  buildOverlayCatalog,
  OverlayKey,
  overlayKeyId,
} from "./overlayCatalog";
import { OverlaySelection, selectedOverlay } from "./overlaySynchronization";
import {
  SourceMappingDiagnostics,
  SourceMappingLocation,
} from "./sourceAnnotations";

export type CurrentAnalysisState =
  | { kind: "empty" }
  | {
      kind: "current";
      analysis: Analysis;
      overlays: readonly OverlayKey[];
      selectedOverlayId?: string;
      codeLensEnabled?: boolean;
      heatmapEnabled?: boolean;
      sourceMappings?: readonly SourceMappingDiagnostics[];
    };

export interface CurrentAnalysisAnnotations {
  readonly sourceMappingDiagnostics: readonly SourceMappingDiagnostics[];
  setAnalysis: (
    owner: object,
    standardizedOutput: unknown,
    entityNodeMappings: unknown,
    requestedSelection?: OverlaySelection,
  ) => void;
  selectOverlay: (overlay: OverlayKey | undefined) => boolean;
  clearAnalysis: (owner: object) => void;
  sourceLocationForId: (id: string) => SourceMappingLocation | undefined;
  subscribe: (listener: () => void) => { dispose: () => void };
}

export interface CurrentAnalysisViewOptions {
  currentAnalysis: () => Analysis | undefined;
  annotations: CurrentAnalysisAnnotations;
  setOverlaySelection: (analysis: Analysis, selection: OverlaySelection) => void;
  isCodeLensEnabled?: () => boolean;
  isHeatmapEnabled?: () => boolean;
  openSettings?: () => void;
  openSourceFileMap?: () => void;
  openSourceLocation?: (location: SourceMappingLocation) => void;
}

export class CurrentAnalysisViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private messageSubscription: vscode.Disposable | undefined;
  private viewDisposalSubscription: vscode.Disposable | undefined;
  private state: CurrentAnalysisState = { kind: "empty" };
  private observedCurrent: Analysis | undefined;
  private annotationOwner: Analysis | undefined;
  private overlays: readonly OverlayKey[] = [];
  private selectedOverlay: OverlayKey | undefined;
  private disposed = false;
  private readonly annotationSubscription: { dispose: () => void };

  public constructor(private readonly options: CurrentAnalysisViewOptions) {
    this.annotationSubscription = options.annotations.subscribe(() => {
      if (!this.disposed) {
        this.publishCurrentState();
      }
    });
    this.refresh();
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    if (this.disposed) {
      return;
    }
    this.clearViewBindings();
    this.view = view;
    view.webview.options = { enableScripts: true };
    this.messageSubscription = view.webview.onDidReceiveMessage((message: unknown) => {
      if (this.view !== view || typeof message !== "object" || message === null) {
        return;
      }
      const candidate = message as {
        command?: unknown;
        overlayId?: unknown;
        locationId?: unknown;
      };
      switch (candidate.command) {
        case "openSettings":
          this.options.openSettings?.();
          break;
        case "openSourceFileMap":
          this.options.openSourceFileMap?.();
          break;
        case "openSourceLocation": {
          if (typeof candidate.locationId !== "string") {
            break;
          }
          const location = this.options.annotations.sourceLocationForId(candidate.locationId);
          if (location) {
            this.options.openSourceLocation?.(location);
          }
          break;
        }
        case "selectOverlay": {
          this.refresh();
          const selected = typeof candidate.overlayId === "string" && candidate.overlayId.length > 0
            ? this.overlays.find((overlay) => overlayKeyId(overlay) === candidate.overlayId)
            : undefined;
          if (this.state.kind === "current" && (selected || candidate.overlayId === "")) {
            const selection: OverlaySelection = selected
              ? { kind: "overlay", overlay: selected }
              : { kind: "none" };
            this.selectedOverlay = selected;
            if (this.annotationOwner?.id === this.state.analysis.id) {
              this.options.annotations.selectOverlay(selected);
            }
            this.options.setOverlaySelection(this.state.analysis, selection);
            this.publishCurrentState();
          }
          break;
        }
      }
    });
    this.viewDisposalSubscription = view.onDidDispose(() => {
      if (this.view !== view) {
        return;
      }
      this.clearViewBindings();
      this.view = undefined;
    });
    this.render();
  }

  /** Synchronizes the view and source highlighting with AnalysisStore.currentAnalysis. */
  public refresh(): void {
    if (this.disposed) {
      return;
    }
    const current = this.options.currentAnalysis();
    if (current === this.observedCurrent) {
      this.publishCurrentState();
      return;
    }

    this.clearAnnotations();
    this.observedCurrent = current;
    this.overlays = current?.standardizedOutput === undefined
      ? []
      : buildOverlayCatalog(current.standardizedOutput);
    this.selectedOverlay = selectedOverlay(current?.overlaySelection, this.overlays);

    if (
      current?.status === "complete" &&
      current.standardizedOutput !== undefined
    ) {
      this.options.annotations.setAnalysis(
        current,
        current.standardizedOutput,
        current.entityNodeMappings,
        current.overlaySelection,
      );
      this.annotationOwner = current;
    }

    this.publishCurrentState();
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.annotationSubscription.dispose();
    this.clearViewBindings();
    this.clearAnnotations();
    this.observedCurrent = undefined;
    this.overlays = [];
    this.selectedOverlay = undefined;
    this.view = undefined;
  }

  private publishCurrentState(): void {
    const current = this.options.currentAnalysis();
    if (!current) {
      this.state = { kind: "empty" };
      this.render();
      return;
    }
    this.state = {
      kind: "current",
      analysis: current,
      overlays: this.overlays,
      selectedOverlayId: this.selectedOverlay === undefined
        ? undefined
        : overlayKeyId(this.selectedOverlay),
      codeLensEnabled: this.options.isCodeLensEnabled?.() ?? true,
      heatmapEnabled: this.options.isHeatmapEnabled?.() ?? true,
      sourceMappings: this.annotationOwner?.id === current.id
        ? this.options.annotations.sourceMappingDiagnostics
        : [],
    };
    this.render();
  }

  private clearAnnotations(): void {
    if (!this.annotationOwner) {
      return;
    }
    const owner = this.annotationOwner;
    this.annotationOwner = undefined;
    this.options.annotations.clearAnalysis(owner);
  }

  private clearViewBindings(): void {
    this.messageSubscription?.dispose();
    this.messageSubscription = undefined;
    this.viewDisposalSubscription?.dispose();
    this.viewDisposalSubscription = undefined;
  }

  private render(): void {
    if (this.view && !this.disposed) {
      this.view.webview.html = renderCurrentAnalysis(this.state);
    }
  }
}

export function renderCurrentAnalysis(
  state: CurrentAnalysisState,
  nonce = randomBytes(18).toString("base64"),
): string {
  const safeNonce = escapeHtml(nonce);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; style-src 'nonce-${safeNonce}'; script-src 'nonce-${safeNonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style nonce="${safeNonce}">
    body { margin: 0; padding: 12px 16px 16px; color: var(--vscode-foreground); font: var(--vscode-font-size) var(--vscode-font-family); }
    .empty, .hint { margin: 0; color: var(--vscode-descriptionForeground); line-height: 1.5; }
    .hint { margin-top: 4px; }
    dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 5px 10px; margin: 0 0 12px; }
    dt { color: var(--vscode-descriptionForeground); }
    dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
    .overlay-control { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 4px 8px; margin-bottom: 12px; }
    .overlay-control .hint, .overlay-control .presentation-warning { grid-column: 2; }
    .presentation-warning { margin: 2px 0 0; color: var(--vscode-descriptionForeground); font-size: 0.92em; line-height: 1.4; }
    .link-button { margin: 0; padding: 0; border: 0; color: var(--vscode-textLink-foreground); background: none; font: inherit; cursor: pointer; text-decoration: underline; }
    .link-button:hover { color: var(--vscode-textLink-activeForeground); }
    label { color: var(--vscode-descriptionForeground); }
    select { width: 100%; min-width: 0; padding: 4px 6px; border: 1px solid var(--vscode-dropdown-border); color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); font: inherit; }
    .analysis-results { margin: 14px 0 12px 4px; }
    .analysis-result { margin: 8px 0; }
    .analysis-results summary { color: var(--vscode-descriptionForeground); font-weight: 600; cursor: pointer; }
    .analysis-result[open] > summary { margin-bottom: 6px; }
    .result-subsection { margin: 6px 0 6px 10px; }
    .result-subsection[open] > summary { margin-bottom: 5px; }
    .result-subsection dl { margin: 0 0 8px 10px; }
    .model-metrics dl { grid-template-columns: minmax(25%, auto) minmax(25%, auto); }
    .model-metrics dt, .model-metrics dd { min-width: 0; overflow-wrap: anywhere; }
    .source-mappings-content { margin-left: 10px; }
    .source-mappings-content dl { margin-left: 0; }
    .inline-setting-link { margin-left: 4px; white-space: nowrap; }
    .source-locations { margin-top: 6px; }
    .source-locations > summary { color: var(--vscode-descriptionForeground); cursor: pointer; }
    .source-location-groups { margin: 5px 0 0 18px; padding: 0; }
    .source-location-groups li { margin: 3px 0; }
    .source-location-lines { display: inline-flex; flex-wrap: wrap; gap: 2px 6px; margin-left: 5px; }
    .unavailable { color: var(--vscode-descriptionForeground); font-style: italic; }
  </style>
</head>
<body>
  ${currentAnalysisContent(state)}
  <script nonce="${safeNonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('overlay')?.addEventListener('change', (event) => {
      vscode.postMessage({ command: 'selectOverlay', overlayId: event.target.value });
    });
    document.getElementById('open-settings')?.addEventListener('click', () => {
      vscode.postMessage({ command: 'openSettings' });
    });
    document.querySelectorAll('[data-command]').forEach((element) => {
      element.addEventListener('click', () => {
        vscode.postMessage({ command: element.dataset.command });
      });
    });
    document.querySelectorAll('[data-location-id]').forEach((element) => {
      element.addEventListener('click', () => {
        vscode.postMessage({
          command: 'openSourceLocation',
          locationId: element.dataset.locationId,
        });
      });
    });
  </script>
</body>
</html>`;
}

function currentAnalysisContent(state: CurrentAnalysisState): string {
  if (state.kind === "empty") {
    return '<p class="empty">No current analysis run. Open a completed analysis run below, or run a new analysis.</p>';
  }

  const { analysis } = state;
  const presentation = analysisPresentation(analysis);
  const modelStatistics = resultSectionsContent(
    analysis.standardizedOutput,
    state.sourceMappings ?? [],
  );
  const overlayContent = overlaySelectorContent(state);
  const status = analysis.finishedAt
    ? `${presentation.status} · ${formatDate(analysis.finishedAt)}`
    : presentation.status;
  const errorRow = analysis.error
    ? `<dt>Details</dt><dd>${escapeHtml(analysis.error)}</dd>`
    : "";
  const inputRows = [
    analysis.modelPath
      ? `<dt>Source model</dt><dd>${escapeHtml(analysis.modelPath)}</dd>`
      : "",
    ...analysis.profilingDataPaths.map((profilingDataPath, index) =>
      `<dt>Profiling data${analysis.profilingDataPaths.length > 1 ? ` ${index + 1}` : ""}</dt><dd>${escapeHtml(profilingDataPath)}</dd>`
    ),
  ].join("");
  return `${overlayContent}
  <dl>
    ${inputRows}
    <dt>Mode</dt><dd>${escapeHtml(presentation.mode)}</dd>
    <dt>Checks</dt><dd>${escapeHtml(presentation.checks)}</dd>
    <dt>Target profile</dt><dd>${escapeHtml(analysis.targetProfile)}</dd>
    <dt>Status</dt><dd>${escapeHtml(status)}</dd>
    ${errorRow}
  </dl>
  ${modelStatistics}`;
}

function resultSectionsContent(
  standardizedOutput: unknown,
  sourceMappings: readonly SourceMappingDiagnostics[],
): string {
  if (!isRecord(standardizedOutput) || !Array.isArray(standardizedOutput.results)) {
    return "";
  }

  const groups = standardizedOutput.results.flatMap((value, resultIndex) => {
    if (!isRecord(value)) {
      return [];
    }
    const rows = modelStatisticRows(value.metrics);
    const sourceMapping = sourceMappings.find((mapping) => mapping.resultIndex === resultIndex);
    if (rows.length === 0 && !sourceMapping) {
      return [];
    }
    const resultKind = typeof value.kind === "string" && value.kind.length > 0
      ? value.kind
      : "result";
    return [{
      heading: `Result ${resultIndex + 1} · ${resultKind}`,
      rows,
      sourceMapping,
    }];
  });

  if (groups.length === 0) {
    return "";
  }
  const content = groups.map(({ heading, rows, sourceMapping }) => {
    const modelMetrics = rows.length === 0
      ? ""
      : `<details class="result-subsection model-metrics" open><summary>Model metrics</summary><dl>${rows.join("")}</dl></details>`;
    const mappings = sourceMapping ? sourceMappingContent(sourceMapping) : "";
    return `<details class="analysis-result" open><summary>${escapeHtml(heading)}</summary>${modelMetrics}${mappings}</details>`;
  }).join("");
  return `<section class="analysis-results" aria-label="Analysis results">${content}</section>`;
}

function modelStatisticRows(metricValues: unknown): string[] {
  if (!Array.isArray(metricValues)) {
    return [];
  }
  return metricValues.flatMap((metric) => {
    if (!isRecord(metric) || typeof metric.name !== "string" || metric.name.length === 0) {
      return [];
    }
    const unitText = typeof metric.unit === "string" && metric.unit.length > 0
      ? metric.unit
      : "";
    const unit = unitText.length > 0 ? ` ${escapeHtml(unitText)}` : "";
    const qualifiers = isRecord(metric.qualifiers) && Object.keys(metric.qualifiers).length > 0
      ? ` · ${escapeHtml(JSON.stringify(metric.qualifiers))}`
      : "";
    const label = `${escapeHtml(metric.name)}${qualifiers}`;
    const renderedValue = modelStatisticValue(metric.value);
    if (renderedValue !== undefined) {
      const tooltip = renderedValue.fullValue === undefined
        ? ""
        : ` title="${escapeHtml(`${renderedValue.fullValue}${unitText.length > 0 ? ` ${unitText}` : ""}`)}"`;
      return [`<dt>${label}</dt><dd${tooltip}>${escapeHtml(renderedValue.displayValue)}${unit}</dd>`];
    }
    const detail = typeof metric.reason === "string" && metric.reason.length > 0
      ? ` — ${escapeHtml(metric.reason)}`
      : typeof metric.availability === "string" && metric.availability.length > 0
        ? ` — ${escapeHtml(metric.availability)}`
        : "";
    return [`<dt>${label}</dt><dd class="unavailable">Unavailable${detail}</dd>`];
  });
}

function sourceMappingContent(mapping: SourceMappingDiagnostics): string {
  const missingCount = Math.max(
    0,
    mapping.distinctSourceLocations - mapping.accessibleSourceLocations,
  );
  const accessibleValue = mapping.accessibilityPending
    ? '<span class="unavailable">Checking…</span>'
    : String(mapping.accessibleSourceLocations);
  const sourceMapLink = mapping.accessibilityPending || missingCount === 0
    ? ""
    : ' <span class="inline-setting-link">[<button class="link-button" type="button" data-command="openSourceFileMap">Configure source file mapping</button>]</span>';
  const sourceFiles = sourceFileList(mapping.sourceFiles);
  const accessibleLocations = sourceLocationList(mapping.locations);
  return `<details class="result-subsection source-mappings" open>
    <summary>Source mappings</summary>
    <div class="source-mappings-content">
      <dl>
        <dt>Code stacks</dt><dd title="${mapping.reportedCodeStacks} code stacks were reported; ${mapping.mappedCodeStacks} are mapped to Model Explorer; ${mapping.sourceLocatedCodeStacks} mapped code stacks have valid file and line source attributes.">${mapping.reportedCodeStacks} reported · ${mapping.mappedCodeStacks} mapped</dd>
      </dl>
      <details class="source-locations distinct-source-locations">
        <summary>Distinct source locations: ${mapping.distinctSourceLocations}</summary>
        ${sourceFiles}
      </details>
      <details class="source-locations accessible-source-locations">
        <summary>Accessible locally: ${accessibleValue}${sourceMapLink}</summary>
        ${accessibleLocations}
      </details>
    </div>
  </details>`;
}

function sourceFileList(files: readonly string[]): string {
  if (files.length === 0) {
    return "";
  }
  const groups = files
    .map((file) => `<li title="${escapeHtml(file)}">${escapeHtml(file)}</li>`)
    .join("");
  return `<ul class="source-location-groups source-file-groups">${groups}</ul>`;
}

function sourceLocationList(locations: readonly SourceMappingLocation[]): string {
  if (locations.length === 0) {
    return "";
  }
  const byFile = new Map<string, SourceMappingLocation[]>();
  for (const location of locations) {
    const entries = byFile.get(location.localFile) ?? [];
    entries.push(location);
    byFile.set(location.localFile, entries);
  }
  const groups = [...byFile]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, entries]) => {
      const lines = entries
        .sort((left, right) => left.line - right.line)
        .map((location) =>
          `<button class="link-button" type="button" data-location-id="${escapeHtml(location.id)}">${location.line}</button>`
        )
        .join("");
      return `<li><span title="${escapeHtml(file)}">${escapeHtml(file)}</span><span class="source-location-lines">${lines}</span></li>`;
    })
    .join("");
  return `<ul class="source-location-groups">${groups}</ul>`;
}

function modelStatisticValue(
  value: unknown,
): { displayValue: string; fullValue?: string } | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return {
      displayValue: formatDisplayNumber(value),
      fullValue: String(value),
    };
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return { displayValue: String(value) };
  }
  return undefined;
}

function overlaySelectorContent(state: Extract<CurrentAnalysisState, { kind: "current" }>): string {
  if (state.overlays.length === 0) {
    const message = state.analysis.status === "complete"
      ? "No overlays are available in standardized output for this analysis run."
      : `Overlays are unavailable while this analysis run is ${state.analysis.status}.`;
    return `<div class="overlay-control"><label for="overlay">Overlay:</label>
  <select id="overlay" aria-label="Overlay" disabled><option value="">Unavailable</option></select>
  <p class="hint">${escapeHtml(message)}</p>${sourcePresentationWarning(state)}</div>`;
  }

  const noneOption = `<option value=""${state.selectedOverlayId === undefined ? " selected" : ""}>None</option>`;
  const options = state.overlays.map((overlay) => {
    const id = overlayKeyId(overlay);
    return `<option value="${escapeHtml(id)}"${id === state.selectedOverlayId ? " selected" : ""}>${escapeHtml(overlayLabel(overlay))}</option>`;
  }).join("");
  const presentationWarning = sourcePresentationWarning(state);
  return `<div class="overlay-control"><label for="overlay">Overlay:</label>
  <select id="overlay" aria-label="Overlay">${noneOption}${options}</select>
  ${presentationWarning}</div>`;
}

function sourcePresentationWarning(
  state: Extract<CurrentAnalysisState, { kind: "current" }>,
): string {
  const codeLensEnabled = state.codeLensEnabled !== false;
  const heatmapEnabled = state.heatmapEnabled !== false;
  if (codeLensEnabled && heatmapEnabled) {
    return "";
  }
  const message = !codeLensEnabled && !heatmapEnabled
    ? "Source highlighting and CodeLens are disabled, so overlay changes will not appear in source editors."
    : !heatmapEnabled
      ? "Source highlighting is disabled, so overlay colors will not appear in source editors."
      : "CodeLens is disabled, so overlay values will not appear above source lines.";
  return `<p class="presentation-warning">${message} <button id="open-settings" class="link-button" type="button">Open MLIA settings</button>.</p>`;
}

function overlayLabel(overlay: OverlayKey): string {
  const unit = overlay.unit.trim();
  const breakdown = qualifierLabel("breakdown", overlay.breakdownQualifiers);
  const metricValues = qualifierLabel("metric", overlay.metricQualifiers);
  const qualifiers = [breakdown, metricValues].filter((value): value is string => value !== undefined);
  const identity = `${overlay.name}${unit ? ` (${unit})` : ""}${qualifiers.length > 0 ? ` · ${qualifiers.join(" · ")}` : ""}`;
  return `Result ${overlay.resultIndex + 1} · ${overlay.resultKind} · ${overlay.category}: ${identity}`;
}

function qualifierLabel(
  kind: "breakdown" | "metric",
  qualifiers: OverlayKey["breakdownQualifiers"],
): string | undefined {
  return Object.keys(qualifiers).length === 0
    ? undefined
    : `${kind}: ${JSON.stringify(qualifiers)}`;
}

function formatDate(value: Date): string {
  return value.toLocaleString();
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}
