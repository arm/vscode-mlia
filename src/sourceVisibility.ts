export const showCodeLensConfiguration = "mlia-vscode.showCodeLens";
export const showHeatmapConfiguration = "mlia-vscode.showHeatmap";

export interface SourceVisibilityConfigurationChange {
  affectsConfiguration: (section: string) => boolean;
}

export interface SourceVisibilityControllerOptions {
  refreshCodeLenses: () => void;
  setHeatmapEnabled: (enabled: boolean) => void;
  isHeatmapEnabled: () => boolean;
}

export class SourceVisibilityController {
  public constructor(private readonly options: SourceVisibilityControllerOptions) {}

  public initialize(): void {
    this.options.setHeatmapEnabled(this.options.isHeatmapEnabled());
  }

  public configurationChanged(event: SourceVisibilityConfigurationChange): void {
    if (event.affectsConfiguration(showCodeLensConfiguration)) {
      this.options.refreshCodeLenses();
    }
    if (event.affectsConfiguration(showHeatmapConfiguration)) {
      this.options.setHeatmapEnabled(this.options.isHeatmapEnabled());
    }
  }
}
