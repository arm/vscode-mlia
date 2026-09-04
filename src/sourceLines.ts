import { deepFreeze } from "./deepFreeze";
import { buildOverlayCatalog, defaultOverlayKey, OverlayKey, overlayKeyId } from "./overlayCatalog";

export interface SourceEntityReference {
  readonly resultIndex: number;
  readonly entityId: string;
}

export interface SourceCodeStackRecord extends SourceEntityReference {
  readonly resultKind: string;
  readonly source?: {
    readonly file: string;
    readonly line: number;
  };
}

export interface SourceResultRecord {
  readonly resultIndex: number;
  readonly resultKind: string;
  readonly reportedCodeStackIds: readonly string[];
  readonly mappedCodeStacks: readonly SourceCodeStackRecord[];
}

export interface SourceRecordCollection {
  readonly sourceLines: readonly SourceLineResultRecord[];
  readonly results: readonly SourceResultRecord[];
}

export type SourceLineQualifierValue =
  | null
  | string
  | boolean
  | number
  | readonly SourceLineQualifierValue[]
  | { readonly [key: string]: SourceLineQualifierValue };

export type SourceLineQualifiers = Readonly<Record<string, SourceLineQualifierValue>>;

export type SourceLineMetricStatus = "complete" | "partial" | "unavailable";

export type SourceLineMetricReasonCode =
  | "missing_metric"
  | "conflicting_equivalent_figures"
  | "overlapping_leaf_sets"
  | "unresolved_hierarchy"
  | "unsupported_aggregation"
  | "conflicting_metric_identity";

export interface SourceLineMetricReason {
  readonly code: SourceLineMetricReasonCode;
  readonly entityReferences: readonly SourceEntityReference[];
  readonly leafIds: readonly string[];
}

export interface SourceLineMetricAggregate {
  readonly name: string;
  readonly unit: string;
  readonly breakdownQualifiers: SourceLineQualifiers;
  readonly metricQualifiers: SourceLineQualifiers;
  readonly aggregation?: string;
  readonly samples?: number;
  readonly value?: number;
  readonly status: SourceLineMetricStatus;
  readonly contributors: readonly SourceEntityReference[];
  readonly missingEntityReferences: readonly SourceEntityReference[];
  readonly ambiguousEntityReferences: readonly SourceEntityReference[];
  readonly coveredLeafIds: readonly string[];
  readonly uncoveredLeafIds: readonly string[];
  readonly reasons: readonly SourceLineMetricReason[];
}

interface MetricIdentity {
  readonly key: string;
  readonly name: string;
  readonly unit: string;
  readonly breakdownQualifiers: SourceLineQualifiers;
  readonly metricQualifiers: SourceLineQualifiers;
}

export interface SourceLineHeatmapColor {
  readonly hex: string;
  readonly opacity: number;
  readonly rgba: string;
  readonly basis: string | "unavailable";
}

export interface SourceLineOverlayPresentation {
  readonly category: Exclude<OverlayKey["category"], "metric">;
  readonly value: string;
  readonly tooltip: string;
  readonly color: SourceLineHeatmapColor;
}

export interface SourceModelMetric {
  readonly name: string;
  readonly value: number;
  readonly unit: string;
  readonly qualifiers: SourceLineQualifiers;
}

export interface SourceLineResultRecord {
  readonly file: string;
  readonly line: number;
  readonly resultIndex: number;
  readonly resultKind: string;
  readonly entities: readonly SourceEntityReference[];
  readonly metrics: readonly SourceLineMetricAggregate[];
  readonly modelMetrics: readonly SourceModelMetric[];
  readonly totalCycles: SourceLineMetricAggregate;
  readonly overlayPresentations: readonly SourceLineOverlayPresentation[];
  readonly selectedOverlay?: OverlayKey;
  readonly selectedPresentation?: SourceLineOverlayPresentation;
  readonly selectedMetric: SourceLineMetricAggregate;
  readonly selectedModelMetric?: SourceModelMetric;
  readonly color: SourceLineHeatmapColor;
  readonly callers: readonly SourceEntityReference[];
  readonly called: readonly SourceEntityReference[];
}

type UnprojectedSourceLineResultRecord = Omit<
  SourceLineResultRecord,
  "selectedOverlay" | "selectedPresentation" | "selectedMetric" | "selectedModelMetric" | "color"
>;

interface ParsedEntity {
  id: string;
  kind: string;
  parentIds: string[];
  childIds: string[];
  hasMalformedChildReferences: boolean;
  file?: string;
  line?: number;
  placement?: unknown;
  status?: unknown;
}

interface EntityGraph {
  entities: Map<string, ParsedEntity>;
  children: Map<string, Set<string>>;
  parents: Map<string, Set<string>>;
  unresolvedChildren: Set<string>;
  reportedCodeStackIds: Set<string>;
}


interface KnownMetricFigure {
  kind: "known";
  value: number;
  aggregation?: string;
  samples?: number;
  signature: string;
}

interface MissingMetricFigure {
  kind: "missing";
}

interface UnsupportedMetricFigure {
  kind: "unsupported";
}

interface ConflictingMetricFigure {
  kind: "conflicting";
}

type MetricFigure =
  | KnownMetricFigure
  | MissingMetricFigure
  | UnsupportedMetricFigure
  | ConflictingMetricFigure;

interface EntityMetricFigure {
  identity: MetricIdentity;
  figure: MetricFigure;
}

const MIN_COLOR = [0x2e, 0x7d, 0x32] as const;
const MAX_COLOR = [0xc6, 0x28, 0x28] as const;
const FALLBACK_COLOR = "#757575";
const COMPLETE_OPACITY = 0.28;
const PARTIAL_OPACITY = 0.12;
const FALLBACK_OPACITY = 0.08;

/**
 * Build immutable, raw-source-path records from standardized MLIA output and the
 * result-scoped Model Explorer mappings. Local source mapping is deliberately not
 * part of this operation so callers can reindex after settings changes without
 * reparsing analysis data.
 */
export function buildSourceRecords(
  standardizedOutput: unknown,
  entityNodeMappings: unknown,
): SourceRecordCollection {
  const outputResults = objectArrayProperty(standardizedOutput, "results");
  if (!outputResults) {
    return deepFreeze({ sourceLines: [], results: [] });
  }
  const mappingResults = objectArrayProperty(entityNodeMappings, "results") ?? [];

  const mappedIdsByResult = mappedEntityIdsByResult(mappingResults);
  const records: UnprojectedSourceLineResultRecord[] = [];
  const results: SourceResultRecord[] = [];
  for (const [resultIndex, outputResult] of outputResults.entries()) {
    if (!isRecord(outputResult)) {
      continue;
    }
    const built = buildResultSourceRecords(
      outputResult,
      resultIndex,
      mappedIdsByResult.get(resultIndex) ?? new Set(),
    );
    records.push(...built.sourceLines);
    results.push(built.result);
  }

  const sorted = records.sort(compareSourceLines);
  return deepFreeze({
    sourceLines: projectSourceMetric(
      sorted,
      defaultOverlayKey(buildOverlayCatalog(standardizedOutput)),
    ),
    results,
  });
}

/**
 * Build immutable, raw-source-path line records from standardized MLIA output.
 * Lines without a numeric total use a neutral #757575 color at opacity 0.08.
 */
export function buildSourceLines(
  standardizedOutput: unknown,
  entityNodeMappings: unknown,
): readonly SourceLineResultRecord[] {
  return buildSourceRecords(standardizedOutput, entityNodeMappings).sourceLines;
}

function buildResultSourceRecords(
  result: Readonly<Record<string, unknown>>,
  resultIndex: number,
  mappedIds: ReadonlySet<string>,
): { result: SourceResultRecord; sourceLines: UnprojectedSourceLineResultRecord[] } {
  const resultKind = typeof result.kind === "string" && result.kind.length > 0
    ? result.kind
    : "result";
  const entityValues = Array.isArray(result.entities) ? result.entities : [];
  const graph = buildEntityGraph(entityValues);
  const mappedCodeStackIds = new Set(
    [...mappedIds].filter((id) => graph.entities.get(id)?.kind === "code_stack"),
  );
  const mappedCodeStacks = [...mappedCodeStackIds].sort().map((entityId) => {
    const entity = graph.entities.get(entityId) as ParsedEntity;
    return {
      resultIndex,
      resultKind,
      entityId,
      ...(entity.file === undefined || entity.line === undefined
        ? {}
        : { source: { file: entity.file, line: entity.line } }),
    };
  });
  const leafSets = resolveSourceOperatorLeafSets(graph);
  const figuresByEntity = parseEntityMetrics(result.breakdowns, graph.entities, "code_line");
  const modelMetrics = parseModelMetrics(result.metrics);
  const lineEntities = [...graph.entities.values()]
    .filter((entity) =>
      entity.kind === "code_line" &&
      entity.file !== undefined &&
      entity.line !== undefined
    )
    .sort((left, right) =>
      (left.file as string).localeCompare(right.file as string) ||
      (left.line as number) - (right.line as number) ||
      left.id.localeCompare(right.id)
    );

  const sourceLines = lineEntities.map((lineEntity) => {
    const lineReference = reference(resultIndex, lineEntity.id);
    const stackEntities = [...(graph.children.get(lineEntity.id) ?? [])]
      .map((entityId) => graph.entities.get(entityId))
      .filter((entity): entity is ParsedEntity => entity?.kind === "code_stack")
      .sort((left, right) => left.id.localeCompare(right.id));
    const references = [
      lineReference,
      ...stackEntities.map((entity) => reference(resultIndex, entity.id)),
    ];
    const metrics = [...(figuresByEntity.get(lineEntity.id)?.values() ?? [])]
      .sort((left, right) => left.identity.key.localeCompare(right.identity.key))
      .map((metric) => directLineMetric(resultIndex, lineEntity, metric, leafSets));
    const totalCycles = selectTotalCycles(resultIndex, [lineEntity], leafSets, metrics);
    return {
      file: lineEntity.file as string,
      line: lineEntity.line as number,
      resultIndex,
      resultKind,
      entities: references,
      metrics,
      modelMetrics,
      totalCycles,
      overlayPresentations: sourceOverlayPresentations(result, [lineEntity], graph),
      callers: lineRelationships(resultIndex, stackEntities, graph, mappedCodeStackIds, "parents"),
      called: lineRelationships(resultIndex, stackEntities, graph, mappedCodeStackIds, "children"),
    };
  });
  return {
    result: {
      resultIndex,
      resultKind,
      reportedCodeStackIds: [...graph.reportedCodeStackIds].sort(),
      mappedCodeStacks,
    },
    sourceLines,
  };
}

function sourcePresentationEntities(
  origins: readonly ParsedEntity[],
  graph: EntityGraph,
): ParsedEntity[] {
  const included = new Map<string, ParsedEntity>();
  const pending = origins.map(({ id }) => id);
  while (pending.length > 0) {
    const entityId = pending.shift() as string;
    if (included.has(entityId)) {
      continue;
    }
    const entity = graph.entities.get(entityId);
    if (!entity) {
      continue;
    }
    included.set(entityId, entity);
    pending.push(...[...(graph.children.get(entityId) ?? [])].sort());
  }
  return [...included.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function sourceOverlayPresentations(
  result: Readonly<Record<string, unknown>>,
  entities: readonly ParsedEntity[],
  graph: EntityGraph,
): SourceLineOverlayPresentation[] {
  const presentationEntities = sourcePresentationEntities(entities, graph);
  const entityIds = new Set(presentationEntities.map(({ id }) => id));
  const presentations: SourceLineOverlayPresentation[] = [];
  const placementValues = presentationEntities
    .map(({ placement }) => placement)
    .filter((value) => value !== undefined && value !== null)
    .map((value) => {
      const text = stringifyOverlayValue(value);
      const normalized = text.toLowerCase();
      return {
        text: normalized === "npu" || normalized === "nx" || normalized === "cpu" || normalized === "gpu"
          ? text.toUpperCase()
          : text,
        color: placementColor(text),
      };
    });
  const placement = categoricalPresentation(
    "placement",
    placementValues.map(({ text }) => text),
    placementValues[0]?.color,
  );
  if (placement) {
    presentations.push(placement);
  }

  const status = categoricalPresentation(
    "status",
    presentationEntities
      .map(({ status: value }) => value)
      .filter((value) => value !== undefined && value !== null)
      .map(stringifyOverlayValue),
  );
  if (status) {
    presentations.push(status);
  }

  const checkValues: Array<{ text: string; color?: string }> = [];
  for (const value of Array.isArray(result.checks) ? result.checks : []) {
    if (!isRecord(value) || typeof value.entity_id !== "string" || !entityIds.has(value.entity_id)) {
      continue;
    }
    const details = isRecord(value.details) ? value.details : undefined;
    const messages = Array.isArray(details?.reasons)
      ? details.reasons.flatMap((reason) => {
          if (!isRecord(reason)) {
            return [];
          }
          const description = reason.description;
          const message = description !== undefined && description !== null && String(description).length > 0
            ? description
            : reason.detail;
          return message === undefined || message === null || String(message).length === 0
            ? []
            : [String(message)];
        })
      : [];
    const uniqueMessages = [...new Set(messages)];
    if (uniqueMessages.length > 0) {
      checkValues.push({
        text: uniqueMessages.join("; "),
        color: checkStatusColor(String(value.status ?? "")),
      });
    }
  }
  const checks = categoricalPresentation(
    "checks",
    checkValues.map(({ text }) => text),
    checkValues.find(({ color }) => color !== undefined)?.color,
  );
  if (checks) {
    presentations.push(checks);
  }

  const adviceValues: Array<{ text: string; color: string }> = [];
  for (const value of Array.isArray(result.advice) ? result.advice : []) {
    if (!isRecord(value) || value.message === undefined || value.message === null) {
      continue;
    }
    const affected = Array.isArray(value.affected_entity_ids)
      ? value.affected_entity_ids
      : [];
    if (!affected.some((entityId) => typeof entityId === "string" && entityIds.has(entityId))) {
      continue;
    }
    const text = String(value.message);
    if (text.length > 0) {
      adviceValues.push({ text, color: severityColor(String(value.severity ?? "info")) });
    }
  }
  const advice = categoricalPresentation(
    "advice",
    adviceValues.map(({ text }) => text),
    adviceValues[0]?.color,
  );
  if (advice) {
    presentations.push(advice);
  }
  return presentations;
}

function categoricalPresentation(
  category: SourceLineOverlayPresentation["category"],
  rawValues: readonly string[],
  hex = "#757575",
): SourceLineOverlayPresentation | undefined {
  const values = [...new Set(rawValues.filter((value) => value.length > 0))];
  if (values.length === 0) {
    return undefined;
  }
  const value = values.join(" — ");
  return {
    category,
    value,
    tooltip: `MLIA ${category} for this source line: ${value}`,
    color: categoricalColor(hex, category),
  };
}

function categoricalColor(hex: string, category: string): SourceLineHeatmapColor {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(hex);
  const rgb = match
    ? [Number.parseInt(match[1], 16), Number.parseInt(match[2], 16), Number.parseInt(match[3], 16)]
    : [117, 117, 117];
  const opacity = 0.18;
  return {
    hex,
    opacity,
    rgba: `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${opacity})`,
    basis: category,
  };
}

function stringifyOverlayValue(value: unknown): string {
  if (value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function placementColor(value: string): string {
  return ({ npu: "#2e7d32", nx: "#2e7d32", cpu: "#c62828", gpu: "#1565c0" } as Record<string, string>)[value.toLowerCase()] ?? "#757575";
}

function checkStatusColor(value: string): string | undefined {
  return ({
    fail: "#c62828",
    failed: "#c62828",
    error: "#c62828",
    warn: "#f9a825",
    warning: "#f9a825",
  } as Record<string, string>)[value.toLowerCase()];
}

function severityColor(value: string): string {
  return ({ info: "#1565c0", warning: "#f9a825", error: "#c62828" } as Record<string, string>)[value.toLowerCase()] ?? "#757575";
}

function mappedEntityIdsByResult(mappingResults: unknown[]): Map<number, Set<string>> {
  const mappedIdsByResult = new Map<number, Set<string>>();
  for (const value of mappingResults) {
    if (!isRecord(value) || !isNonNegativeInteger(value.resultIndex) || !Array.isArray(value.mappings)) {
      continue;
    }
    const resultIds = mappedIdsByResult.get(value.resultIndex) ?? new Set<string>();
    for (const mapping of value.mappings) {
      if (isRecord(mapping) && typeof mapping.entityId === "string") {
        resultIds.add(mapping.entityId);
      }
    }
    mappedIdsByResult.set(value.resultIndex, resultIds);
  }
  return mappedIdsByResult;
}

function buildEntityGraph(values: unknown[]): EntityGraph {
  const entitiesById = new Map<string, ParsedEntity[]>();
  const reportedCodeStackIds = new Set<string>();
  for (const value of values) {
    const entity = parseEntity(value);
    if (entity) {
      if (entity.kind === "code_stack") {
        reportedCodeStackIds.add(entity.id);
      }
      const matches = entitiesById.get(entity.id) ?? [];
      matches.push(entity);
      entitiesById.set(entity.id, matches);
    }
  }
  const entities = new Map(
    [...entitiesById]
      .filter(([, matches]) => matches.length === 1)
      .map(([id, matches]) => [id, matches[0]]),
  );
  const children = new Map([...entities].map(([id]) => [id, new Set<string>()]));
  const parents = new Map([...entities].map(([id]) => [id, new Set<string>()]));
  const unresolvedChildren = new Set<string>();

  const addEdge = (parentId: string, childId: string): void => {
    children.get(parentId)?.add(childId);
    parents.get(childId)?.add(parentId);
  };
  for (const entity of entities.values()) {
    if (entity.hasMalformedChildReferences) {
      unresolvedChildren.add(entity.id);
    }
    for (const childId of entity.childIds) {
      if (entities.has(childId)) {
        addEdge(entity.id, childId);
      } else {
        unresolvedChildren.add(entity.id);
      }
    }
    for (const parentId of entity.parentIds) {
      if (entities.has(parentId)) {
        addEdge(parentId, entity.id);
      }
    }
  }
  return { entities, children, parents, unresolvedChildren, reportedCodeStackIds };
}

function parseEntity(value: unknown): ParsedEntity | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.kind !== "string") {
    return undefined;
  }
  const location = sourceLocation(value.kind, value.attributes);
  return {
    id: value.id,
    kind: value.kind,
    parentIds: stringArray(value.parent_ids),
    childIds: stringArray(value.child_ids),
    hasMalformedChildReferences: hasMalformedStringArray(value.child_ids),
    placement: value.placement,
    status: value.status,
    ...location,
  };
}

function sourceLocation(
  kind: string,
  attributes: unknown,
): { file: string; line: number } | undefined {
  if (
    (kind !== "code_stack" && kind !== "code_line") ||
    !isRecord(attributes) ||
    typeof attributes.file !== "string" ||
    attributes.file.length === 0 ||
    !isPositiveInteger(attributes.line)
  ) {
    return undefined;
  }
  return { file: attributes.file, line: attributes.line };
}

function resolveSourceOperatorLeafSets(graph: EntityGraph): Map<string, ReadonlySet<string> | undefined> {
  const remainingChildren = new Map<string, number>();
  for (const [entityId, childIds] of graph.children) {
    remainingChildren.set(entityId, childIds.size);
  }
  const ready = [...remainingChildren]
    .filter(([entityId, count]) => count === 0 && !graph.unresolvedChildren.has(entityId))
    .map(([entityId]) => entityId)
    .sort();
  const resolved = new Map<string, ReadonlySet<string>>();

  while (ready.length > 0) {
    const entityId = ready.shift() as string;
    const entity = graph.entities.get(entityId) as ParsedEntity;
    const childIds = graph.children.get(entityId) as Set<string>;
    const leaves = new Set<string>();
    if (entity.kind === "source_operator") {
      leaves.add(entityId);
    } else {
      for (const childId of childIds) {
        for (const leafId of resolved.get(childId) ?? []) {
          leaves.add(leafId);
        }
      }
    }
    resolved.set(entityId, leaves);
    for (const parentId of graph.parents.get(entityId) ?? []) {
      const remaining = (remainingChildren.get(parentId) ?? 0) - 1;
      remainingChildren.set(parentId, remaining);
      if (remaining === 0 && !graph.unresolvedChildren.has(parentId)) {
        insertSorted(ready, parentId);
      }
    }
  }

  return new Map(
    [...graph.entities].map(([entityId]) => [entityId, resolved.get(entityId)]),
  );
}

function parseModelMetrics(metricValues: unknown): SourceModelMetric[] {
  if (!Array.isArray(metricValues)) {
    return [];
  }
  const candidates = new Map<string, { identity: MetricIdentity; figures: MetricFigure[] }>();
  for (const value of metricValues) {
    const parsed = parseMetric(value, {});
    if (!parsed) {
      continue;
    }
    const candidate = candidates.get(parsed.identity.key) ?? {
      identity: parsed.identity,
      figures: [],
    };
    candidate.figures.push(parsed.figure);
    candidates.set(parsed.identity.key, candidate);
  }
  return [...candidates]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([, candidate]) => {
      const figure = reconcileFigures(candidate.figures);
      return candidate.figures.length === 1 && figure.kind === "known"
        ? [{
            name: candidate.identity.name,
            value: figure.value,
            unit: candidate.identity.unit,
            qualifiers: candidate.identity.metricQualifiers,
          }]
        : [];
    });
}

function parseEntityMetrics(
  breakdownValues: unknown,
  entities: ReadonlyMap<string, ParsedEntity>,
  entityKind: string,
): Map<string, Map<string, EntityMetricFigure>> {
  const candidates = new Map<string, Map<string, { identity: MetricIdentity; figures: MetricFigure[] }>>();
  if (!Array.isArray(breakdownValues)) {
    return new Map();
  }

  for (const breakdown of breakdownValues) {
    if (
      !isRecord(breakdown) ||
      typeof breakdown.entity_id !== "string" ||
      entities.get(breakdown.entity_id)?.kind !== entityKind ||
      !Array.isArray(breakdown.metrics)
    ) {
      continue;
    }
    const breakdownQualifiers = qualifierObject(breakdown.qualifiers);
    if (!breakdownQualifiers) {
      continue;
    }
    const entityMetrics = candidates.get(breakdown.entity_id) ?? new Map();
    for (const metricValue of breakdown.metrics) {
      const parsed = parseMetric(metricValue, breakdownQualifiers);
      if (!parsed) {
        continue;
      }
      const candidate = entityMetrics.get(parsed.identity.key) ?? {
        identity: parsed.identity,
        figures: [],
      };
      candidate.figures.push(parsed.figure);
      entityMetrics.set(parsed.identity.key, candidate);
    }
    candidates.set(breakdown.entity_id, entityMetrics);
  }

  return new Map(
    [...candidates].map(([entityId, entityMetrics]) => [
      entityId,
      new Map(
        [...entityMetrics].map(([identityKey, candidate]) => [
          identityKey,
          {
            identity: candidate.identity,
            figure: reconcileFigures(candidate.figures),
          },
        ]),
      ),
    ]),
  );
}

function parseMetric(
  value: unknown,
  breakdownQualifiers: SourceLineQualifiers,
): EntityMetricFigure | undefined {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.unit !== "string") {
    return undefined;
  }
  const metricQualifiers = qualifierObject(value.qualifiers);
  if (!metricQualifiers) {
    return undefined;
  }
  const identity: MetricIdentity = {
    key: canonicalJson([
      value.name,
      value.unit,
      breakdownQualifiers,
      metricQualifiers,
    ]),
    name: value.name,
    unit: value.unit,
    breakdownQualifiers,
    metricQualifiers,
  };

  if (
    typeof value.value === "number" &&
    Number.isFinite(value.value) &&
    value.availability === undefined &&
    value.reason === undefined
  ) {
    const aggregation = value.aggregation;
    const samples = value.samples;
    if (
      (aggregation !== undefined && typeof aggregation !== "string") ||
      (samples !== undefined && !isNonNegativeSafeInteger(samples))
    ) {
      return { identity, figure: { kind: "unsupported" } };
    }
    const figure: KnownMetricFigure = {
      kind: "known",
      value: value.value,
      ...(aggregation === undefined ? {} : { aggregation }),
      ...(samples === undefined ? {} : { samples }),
      signature: canonicalJson([value.value, aggregation ?? null, samples ?? null]),
    };
    return { identity, figure };
  }

  if (value.value === undefined || value.value === null || value.availability !== undefined) {
    return { identity, figure: { kind: "missing" } };
  }
  return { identity, figure: { kind: "unsupported" } };
}

function reconcileFigures(figures: MetricFigure[]): MetricFigure {
  const known = figures.filter((figure): figure is KnownMetricFigure => figure.kind === "known");
  const signatures = new Set(known.map((figure) => figure.signature));
  if (signatures.size > 1) {
    return { kind: "conflicting" };
  }
  if (figures.some((figure) => figure.kind === "unsupported")) {
    return { kind: "unsupported" };
  }
  if (known.length > 0) {
    return known[0];
  }
  return { kind: "missing" };
}

function directLineMetric(
  resultIndex: number,
  entity: ParsedEntity,
  metric: EntityMetricFigure,
  leafSets: ReadonlyMap<string, ReadonlySet<string> | undefined>,
): SourceLineMetricAggregate {
  const entityReference = reference(resultIndex, entity.id);
  const leafIds = [...(leafSets.get(entity.id) ?? [])].sort();
  const base = {
    name: metric.identity.name,
    unit: metric.identity.unit,
    breakdownQualifiers: metric.identity.breakdownQualifiers,
    metricQualifiers: metric.identity.metricQualifiers,
  };
  if (metric.figure.kind === "known") {
    return {
      ...base,
      value: metric.figure.value,
      ...(metric.figure.aggregation === undefined
        ? {}
        : { aggregation: metric.figure.aggregation }),
      ...(metric.figure.samples === undefined
        ? {}
        : { samples: metric.figure.samples }),
      status: "complete",
      contributors: [entityReference],
      missingEntityReferences: [],
      ambiguousEntityReferences: [],
      coveredLeafIds: leafIds,
      uncoveredLeafIds: [],
      reasons: [],
    };
  }

  const conflicting = metric.figure.kind === "conflicting";
  const reason: SourceLineMetricReasonCode = conflicting
    ? "conflicting_equivalent_figures"
    : metric.figure.kind === "unsupported"
      ? "unsupported_aggregation"
      : "missing_metric";
  return {
    ...base,
    status: "unavailable",
    contributors: [],
    missingEntityReferences: conflicting ? [] : [entityReference],
    ambiguousEntityReferences: conflicting ? [entityReference] : [],
    coveredLeafIds: [],
    uncoveredLeafIds: leafIds,
    reasons: [{
      code: reason,
      entityReferences: [entityReference],
      leafIds,
    }],
  };
}

function selectTotalCycles(
  resultIndex: number,
  entities: ParsedEntity[],
  leafSets: ReadonlyMap<string, ReadonlySet<string> | undefined>,
  metrics: SourceLineMetricAggregate[],
): SourceLineMetricAggregate {
  const totals = metrics.filter((metric) => metric.name === "total_cycles");
  if (totals.length === 1) {
    return totals[0];
  }
  const coverage = lineCoverage(resultIndex, entities, leafSets);
  if (totals.length === 0) {
    const reasons: SourceLineMetricReason[] = [{
      code: "missing_metric",
      entityReferences: coverage.references,
      leafIds: coverage.leafIds,
    }];
    if (coverage.unresolvedReferences.length > 0) {
      reasons.push({
        code: "unresolved_hierarchy",
        entityReferences: coverage.unresolvedReferences,
        leafIds: [],
      });
    }
    return {
      name: "total_cycles",
      unit: "",
      breakdownQualifiers: {},
      metricQualifiers: {},
      status: "unavailable",
      contributors: [],
      missingEntityReferences: coverage.references,
      ambiguousEntityReferences: [],
      coveredLeafIds: [],
      uncoveredLeafIds: coverage.leafIds,
      reasons,
    };
  }
  const metricReferences = sortReferences(
    totals.flatMap((metric) => [
      ...metric.contributors,
      ...metric.missingEntityReferences,
      ...metric.ambiguousEntityReferences,
    ]),
  );
  const ambiguousReferences = metricReferences.length > 0
    ? metricReferences
    : coverage.references;
  const reasons: SourceLineMetricReason[] = [{
    code: "conflicting_metric_identity",
    entityReferences: ambiguousReferences,
    leafIds: coverage.leafIds,
  }];
  if (coverage.unresolvedReferences.length > 0) {
    reasons.push({
      code: "unresolved_hierarchy",
      entityReferences: coverage.unresolvedReferences,
      leafIds: [],
    });
  }
  return {
    name: "total_cycles",
    unit: "",
    breakdownQualifiers: {},
    metricQualifiers: {},
    status: "unavailable",
    contributors: [],
    missingEntityReferences: [],
    ambiguousEntityReferences: ambiguousReferences,
    coveredLeafIds: [],
    uncoveredLeafIds: coverage.leafIds,
    reasons,
  };
}

function lineCoverage(
  resultIndex: number,
  entities: ParsedEntity[],
  leafSets: ReadonlyMap<string, ReadonlySet<string> | undefined>,
): {
  references: SourceEntityReference[];
  unresolvedReferences: SourceEntityReference[];
  leafIds: string[];
} {
  const references = entities.map((entity) => reference(resultIndex, entity.id));
  const unresolvedReferences: SourceEntityReference[] = [];
  const leafIds = new Set<string>();
  for (const entity of entities) {
    const leaves = leafSets.get(entity.id);
    if (!leaves || leaves.size === 0) {
      unresolvedReferences.push(reference(resultIndex, entity.id));
      continue;
    }
    for (const leafId of leaves) {
      leafIds.add(leafId);
    }
  }
  return {
    references: sortReferences(references),
    unresolvedReferences: sortReferences(unresolvedReferences),
    leafIds: [...leafIds].sort(),
  };
}

function lineRelationships(
  resultIndex: number,
  entities: ParsedEntity[],
  graph: EntityGraph,
  mappedCodeStackIds: ReadonlySet<string>,
  direction: "parents" | "children",
): SourceEntityReference[] {
  const relationships = new Set<string>();
  const adjacency = direction === "parents" ? graph.parents : graph.children;
  for (const origin of entities) {
    const pending = [...(adjacency.get(origin.id) ?? [])].sort();
    const visited = new Set<string>();
    while (pending.length > 0) {
      const entityId = pending.shift() as string;
      if (visited.has(entityId)) {
        continue;
      }
      visited.add(entityId);
      const entity = graph.entities.get(entityId);
      if (!entity || entity.kind !== "code_stack") {
        continue;
      }
      if (mappedCodeStackIds.has(entityId)) {
        if (entityId !== origin.id) {
          relationships.add(entityId);
        }
        continue;
      }
      for (const nextId of [...(adjacency.get(entityId) ?? [])].sort()) {
        insertSorted(pending, nextId);
      }
    }
  }
  return [...relationships].sort().map((entityId) => reference(resultIndex, entityId));
}

function metricIdentity(
  metric: Pick<SourceLineMetricAggregate, "name" | "unit" | "breakdownQualifiers" | "metricQualifiers">,
): MetricIdentity {
  return {
    key: canonicalJson([
      metric.name,
      metric.unit,
      metric.breakdownQualifiers,
      metric.metricQualifiers,
    ]),
    name: metric.name,
    unit: metric.unit,
    breakdownQualifiers: metric.breakdownQualifiers,
    metricQualifiers: metric.metricQualifiers,
  };
}

export function projectSourceMetric(
  records: readonly (SourceLineResultRecord | UnprojectedSourceLineResultRecord)[],
  requestedOverlay?: OverlayKey,
): readonly SourceLineResultRecord[] {
  const unprojected = records.map(stripSourceMetricProjection);
  if (!requestedOverlay) {
    return deepFreeze(unprojected.map((record) => ({
      ...record,
      selectedMetric: unselectedSourceMetric(record),
      color: fallbackColor(),
    })));
  }

  const selected = requestedOverlay;
  if (selected.category !== "metric") {
    return deepFreeze(unprojected.map((record) => {
      const matchingResult = sourceRecordMatchesOverlay(record, selected);
      const selectedPresentation = matchingResult
        ? record.overlayPresentations.find(({ category }) => category === selected.category)
        : undefined;
      return {
        ...record,
        selectedOverlay: selected,
        ...(selectedPresentation === undefined ? {} : { selectedPresentation }),
        selectedMetric: unavailableMetric(record, selected),
        color: selectedPresentation?.color ?? fallbackColor(),
      };
    }));
  }

  const projectable = isSourceMetricSelection(unprojected, selected);
  const selectedByRecord = unprojected.map((record) =>
    projectable && sourceRecordMatchesOverlay(record, selected)
      ? record.metrics.find((metric) => metricMatchesOverlay(metric, selected)) ??
        unavailableMetric(record, selected)
      : unavailableMetric(record, selected)
  );
  const numericValues: number[] = [];
  for (const [index, record] of unprojected.entries()) {
    const value = selectedByRecord[index].value;
    if (projectable && sourceRecordMatchesOverlay(record, selected) && value !== undefined) {
      numericValues.push(value);
    }
  }

  return deepFreeze(unprojected.map((record, index) => {
    const selectedMetric = selectedByRecord[index];
    const matchingResult = projectable && sourceRecordMatchesOverlay(record, selected);
    const selectedModelMetric = matchingResult
      ? modelMetricForSelection(record.modelMetrics, selected)
      : undefined;
    const value = selectedMetric.value;
    if (!matchingResult || value === undefined || numericValues.length === 0) {
      return {
        ...record,
        selectedOverlay: selected,
        selectedMetric,
        ...(selectedModelMetric === undefined ? {} : { selectedModelMetric }),
        color: fallbackColor(),
      };
    }
    const minimum = Math.min(...numericValues);
    const maximum = Math.max(...numericValues);
    const ratio = heatmapRatio(value, minimum, maximum);
    const rgb = MIN_COLOR.map((component, componentIndex) =>
      Math.floor(component + (MAX_COLOR[componentIndex] - component) * ratio),
    );
    const hex = `#${rgb.map(hexComponent).join("")}`;
    const opacity = selectedMetric.status === "complete"
      ? COMPLETE_OPACITY
      : PARTIAL_OPACITY;
    return {
      ...record,
      selectedOverlay: selected,
      selectedMetric,
      ...(selectedModelMetric === undefined ? {} : { selectedModelMetric }),
      color: {
        hex,
        opacity,
        rgba: `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${opacity})`,
        basis: selected.name === "total_cycles" ? "total_cycles" : overlayKeyId(selected),
      },
    };
  }));
}

function isSourceMetricSelection(
  records: readonly UnprojectedSourceLineResultRecord[],
  selected: OverlayKey,
): boolean {
  return selected.category === "metric" && records.some((record) =>
    sourceRecordMatchesOverlay(record, selected) &&
    record.metrics.some((metric) => metricMatchesOverlay(metric, selected))
  );
}

export function sourceRecordMatchesOverlay(
  record: Pick<UnprojectedSourceLineResultRecord, "resultIndex" | "resultKind">,
  selected: OverlayKey,
): boolean {
  return record.resultIndex === selected.resultIndex && record.resultKind === selected.resultKind;
}

function metricMatchesOverlay(
  metric: Pick<SourceLineMetricAggregate, "name" | "unit" | "breakdownQualifiers" | "metricQualifiers">,
  overlay: OverlayKey,
): boolean {
  const identity = metricIdentity(metric);
  return identity.name === overlay.name &&
    identity.unit === overlay.unit &&
    canonicalJson(identity.breakdownQualifiers) === canonicalJson(overlay.breakdownQualifiers) &&
    canonicalJson(identity.metricQualifiers) === canonicalJson(overlay.metricQualifiers);
}

function stripSourceMetricProjection(
  record: SourceLineResultRecord | UnprojectedSourceLineResultRecord,
): UnprojectedSourceLineResultRecord {
  if (!("selectedMetric" in record)) {
    return record;
  }
  const {
    selectedOverlay: _selectedOverlay,
    selectedPresentation: _selectedPresentation,
    selectedMetric: _selectedMetric,
    selectedModelMetric: _selectedModelMetric,
    color: _color,
    ...raw
  } = record;
  return raw;
}

function unselectedSourceMetric(
  record: UnprojectedSourceLineResultRecord,
): SourceLineMetricAggregate {
  const total = record.totalCycles;
  if (
    Object.keys(total.breakdownQualifiers).length === 0 &&
    Object.keys(total.metricQualifiers).length === 0
  ) {
    return total;
  }
  return {
    name: "total_cycles",
    unit: "",
    breakdownQualifiers: {},
    metricQualifiers: {},
    status: "unavailable",
    contributors: [],
    missingEntityReferences: record.entities,
    ambiguousEntityReferences: [],
    coveredLeafIds: [],
    uncoveredLeafIds: [],
    reasons: [{
      code: "missing_metric",
      entityReferences: record.entities,
      leafIds: [],
    }],
  };
}

function unavailableMetric(
  record: UnprojectedSourceLineResultRecord,
  identity: OverlayKey,
): SourceLineMetricAggregate {
  return {
    name: identity.name,
    unit: identity.unit,
    breakdownQualifiers: identity.breakdownQualifiers,
    metricQualifiers: identity.metricQualifiers,
    status: "unavailable",
    contributors: [],
    missingEntityReferences: record.entities,
    ambiguousEntityReferences: [],
    coveredLeafIds: [],
    uncoveredLeafIds: [],
    reasons: [{
      code: "missing_metric",
      entityReferences: record.entities,
      leafIds: [],
    }],
  };
}

function modelMetricForSelection(
  modelMetrics: readonly SourceModelMetric[],
  selected: OverlayKey,
): SourceModelMetric | undefined {
  if (Object.keys(selected.breakdownQualifiers).length > 0) {
    return undefined;
  }
  return modelMetrics.find((metric) =>
    metric.name === selected.name &&
    metric.unit === selected.unit &&
    canonicalJson(metric.qualifiers) === canonicalJson(selected.metricQualifiers)
  );
}

function heatmapRatio(value: number, minimum: number, maximum: number): number {
  if (minimum === maximum) {
    return 0.5;
  }

  const offset = value - minimum;
  const span = maximum - minimum;
  let ratio = Number.isFinite(offset) && Number.isFinite(span)
    ? offset / span
    : Number.NaN;
  if (!Number.isFinite(ratio)) {
    const scale = Math.max(Math.abs(value), Math.abs(minimum), Math.abs(maximum));
    const scaledValue = value / scale;
    const scaledMinimum = minimum / scale;
    const scaledMaximum = maximum / scale;
    ratio = (scaledValue - scaledMinimum) / (scaledMaximum - scaledMinimum);
  }
  return Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0.5;
}

function fallbackColor(): SourceLineHeatmapColor {
  return {
    hex: FALLBACK_COLOR,
    opacity: FALLBACK_OPACITY,
    rgba: "rgba(117, 117, 117, 0.08)",
    basis: "unavailable",
  };
}

const INVALID_QUALIFIER = Symbol("invalid qualifier");

function qualifierObject(value: unknown): SourceLineQualifiers | undefined {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const clone = cloneQualifierValue(value, new Set<object>());
  return clone === INVALID_QUALIFIER || !isRecord(clone) ? undefined : clone;
}

function cloneQualifierValue(
  value: unknown,
  ancestors: Set<object>,
): SourceLineQualifierValue | typeof INVALID_QUALIFIER {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value !== "object") {
    return INVALID_QUALIFIER;
  }
  if (ancestors.has(value)) {
    return INVALID_QUALIFIER;
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    const cloned: SourceLineQualifierValue[] = [];
    for (const item of value) {
      const clone = cloneQualifierValue(item, ancestors);
      if (clone === INVALID_QUALIFIER) {
        ancestors.delete(value);
        return INVALID_QUALIFIER;
      }
      cloned.push(clone);
    }
    ancestors.delete(value);
    return cloned;
  }
  const cloned: Record<string, SourceLineQualifierValue> = {};
  for (const key of Object.keys(value).sort()) {
    const clone = cloneQualifierValue((value as Readonly<Record<string, unknown>>)[key], ancestors);
    if (clone === INVALID_QUALIFIER) {
      ancestors.delete(value);
      return INVALID_QUALIFIER;
    }
    Object.defineProperty(cloned, key, {
      value: clone,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  ancestors.delete(value);
  return cloned;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function objectArrayProperty(value: unknown, property: string): unknown[] | undefined {
  return isRecord(value) && Array.isArray(value[property])
    ? value[property] as unknown[]
    : undefined;
}

function reference(resultIndex: number, entityId: string): SourceEntityReference {
  return { resultIndex, entityId };
}

function referenceKey(item: SourceEntityReference): string {
  return `${item.resultIndex}:${item.entityId}`;
}

function sortReferences(references: SourceEntityReference[]): SourceEntityReference[] {
  return [...new Map(references.map((item) => [referenceKey(item), item])).values()].sort(
    (left, right) => left.resultIndex - right.resultIndex || left.entityId.localeCompare(right.entityId),
  );
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string"))].sort()
    : [];
}

function hasMalformedStringArray(value: unknown): boolean {
  return value !== undefined &&
    (!Array.isArray(value) || value.some((item) => typeof item !== "string"));
}

function compareSourceLines(
  left: Pick<SourceLineResultRecord, "resultIndex" | "file" | "line">,
  right: Pick<SourceLineResultRecord, "resultIndex" | "file" | "line">,
): number {
  return left.resultIndex - right.resultIndex ||
    left.file.localeCompare(right.file) ||
    left.line - right.line;
}

function insertSorted(values: string[], value: string): void {
  if (values.includes(value)) {
    return;
  }
  const index = values.findIndex((candidate) => candidate.localeCompare(value) > 0);
  if (index < 0) {
    values.push(value);
  } else {
    values.splice(index, 0, value);
  }
}

function hexComponent(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
