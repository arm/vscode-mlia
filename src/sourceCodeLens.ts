import { formatDisplayNumber } from "./numberFormatting";
import { MappedSourceLineResultRecord } from "./sourceAnnotations";
import {
  SourceEntityReference,
  SourceLineMetricAggregate,
  SourceLineMetricReasonCode,
  SourceModelMetric,
  sourceRecordMatchesOverlay,
} from "./sourceLines";

export const sourceOverlayActionCommand = "mlia-vscode.executeSourceOverlayAction";

export type SourceCodeLensKind = "caller" | "overlay" | "called";

export interface SourceCodeLensAction {
  analysisId: string;
  kind: "entity" | "relationship";
  entity: SourceEntityReference;
}

export interface SourceCodeLensDescriptor {
  line: number;
  kind: SourceCodeLensKind;
  title: string;
  tooltip: string;
  action?: SourceCodeLensAction;
}

export interface SourceCodeLensCommand {
  title: string;
  command: string;
  tooltip: string;
  arguments?: SourceCodeLensAction[];
}

const reasonDescriptions: Record<SourceLineMetricReasonCode, string> = {
  missing_metric: "some metric data is missing",
  conflicting_equivalent_figures: "equivalent metric figures conflict",
  overlapping_leaf_sets: "metric coverage overlaps",
  unresolved_hierarchy: "source hierarchy coverage is unresolved",
  unsupported_aggregation: "metric figures cannot be aggregated safely",
  conflicting_metric_identity: "multiple metric identities conflict",
};

export class SourceCodeLensProducer {
  private readonly refreshListeners = new Set<() => void>();

  public constructor(private readonly isEnabled: () => boolean) {}

  public provide(
    records: readonly MappedSourceLineResultRecord[],
    analysisId: string | undefined,
    lineCount = Number.POSITIVE_INFINITY,
  ): SourceCodeLensDescriptor[] {
    if (!analysisId || !this.isEnabled()) {
      return [];
    }
    return sourceCodeLensDescriptors(records, analysisId, lineCount);
  }

  public onDidRefresh(listener: () => void): { dispose: () => void } {
    this.refreshListeners.add(listener);
    return { dispose: () => this.refreshListeners.delete(listener) };
  }

  public refresh(): void {
    for (const listener of this.refreshListeners) {
      listener();
    }
  }

  public dispose(): void {
    this.refreshListeners.clear();
  }
}

export function sourceCodeLensDescriptors(
  records: readonly MappedSourceLineResultRecord[],
  analysisId: string,
  lineCount = Number.POSITIVE_INFINITY,
): SourceCodeLensDescriptor[] {
  return records
    .filter((record) =>
      record.line >= 1 &&
      record.line <= lineCount &&
      (record.selectedOverlay === undefined
        ? record.resultIndex === 0
        : sourceRecordMatchesOverlay(record, record.selectedOverlay))
    )
    .flatMap((record) => descriptorsForRecord(record, analysisId));
}

export function sourceCodeLensCommand(
  descriptor: SourceCodeLensDescriptor,
): SourceCodeLensCommand {
  // VS Code renders an empty command identifier as plain CodeLens text instead of a link.
  return {
    title: descriptor.title,
    command: descriptor.action ? sourceOverlayActionCommand : "",
    tooltip: descriptor.tooltip,
    ...(descriptor.action ? { arguments: [descriptor.action] } : {}),
  };
}

function descriptorsForRecord(
  record: MappedSourceLineResultRecord,
  analysisId: string,
): SourceCodeLensDescriptor[] {
  const line = record.line - 1;
  const overlay = overlayDescriptor(line, record, analysisId);
  const descriptors: SourceCodeLensDescriptor[] = overlay ? [overlay] : [];
  const caller = relationshipDescriptor(line, "caller", record.callers, analysisId);
  if (caller) {
    descriptors.push(caller);
  }
  const called = relationshipDescriptor(line, "called", record.called, analysisId);
  if (called) {
    descriptors.push(called);
  }
  return descriptors;
}

function overlayDescriptor(
  line: number,
  record: MappedSourceLineResultRecord,
  analysisId: string,
): SourceCodeLensDescriptor | undefined {
  if (!record.selectedOverlay) {
    return undefined;
  }
  if (record.selectedOverlay.category !== "metric") {
    const category = record.selectedOverlay.category;
    const presentation = record.selectedPresentation;
    const descriptor: SourceCodeLensDescriptor = {
      line,
      kind: "overlay",
      title: presentation
        ? `MLIA: ${displayCategory(category)} — ${presentation.value}`
        : `MLIA: ${displayCategory(category)} unavailable`,
      tooltip: presentation?.tooltip ?? `MLIA ${category} is unavailable for this source line.`,
    };
    const entity = preferredOverlayEntity(record.entities);
    return entity
      ? { ...descriptor, action: { analysisId, kind: "entity", entity } }
      : descriptor;
  }
  return metricDescriptor(line, record, analysisId);
}

function displayCategory(category: string): string {
  return category[0].toUpperCase() + category.slice(1);
}

function metricDescriptor(
  line: number,
  record: MappedSourceLineResultRecord,
  analysisId: string,
): SourceCodeLensDescriptor {
  const metric = record.selectedMetric;
  const unit = metric.unit.trim() || (metric.name === "total_cycles" ? "cycles" : "units");
  const descriptor: SourceCodeLensDescriptor = {
    line,
    kind: "overlay",
    title: metricTitle(metric, unit, record.selectedModelMetric),
    tooltip: metricTooltip(metric),
  };
  const entity = preferredOverlayEntity(record.entities);
  return entity
    ? {
        ...descriptor,
        action: { analysisId, kind: "entity", entity },
      }
    : descriptor;
}

function preferredOverlayEntity(
  entities: readonly SourceEntityReference[],
): SourceEntityReference | undefined {
  return entities.find(({ entityId }) => entityId.startsWith("code_stack/")) ?? entities[0];
}

function metricTitle(
  metric: SourceLineMetricAggregate,
  unit: string,
  modelMetric: SourceModelMetric | undefined,
): string {
  const name = metricDisplayName(metric.name);
  if (metric.status === "unavailable" || metric.value === undefined) {
    return `MLIA: ${name} unavailable`;
  }
  const value = formatDisplayNumber(metric.value);
  const percentage = percentageOfModelTotal(metric, modelMetric);
  const modelShare = percentage === undefined ? "" : ` (${percentage} of model)`;
  if (metric.name === "total_cycles") {
    return metric.status === "partial"
      ? `MLIA: partial total — ${value} ${unit}${modelShare}`
      : `MLIA: ${value} ${unit}${modelShare}`;
  }
  return metric.status === "partial"
    ? `MLIA: partial ${name} — ${value} ${unit}${modelShare}`
    : `MLIA: ${name} — ${value} ${unit}${modelShare}`;
}

function percentageOfModelTotal(
  metric: SourceLineMetricAggregate,
  modelMetric: SourceModelMetric | undefined,
): string | undefined {
  if (
    metric.value === undefined ||
    metric.value < 0 ||
    modelMetric === undefined ||
    modelMetric.value <= 0 ||
    normalizedUnit(metric.unit) !== normalizedUnit(modelMetric.unit) ||
    Object.keys(metric.breakdownQualifiers).length > 0 ||
    JSON.stringify(metric.metricQualifiers) !== JSON.stringify(modelMetric.qualifiers)
  ) {
    return undefined;
  }
  const percentage = metric.value / modelMetric.value * 100;
  if (!Number.isFinite(percentage)) {
    return undefined;
  }
  if (percentage > 0 && percentage < 0.01) {
    return "<0.01%";
  }
  return `${formatDisplayNumber(percentage)}%`;
}

function normalizedUnit(unit: string): string {
  return unit.trim();
}

function metricTooltip(metric: SourceLineMetricAggregate): string {
  if (metric.name === "total_cycles") {
    if (metric.status === "complete") {
      return "Complete MLIA total for this source line.";
    }
    const totalCycleReasons: Record<SourceLineMetricReasonCode, string> = {
      missing_metric: "some cycle data is missing",
      conflicting_equivalent_figures: "equivalent cycle figures conflict",
      overlapping_leaf_sets: "cycle coverage overlaps",
      unresolved_hierarchy: "source hierarchy coverage is unresolved",
      unsupported_aggregation: "cycle figures cannot be aggregated safely",
      conflicting_metric_identity: "multiple total cycle metrics conflict",
    };
    const reasons = [...new Set(metric.reasons.map(({ code }) => totalCycleReasons[code]))];
    const explanation = reasons.length > 0 ? reasons.join("; ") : "some cycle data is unavailable";
    return metric.status === "partial"
      ? `Partial MLIA total: ${explanation}.`
      : `MLIA total unavailable: ${explanation}.`;
  }

  const name = metricDisplayName(metric.name);
  if (metric.status === "complete") {
    return `Complete MLIA ${name} total for this source line.`;
  }
  const reasons = [...new Set(metric.reasons.map(({ code }) => reasonDescriptions[code]))];
  const explanation = reasons.length > 0
    ? reasons.join("; ")
    : "some metric data is unavailable";
  return metric.status === "partial"
    ? `Partial MLIA ${name} total: ${explanation}.`
    : `MLIA ${name} unavailable: ${explanation}.`;
}

function metricDisplayName(name: string): string {
  return name.replace(/_/gu, " ");
}

function relationshipDescriptor(
  line: number,
  kind: "caller" | "called",
  targets: readonly SourceEntityReference[],
  analysisId: string,
): SourceCodeLensDescriptor | undefined {
  if (targets.length === 0) {
    return undefined;
  }
  const caller = kind === "caller";
  const unique = targets.length === 1;
  const descriptor: SourceCodeLensDescriptor = {
    line,
    kind,
    title: caller
      ? unique ? "← Called by" : `Called by (${targets.length})`
      : unique ? "Calls into →" : `Calls into (${targets.length})`,
    tooltip: unique
      ? caller ? "Go to the calling source line." : "Go to the called source line."
      : caller
        ? "Go to the first calling source line."
        : "Go to the first called source line.",
    action: { analysisId, kind: "relationship", entity: targets[0] },
  };
  return descriptor;
}
