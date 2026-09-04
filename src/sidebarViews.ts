import * as vscode from "vscode";

import { analysisActivationCommand } from "./analysisActivation";
import { analysisPresentation } from "./analysisPresentation";
import { Analysis, AnalysisStore } from "./analysisStore";

export class AnalysisTreeItem extends vscode.TreeItem {
  public constructor(public readonly analysis: Analysis, current: boolean, controllable: boolean) {
    const presentation = analysisPresentation(analysis);
    super(presentation.inputSummary, vscode.TreeItemCollapsibleState.None);
    this.id = analysis.id;
    this.description = presentation.treeDescription;
    this.tooltip = presentation.tooltipDetails.join("\n");
    const icon = current
      ? "pinned"
      : analysis.status === "complete"
        ? undefined
        : analysis.status === "running"
          ? "loading~spin"
          : statusIcon(analysis.status);
    this.iconPath = icon ? new vscode.ThemeIcon(icon) : undefined;
    const ownership = analysis.status === "running" ? (controllable ? "controllable" : "external") : "other";
    this.contextValue = `analysis.${analysis.status}.${ownership}.${current ? "current" : "other"}`;
    this.command = analysisActivationCommand(analysis);
  }
}

export class AnalysesTreeProvider implements vscode.TreeDataProvider<AnalysisTreeItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  public readonly onDidChangeTreeData = this.changed.event;

  public constructor(private readonly store: AnalysisStore) {}

  public refresh(): void {
    this.changed.fire();
  }

  public getTreeItem(item: AnalysisTreeItem): vscode.TreeItem {
    return item;
  }

  public getChildren(): AnalysisTreeItem[] {
    const currentId = this.store.currentAnalysis?.id;
    return this.store.analyses.map(
      (analysis) => new AnalysisTreeItem(
        analysis,
        analysis.id === currentId,
        this.store.isControllable(analysis),
      ),
    );
  }
}

function statusIcon(status: Analysis["status"]): string {
  switch (status) {
    case "complete":
      return "pass-filled";
    case "failed":
      return "error";
    case "cancelled":
      return "circle-slash";
    case "interrupted":
      return "debug-disconnect";
    case "running":
      return "loading~spin";
  }
}
