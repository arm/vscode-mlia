import { randomUUID } from "crypto";
import type { Dirent, Stats } from "fs";
import * as fs from "fs/promises";
import type { FileHandle } from "fs/promises";
import * as path from "path";

import type { MliaAnalysisMode, MliaAnalysisOptions } from "./pythonRuntime";
import {
  emptyModelExplorerOverlayCatalog,
  ModelExplorerOverlayCatalog,
  OverlaySelection,
  parseModelExplorerOverlayManifest,
  sameOverlaySelection,
} from "./overlaySynchronization";

export type AnalysisStatus = "running" | "complete" | "failed" | "cancelled" | "interrupted";

export interface AnalysisArtifacts {
  htmlPath: string;
  standardizedOutputPath: string;
  entityNodeMappingsPath: string;
}

export interface Analysis {
  id: string;
  modelPath?: string;
  profilingDataPaths: string[];
  targetProfile: string;
  analysisMode: MliaAnalysisMode;
  analysisOptions: MliaAnalysisOptions;
  status: AnalysisStatus;
  startedAt: Date;
  finishedAt?: Date;
  analysisDir: string;
  ownerPid?: number;
  artifacts?: AnalysisArtifacts;
  standardizedOutput?: unknown;
  entityNodeMappings?: unknown;
  modelExplorerOverlayCatalog?: ModelExplorerOverlayCatalog;
  overlaySelection?: OverlaySelection;
  error?: string;
}

export interface AnalysisStoreFileSystem {
  mkdir: (filePath: string, options?: { recursive?: boolean }) => Promise<unknown>;
  readdir: (filePath: string, options: { withFileTypes: true }) => Promise<Dirent[]>;
  readFile: (filePath: string, encoding: "utf8") => Promise<string>;
  open: (filePath: string, flags: string) => Promise<FileHandle>;
  rename: (oldPath: string, newPath: string) => Promise<void>;
  rm: (filePath: string, options: { recursive?: boolean; force?: boolean }) => Promise<void>;
  stat: (filePath: string) => Promise<Stats>;
  realpath: (filePath: string) => Promise<string>;
}

export interface AnalysisStoreOptions {
  globalStoragePath: string;
  ownerPid?: number;
  createId?: () => string;
  isProcessAlive?: (pid: number) => boolean;
  log?: (message: string) => void;
  fileSystem?: Partial<AnalysisStoreFileSystem>;
  waitBeforeManifestRetry?: (attempt: number) => Promise<void>;
}

export interface ClearAllAnalysesOutcome {
  deletedIds: string[];
  skipped: Array<{ directoryName: string; analysisId?: string; reason: string }>;
}

export type DeleteAnalysisOutcome =
  | { status: "deleted"; analysisId: string }
  | { status: "notDeleted"; reason: string }
  | { status: "removeFailed"; analysis: Analysis; reason: string };

interface AnalysisManifestV1 {
  version: 1;
  id: string;
  modelPath?: string;
  profilingDataPaths: string[];
  targetProfile: string;
  analysisMode: MliaAnalysisMode;
  analysisOptions: MliaAnalysisOptions;
  status: AnalysisStatus;
  startedAt: string;
  finishedAt?: string;
  ownerPid?: number;
  artifacts?: AnalysisArtifacts;
  error?: string;
}

class InvalidManifestError extends Error {}

const manifestVersion = 1;
const defaultAnalysisOptions: MliaAnalysisOptions = {
  performance: true,
  compatibility: false,
};
const manifestFileName = "manifest.json";
const manifestRenameRetryDelaysMs = [10, 25, 50, 100];

const defaultFileSystem: AnalysisStoreFileSystem = {
  mkdir: (filePath, options) => fs.mkdir(filePath, options),
  readdir: (filePath, options) => fs.readdir(filePath, options),
  readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
  open: (filePath, flags) => fs.open(filePath, flags),
  rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
  rm: (filePath, options) => fs.rm(filePath, options),
  stat: (filePath) => fs.stat(filePath),
  realpath: (filePath) => fs.realpath(filePath),
};

export class AnalysisStore {
  private readonly analysesById = new Map<string, Analysis>();
  private readonly listeners = new Set<() => void>();
  private readonly ownerPid: number;
  private readonly createId: () => string;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly log: (message: string) => void;
  private readonly fileSystem: AnalysisStoreFileSystem;
  private readonly waitBeforeManifestRetry: (attempt: number) => Promise<void>;
  private currentId: string | undefined;
  private mutationTail: Promise<void> = Promise.resolve();

  public readonly analysesRootPath: string;

  public constructor(options: AnalysisStoreOptions) {
    this.analysesRootPath = path.join(options.globalStoragePath, "analysis-runs");
    this.ownerPid = options.ownerPid ?? process.pid;
    this.createId = options.createId ?? randomUUID;
    this.isProcessAlive = options.isProcessAlive ?? processIsAlive;
    this.log = options.log ?? (() => undefined);
    this.fileSystem = { ...defaultFileSystem, ...options.fileSystem };
    this.waitBeforeManifestRetry = options.waitBeforeManifestRetry ?? defaultManifestRetryWait;
  }

  public get analyses(): Analysis[] {
    return [...this.analysesById.values()].sort(
      (left, right) => right.startedAt.getTime() - left.startedAt.getTime(),
    );
  }

  public get currentAnalysis(): Analysis | undefined {
    return this.currentId === undefined ? undefined : this.analysesById.get(this.currentId);
  }

  public get(id: string): Analysis | undefined {
    return this.analysesById.get(id);
  }

  public isControllable(analysis: Analysis): boolean {
    return analysis.status === "running" && analysis.ownerPid === this.ownerPid;
  }

  public async ensureAnalysesRoot(): Promise<string> {
    await this.fileSystem.mkdir(this.analysesRootPath, { recursive: true });
    return this.analysesRootPath;
  }

  public load(): Promise<void> {
    return this.runMutation(() => this.scanLocked(false));
  }

  public rescan(): Promise<void> {
    return this.runMutation(() => this.scanLocked(true));
  }

  public allocateRunning(
    modelPath: string | undefined,
    targetProfile: string,
    startedAt = new Date(),
    profilingDataPaths: string[] = [],
    analysisMode: MliaAnalysisMode = profilingDataPaths.length > 0 ? "profiling" : "estimation",
    analysisOptions: MliaAnalysisOptions = defaultAnalysisOptions,
  ): Promise<Analysis> {
    if (!modelPath && profilingDataPaths.length === 0) {
      return Promise.reject(new Error("A source model or profiling data path is required."));
    }
    return this.runMutation(async () => {
      await this.ensureAnalysesRoot();

      for (;;) {
        const id = this.createId();
        const analysisDir = path.join(this.analysesRootPath, id);
        try {
          await this.fileSystem.mkdir(analysisDir);
        } catch (error) {
          if (isFileAlreadyExistsError(error)) {
            continue;
          }
          throw error;
        }

        const analysis: Analysis = {
          id,
          modelPath,
          profilingDataPaths: [...profilingDataPaths],
          targetProfile,
          analysisMode,
          analysisOptions: { ...analysisOptions },
          status: "running",
          startedAt,
          analysisDir,
          ownerPid: this.ownerPid,
        };
        try {
          await this.writeManifest(analysis);
        } catch (error) {
          await this.fileSystem.rm(analysisDir, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }

        this.analysesById.set(id, analysis);
        this.emit();
        return analysis;
      }
    });
  }

  public async complete(id: string, artifacts: AnalysisArtifacts): Promise<Analysis | undefined> {
    const expected = await this.runMutation(async () => {
      const analysis = this.analysesById.get(id);
      return analysis && this.isControllable(analysis) ? analysis : undefined;
    });
    if (!expected) {
      return undefined;
    }

    const loadedArtifacts = await this.loadArtifacts(expected.analysisDir, artifacts);

    return this.runMutation(async () => {
      const current = this.analysesById.get(id);
      if (!current || !sameRunningIdentity(current, expected) || !this.isControllable(current)) {
        return undefined;
      }

      const persisted = await this.readAnalysisDirectory(current.analysisDir, true);
      if (!persisted || !sameRunningIdentity(persisted, expected) || !this.isControllable(persisted)) {
        this.replaceFromDisk(id, persisted);
        return undefined;
      }

      const completed: Analysis = {
        ...persisted,
        status: "complete",
        finishedAt: terminalFinishedAt(persisted.startedAt),
        ownerPid: undefined,
        artifacts: loadedArtifacts.artifacts,
        standardizedOutput: loadedArtifacts.standardizedOutput,
        entityNodeMappings: loadedArtifacts.entityNodeMappings,
        modelExplorerOverlayCatalog: loadedArtifacts.modelExplorerOverlayCatalog,
        overlaySelection: current.overlaySelection,
        error: undefined,
      };
      await this.writeManifest(completed);
      this.analysesById.set(id, completed);
      this.emit();
      return completed;
    });
  }

  public fail(id: string, error: string): Promise<boolean> {
    return this.runMutation(async () => {
      const expected = this.analysesById.get(id);
      if (!expected || !this.isControllable(expected)) {
        return false;
      }

      const persisted = await this.readAnalysisDirectory(expected.analysisDir, true);
      if (!persisted || !sameRunningIdentity(persisted, expected) || !this.isControllable(persisted)) {
        this.replaceFromDisk(id, persisted);
        return false;
      }

      const failed: Analysis = {
        ...persisted,
        status: "failed",
        finishedAt: terminalFinishedAt(persisted.startedAt),
        ownerPid: undefined,
        artifacts: undefined,
        standardizedOutput: undefined,
        entityNodeMappings: undefined,
        error,
      };
      await this.writeManifest(failed);
      this.analysesById.set(id, failed);
      if (this.currentId === id) {
        this.currentId = undefined;
      }
      this.emit();
      return true;
    });
  }

  public cancel(id: string): Promise<boolean> {
    return this.runMutation(async () => {
      const expected = this.analysesById.get(id);
      if (!expected || !this.isControllable(expected)) {
        return false;
      }

      // Ownership must be checked from disk immediately before the state change.
      // This prevents stale in-memory ownership from overwriting a live foreign run.
      const persisted = await this.readAnalysisDirectory(expected.analysisDir, true);
      if (!persisted || !sameRunningIdentity(persisted, expected) || !this.isControllable(persisted)) {
        this.replaceFromDisk(id, persisted);
        return false;
      }

      const cancelled: Analysis = {
        ...persisted,
        status: "cancelled",
        finishedAt: terminalFinishedAt(persisted.startedAt),
        ownerPid: undefined,
        error: undefined,
      };
      await this.writeManifest(cancelled);
      this.analysesById.set(id, cancelled);
      this.emit();
      return true;
    });
  }

  public setCurrent(id: string): Promise<boolean> {
    return this.runMutation(async () => {
      const analysis = this.analysesById.get(id);
      if (!analysis || analysis.status !== "complete") {
        return false;
      }
      this.currentId = id;
      this.emit();
      return true;
    });
  }

  public setOverlaySelection(id: string, selection: OverlaySelection): Promise<boolean> {
    return this.runMutation(async () => {
      const analysis = this.analysesById.get(id);
      if (!analysis || analysis.status !== "complete") {
        return false;
      }
      if (sameOverlaySelection(analysis.overlaySelection, selection)) {
        return true;
      }
      this.analysesById.set(id, { ...analysis, overlaySelection: selection });
      this.emit();
      return true;
    });
  }

  public delete(
    id: string,
    beforeRemove?: (analysis: Analysis) => void,
  ): Promise<DeleteAnalysisOutcome> {
    return this.runMutation(async () => {
      await this.scanLocked(true);
      const known = this.analysesById.get(id);
      if (!known) {
        return { status: "notDeleted", reason: "The stored analysis run no longer exists." };
      }

      const analysis = await this.readAnalysisDirectory(known.analysisDir, true);
      if (!analysis || analysis.id !== id || analysis.status === "running") {
        this.replaceFromDisk(id, analysis);
        return {
          status: "notDeleted",
          reason: "The stored analysis run is owned by a running extension host.",
        };
      }

      beforeRemove?.(analysis);
      try {
        await this.fileSystem.rm(analysis.analysisDir, { recursive: true, force: false });
      } catch (error) {
        const reason = `Could not remove the stored analysis run directory: ${errorMessage(error)}`;
        this.log(`${reason} (${analysis.analysisDir})`);
        return { status: "removeFailed", analysis, reason };
      }

      this.analysesById.delete(id);
      if (this.currentId === id) {
        this.currentId = undefined;
      }
      this.emit();
      return { status: "deleted", analysisId: id };
    });
  }

  public clearAll(beforeRemove?: (analysis: Analysis) => void): Promise<ClearAllAnalysesOutcome> {
    return this.runMutation(async () => {
      await this.scanLocked(true);
      const entries = await this.fileSystem.readdir(this.analysesRootPath, { withFileTypes: true });
      const candidates = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      const outcome: ClearAllAnalysesOutcome = { deletedIds: [], skipped: [] };

      for (const directoryName of candidates) {
        const analysisDir = path.join(this.analysesRootPath, directoryName);
        let analysis: Analysis | undefined;
        try {
          analysis = await this.readAnalysisDirectory(analysisDir, true);
        } catch (error) {
          const reason = errorMessage(error);
          this.log(`Skipping analysis run directory during clear: ${analysisDir}: ${reason}`);
          outcome.skipped.push({ directoryName, reason });
          continue;
        }

        if (!analysis) {
          outcome.skipped.push({ directoryName, reason: "Manifest could not be loaded." });
          continue;
        }
        if (analysis.status === "running") {
          this.analysesById.set(analysis.id, analysis);
          outcome.skipped.push({
            directoryName,
            analysisId: analysis.id,
            reason: `Analysis is owned by live process ${analysis.ownerPid}.`,
          });
          continue;
        }

        beforeRemove?.(analysis);
        try {
          await this.fileSystem.rm(analysisDir, { recursive: true, force: false });
        } catch (error) {
          const reason = `Could not remove analysis run directory: ${errorMessage(error)}`;
          this.log(`Skipping analysis run directory during clear: ${analysisDir}: ${reason}`);
          outcome.skipped.push({ directoryName, analysisId: analysis.id, reason });
          continue;
        }
        this.analysesById.delete(analysis.id);
        if (this.currentId === analysis.id) {
          this.currentId = undefined;
        }
        outcome.deletedIds.push(analysis.id);
      }

      this.emit();
      return outcome;
    });
  }

  public subscribe(listener: () => void): { dispose: () => void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private runMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async scanLocked(preserveCurrent: boolean): Promise<void> {
    await this.ensureAnalysesRoot();
    const entries = await this.fileSystem.readdir(this.analysesRootPath, { withFileTypes: true });
    const previousSelections = new Map(
      [...this.analysesById].map(([id, analysis]) => [id, analysis.overlaySelection] as const),
    );
    const analyses = new Map<string, Analysis>();

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const analysisDir = path.join(this.analysesRootPath, entry.name);
      try {
        const analysis = await this.readAnalysisDirectory(analysisDir, true);
        if (analysis) {
          const overlaySelection = previousSelections.get(analysis.id);
          analyses.set(
            analysis.id,
            overlaySelection === undefined ? analysis : { ...analysis, overlaySelection },
          );
        }
      } catch (error) {
        this.log(`Skipping invalid MLIA analysis manifest in ${analysisDir}: ${errorMessage(error)}`);
      }
    }

    const previousCurrentId = preserveCurrent ? this.currentId : undefined;
    this.analysesById.clear();
    for (const [id, analysis] of analyses) {
      this.analysesById.set(id, analysis);
    }
    this.currentId = previousCurrentId !== undefined && analyses.get(previousCurrentId)?.status === "complete"
      ? previousCurrentId
      : undefined;
    this.emit();
  }

  private async readAnalysisDirectory(
    analysisDir: string,
    normalize: boolean,
  ): Promise<Analysis | undefined> {
    const manifest = await this.readManifest(analysisDir);
    if (path.basename(analysisDir) !== manifest.id) {
      throw new InvalidManifestError(`Manifest id '${manifest.id}' does not match its directory name.`);
    }

    let analysis = manifestToAnalysis(manifest, analysisDir);
    if (analysis.status === "running" && !this.isProcessAlive(analysis.ownerPid!)) {
      analysis = {
        ...analysis,
        status: "interrupted",
        ownerPid: undefined,
        error: `Analysis was interrupted because owning extension host process ${manifest.ownerPid} is no longer running.`,
      };
      if (normalize) {
        await this.writeManifest(analysis);
      }
    }

    if (analysis.status !== "complete") {
      return analysis;
    }

    try {
      const loadedArtifacts = await this.loadArtifacts(analysisDir, analysis.artifacts!);
      return {
        ...analysis,
        artifacts: loadedArtifacts.artifacts,
        standardizedOutput: loadedArtifacts.standardizedOutput,
        entityNodeMappings: loadedArtifacts.entityNodeMappings,
        modelExplorerOverlayCatalog: loadedArtifacts.modelExplorerOverlayCatalog,
      };
    } catch (error) {
      const failed: Analysis = {
        ...analysis,
        status: "failed",
        artifacts: undefined,
        standardizedOutput: undefined,
        entityNodeMappings: undefined,
        modelExplorerOverlayCatalog: undefined,
        error: `Stored analysis is unusable: ${errorMessage(error)}`,
      };
      if (normalize) {
        await this.writeManifest(failed);
      }
      return failed;
    }
  }

  private async readManifest(analysisDir: string): Promise<AnalysisManifestV1> {
    const manifestPath = path.join(analysisDir, manifestFileName);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await this.fileSystem.readFile(manifestPath, "utf8")) as unknown;
    } catch (error) {
      throw new InvalidManifestError(`Could not read valid JSON from ${manifestPath}: ${errorMessage(error)}`);
    }

    if (!isRecord(parsed)) {
      throw new InvalidManifestError("Manifest must be a JSON object.");
    }
    if (parsed.version !== manifestVersion) {
      throw new InvalidManifestError(`Unsupported manifest version '${String(parsed.version)}'.`);
    }
    if (typeof parsed.id !== "string" || !parsed.id) {
      throw new InvalidManifestError("Manifest id must be a non-empty string.");
    }
    if (parsed.modelPath !== undefined && (typeof parsed.modelPath !== "string" || !parsed.modelPath)) {
      throw new InvalidManifestError("Manifest modelPath must be a non-empty string when present.");
    }
    const profilingDataPaths = parsed.profilingDataPaths === undefined
      ? []
      : parseProfilingDataPaths(parsed.profilingDataPaths);
    if (parsed.modelPath === undefined && profilingDataPaths.length === 0) {
      throw new InvalidManifestError("Manifest must contain modelPath or profilingDataPaths.");
    }
    if (typeof parsed.targetProfile !== "string" || !parsed.targetProfile) {
      throw new InvalidManifestError("Manifest targetProfile must be a non-empty string.");
    }
    const analysisMode = parsed.analysisMode === undefined
      ? profilingDataPaths.length === 0 ? "estimation" : "profiling"
      : parseAnalysisMode(parsed.analysisMode);
    const analysisOptions = parsed.analysisOptions === undefined
      ? { ...defaultAnalysisOptions }
      : parseAnalysisOptions(parsed.analysisOptions);
    if (!isAnalysisStatus(parsed.status)) {
      throw new InvalidManifestError(`Manifest has invalid status '${String(parsed.status)}'.`);
    }
    if (typeof parsed.startedAt !== "string") {
      throw new InvalidManifestError("Manifest startedAt must be a valid date string.");
    }
    const startedAtTime = Date.parse(parsed.startedAt);
    if (!Number.isFinite(startedAtTime)) {
      throw new InvalidManifestError("Manifest startedAt must be a valid date string.");
    }
    const finishedAtTime = typeof parsed.finishedAt === "string"
      ? Date.parse(parsed.finishedAt)
      : Number.NaN;
    if (parsed.finishedAt !== undefined && !Number.isFinite(finishedAtTime)) {
      throw new InvalidManifestError("Manifest finishedAt must be a valid date string when present.");
    }
    if (parsed.status === "running" && parsed.finishedAt !== undefined) {
      throw new InvalidManifestError("A running manifest must not contain finishedAt.");
    }
    if (parsed.finishedAt !== undefined && finishedAtTime < startedAtTime) {
      throw new InvalidManifestError("Manifest finishedAt must not be earlier than startedAt.");
    }
    if (parsed.status === "running" && (!Number.isInteger(parsed.ownerPid) || (parsed.ownerPid as number) <= 0)) {
      throw new InvalidManifestError("A running manifest must have a positive integer ownerPid.");
    }
    if (parsed.error !== undefined && typeof parsed.error !== "string") {
      throw new InvalidManifestError("Manifest error must be a string when present.");
    }

    const artifacts = parsed.artifacts === undefined ? undefined : parseRelativeArtifacts(parsed.artifacts);
    if (parsed.status === "complete" && !artifacts) {
      throw new InvalidManifestError("A complete manifest must contain artifact paths.");
    }

    return {
      version: 1,
      id: parsed.id,
      modelPath: parsed.modelPath as string | undefined,
      profilingDataPaths,
      targetProfile: parsed.targetProfile,
      analysisMode,
      analysisOptions,
      status: parsed.status,
      startedAt: parsed.startedAt,
      finishedAt: parsed.finishedAt as string | undefined,
      ownerPid: parsed.status === "running" ? parsed.ownerPid as number : undefined,
      artifacts,
      error: parsed.error,
    };
  }

  private async writeManifest(analysis: Analysis): Promise<void> {
    const manifest = analysisToManifest(analysis);
    const manifestPath = path.join(analysis.analysisDir, manifestFileName);
    const temporaryPath = path.join(
      analysis.analysisDir,
      `.${manifestFileName}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      const handle = await this.fileSystem.open(temporaryPath, "wx");
      try {
        await handle.writeFile(`${JSON.stringify(manifest, undefined, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }

      // Keep the destination continuously present. On Windows antivirus, indexers,
      // and webviews can transiently hold the old file, so retry replace-renames
      // without ever unlinking the destination first.
      for (let retry = 0;; retry += 1) {
        try {
          await this.fileSystem.rename(temporaryPath, manifestPath);
          break;
        } catch (error) {
          if (!isTransientManifestRenameError(error) || retry >= manifestRenameRetryDelaysMs.length) {
            throw error;
          }
          await this.waitBeforeManifestRetry(retry + 1);
        }
      }
    } catch (error) {
      await this.fileSystem.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async loadArtifacts(
    analysisDir: string,
    artifacts: AnalysisArtifacts,
  ): Promise<{
    artifacts: AnalysisArtifacts;
    standardizedOutput: unknown;
    entityNodeMappings: unknown;
    modelExplorerOverlayCatalog: ModelExplorerOverlayCatalog;
  }> {
    const relative = relativeArtifacts(analysisDir, artifacts);
    const absolute = absoluteArtifacts(analysisDir, relative);
    const realAnalysisDir = await this.fileSystem.realpath(analysisDir);
    const realArtifacts: AnalysisArtifacts = {
      htmlPath: await this.realManagedPath(realAnalysisDir, absolute.htmlPath),
      standardizedOutputPath: await this.realManagedPath(realAnalysisDir, absolute.standardizedOutputPath),
      entityNodeMappingsPath: await this.realManagedPath(realAnalysisDir, absolute.entityNodeMappingsPath),
    };
    const [htmlStat, standardizedOutputText, entityNodeMappingsText] = await Promise.all([
      this.fileSystem.stat(realArtifacts.htmlPath),
      this.fileSystem.readFile(realArtifacts.standardizedOutputPath, "utf8"),
      this.fileSystem.readFile(realArtifacts.entityNodeMappingsPath, "utf8"),
    ]);
    if (!htmlStat.isFile()) {
      throw new Error(`Required Model Explorer artifact is not a file: ${realArtifacts.htmlPath}`);
    }

    let standardizedOutput: unknown;
    let entityNodeMappings: unknown;
    try {
      standardizedOutput = JSON.parse(standardizedOutputText) as unknown;
    } catch (error) {
      throw new Error(`Invalid standardized output JSON: ${errorMessage(error)}`);
    }
    try {
      entityNodeMappings = JSON.parse(entityNodeMappingsText) as unknown;
    } catch (error) {
      throw new Error(`Invalid entity-node mappings JSON: ${errorMessage(error)}`);
    }
    const modelExplorerOverlayCatalog = await this.loadModelExplorerOverlayCatalog(
      realAnalysisDir,
    );
    return {
      artifacts: realArtifacts,
      standardizedOutput,
      entityNodeMappings,
      modelExplorerOverlayCatalog,
    };
  }

  private async loadModelExplorerOverlayCatalog(
    realAnalysisDir: string,
  ): Promise<ModelExplorerOverlayCatalog> {
    const manifestPath = path.join(
      realAnalysisDir,
      "mlia-output",
      "model-explorer",
      "manifest.json",
    );
    try {
      const realManifestPath = await this.realManagedPath(realAnalysisDir, manifestPath);
      const catalog = parseModelExplorerOverlayManifest(
        await this.fileSystem.readFile(realManifestPath, "utf8"),
      );
      for (const diagnostic of catalog.diagnostics) {
        this.log(`Ignoring Model Explorer overlay manifest entry in ${realManifestPath}: ${diagnostic}`);
      }
      return catalog;
    } catch (error) {
      this.log(
        `Model Explorer overlay manifest is unavailable at ${manifestPath}; overlay synchronization will fail closed: ${errorMessage(error)}`,
      );
      return emptyModelExplorerOverlayCatalog();
    }
  }

  private async realManagedPath(realAnalysisDir: string, artifactPath: string): Promise<string> {
    const realArtifactPath = await this.fileSystem.realpath(artifactPath);
    if (!isPathContained(realAnalysisDir, realArtifactPath)) {
      throw new InvalidManifestError(
        `Managed artifact resolves outside the analysis directory: ${artifactPath}`,
      );
    }
    return realArtifactPath;
  }

  private replaceFromDisk(id: string, analysis: Analysis | undefined): void {
    if (analysis?.id === id) {
      const previousSelection = this.analysesById.get(id)?.overlaySelection;
      this.analysesById.set(
        id,
        previousSelection === undefined ? analysis : { ...analysis, overlaySelection: previousSelection },
      );
      if (this.currentId === id && analysis.status !== "complete") {
        this.currentId = undefined;
      }
      this.emit();
    }
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function manifestToAnalysis(manifest: AnalysisManifestV1, analysisDir: string): Analysis {
  return {
    id: manifest.id,
    modelPath: manifest.modelPath,
    profilingDataPaths: [...manifest.profilingDataPaths],
    targetProfile: manifest.targetProfile,
    analysisMode: manifest.analysisMode,
    analysisOptions: { ...manifest.analysisOptions },
    status: manifest.status,
    startedAt: new Date(manifest.startedAt),
    finishedAt: manifest.finishedAt === undefined ? undefined : new Date(manifest.finishedAt),
    analysisDir,
    ownerPid: manifest.ownerPid,
    artifacts: manifest.artifacts === undefined
      ? undefined
      : absoluteArtifacts(analysisDir, manifest.artifacts),
    error: manifest.error,
  };
}

function analysisToManifest(analysis: Analysis): AnalysisManifestV1 {
  return {
    version: 1,
    id: analysis.id,
    modelPath: analysis.modelPath,
    profilingDataPaths: [...analysis.profilingDataPaths],
    targetProfile: analysis.targetProfile,
    analysisMode: analysis.analysisMode,
    analysisOptions: { ...analysis.analysisOptions },
    status: analysis.status,
    startedAt: analysis.startedAt.toISOString(),
    finishedAt: analysis.finishedAt?.toISOString(),
    ownerPid: analysis.status === "running" ? analysis.ownerPid : undefined,
    artifacts: analysis.status === "complete" && analysis.artifacts
      ? relativeArtifacts(analysis.analysisDir, analysis.artifacts)
      : undefined,
    error: analysis.error,
  };
}

function parseRelativeArtifacts(value: unknown): AnalysisArtifacts {
  if (!isRecord(value)) {
    throw new InvalidManifestError("Manifest artifacts must be an object.");
  }
  return {
    htmlPath: parseRelativePath(value.htmlPath, "htmlPath"),
    standardizedOutputPath: parseRelativePath(value.standardizedOutputPath, "standardizedOutputPath"),
    entityNodeMappingsPath: parseRelativePath(value.entityNodeMappingsPath, "entityNodeMappingsPath"),
  };
}

function relativeArtifacts(analysisDir: string, artifacts: AnalysisArtifacts): AnalysisArtifacts {
  return {
    htmlPath: relativeManagedPath(analysisDir, artifacts.htmlPath),
    standardizedOutputPath: relativeManagedPath(analysisDir, artifacts.standardizedOutputPath),
    entityNodeMappingsPath: relativeManagedPath(analysisDir, artifacts.entityNodeMappingsPath),
  };
}

function absoluteArtifacts(analysisDir: string, artifacts: AnalysisArtifacts): AnalysisArtifacts {
  return {
    htmlPath: resolveManagedPath(analysisDir, artifacts.htmlPath),
    standardizedOutputPath: resolveManagedPath(analysisDir, artifacts.standardizedOutputPath),
    entityNodeMappingsPath: resolveManagedPath(analysisDir, artifacts.entityNodeMappingsPath),
  };
}

function relativeManagedPath(analysisDir: string, filePath: string): string {
  const relative = path.relative(analysisDir, filePath);
  return parseRelativePath(relative, "artifact path");
}

function resolveManagedPath(analysisDir: string, relativePath: string): string {
  const safeRelativePath = parseRelativePath(relativePath, "artifact path");
  const resolved = path.resolve(analysisDir, safeRelativePath);
  if (!isPathContained(analysisDir, resolved)) {
    throw new InvalidManifestError("Manifest artifact path must remain inside the analysis directory.");
  }
  return resolved;
}

function parseRelativePath(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || isAbsoluteOrDriveRelative(value)) {
    throw new InvalidManifestError(`Manifest ${name} must be a non-empty relative path.`);
  }
  if (value.split(/[\\/]+/u).includes("..")) {
    throw new InvalidManifestError(`Manifest ${name} must remain inside the analysis directory.`);
  }
  return path.normalize(value);
}

function isAbsoluteOrDriveRelative(value: string): boolean {
  return path.isAbsolute(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/u.test(value);
}

function isPathContained(rootPath: string, candidatePath: string): boolean {
  const root = comparablePath(rootPath);
  const candidate = comparablePath(candidatePath);
  return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

function comparablePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function terminalFinishedAt(startedAt: Date): Date {
  return new Date(Math.max(Date.now(), startedAt.getTime()));
}

function sameRunningIdentity(left: Analysis, right: Analysis): boolean {
  return left.status === "running" && right.status === "running" &&
    left.id === right.id &&
    comparablePath(left.analysisDir) === comparablePath(right.analysisDir) &&
    left.modelPath === right.modelPath &&
    samePaths(left.profilingDataPaths, right.profilingDataPaths) &&
    left.targetProfile === right.targetProfile &&
    left.analysisMode === right.analysisMode &&
    left.analysisOptions.performance === right.analysisOptions.performance &&
    left.analysisOptions.compatibility === right.analysisOptions.compatibility &&
    left.startedAt.getTime() === right.startedAt.getTime() &&
    left.ownerPid === right.ownerPid;
}

function parseProfilingDataPaths(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((pathValue) => typeof pathValue !== "string" || pathValue.length === 0)
  ) {
    throw new InvalidManifestError(
      "Manifest profilingDataPaths must be an array of non-empty strings.",
    );
  }
  return [...value];
}

function parseAnalysisMode(value: unknown): MliaAnalysisMode {
  if (value !== "estimation" && value !== "profiling") {
    throw new InvalidManifestError(`Manifest analysisMode has invalid value '${String(value)}'.`);
  }
  return value;
}

function parseAnalysisOptions(value: unknown): MliaAnalysisOptions {
  if (
    !isRecord(value) ||
    typeof value.performance !== "boolean" ||
    typeof value.compatibility !== "boolean"
  ) {
    throw new InvalidManifestError(
      "Manifest analysisOptions must contain boolean performance and compatibility fields.",
    );
  }
  return {
    performance: value.performance,
    compatibility: value.compatibility,
  };
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isAnalysisStatus(value: unknown): value is AnalysisStatus {
  return value === "running" || value === "complete" || value === "failed" ||
    value === "cancelled" || value === "interrupted";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isPermissionError(error);
  }
}

function isPermissionError(error: unknown): boolean {
  return fileSystemErrorCode(error) === "EPERM";
}

function isFileAlreadyExistsError(error: unknown): boolean {
  return fileSystemErrorCode(error) === "EEXIST";
}

function isTransientManifestRenameError(error: unknown): boolean {
  const code = fileSystemErrorCode(error);
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

function fileSystemErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function defaultManifestRetryWait(attempt: number): Promise<void> {
  const delay = manifestRenameRetryDelaysMs[Math.min(attempt - 1, manifestRenameRetryDelaysMs.length - 1)];
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
