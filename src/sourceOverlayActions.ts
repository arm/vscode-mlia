import { MappedSourceLineResultRecord, SourceAnnotationIndex } from "./sourceAnnotations";
import { SourceCodeLensAction } from "./sourceCodeLens";
import { SourceEntityReference } from "./sourceLines";

export type SourceOverlayOpenOutcome = "ready" | "selected";

export interface SourceOverlayActionExecutor {
  execute: (action: SourceCodeLensAction) => Promise<boolean>;
}

export function executeSourceOverlayAction(
  controller: SourceOverlayActionExecutor,
  action?: SourceCodeLensAction,
): Promise<boolean> | false {
  return action ? controller.execute(action) : false;
}

export interface SourceOverlayActionHost<Analysis, PreparedSource> {
  currentAnalysis: () => Analysis | undefined;
  openAnalysis: (
    analysis: Analysis,
    entity: SourceEntityReference,
  ) => Promise<SourceOverlayOpenOutcome | false>;
  canSelectEntity: (analysis: Analysis, entity: SourceEntityReference) => boolean;
  selectEntity: (analysis: Analysis, entity: SourceEntityReference) => Promise<boolean>;
  prepareSource: (
    analysis: Analysis,
    record: MappedSourceLineResultRecord,
  ) => Promise<PreparedSource | undefined>;
  revealSource: (
    analysis: Analysis,
    record: MappedSourceLineResultRecord,
    prepared: PreparedSource,
  ) => Promise<boolean>;
}

export class SourceOverlayActionController<Analysis extends { id: string }, PreparedSource> {
  public constructor(
    private readonly index: SourceAnnotationIndex,
    private readonly host: SourceOverlayActionHost<Analysis, PreparedSource>,
  ) {}

  public async execute(action: SourceCodeLensAction): Promise<boolean> {
    const analysis = this.actionAnalysis(action);
    if (!analysis || !this.host.canSelectEntity(analysis, action.entity)) {
      return false;
    }

    let record: MappedSourceLineResultRecord | undefined;
    let prepared: PreparedSource | undefined;
    if (action.kind === "relationship") {
      record = this.index.sourceLineRecordForEntity(action.entity);
      if (!record) {
        return false;
      }
      prepared = await this.host.prepareSource(analysis, record);
      if (
        prepared === undefined ||
        !this.isCurrent(analysis, action) ||
        this.index.sourceLineRecordForEntity(action.entity) !== record ||
        !this.host.canSelectEntity(analysis, action.entity)
      ) {
        return false;
      }
    }

    if (record && prepared !== undefined) {
      if (!await this.host.revealSource(analysis, record, prepared)) {
        return false;
      }
      if (
        !this.isCurrent(analysis, action) ||
        this.index.sourceLineRecordForEntity(action.entity) !== record ||
        !this.host.canSelectEntity(analysis, action.entity)
      ) {
        return false;
      }
    }

    // Source reveal and Model Explorer updates are separate VS Code UI effects.
    // Reveal first so a reveal failure cannot open/select a panel. If the later
    // panel operation fails, the already-revealed source cannot be rolled back.
    let opened: SourceOverlayOpenOutcome | false;
    try {
      opened = await this.host.openAnalysis(analysis, action.entity);
    } catch {
      // Panel loading is a host UI operation. Its current-generation error is
      // rendered by the host; the CodeLens command reports the failed action.
      return false;
    }
    if (
      !opened ||
      !this.isCurrent(analysis, action) ||
      !this.host.canSelectEntity(analysis, action.entity)
    ) {
      return false;
    }

    if (opened === "selected") {
      return this.isCurrent(analysis, action);
    }
    if (!await this.host.selectEntity(analysis, action.entity)) {
      return false;
    }
    return this.isCurrent(analysis, action);
  }

  private actionAnalysis(action: SourceCodeLensAction): Analysis | undefined {
    const current = this.host.currentAnalysis();
    return current?.id === action.analysisId ? current : undefined;
  }

  private isCurrent(analysis: Analysis, action: SourceCodeLensAction): boolean {
    const current = this.host.currentAnalysis();
    return current === analysis && current.id === action.analysisId;
  }
}
