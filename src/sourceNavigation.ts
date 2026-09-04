import * as path from "path";

export interface CodeStackLocation {
  file: string;
  line: number;
}

export interface EntityContext {
  entity: unknown;
  resultEntities: unknown[];
  mappedCodeStackIds?: ReadonlySet<string>;
}

interface Entity {
  id: string;
  kind: string;
  parentIds: string[];
  childIds: string[];
  attributes?: unknown;
}

export interface OpenTextTab {
  uri: string;
  viewColumn: number;
}

export interface SourceRevealPlan {
  showOptions: {
    viewColumn: number;
    preview: true;
    preserveFocus: true;
  };
  selection: {
    line: number;
    startCharacter: 0;
    endCharacter: number;
  };
}

export function sourceRevealPlan(
  viewColumn: number,
  line: number,
  lineLength: number,
): SourceRevealPlan {
  return {
    showOptions: {
      viewColumn,
      preview: true,
      preserveFocus: true,
    },
    selection: {
      line,
      startCharacter: 0,
      endCharacter: lineLength,
    },
  };
}

export interface SourceLineBorderHost<Editor, Range, Timer> {
  setBorder: (editor: Editor, ranges: readonly Range[]) => void;
  schedule: (callback: () => void, delayMs: number) => Timer;
  cancel: (timer: Timer) => void;
  disposeBorder: () => void;
}

export class TransientSourceLineBorder<Editor, Range, Timer> {
  private active: { editor: Editor; timer?: Timer } | undefined;
  private disposed = false;

  public constructor(
    private readonly host: SourceLineBorderHost<Editor, Range, Timer>,
    private readonly durationMs: number,
  ) {}

  public show(editor: Editor, range: Range): void {
    if (this.disposed) {
      return;
    }
    this.clear();
    this.host.setBorder(editor, [range]);
    const active: { editor: Editor; timer?: Timer } = { editor };
    this.active = active;
    active.timer = this.host.schedule(() => {
      if (this.active !== active) {
        return;
      }
      this.active = undefined;
      this.host.setBorder(editor, []);
    }, this.durationMs);
  }

  public clear(): void {
    const active = this.active;
    this.active = undefined;
    if (!active) {
      return;
    }
    if (active.timer !== undefined) {
      this.host.cancel(active.timer);
    }
    this.host.setBorder(active.editor, []);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.clear();
    this.disposed = true;
    this.host.disposeBorder();
  }
}

export function sourceViewColumn(
  targetUri: string,
  openTextTabs: OpenTextTab[],
  groupViewColumns: number[],
  modelExplorerViewColumn: number | undefined,
): number | undefined {
  const existingTab = openTextTabs.find((tab) => tab.uri === targetUri);
  if (existingTab) {
    return existingTab.viewColumn;
  }
  if (modelExplorerViewColumn === undefined) {
    return undefined;
  }
  return groupViewColumns.find((viewColumn) => viewColumn !== modelExplorerViewColumn);
}

export interface CodeStackLocationFailure {
  readonly reason: string;
}

type CodeStackLocationResolution =
  | { kind: "resolved"; location: CodeStackLocation }
  | { kind: "unresolved"; reason: string };

export function resolveCodeStackLocation(
  contexts: EntityContext[],
  reportFailure?: (failure: CodeStackLocationFailure) => void,
): CodeStackLocation | undefined {
  if (contexts.length === 0) {
    reportFailure?.({ reason: "the selected Model Explorer node has no mapped MLIA entities" });
    return undefined;
  }

  const resolutions = contexts.map(resolveContextCodeStackLocation);
  const failure = resolutions.find(
    (resolution): resolution is Extract<CodeStackLocationResolution, { kind: "unresolved" }> =>
      resolution.kind === "unresolved",
  );
  if (failure) {
    reportFailure?.({ reason: failure.reason });
    return undefined;
  }

  const locations = resolutions.map((resolution) =>
    (resolution as Extract<CodeStackLocationResolution, { kind: "resolved" }>).location
  );
  const first = locations[0];
  if (!locations.every((location) => location.file === first.file && location.line === first.line)) {
    const distinctLocations = [...new Set(locations.map(({ file, line }) => `${file}:${line}`))];
    reportFailure?.({
      reason: `the mapped entities resolve to different source locations: ${distinctLocations.join(", ")}`,
    });
    return undefined;
  }
  return first;
}

function resolveContextCodeStackLocation(context: EntityContext): CodeStackLocationResolution {
  const entities = parseEntities(context.resultEntities);
  const selected = parseEntity(context.entity);
  if (!selected) {
    return { kind: "unresolved", reason: "a mapped MLIA entity is malformed" };
  }
  if (!entities.has(selected.id)) {
    return {
      kind: "unresolved",
      reason: `mapped entity ${selected.id} is absent from its result's entity collection`,
    };
  }

  if (selected.kind === "code_stack") {
    if (context.mappedCodeStackIds !== undefined && !context.mappedCodeStackIds.has(selected.id)) {
      return {
        kind: "unresolved",
        reason: `code stack ${selected.id} is not present in the Model Explorer entity mappings`,
      };
    }
    const location = codeStackLocation(selected);
    return location
      ? { kind: "resolved", location }
      : {
          kind: "unresolved",
          reason: `code stack ${selected.id} has no valid source file and positive line number`,
        };
  }

  const sourceOperators = descendantSourceOperators(selected, entities);
  if (sourceOperators.length === 0) {
    return {
      kind: "unresolved",
      reason: `entity ${selected.id} has no source-operator descendants`,
    };
  }

  const ancestorDistances = sourceOperators.map((entity) =>
    codeStackAncestorDistances(entity, entities, context.mappedCodeStackIds),
  );
  const missingAncestorIndex = ancestorDistances.findIndex((distances) => distances.size === 0);
  if (missingAncestorIndex >= 0) {
    return {
      kind: "unresolved",
      reason: `source operator ${sourceOperators[missingAncestorIndex].id} has no mapped code-stack ancestor`,
    };
  }

  const commonIds = [...ancestorDistances[0].keys()].filter((id) =>
    ancestorDistances.every((distances) => distances.has(id)),
  );
  if (commonIds.length === 0) {
    return {
      kind: "unresolved",
      reason: `source operators ${sourceOperators.map(({ id }) => id).sort().join(", ")} do not share a mapped code-stack ancestor`,
    };
  }

  const ranked = commonIds
    .map((id) => ({
      id,
      maximumDistance: Math.max(...ancestorDistances.map((distances) => distances.get(id) ?? Number.MAX_SAFE_INTEGER)),
      totalDistance: ancestorDistances.reduce((total, distances) => total + (distances.get(id) ?? 0), 0),
    }))
    .sort((left, right) =>
      left.maximumDistance - right.maximumDistance ||
      left.totalDistance - right.totalDistance ||
      left.id.localeCompare(right.id),
    );
  const closest = ranked[0];
  const equallyClose = ranked.filter(
    (candidate) =>
      candidate.maximumDistance === closest.maximumDistance &&
      candidate.totalDistance === closest.totalDistance,
  );
  if (equallyClose.length !== 1) {
    return {
      kind: "unresolved",
      reason: `entity ${selected.id} has multiple equally close mapped code-stack ancestors: ${equallyClose.map(({ id }) => id).join(", ")}`,
    };
  }

  const location = codeStackLocation(entities.get(closest.id));
  return location
    ? { kind: "resolved", location }
    : {
        kind: "unresolved",
        reason: `resolved code stack ${closest.id} has no valid source file and positive line number`,
      };
}

function descendantSourceOperators(selected: Entity, entities: Map<string, Entity>): Entity[] {
  if (selected.kind === "source_operator") {
    return [selected];
  }

  const sourceOperators: Entity[] = [];
  const pending = [...selected.childIds];
  const visited = new Set<string>([selected.id]);
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || visited.has(id)) {
      continue;
    }
    visited.add(id);
    const entity = entities.get(id);
    if (!entity) {
      continue;
    }
    if (entity.kind === "source_operator") {
      sourceOperators.push(entity);
    } else {
      pending.push(...entity.childIds);
    }
  }
  return sourceOperators;
}

function codeStackAncestorDistances(
  sourceOperator: Entity,
  entities: Map<string, Entity>,
  mappedCodeStackIds: ReadonlySet<string> | undefined,
): Map<string, number> {
  const distances = new Map<string, number>();
  const pending = sourceOperator.parentIds.map((id) => ({ id, distance: 1 }));
  const visitedDistances = new Map<string, number>();
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current) {
      continue;
    }
    const previousDistance = visitedDistances.get(current.id);
    if (previousDistance !== undefined && previousDistance <= current.distance) {
      continue;
    }
    visitedDistances.set(current.id, current.distance);
    const entity = entities.get(current.id);
    if (!entity) {
      continue;
    }
    if (
      entity.kind === "code_stack" &&
      (mappedCodeStackIds === undefined || mappedCodeStackIds.has(entity.id))
    ) {
      distances.set(entity.id, current.distance);
    }
    pending.push(...entity.parentIds.map((id) => ({ id, distance: current.distance + 1 })));
  }
  return distances;
}

function parseEntities(values: unknown[]): Map<string, Entity> {
  const entities = new Map<string, Entity>();
  for (const value of values) {
    const entity = parseEntity(value);
    if (entity) {
      entities.set(entity.id, entity);
    }
  }
  return entities;
}

function parseEntity(value: unknown): Entity | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as {
    id?: unknown;
    kind?: unknown;
    parent_ids?: unknown;
    child_ids?: unknown;
    attributes?: unknown;
  };
  if (typeof candidate.id !== "string" || typeof candidate.kind !== "string") {
    return undefined;
  }
  return {
    id: candidate.id,
    kind: candidate.kind,
    parentIds: stringArray(candidate.parent_ids),
    childIds: stringArray(candidate.child_ids),
    attributes: candidate.attributes,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function codeStackLocation(entity: Entity | undefined): CodeStackLocation | undefined {
  if (!entity || entity.kind !== "code_stack" || typeof entity.attributes !== "object" || entity.attributes === null) {
    return undefined;
  }
  const attributes = entity.attributes as { file?: unknown; line?: unknown };
  return typeof attributes.file === "string" &&
    attributes.file.length > 0 &&
    typeof attributes.line === "number" &&
    Number.isInteger(attributes.line) &&
    attributes.line > 0
    ? { file: attributes.file, line: attributes.line }
    : undefined;
}

export function mappedCodeStackEntityIds(
  resultEntities: unknown[],
  mappings: unknown,
): ReadonlySet<string> {
  const codeStackIds = new Set(
    resultEntities
      .map(parseEntity)
      .filter((entity): entity is Entity => entity?.kind === "code_stack")
      .map((entity) => entity.id),
  );
  const mappedIds = new Set<string>();
  if (!Array.isArray(mappings)) {
    return mappedIds;
  }
  for (const value of mappings) {
    if (typeof value !== "object" || value === null) {
      continue;
    }
    const entityId = (value as { entityId?: unknown }).entityId;
    if (typeof entityId === "string" && codeStackIds.has(entityId)) {
      mappedIds.add(entityId);
    }
  }
  return mappedIds;
}

export function codeStackLocations(entities: unknown[]): CodeStackLocation[] {
  const locations: CodeStackLocation[] = [];
  for (const value of entities) {
    if (typeof value !== "object" || value === null) {
      continue;
    }
    const candidate = value as { kind?: unknown; attributes?: unknown };
    if (candidate.kind !== "code_stack" || typeof candidate.attributes !== "object" || candidate.attributes === null) {
      continue;
    }
    const attributes = candidate.attributes as { file?: unknown; line?: unknown };
    if (
      typeof attributes.file === "string" &&
      attributes.file.length > 0 &&
      typeof attributes.line === "number" &&
      Number.isInteger(attributes.line) &&
      attributes.line > 0
    ) {
      locations.push({ file: attributes.file, line: attributes.line });
    }
  }
  return locations;
}

export function mapSourcePath(sourcePath: string, sourceFileMap: Record<string, string>): string {
  const normalizedSource = normalizeSeparators(sourcePath);
  const mapping = Object.entries(sourceFileMap)
    .map(([sourcePrefix, localPrefix]) => ({
      sourcePrefix: normalizeSeparators(sourcePrefix),
      localPrefix,
    }))
    .filter(({ sourcePrefix }) => prefixMatches(normalizedSource, sourcePrefix))
    .sort((left, right) => right.sourcePrefix.length - left.sourcePrefix.length)[0];

  if (!mapping) {
    return path.normalize(sourcePath);
  }

  const suffix = normalizedSource.slice(mapping.sourcePrefix.length).replace(/^\/+/, "");
  return path.normalize(suffix ? path.join(mapping.localPrefix, ...suffix.split("/")) : mapping.localPrefix);
}

function normalizeSeparators(value: string): string {
  return value.replace(/\\/gu, "/").replace(/\/+$/u, "");
}

function prefixMatches(sourcePath: string, prefix: string): boolean {
  return sourcePath === prefix || sourcePath.startsWith(`${prefix}/`);
}
