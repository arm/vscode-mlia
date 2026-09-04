import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, it } from "node:test";

import {
  AnalysisPanelController,
  beginAnalysis,
  cancelAnalysis,
  completeAnalysis,
  deleteAnalysis,
  startAnalysis,
} from "../analysisLifecycle";
import {
  Analysis,
  AnalysisArtifacts,
  AnalysisStore,
  AnalysisStoreFileSystem,
} from "../analysisStore";

const tempDirs: string[] = [];
let nextId = 1;

async function store(fileSystem?: Partial<AnalysisStoreFileSystem>): Promise<AnalysisStore> {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "mlia-lifecycle-test-"));
  tempDirs.push(storage);
  return new AnalysisStore({
    globalStoragePath: storage,
    ownerPid: 100,
    createId: () => `analysis-${nextId++}`,
    isProcessAlive: (pid) => pid === 100,
    fileSystem,
  });
}

async function artifacts(analysis: Analysis): Promise<AnalysisArtifacts> {
  const root = path.join(analysis.analysisDir, "mlia-output", "model-explorer");
  const bundle = path.join(root, "bundle");
  await fs.mkdir(bundle, { recursive: true });
  const value = {
    htmlPath: path.join(bundle, "index.html"),
    standardizedOutputPath: path.join(root, "standardized-output.json"),
    entityNodeMappingsPath: path.join(root, "entity-node-mappings.json"),
  };
  await Promise.all([
    fs.writeFile(value.htmlPath, "<html></html>"),
    fs.writeFile(value.standardizedOutputPath, JSON.stringify({ results: [] })),
    fs.writeFile(value.entityNodeMappingsPath, JSON.stringify({ results: [] })),
  ]);
  return value;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function panels(): AnalysisPanelController & {
  started: Array<{ analysis: Analysis; focus: string }>;
  opened: Array<{ analysis: Analysis; focus: string }>;
  errors: Array<{ analysisId: string; message: string }>;
  closed: string[];
} {
  const started: Array<{ analysis: Analysis; focus: string }> = [];
  const opened: Array<{ analysis: Analysis; focus: string }> = [];
  const errors: Array<{ analysisId: string; message: string }> = [];
  const closed: string[] = [];
  return {
    started,
    opened,
    errors,
    closed,
    openRunning: (analysis, focus) => started.push({ analysis, focus }),
    open: async (analysis, focus) => {
      opened.push({ analysis, focus });
    },
    showError: (analysisId, message) => errors.push({ analysisId, message }),
    close: (analysisId) => closed.push(analysisId),
  };
}

afterEach(async () => {
  nextId = 1;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("analysis lifecycle", () => {
  it("opens a loading panel as soon as a persisted analysis starts", async () => {
    const analysisStore = await store();
    const panelController = panels();
    const analysis = await analysisStore.allocateRunning("model.vgf", "neural-technology");
    beginAnalysis(panelController, analysis, true);
    assert.deepStrictEqual(
      panelController.started.map(({ analysis: opened, focus }) => ({ id: opened.id, focus })),
      [{ id: analysis.id, focus: "focus" }],
    );
  });

  it("does not open a loading panel when automatic Model Explorer opening was disabled at start", async () => {
    const analysisStore = await store();
    const panelController = panels();
    const analysis = await analysisStore.allocateRunning("model.vgf", "neural-technology");

    beginAnalysis(panelController, analysis, false);

    assert.deepStrictEqual(panelController.started, []);
  });

  it("persists synchronous start failure without creating or revealing a panel when auto-open is disabled", async () => {
    const analysisStore = await store();
    const panelController = panels();

    const result = await startAnalysis({
      store: analysisStore,
      panels: panelController,
      runningCommands: new Map<string, { stop: () => void }>(),
      modelPath: "model.vgf",
      profilingDataPaths: [],
      targetProfile: "neural-technology",
      analysisMode: "estimation",
      analysisOptions: { performance: true, compatibility: false },
      autoOpen: false,
      start: (): { command: { stop: () => void }; completion: Promise<AnalysisArtifacts> } => {
        throw new Error("could not start");
      },
      synchronousFailureMessage: (message) => `start: ${message}`,
      asynchronousFailureMessage: (message) => `completion: ${message}`,
    });

    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(panelController.started, []);
    assert.deepStrictEqual(panelController.opened, []);
    assert.deepStrictEqual(panelController.errors, [{
      analysisId: result.analysis.id,
      message: "start: could not start",
    }]);
    await analysisStore.rescan();
    assert.strictEqual(analysisStore.get(result.analysis.id)?.status, "failed");
    assert.strictEqual(analysisStore.get(result.analysis.id)?.error, "could not start");
  });

  it("persists asynchronous failure without creating or revealing a panel when auto-open is disabled", async () => {
    const analysisStore = await store();
    const panelController = panels();
    const runningCommands = new Map<string, { stop: () => void }>();
    const logs: string[] = [];

    const result = await startAnalysis({
      store: analysisStore,
      panels: panelController,
      runningCommands,
      modelPath: "model.vgf",
      profilingDataPaths: [],
      targetProfile: "neural-technology",
      analysisMode: "estimation",
      analysisOptions: { performance: true, compatibility: false },
      autoOpen: false,
      start: () => ({
        command: { stop: () => {} },
        completion: Promise.reject(new Error("analysis failed")),
      }),
      synchronousFailureMessage: (message) => `start: ${message}`,
      asynchronousFailureMessage: (message) => `completion: ${message}`,
      log: (message) => logs.push(message),
    });

    assert.strictEqual(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.strictEqual(await result.settled, false);
    assert.deepStrictEqual(panelController.started, []);
    assert.deepStrictEqual(panelController.opened, []);
    assert.deepStrictEqual(panelController.errors, [{
      analysisId: result.analysis.id,
      message: "completion: analysis failed",
    }]);
    assert.strictEqual(runningCommands.has(result.analysis.id), false);
    await analysisStore.rescan();
    assert.strictEqual(analysisStore.get(result.analysis.id)?.status, "failed");
    assert.strictEqual(analysisStore.get(result.analysis.id)?.error, "analysis failed");
    assert.deepStrictEqual(logs, []);
  });

  it("makes a successful analysis current and opens its panel", async () => {
    const analysisStore = await store();
    const panelController = panels();
    const analysis = await analysisStore.allocateRunning("model.vgf", "neural-technology");

    assert.strictEqual(
      await completeAnalysis(analysisStore, panelController, analysis.id, await artifacts(analysis), true),
      true,
    );
    assert.strictEqual(analysisStore.currentAnalysis?.id, analysis.id);
    assert.deepStrictEqual(analysisStore.get(analysis.id)?.standardizedOutput, { results: [] });
    assert.deepStrictEqual(analysisStore.get(analysis.id)?.entityNodeMappings, { results: [] });
    assert.deepStrictEqual(
      panelController.opened.map(({ analysis: opened, focus }) => ({ id: opened.id, focus })),
      [{ id: analysis.id, focus: "focus" }],
    );
  });

  it("persists and makes a successful analysis current without opening it when auto-open is disabled", async () => {
    const analysisStore = await store();
    const panelController = panels();
    const analysis = await analysisStore.allocateRunning("model.vgf", "neural-technology");

    assert.strictEqual(
      await completeAnalysis(analysisStore, panelController, analysis.id, await artifacts(analysis), false),
      true,
    );

    assert.strictEqual(analysisStore.currentAnalysis?.id, analysis.id);
    assert.strictEqual(analysisStore.get(analysis.id)?.status, "complete");
    assert.deepStrictEqual(panelController.opened, []);
  });

  it("persists cancellation before stopping and removing the command", async () => {
    const analysisStore = await store();
    const analysis = await analysisStore.allocateRunning("model.vgf", "neural-technology");
    let statusWhenStopped: string | undefined;
    const commands = new Map([[analysis.id, {
      stop: () => {
        statusWhenStopped = analysisStore.get(analysis.id)?.status;
      },
    }]]);

    assert.strictEqual(await cancelAnalysis(analysisStore, commands, analysis.id), true);
    assert.strictEqual(statusWhenStopped, "cancelled");
    assert.strictEqual(commands.has(analysis.id), false);
  });

  it("does not make current or open a panel when cancellation wins during artifact reads", async () => {
    const artifactRead = deferred();
    const continueRead = deferred();
    let deferArtifact = false;
    const analysisStore = await store({
      readFile: async (filePath, encoding) => {
        const content = await fs.readFile(filePath, encoding);
        if (deferArtifact && filePath.endsWith("standardized-output.json")) {
          deferArtifact = false;
          artifactRead.resolve();
          await continueRead.promise;
        }
        return content;
      },
    });
    const panelController = panels();
    const analysis = await analysisStore.allocateRunning("model.vgf", "neural-technology");
    const generated = await artifacts(analysis);
    const commands = new Map([[analysis.id, { stop: () => undefined }]]);

    deferArtifact = true;
    const completion = completeAnalysis(analysisStore, panelController, analysis.id, generated, true);
    await artifactRead.promise;
    assert.strictEqual(await cancelAnalysis(analysisStore, commands, analysis.id), true);
    continueRead.resolve();

    assert.strictEqual(await completion, false);
    assert.strictEqual(analysisStore.currentAnalysis, undefined);
    assert.deepStrictEqual(panelController.opened, []);
    assert.strictEqual(analysisStore.get(analysis.id)?.status, "cancelled");
  });

  it("does not cancel a completed analysis", async () => {
    const analysisStore = await store();
    const analysis = await analysisStore.allocateRunning("model.vgf", "neural-technology");
    await completeAnalysis(analysisStore, panels(), analysis.id, await artifacts(analysis), true);
    let stopped = false;
    const commands = new Map([[analysis.id, { stop: () => { stopped = true; } }]]);

    assert.strictEqual(await cancelAnalysis(analysisStore, commands, analysis.id), false);
    assert.strictEqual(stopped, false);
  });

  it("closes a panel before deleting a non-running analysis directory", async () => {
    const analysisStore = await store();
    const panelController = panels();
    const analysis = await analysisStore.allocateRunning("model.vgf", "neural-technology");
    await completeAnalysis(analysisStore, panelController, analysis.id, await artifacts(analysis), true);
    panelController.closed.length = 0;

    assert.deepStrictEqual(await deleteAnalysis(analysisStore, panelController, analysis.id), {
      status: "deleted",
      analysisId: analysis.id,
    });
    assert.deepStrictEqual(panelController.closed, [analysis.id]);
    assert.strictEqual(analysisStore.get(analysis.id), undefined);
    await assert.rejects(fs.stat(analysis.analysisDir), /ENOENT/);
  });

  it("does not close or delete a live running analysis", async () => {
    const analysisStore = await store();
    const panelController = panels();
    const analysis = await analysisStore.allocateRunning("model.vgf", "neural-technology");

    assert.deepStrictEqual(await deleteAnalysis(analysisStore, panelController, analysis.id), {
      status: "notDeleted",
      reason: "The stored analysis run is owned by a running extension host.",
    });
    assert.deepStrictEqual(panelController.closed, []);
    assert.strictEqual(analysisStore.get(analysis.id)?.status, "running");
  });
});
