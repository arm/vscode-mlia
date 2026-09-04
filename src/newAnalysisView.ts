import * as vscode from "vscode";

import { AnalysisInputs } from "./analysisInputs";
import { PathList } from "./pathList";
import {
  MliaAnalysisMode,
  MliaAnalysisOptions,
  MliaTarget,
} from "./pythonRuntime";

export type NewAnalysisState =
  | { kind: "starting" }
  | { kind: "setupRequired" }
  | { kind: "incomplete" }
  | { kind: "available" }
  | { kind: "refreshing"; message?: string }
  | {
      kind: "ready";
      version: string;
      targets: MliaTarget[];
      selectedTargetProfile?: string;
      analysisMode: MliaAnalysisMode;
      analysisOptions: MliaAnalysisOptions;
      analysisInputs: AnalysisInputs;
    }
  | { kind: "failed"; message: string };

export interface NewAnalysisViewOptions {
  refreshEnvironment: () => void;
  runAnalysis: (
    targetProfile: string,
    analysisMode: MliaAnalysisMode,
    analysisOptions: MliaAnalysisOptions,
    analysisInputs: AnalysisInputs,
  ) => void;
  showLog: () => void;
  selectTargetProfile: (targetProfile: string) => void;
  selectAnalysisMode: (analysisMode: MliaAnalysisMode) => void;
  selectAnalysisOptions: (analysisOptions: MliaAnalysisOptions) => void;
  selectAnalysisInputs: (analysisInputs: AnalysisInputs) => void;
  pickModelPath: () => Promise<string | undefined>;
  pickProfilingDataPath: () => Promise<string | undefined>;
}

export class NewAnalysisViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private state: NewAnalysisState = { kind: "starting" };

  public constructor(private readonly options: NewAnalysisViewOptions) {}

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((message: unknown) => {
      if (typeof message !== "object" || message === null) {
        return;
      }
      const candidate = message as {
        command?: unknown;
        targetProfile?: unknown;
        performance?: unknown;
        compatibility?: unknown;
        analysisMode?: unknown;
        modelPath?: unknown;
        profilingDataPaths?: unknown;
        pathListAction?: unknown;
        index?: unknown;
      };
      switch (candidate.command) {
        case "refreshEnvironment":
          this.options.refreshEnvironment();
          break;
        case "runAnalysis":
          if (
            typeof candidate.targetProfile === "string" &&
            (candidate.analysisMode === "estimation" || candidate.analysisMode === "profiling") &&
            typeof candidate.performance === "boolean" &&
            typeof candidate.compatibility === "boolean" &&
            typeof candidate.modelPath === "string" &&
            isStringArray(candidate.profilingDataPaths)
          ) {
            this.options.runAnalysis(
              candidate.targetProfile,
              candidate.analysisMode,
              {
                performance: candidate.performance,
                compatibility: candidate.compatibility,
              },
              analysisInputs(candidate.modelPath, candidate.profilingDataPaths),
            );
          }
          break;
        case "showLog":
          this.options.showLog();
          break;
        case "selectTargetProfile":
          if (typeof candidate.targetProfile === "string") {
            this.options.selectTargetProfile(candidate.targetProfile);
          }
          break;
        case "selectAnalysisMode":
          if (candidate.analysisMode === "estimation" || candidate.analysisMode === "profiling") {
            this.options.selectAnalysisMode(candidate.analysisMode);
          }
          break;
        case "selectAnalysisOptions":
          if (typeof candidate.performance === "boolean" && typeof candidate.compatibility === "boolean") {
            this.options.selectAnalysisOptions({
              performance: candidate.performance,
              compatibility: candidate.compatibility,
            });
          }
          break;
        case "selectAnalysisInputs":
          if (typeof candidate.modelPath === "string" && isStringArray(candidate.profilingDataPaths)) {
            const inputs = analysisInputs(candidate.modelPath, candidate.profilingDataPaths);
            if (this.state.kind === "ready" && this.state.analysisMode === "estimation") {
              inputs.profilingDataPaths = this.state.analysisInputs.profilingDataPaths;
            }
            this.updateAnalysisInputs(inputs, false);
          }
          break;
        case "pickModelPath":
          void this.pickModelPath();
          break;
        case "editProfilingDataPaths":
          if (
            isPathListAction(candidate.pathListAction) &&
            isStringArray(candidate.profilingDataPaths) &&
            typeof candidate.index === "number" &&
            Number.isInteger(candidate.index)
          ) {
            void this.editProfilingDataPaths(
              candidate.pathListAction,
              candidate.index,
              candidate.profilingDataPaths,
            );
          }
          break;
      }
    });
    this.render();
  }

  public setState(state: NewAnalysisState): void {
    this.state = state;
    this.render();
  }

  private async pickModelPath(): Promise<void> {
    const selected = await this.options.pickModelPath();
    if (selected === undefined || this.state.kind !== "ready") {
      return;
    }
    this.updateAnalysisInputs({ ...this.state.analysisInputs, modelPath: selected }, true);
  }

  private async editProfilingDataPaths(
    action: PathListAction,
    index: number,
    currentPaths: string[],
  ): Promise<void> {
    if (this.state.kind !== "ready") {
      return;
    }
    const paths = [...currentPaths];
    if (action === "browse") {
      const selected = await this.options.pickProfilingDataPath();
      if (selected === undefined || this.state.kind !== "ready") {
        return;
      }
      if (index < paths.length) {
        paths[index] = selected;
      } else {
        paths.push(selected);
      }
    } else if (action === "remove") {
      paths.splice(index, 1);
    } else {
      const otherIndex = action === "moveUp" ? index - 1 : index + 1;
      if (index < 0 || index >= paths.length || otherIndex < 0 || otherIndex >= paths.length) {
        return;
      }
      [paths[index], paths[otherIndex]] = [paths[otherIndex], paths[index]];
    }
    this.updateAnalysisInputs({
      ...this.state.analysisInputs,
      profilingDataPaths: paths,
    }, true);
  }

  private updateAnalysisInputs(inputs: AnalysisInputs, render: boolean): void {
    if (this.state.kind !== "ready") {
      return;
    }
    this.state = { ...this.state, analysisInputs: inputs };
    this.options.selectAnalysisInputs(inputs);
    if (render) {
      this.render();
    }
  }

  private render(): void {
    if (this.view) {
      this.view.webview.html = renderNewAnalysis(this.state);
    }
  }
}

export function renderNewAnalysis(state: NewAnalysisState): string {
  const content = stateContent(state);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 12px 16px 16px; color: var(--vscode-foreground); font: var(--vscode-font-size) var(--vscode-font-family); }
    .status { margin: 0 0 12px; color: var(--vscode-descriptionForeground); line-height: 1.5; }
    .actions { display: grid; gap: 8px; }
    .mode-tabs { display: grid; grid-template-columns: 1fr 1fr; margin-bottom: 10px; border-bottom: 1px solid var(--vscode-panel-border); }
    .mode-tab { border: 0; border-bottom: 2px solid transparent; border-radius: 0; color: var(--vscode-foreground); background: transparent; }
    .mode-tab:hover { background: var(--vscode-list-hoverBackground); }
    .mode-tab.selected { border-bottom-color: var(--vscode-focusBorder); color: var(--vscode-textLink-foreground); }
    button { width: 100%; padding: 5px 10px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font: inherit; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button:disabled { cursor: default; opacity: 0.6; }
    .path-fields { display: grid; gap: 8px; margin-bottom: 10px; }
    .path-control { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px; }
    .path-control input { min-width: 0; width: 100%; box-sizing: border-box; padding: 4px 6px; border: 1px solid var(--vscode-input-border, transparent); color: var(--vscode-input-foreground); background: var(--vscode-input-background); font: inherit; }
    .path-control input::placeholder { color: var(--vscode-input-placeholderForeground); }
    .path-control button { width: auto; min-width: 32px; padding: 4px 8px; }
    .path-list { display: grid; gap: 6px; }
    .path-list-label { font-weight: 600; }
    .path-list-rows { display: grid; gap: 5px; }
    .path-list-row { display: grid; grid-template-columns: auto minmax(0, 1fr) repeat(2, auto); gap: 4px; align-items: center; }
    .path-list[data-reorderable] .path-list-row { grid-template-columns: auto minmax(0, 1fr) repeat(4, auto); }
    .path-list-reorder { display: none; }
    .path-list[data-reorderable] .path-list-reorder { display: block; }
    .path-list-index { min-width: 1.5em; color: var(--vscode-descriptionForeground); text-align: right; }
    .path-list-row input { min-width: 0; width: 100%; box-sizing: border-box; padding: 4px 6px; border: 1px solid var(--vscode-input-border, transparent); color: var(--vscode-input-foreground); background: var(--vscode-input-background); font: inherit; }
    .path-list-row input::placeholder { color: var(--vscode-input-placeholderForeground); }
    button.path-list-button { width: 28px; min-width: 28px; padding: 4px; }
    button.path-list-button-hidden { visibility: hidden; pointer-events: none; }
    .analysis-row { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 8px; align-items: center; margin-bottom: 8px; }
    select { min-width: 0; width: 100%; max-width: 100%; padding: 4px 6px; border: 1px solid var(--vscode-dropdown-border); color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); font: inherit; }
    .analysis-types { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; white-space: nowrap; }
    .analysis-types label { display: inline-flex; gap: 4px; align-items: center; }
    .analysis-types input { margin: 0; }
    .analysis-row button { width: 100%; white-space: nowrap; }
    @media (max-width: 440px) { .analysis-row { grid-template-columns: minmax(0, 1fr) auto; } .analysis-row button { grid-column: 1 / -1; } }
    .spinner { display: inline-block; width: 10px; height: 10px; margin-right: 7px; border: 2px solid var(--vscode-progressBar-background); border-right-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; vertical-align: -2px; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  ${content}
  <script>
    const vscode = acquireVsCodeApi();
    const targetProfile = document.getElementById('target-profile');
    const performance = document.getElementById('analysis-performance');
    const compatibility = document.getElementById('analysis-compatibility');
    const modelPath = document.getElementById('model-path');
    const pathList = document.querySelector('[data-path-list]');
    const profilingDataInputs = () => Array.from(document.querySelectorAll('[data-path-list-input]'));
    const profilingDataPaths = () => profilingDataInputs()
      .map((input) => input.value)
      .filter((path) => path.trim().length > 0);
    const runAnalysis = document.querySelector('[data-command="runAnalysis"]');
    const analysisMode = document.querySelector('.analysis-controls')?.dataset.analysisMode;
    const analysisOptions = () => ({
      performance: performance?.checked === true,
      compatibility: compatibility?.checked === true,
    });
    const analysisInputs = () => ({
      modelPath: modelPath?.value ?? '',
      profilingDataPaths: profilingDataPaths(),
    });
    const refreshPathListRows = () => {
      const rows = Array.from(document.querySelectorAll('[data-path-list-row]'));
      const populatedCount = profilingDataPaths().length;
      pathList?.toggleAttribute('data-reorderable', populatedCount > 1);
      const label = pathList?.dataset.label?.toLowerCase() ?? 'path';
      rows.forEach((row, index) => {
        row.dataset.index = String(index);
        row.querySelector('.path-list-index').textContent = '[' + index + ']';
        const input = row.querySelector('[data-path-list-input]');
        input.dataset.index = String(index);
        input.setAttribute('aria-label', label + ' path ' + index);
        row.querySelectorAll('[data-path-list-action]').forEach((button) => {
          const action = button.dataset.pathListAction;
          button.dataset.index = String(index);
          const hidden =
            (action === 'moveUp' && (index === 0 || index >= populatedCount)) ||
            (action === 'moveDown' && index >= populatedCount - 1) ||
            (action === 'remove' && index >= populatedCount);
          button.classList.toggle('path-list-button-hidden', hidden);
        });
      });
    };
    const ensureTrailingBlankPath = () => {
      const rows = Array.from(document.querySelectorAll('[data-path-list-row]'));
      const lastRow = rows.at(-1);
      const lastInput = lastRow?.querySelector('[data-path-list-input]');
      if (!lastRow || !lastInput || lastInput.value.trim().length === 0) {
        refreshPathListRows();
        return;
      }
      const blankRow = lastRow.cloneNode(true);
      blankRow.querySelector('[data-path-list-input]').value = '';
      lastRow.parentElement?.appendChild(blankRow);
      refreshPathListRows();
    };
    const updateRunAnalysis = () => {
      if (runAnalysis) {
        const selected = analysisOptions();
        const inputs = analysisInputs();
        const hasRequiredInput = analysisMode === 'profiling'
          ? inputs.profilingDataPaths.length > 0
          : Boolean(inputs.modelPath);
        runAnalysis.disabled = !targetProfile?.value ||
          (!selected.performance && !selected.compatibility) ||
          !hasRequiredInput;
      }
    };
    document.querySelectorAll('[data-command]').forEach((button) => {
      button.addEventListener('click', () => {
        if (button.dataset.command === 'runAnalysis') {
          vscode.postMessage({
            command: 'runAnalysis',
            targetProfile: targetProfile?.value ?? '',
            analysisMode,
            ...analysisOptions(),
            ...analysisInputs(),
          });
        } else if (button.dataset.command === 'selectAnalysisMode') {
          vscode.postMessage({ command: 'selectAnalysisMode', analysisMode: button.dataset.mode });
        } else {
          vscode.postMessage({ command: button.dataset.command });
        }
      });
    });
    targetProfile?.addEventListener('change', (event) => {
      vscode.postMessage({ command: 'selectTargetProfile', targetProfile: event.target.value });
      updateRunAnalysis();
    });
    [performance, compatibility].forEach((checkbox) => checkbox?.addEventListener('change', () => {
      vscode.postMessage({ command: 'selectAnalysisOptions', ...analysisOptions() });
      updateRunAnalysis();
    }));
    modelPath?.addEventListener('input', () => {
      vscode.postMessage({ command: 'selectAnalysisInputs', ...analysisInputs() });
      updateRunAnalysis();
    });
    document.addEventListener('input', (event) => {
      if (!(event.target instanceof HTMLInputElement) || !event.target.matches('[data-path-list-input]')) {
        return;
      }
      ensureTrailingBlankPath();
      vscode.postMessage({ command: 'selectAnalysisInputs', ...analysisInputs() });
      updateRunAnalysis();
    });
    document.addEventListener('click', (event) => {
      const button = event.target instanceof Element
        ? event.target.closest('[data-path-list-action]')
        : null;
      if (!button || button.classList.contains('path-list-button-hidden')) {
        return;
      }
      if (button.dataset.pathListAction === 'remove') {
        button.closest('[data-path-list-row]')?.remove();
        ensureTrailingBlankPath();
        vscode.postMessage({ command: 'selectAnalysisInputs', ...analysisInputs() });
        updateRunAnalysis();
        return;
      }
      vscode.postMessage({
        command: 'editProfilingDataPaths',
        pathListAction: button.dataset.pathListAction,
        index: Number(button.dataset.index),
        profilingDataPaths: profilingDataPaths(),
      });
    });
    refreshPathListRows();
    updateRunAnalysis();
  </script>
</body>
</html>`;
}

function stateContent(state: NewAnalysisState): string {
  switch (state.kind) {
    case "starting":
      return `<p class="status"><span class="spinner"></span>Starting MLIA…</p>`;
    case "setupRequired":
      return `<p class="status">Set up the MLIA environment to get started.</p>${environmentActions(false)}`;
    case "incomplete":
      return `<p class="status">MLIA environment setup is incomplete. Refresh to repair it.</p>${environmentActions(false)}`;
    case "available":
      return `<p class="status">MLIA environment found, but its version and target profiles have not been loaded.</p>${environmentActions(false)}`;
    case "refreshing":
      return `<p class="status"><span class="spinner"></span>${escapeHtml(state.message ?? "Refreshing MLIA environment…")}</p>`;
    case "ready":
      return analysisControls(state);
    case "failed":
      return `<p class="status">${escapeHtml(state.message)}</p>${environmentActions(true)}`;
  }
}

function analysisControls(state: Extract<NewAnalysisState, { kind: "ready" }>): string {
  const targets = state.targets.filter((target) =>
    target.backends.some((backend) => backend.capabilities[state.analysisMode].length > 0),
  );
  const availableProfiles = new Set(targets.flatMap(({ profiles }) => profiles));
  const selectedProfile = state.selectedTargetProfile && availableProfiles.has(state.selectedTargetProfile)
    ? state.selectedTargetProfile
    : undefined;
  const options = [
    `<option value=""${selectedProfile ? "" : " selected"}>Select target profile</option>`,
    ...targets.map(({ prettyName, profiles }) =>
      `<optgroup label="${escapeHtml(prettyName)}">${profiles.map(
        (profile) => `<option value="${escapeHtml(profile)}"${profile === selectedProfile ? " selected" : ""}>${escapeHtml(profile)}</option>`,
      ).join("")}</optgroup>`,
    ),
  ].join("");
  const categories = selectedProfile
    ? new Set(
        targets
          .find(({ profiles }) => profiles.includes(selectedProfile))
          ?.backends.flatMap((backend) => backend.capabilities[state.analysisMode]) ?? [],
      )
    : new Set<string>();
  const performanceSupported = categories.has("performance");
  const compatibilitySupported = categories.has("compatibility");
  const selectedAnalysis =
    (state.analysisOptions.performance && performanceSupported) ||
    (state.analysisOptions.compatibility && compatibilitySupported);
  const hasRequiredInput = state.analysisMode === "estimation"
    ? Boolean(state.analysisInputs.modelPath)
    : state.analysisInputs.profilingDataPaths.length > 0 &&
      state.analysisInputs.profilingDataPaths.every((path) => path.trim().length > 0);
  const enabled = Boolean(selectedProfile && selectedAnalysis && hasRequiredInput);
  const fields = state.analysisMode === "estimation"
    ? pathField("model-path", "Source model (required)", state.analysisInputs.modelPath, "pickModelPath", "Select source model")
    : [
        PathList({
          id: "profiling-data",
          label: "Profiling data",
          paths: state.analysisInputs.profilingDataPaths,
          placeholder: "Profiling data path",
          required: true,
        }),
        pathField("model-path", "Source model (optional)", state.analysisInputs.modelPath, "pickModelPath", "Select source model"),
      ].join("");
  return `<div class="analysis-controls" data-analysis-mode="${state.analysisMode}">
  <div class="mode-tabs" role="tablist" aria-label="Analysis input mode">
    ${modeTab("estimation", "Estimation", state.analysisMode)}
    ${modeTab("profiling", "Profiling", state.analysisMode)}
  </div>
  <div class="path-fields">${fields}</div>
  <div class="analysis-row">
    <select id="target-profile" aria-label="Target profile">${options}</select>
    <div class="analysis-types" role="group" aria-label="Analysis types">
      <label><input id="analysis-performance" type="checkbox"${state.analysisOptions.performance && performanceSupported ? " checked" : ""}${performanceSupported ? "" : " disabled"}>Performance</label>
      <label><input id="analysis-compatibility" type="checkbox"${state.analysisOptions.compatibility && compatibilitySupported ? " checked" : ""}${compatibilitySupported ? "" : " disabled"}>Compatibility</label>
    </div>
    <button data-command="runAnalysis"${enabled ? "" : " disabled"}>Run Analysis</button>
  </div>
  </div>`;
}

function modeTab(mode: MliaAnalysisMode, label: string, selected: MliaAnalysisMode): string {
  return `<button class="mode-tab${mode === selected ? " selected" : ""}" data-command="selectAnalysisMode" data-mode="${mode}" role="tab" aria-selected="${mode === selected}">${label}</button>`;
}

function pathField(
  id: string,
  label: string,
  value: string | undefined,
  command: string,
  pickerLabel: string,
): string {
  return `<div class="path-field">
    <div class="path-control">
      <input id="${id}" type="text" value="${escapeHtml(value ?? "")}" placeholder="${label}" aria-label="${label}">
      <button class="secondary" data-command="${command}" type="button" aria-label="${pickerLabel}" title="${pickerLabel}">…</button>
    </div>
  </div>`;
}

function analysisInputs(modelPath: string, profilingDataPaths: string[]): AnalysisInputs {
  return {
    modelPath: modelPath || undefined,
    profilingDataPaths,
  };
}

type PathListAction = "browse" | "remove" | "moveUp" | "moveDown";

function isPathListAction(value: unknown): value is PathListAction {
  return value === "browse" || value === "remove" ||
    value === "moveUp" || value === "moveDown";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function environmentActions(showLog: boolean): string {
  return `<div class="actions">
    <button data-command="refreshEnvironment">Refresh MLIA Environment</button>
    ${showLog ? '<button class="secondary" data-command="showLog">Show Log</button>' : ""}
  </div>`;
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
