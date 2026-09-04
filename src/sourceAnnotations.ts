import { deepFreeze } from "./deepFreeze";
import {
  buildOverlayCatalog,
  OverlayKey,
  overlayKeyId,
} from "./overlayCatalog";
import { OverlaySelection, selectedOverlay } from "./overlaySynchronization";
import {
  buildSourceLines,
  buildSourceRecords,
  projectSourceMetric,
  SourceCodeStackRecord,
  SourceEntityReference,
  SourceLineResultRecord,
  SourceRecordCollection,
  SourceResultRecord,
} from "./sourceLines";
import { mapSourcePath } from "./sourceNavigation";

export interface MappedSourceLocation {
  readonly sourceFile: string;
  readonly localFile: string;
  readonly uri: string;
  readonly line: number;
}

export interface MappedSourceLineResultRecord extends SourceLineResultRecord {
  readonly mappedLocation: MappedSourceLocation;
  readonly localFile: string;
  readonly uri: string;
}

export interface SourceMappingLocation {
  readonly id: string;
  readonly resultIndex: number;
  readonly resultKind: string;
  readonly mappedLocation: MappedSourceLocation;
  readonly localFile: string;
  readonly uri: string;
  readonly line: number;
}

export interface SourceMappingDiagnostics {
  readonly resultIndex: number;
  readonly resultKind: string;
  readonly reportedCodeStacks: number;
  readonly mappedCodeStacks: number;
  readonly sourceLocatedCodeStacks: number;
  readonly distinctSourceLocations: number;
  readonly accessibleSourceLocations: number;
  readonly accessibilityPending: boolean;
  readonly sourceFiles: readonly string[];
  readonly locations: readonly SourceMappingLocation[];
}

export interface SourceAnnotationHost {
  readonly uriForFile: (file: string) => string;
  readonly isFileAccessible?: (file: string) => Promise<boolean>;
  readonly buildSourceRecords?: typeof buildSourceRecords;
  readonly buildSourceLines?: typeof buildSourceLines;
}

interface MappedCodeStack extends SourceCodeStackRecord {
  readonly source: {
    readonly file: string;
    readonly line: number;
  };
  readonly mappedLocation: MappedSourceLocation;
}

export class SourceAnnotationIndex {
  private analysisOwner: object | undefined;
  private rawSourceLines: readonly SourceLineResultRecord[] = [];
  private rawSourceResults: readonly SourceResultRecord[] = [];
  private sourceLines: readonly SourceLineResultRecord[] = [];
  private selectedOverlay: OverlayKey | undefined;
  private sourceFileMap: Record<string, string> = {};
  private mappedSourceLocations = new Map<string, MappedSourceLocation>();
  private sourceLinesByUri = new Map<string, MappedSourceLineResultRecord[]>();
  private sourceLineByEntity = new Map<string, MappedSourceLineResultRecord>();
  private diagnostics: readonly SourceMappingDiagnostics[] = [];
  private sourceLocationsById = new Map<string, SourceMappingLocation>();
  private validationVersion = 0;
  private disposed = false;
  private readonly listeners = new Set<() => void>();

  public constructor(private readonly host: SourceAnnotationHost) {}

  public get hasUsableSourceAnnotations(): boolean {
    return this.rawSourceLines.some((record) =>
      record.metrics.some((metric) => metric.value !== undefined) || record.overlayPresentations.length > 0
    );
  }

  public get selectedOverlayKey(): OverlayKey | undefined {
    return this.selectedOverlay;
  }

  public get sourceMappingDiagnostics(): readonly SourceMappingDiagnostics[] {
    return this.diagnostics;
  }

  public setAnalysis(
    owner: object,
    standardizedOutput: unknown,
    entityNodeMappings: unknown,
    requestedSelection?: OverlaySelection,
  ): void {
    if (this.disposed) {
      return;
    }
    this.analysisOwner = owner;
    const records = this.buildRecords(standardizedOutput, entityNodeMappings);
    this.rawSourceLines = records.sourceLines;
    this.rawSourceResults = records.results;
    this.selectedOverlay = selectedOverlay(
      requestedSelection,
      buildOverlayCatalog(standardizedOutput),
    );
    this.sourceLines = projectSourceMetric(this.rawSourceLines, this.selectedOverlay);
    this.rebuildMappedIndex();
  }

  public selectOverlay(overlay: OverlayKey | undefined): boolean {
    if (this.disposed || sameOverlay(this.selectedOverlay, overlay)) {
      return false;
    }
    this.selectedOverlay = overlay;
    this.sourceLines = projectSourceMetric(this.rawSourceLines, overlay);
    this.rebuildSourceLineIndex();
    this.emit();
    return true;
  }

  public clearAnalysis(owner: object): void {
    if (this.disposed || this.analysisOwner !== owner) {
      return;
    }
    this.analysisOwner = undefined;
    this.rawSourceLines = [];
    this.rawSourceResults = [];
    this.sourceLines = [];
    this.selectedOverlay = undefined;
    this.clearMappedIndex();
    this.emit();
  }

  public updateSourceFileMap(sourceFileMap: Record<string, string>): void {
    if (this.disposed || sameStringRecord(this.sourceFileMap, sourceFileMap)) {
      return;
    }
    this.sourceFileMap = { ...sourceFileMap };
    this.rebuildMappedIndex();
  }

  public mappedSourceLocation(sourceFile: string, line: number): MappedSourceLocation {
    const key = rawLocationKey(sourceFile, line);
    const existing = this.mappedSourceLocations.get(key);
    if (existing) {
      return existing;
    }
    const localFile = mapSourcePath(sourceFile, this.sourceFileMap);
    const location = deepFreeze({
      sourceFile,
      localFile,
      uri: this.host.uriForFile(localFile),
      line,
    });
    this.mappedSourceLocations.set(key, location);
    return location;
  }

  public sourceLineRecordsForUri(uri: string): readonly MappedSourceLineResultRecord[] {
    return [...(this.sourceLinesByUri.get(uri) ?? [])];
  }

  public sourceLineRecordForEntity(
    entity: SourceEntityReference,
  ): MappedSourceLineResultRecord | undefined {
    return this.sourceLineByEntity.get(entityKey(entity));
  }

  public sourceLocationForId(id: string): SourceMappingLocation | undefined {
    return this.sourceLocationsById.get(id);
  }

  public subscribe(listener: () => void): { dispose: () => void } {
    if (this.disposed) {
      return { dispose: () => undefined };
    }
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.analysisOwner = undefined;
    this.rawSourceLines = [];
    this.rawSourceResults = [];
    this.sourceLines = [];
    this.selectedOverlay = undefined;
    this.clearMappedIndex();
    this.emit();
    this.listeners.clear();
  }

  private buildRecords(
    standardizedOutput: unknown,
    entityNodeMappings: unknown,
  ): SourceRecordCollection {
    if (this.host.buildSourceRecords) {
      return this.host.buildSourceRecords(standardizedOutput, entityNodeMappings);
    }
    if (this.host.buildSourceLines) {
      return deepFreeze({
        sourceLines: this.host.buildSourceLines(standardizedOutput, entityNodeMappings),
        results: [],
      });
    }
    return buildSourceRecords(standardizedOutput, entityNodeMappings);
  }

  private rebuildMappedIndex(): void {
    const version = ++this.validationVersion;
    this.mappedSourceLocations = new Map();
    for (const sourceLine of this.sourceLines) {
      this.mappedSourceLocation(sourceLine.file, sourceLine.line);
    }
    for (const result of this.rawSourceResults) {
      for (const codeStack of result.mappedCodeStacks) {
        if (codeStack.source) {
          this.mappedSourceLocation(codeStack.source.file, codeStack.source.line);
        }
      }
    }
    this.rebuildSourceLineIndex();
    this.sourceLocationsById = new Map();

    const mappedByResult = new Map<number, MappedCodeStack[]>();
    this.diagnostics = deepFreeze(this.rawSourceResults.map((result) => {
      const mapped = result.mappedCodeStacks.flatMap((codeStack) => {
        if (!codeStack.source) {
          return [];
        }
        return [{
          ...codeStack,
          source: codeStack.source,
          mappedLocation: this.mappedSourceLocation(codeStack.source.file, codeStack.source.line),
        }];
      });
      const distinctLocations = deduplicatedMappedLocations(mapped);
      mappedByResult.set(result.resultIndex, mapped);
      return {
        resultIndex: result.resultIndex,
        resultKind: result.resultKind,
        reportedCodeStacks: result.reportedCodeStackIds.length,
        mappedCodeStacks: result.mappedCodeStacks.length,
        sourceLocatedCodeStacks: mapped.length,
        distinctSourceLocations: distinctLocations.length,
        accessibleSourceLocations: 0,
        accessibilityPending: distinctLocations.length > 0,
        sourceFiles: sourceFilesForLocations(distinctLocations),
        locations: [],
      };
    }));
    this.emit();

    const localFiles = [...new Set(
      [...mappedByResult.values()].flatMap((records) =>
        records.map(({ mappedLocation }) => mappedLocation.localFile)
      ),
    )];
    if (localFiles.length === 0) {
      return;
    }
    const owner = this.analysisOwner;
    const isFileAccessible = this.host.isFileAccessible ?? (async () => true);
    void Promise.all(localFiles.map(async (file) => {
      try {
        return [file, await isFileAccessible(file)] as const;
      } catch {
        return [file, false] as const;
      }
    })).then((results) => {
      if (
        this.disposed ||
        version !== this.validationVersion ||
        owner !== this.analysisOwner
      ) {
        return;
      }
      const accessibleFiles = new Set(
        results.filter(([, accessible]) => accessible).map(([file]) => file),
      );
      const locationsById = new Map<string, SourceMappingLocation>();
      const diagnostics = this.rawSourceResults.map((result) => {
        const mapped = mappedByResult.get(result.resultIndex) ?? [];
        const distinctLocations = deduplicatedMappedLocations(mapped);
        const accessible = distinctLocations.filter(({ localFile }) => accessibleFiles.has(localFile));
        const locations = accessible.map((mappedLocation, index) => {
          const frozen = deepFreeze({
            id: `source-location:${version}:${result.resultIndex}:${index}`,
            resultIndex: result.resultIndex,
            resultKind: result.resultKind,
            mappedLocation,
            localFile: mappedLocation.localFile,
            uri: mappedLocation.uri,
            line: mappedLocation.line,
          });
          locationsById.set(frozen.id, frozen);
          return frozen;
        });
        return {
          resultIndex: result.resultIndex,
          resultKind: result.resultKind,
          reportedCodeStacks: result.reportedCodeStackIds.length,
          mappedCodeStacks: result.mappedCodeStacks.length,
          sourceLocatedCodeStacks: mapped.length,
          distinctSourceLocations: distinctLocations.length,
          accessibleSourceLocations: accessible.length,
          accessibilityPending: false,
          sourceFiles: sourceFilesForLocations(distinctLocations),
          locations,
        };
      });
      this.sourceLocationsById = locationsById;
      this.diagnostics = deepFreeze(diagnostics);
      this.emit();
    });
  }

  private rebuildSourceLineIndex(): void {
    const sourceLinesByUri = new Map<string, MappedSourceLineResultRecord[]>();
    const sourceLineByEntity = new Map<string, MappedSourceLineResultRecord>();
    const ambiguousEntities = new Set<string>();
    for (const sourceLine of this.sourceLines) {
      const mappedLocation = this.mappedSourceLocation(sourceLine.file, sourceLine.line);
      const mappedLine = deepFreeze({
        ...sourceLine,
        mappedLocation,
        localFile: mappedLocation.localFile,
        uri: mappedLocation.uri,
      });
      const mappedLines = sourceLinesByUri.get(mappedLocation.uri) ?? [];
      mappedLines.push(mappedLine);
      sourceLinesByUri.set(mappedLocation.uri, mappedLines);

      for (const entity of sourceLine.entities) {
        const key = entityKey(entity);
        if (sourceLineByEntity.has(key)) {
          sourceLineByEntity.delete(key);
          ambiguousEntities.add(key);
        } else if (!ambiguousEntities.has(key)) {
          sourceLineByEntity.set(key, mappedLine);
        }
      }
    }
    for (const sourceLines of sourceLinesByUri.values()) {
      sourceLines.sort(
        (left, right) => left.line - right.line || left.resultIndex - right.resultIndex,
      );
      deepFreeze(sourceLines);
    }
    this.sourceLinesByUri = sourceLinesByUri;
    this.sourceLineByEntity = sourceLineByEntity;
  }

  private clearMappedIndex(): void {
    this.validationVersion += 1;
    this.mappedSourceLocations.clear();
    this.sourceLinesByUri.clear();
    this.sourceLineByEntity.clear();
    this.sourceLocationsById.clear();
    this.diagnostics = deepFreeze([] as SourceMappingDiagnostics[]);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function deduplicatedMappedLocations(
  records: readonly MappedCodeStack[],
): MappedSourceLocation[] {
  const locations = new Map<string, MappedSourceLocation>();
  for (const { mappedLocation } of records) {
    const key = localLocationKey(mappedLocation);
    if (!locations.has(key)) {
      locations.set(key, mappedLocation);
    }
  }
  return [...locations.values()].sort((left, right) =>
    left.localFile.localeCompare(right.localFile) || left.line - right.line
  );
}

function sourceFilesForLocations(
  locations: readonly MappedSourceLocation[],
): string[] {
  return [...new Set(locations.map(({ sourceFile }) => sourceFile))]
    .sort((left, right) => left.localeCompare(right));
}

function rawLocationKey(file: string, line: number): string {
  return `${file.length}:${file}:${line}`;
}

function localLocationKey(location: MappedSourceLocation): string {
  return `${location.uri.length}:${location.uri}:${location.line}`;
}

function sameStringRecord(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => left[key] === right[key]);
}

function sameOverlay(left: OverlayKey | undefined, right: OverlayKey | undefined): boolean {
  return left === undefined || right === undefined
    ? left === right
    : overlayKeyId(left) === overlayKeyId(right);
}

function entityKey(entity: SourceEntityReference): string {
  return `${entity.resultIndex}:${entity.entityId}`;
}
