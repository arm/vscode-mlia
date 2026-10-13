import * as assert from "assert";
import * as fsSync from "fs";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, it } from "node:test";

import {
  Analysis,
  AnalysisArtifacts,
  AnalysisStore,
  AnalysisStoreFileSystem,
} from "../analysisStore";

const tempDirs: string[] = [];

async function makeStorage(): Promise<string> {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "mlia-analysis-store-test-"));
  tempDirs.push(storage);
  return storage;
}

function makeStore(
  globalStoragePath: string,
  options: {
    ownerPid?: number;
    ids?: string[];
    alivePids?: number[];
    logs?: string[];
    fileSystem?: Partial<AnalysisStoreFileSystem>;
    waitBeforeManifestRetry?: (attempt: number) => Promise<void>;
  } = {},
): AnalysisStore {
  const ids = options.ids ? [...options.ids] : undefined;
  return new AnalysisStore({
    globalStoragePath,
    ownerPid: options.ownerPid ?? 100,
    createId: ids ? () => {
      const id = ids.shift();
      if (!id) {
        throw new Error("No test analysis id available");
      }
      return id;
    } : undefined,
    isProcessAlive: (pid) => (options.alivePids ?? [options.ownerPid ?? 100]).includes(pid),
    log: (message) => options.logs?.push(message),
    fileSystem: options.fileSystem,
    waitBeforeManifestRetry: options.waitBeforeManifestRetry,
  });
}

async function createArtifacts(analysis: Analysis): Promise<AnalysisArtifacts> {
  const modelExplorerDir = path.join(analysis.analysisDir, "mlia-output", "model-explorer");
  const bundleDir = path.join(modelExplorerDir, "bundle");
  await fs.mkdir(bundleDir, { recursive: true });
  const artifacts = {
    htmlPath: path.join(bundleDir, "index.html"),
    standardizedOutputPath: path.join(modelExplorerDir, "standardized-output.json"),
    entityNodeMappingsPath: path.join(modelExplorerDir, "entity-node-mappings.json"),
  };
  await Promise.all([
    fs.writeFile(artifacts.htmlPath, "<html>Model Explorer</html>", "utf8"),
    fs.writeFile(artifacts.standardizedOutputPath, JSON.stringify({ results: [{ id: 1 }] }), "utf8"),
    fs.writeFile(artifacts.entityNodeMappingsPath, JSON.stringify({ mappings: ["node"] }), "utf8"),
  ]);
  return artifacts;
}

async function readManifest(analysis: Analysis): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(analysis.analysisDir, "manifest.json"), "utf8")) as Record<string, unknown>;
}

async function writeManifest(
  analysisDir: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  await fs.writeFile(path.join(analysisDir, "manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function fileSystemError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("AnalysisStore persistence", () => {
  it("selects new runs immediately and retains selection through failure and rescans", async () => {
    const store = makeStore(await makeStorage());
    const first = await store.allocateRunning("first.vgf", "profile");
    assert.strictEqual(store.currentAnalysis?.id, first.id);
    const second = await store.allocateRunning("second.vgf", "profile");
    assert.strictEqual(store.currentAnalysis?.id, second.id);
    assert.strictEqual(await store.setCurrent(first.id), true);
    await store.fail(first.id, "test failure");
    await store.rescan();
    assert.strictEqual(store.currentAnalysis?.id, first.id);
    assert.strictEqual(store.currentAnalysis?.status, "failed");
    assert.strictEqual(await store.setCurrent(second.id), true);
    await store.cancel(second.id);
    await store.rescan();
    assert.strictEqual(store.currentAnalysis?.status, "cancelled");
    assert.strictEqual(await store.setCurrent("missing"), false);
    assert.strictEqual(store.currentAnalysis?.id, second.id);
  });

  it("keeps an interrupted run selected after its owner disappears", async () => {
    const alivePids = [100];
    const store = makeStore(await makeStorage(), { alivePids });
    const run = await store.allocateRunning("model.vgf", "profile");
    alivePids.length = 0;
    await store.rescan();
    assert.strictEqual(store.currentAnalysis?.id, run.id);
    assert.strictEqual(store.currentAnalysis?.status, "interrupted");
    assert.strictEqual(await store.setCurrent(run.id), true);
  });

  it("allocates a durable UUID directory and persists running ownership before returning", async () => {
    const storage = await makeStorage();
    const store = new AnalysisStore({ globalStoragePath: storage, ownerPid: 4321, isProcessAlive: () => true });

    const analysis = await store.allocateRunning("C:/models/a.vgf", "neural-technology", new Date("2025-01-02T03:04:05Z"));

    assert.match(analysis.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    assert.strictEqual(analysis.analysisDir, path.join(storage, "analysis-runs", analysis.id));
    assert.strictEqual((await fs.stat(analysis.analysisDir)).isDirectory(), true);
    assert.deepStrictEqual(await readManifest(analysis), {
      version: 1,
      id: analysis.id,
      modelPath: "C:/models/a.vgf",
      profilingDataPaths: [],
      targetProfile: "neural-technology",
      analysisMode: "estimation",
      analysisOptions: { performance: true, compatibility: false },
      status: "running",
      startedAt: "2025-01-02T03:04:05.000Z",
      ownerPid: 4321,
    });
  });

  it("persists profiling-only inputs and reloads them", async () => {
    const storage = await makeStorage();
    const store = makeStore(storage, { ids: ["profiling-only"] });

    const analysis = await store.allocateRunning(
      undefined,
      "neural-technology",
      new Date("2025-01-02T03:04:05Z"),
      ["relative/captures/profile.json", "relative/captures/profile-2.json"],
      "profiling",
      { performance: true, compatibility: true },
    );

    assert.strictEqual(analysis.modelPath, undefined);
    assert.deepStrictEqual(analysis.profilingDataPaths, [
      "relative/captures/profile.json",
      "relative/captures/profile-2.json",
    ]);
    assert.deepStrictEqual(await readManifest(analysis), {
      version: 1,
      id: "profiling-only",
      profilingDataPaths: [
        "relative/captures/profile.json",
        "relative/captures/profile-2.json",
      ],
      targetProfile: "neural-technology",
      analysisMode: "profiling",
      analysisOptions: { performance: true, compatibility: true },
      status: "running",
      startedAt: "2025-01-02T03:04:05.000Z",
      ownerPid: 100,
    });

    const reloaded = makeStore(storage);
    await reloaded.load();
    assert.strictEqual(reloaded.get(analysis.id)?.modelPath, undefined);
    assert.deepStrictEqual(reloaded.get(analysis.id)?.profilingDataPaths, [
      "relative/captures/profile.json",
      "relative/captures/profile-2.json",
    ]);
    assert.strictEqual(reloaded.get(analysis.id)?.analysisMode, "profiling");
    assert.deepStrictEqual(reloaded.get(analysis.id)?.analysisOptions, {
      performance: true,
      compatibility: true,
    });
  });

  it("rejects allocation without either analysis input", async () => {
    const storage = await makeStorage();
    const store = makeStore(storage);

    await assert.rejects(
      store.allocateRunning(undefined, "neural-technology"),
      /source model or profiling data path/,
    );
  });

  it("persists relative artifacts, reloads complete analyses, and does not restore current selection", async () => {
    const storage = await makeStorage();
    const store = makeStore(storage, { ids: ["analysis-a"] });
    const analysis = await store.allocateRunning("C:/models/a.vgf", "profile");
    const artifacts = await createArtifacts(analysis);

    const completed = await store.complete(analysis.id, artifacts);
    assert.ok(completed);
    assert.ok(completed.finishedAt);
    assert.strictEqual(await store.setCurrent(analysis.id), true);
    assert.deepStrictEqual(completed.standardizedOutput, { results: [{ id: 1 }] });
    assert.deepStrictEqual(completed.entityNodeMappings, { mappings: ["node"] });

    const manifest = await readManifest(analysis);
    assert.strictEqual(manifest.status, "complete");
    assert.strictEqual(typeof manifest.finishedAt, "string");
    assert.strictEqual("ownerPid" in manifest, false);
    assert.deepStrictEqual(manifest.artifacts, {
      htmlPath: path.join("mlia-output", "model-explorer", "bundle", "index.html"),
      standardizedOutputPath: path.join("mlia-output", "model-explorer", "standardized-output.json"),
      entityNodeMappingsPath: path.join("mlia-output", "model-explorer", "entity-node-mappings.json"),
    });

    const reloaded = makeStore(storage);
    await reloaded.load();
    assert.strictEqual(reloaded.currentAnalysis, undefined);
    assert.strictEqual(reloaded.get(analysis.id)?.status, "complete");
    assert.strictEqual(
      reloaded.get(analysis.id)?.finishedAt?.toISOString(),
      completed.finishedAt.toISOString(),
    );
    assert.deepStrictEqual(reloaded.get(analysis.id)?.standardizedOutput, { results: [{ id: 1 }] });
    assert.deepStrictEqual(reloaded.get(analysis.id)?.entityNodeMappings, { mappings: ["node"] });

    delete manifest.finishedAt;
    await writeManifest(analysis.analysisDir, manifest);
    const legacyReloaded = makeStore(storage);
    await legacyReloaded.load();
    assert.strictEqual(legacyReloaded.get(analysis.id)?.status, "complete");
    assert.strictEqual(legacyReloaded.get(analysis.id)?.finishedAt, undefined);
    assert.deepStrictEqual(legacyReloaded.get(analysis.id)?.standardizedOutput, { results: [{ id: 1 }] });
  });

  it("clamps every terminal timestamp to a future startedAt and reloads the manifests", async () => {
    const storage = await makeStorage();
    const store = makeStore(storage, {
      ids: ["future-complete", "future-failed", "future-cancelled"],
    });
    const futureStartedAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const completed = await store.allocateRunning("complete.vgf", "p", futureStartedAt);
    const failed = await store.allocateRunning("failed.vgf", "p", futureStartedAt);
    const cancelled = await store.allocateRunning("cancelled.vgf", "p", futureStartedAt);

    assert.strictEqual(
      (await store.complete(completed.id, await createArtifacts(completed)))?.finishedAt?.toISOString(),
      futureStartedAt.toISOString(),
    );
    assert.strictEqual(await store.fail(failed.id, "bad analysis"), true);
    assert.strictEqual(await store.cancel(cancelled.id), true);

    for (const analysis of [completed, failed, cancelled]) {
      assert.strictEqual(
        store.get(analysis.id)?.finishedAt?.toISOString(),
        futureStartedAt.toISOString(),
      );
      assert.strictEqual(
        (await readManifest(analysis)).finishedAt,
        futureStartedAt.toISOString(),
      );
    }

    const reloaded = makeStore(storage);
    await reloaded.load();
    assert.strictEqual(reloaded.get(completed.id)?.status, "complete");
    assert.strictEqual(reloaded.get(failed.id)?.status, "failed");
    assert.strictEqual(reloaded.get(cancelled.id)?.status, "cancelled");
    for (const analysis of [completed, failed, cancelled]) {
      const loaded = reloaded.get(analysis.id);
      assert.ok(loaded?.finishedAt);
      assert.ok(loaded.finishedAt.getTime() >= loaded.startedAt.getTime());
      assert.strictEqual(loaded.finishedAt.toISOString(), futureStartedAt.toISOString());
    }
  });

  it("persists failed and cancelled lifecycle states", async () => {
    const storage = await makeStorage();
    const store = makeStore(storage, { ids: ["failed-analysis", "cancelled-analysis"] });
    const failed = await store.allocateRunning("failed.vgf", "p", new Date(1));
    const cancelled = await store.allocateRunning("cancelled.vgf", "p", new Date(2));

    assert.strictEqual(await store.fail(failed.id, "bad analysis"), true);
    assert.strictEqual(await store.cancel(cancelled.id), true);
    const failedAnalysis = store.get(failed.id);
    const cancelledAnalysis = store.get(cancelled.id);
    assert.ok(failedAnalysis?.finishedAt);
    assert.ok(cancelledAnalysis?.finishedAt);
    assert.ok(failedAnalysis.finishedAt.getTime() >= failedAnalysis.startedAt.getTime());
    assert.ok(cancelledAnalysis.finishedAt.getTime() >= cancelledAnalysis.startedAt.getTime());
    const failedManifest = await readManifest(failed);
    const cancelledManifest = await readManifest(cancelled);
    assert.strictEqual(typeof failedManifest.finishedAt, "string");
    assert.strictEqual(typeof cancelledManifest.finishedAt, "string");

    const reloaded = makeStore(storage);
    await reloaded.load();
    assert.deepStrictEqual(
      reloaded.analyses.map(({ id, status, error }) => ({ id, status, error })),
      [
        { id: "cancelled-analysis", status: "cancelled", error: undefined },
        { id: "failed-analysis", status: "failed", error: "bad analysis" },
      ],
    );
    assert.strictEqual(
      reloaded.get(failed.id)?.finishedAt?.toISOString(),
      failedManifest.finishedAt,
    );
    assert.strictEqual(
      reloaded.get(cancelled.id)?.finishedAt?.toISOString(),
      cancelledManifest.finishedAt,
    );
  });

  it("normalizes dead running owners to interrupted but leaves live foreign owners non-controllable", async () => {
    const storage = await makeStorage();
    const creator = makeStore(storage, { ownerPid: 200, ids: ["dead-owner", "live-owner"], alivePids: [200, 300] });
    const dead = await creator.allocateRunning("dead.vgf", "p", new Date(1));
    const live = await creator.allocateRunning("live.vgf", "p", new Date(2));
    const liveManifest = await readManifest(live);
    liveManifest.ownerPid = 300;
    await writeManifest(live.analysisDir, liveManifest);

    const loader = makeStore(storage, { ownerPid: 100, alivePids: [300] });
    await loader.load();

    assert.strictEqual(loader.get(dead.id)?.status, "interrupted");
    assert.match(loader.get(dead.id)?.error ?? "", /process 200 is no longer running/);
    assert.strictEqual((await readManifest(dead)).status, "interrupted");
    assert.strictEqual(loader.get(live.id)?.status, "running");
    assert.strictEqual(loader.get(live.id)?.ownerPid, 300);
    assert.strictEqual(loader.isControllable(loader.get(live.id)!), false);
    assert.strictEqual(await loader.cancel(live.id), false);
  });

  it("normalizes missing or corrupt completed artifacts to failed manifests", async () => {
    const storage = await makeStorage();
    const store = makeStore(storage, { ids: ["missing-html", "corrupt-json"] });
    const missing = await store.allocateRunning("missing.vgf", "p", new Date(1));
    const corrupt = await store.allocateRunning("corrupt.vgf", "p", new Date(2));
    const missingArtifacts = await createArtifacts(missing);
    const corruptArtifacts = await createArtifacts(corrupt);
    await store.complete(missing.id, missingArtifacts);
    await store.complete(corrupt.id, corruptArtifacts);
    await fs.rm(missingArtifacts.htmlPath);
    await fs.writeFile(corruptArtifacts.standardizedOutputPath, "not-json", "utf8");

    const reloaded = makeStore(storage);
    await reloaded.load();

    assert.strictEqual(reloaded.get(missing.id)?.status, "failed");
    assert.match(reloaded.get(missing.id)?.error ?? "", /unusable/);
    assert.strictEqual((await readManifest(missing)).status, "failed");
    assert.strictEqual(reloaded.get(corrupt.id)?.status, "failed");
    assert.match(reloaded.get(corrupt.id)?.error ?? "", /Invalid standardized output JSON/);
    assert.strictEqual((await readManifest(corrupt)).status, "failed");
  });

  it("logs and skips corrupt and unsupported manifests without failing the load", async () => {
    const storage = await makeStorage();
    const analysesRoot = path.join(storage, "analysis-runs");
    const corruptDir = path.join(analysesRoot, "corrupt");
    const unsupportedDir = path.join(analysesRoot, "unsupported");
    await fs.mkdir(corruptDir, { recursive: true });
    await fs.mkdir(unsupportedDir, { recursive: true });
    await fs.writeFile(path.join(corruptDir, "manifest.json"), "not-json", "utf8");
    await writeManifest(unsupportedDir, {
      version: 99,
      id: "unsupported",
      modelPath: "model.vgf",
      targetProfile: "p",
      status: "failed",
      startedAt: new Date(0).toISOString(),
    });
    const logs: string[] = [];
    const store = makeStore(storage, { logs });

    await store.load();

    assert.deepStrictEqual(store.analyses, []);
    assert.strictEqual(logs.length, 2);
    assert.ok(logs.some((message) => message.includes("valid JSON")));
    assert.ok(logs.some((message) => message.includes("Unsupported manifest version")));
  });

  it("rejects invalid finishedAt lifecycle combinations while accepting legacy omission", async () => {
    const storage = await makeStorage();
    const analysesRoot = path.join(storage, "analysis-runs");
    const startedAt = "2025-01-02T03:04:05.000Z";
    const manifests = [
      {
        id: "running-with-finish",
        status: "running",
        startedAt,
        finishedAt: "2025-01-02T03:04:06.000Z",
        ownerPid: 200,
      },
      {
        id: "finish-before-start",
        status: "failed",
        startedAt,
        finishedAt: "2025-01-02T03:04:04.999Z",
      },
      {
        id: "legacy-cancelled",
        status: "cancelled",
        startedAt,
      },
    ] as const;
    await fs.mkdir(analysesRoot, { recursive: true });
    for (const manifest of manifests) {
      const analysisDir = path.join(analysesRoot, manifest.id);
      await fs.mkdir(analysisDir);
      await writeManifest(analysisDir, {
        version: 1,
        modelPath: `${manifest.id}.vgf`,
        targetProfile: "p",
        ...manifest,
      });
    }
    const logs: string[] = [];
    const store = makeStore(storage, { alivePids: [200], logs });

    await store.load();

    assert.deepStrictEqual(
      store.analyses.map(({ id, status, finishedAt }) => ({ id, status, finishedAt })),
      [{ id: "legacy-cancelled", status: "cancelled", finishedAt: undefined }],
    );
    assert.strictEqual(store.get("legacy-cancelled")?.analysisMode, "estimation");
    assert.deepStrictEqual(store.get("legacy-cancelled")?.analysisOptions, {
      performance: true,
      compatibility: false,
    });
    assert.strictEqual(logs.length, 2);
    assert.ok(logs.some((message) => message.includes("running manifest must not contain finishedAt")));
    assert.ok(logs.some((message) => message.includes("finishedAt must not be earlier than startedAt")));
  });

  it("preserves an explicit current analysis across rescans but not a fresh load", async () => {
    const storage = await makeStorage();
    const store = makeStore(storage, { ids: ["current-analysis"] });
    const analysis = await store.allocateRunning("model.vgf", "p");
    await store.complete(analysis.id, await createArtifacts(analysis));
    await store.setCurrent(analysis.id);

    await store.rescan();
    assert.strictEqual(store.currentAnalysis?.id, analysis.id);

    const fresh = makeStore(storage);
    await fresh.load();
    assert.strictEqual(fresh.currentAnalysis, undefined);
  });

  it("serializes a deferred rescan so stale disk state cannot replace a newer completion", async () => {
    const storage = await makeStorage();
    const manifestRead = deferred();
    const continueRead = deferred();
    let deferManifest = false;
    const store = makeStore(storage, {
      ids: ["rescan-race"],
      fileSystem: {
        readFile: async (filePath, encoding) => {
          const content = await fs.readFile(filePath, encoding);
          if (deferManifest && path.basename(filePath) === "manifest.json") {
            deferManifest = false;
            manifestRead.resolve();
            await continueRead.promise;
          }
          return content;
        },
      },
    });
    const analysis = await store.allocateRunning("model.vgf", "p");
    const generated = await createArtifacts(analysis);

    deferManifest = true;
    const rescan = store.rescan();
    await manifestRead.promise;
    const completion = store.complete(analysis.id, generated);
    continueRead.resolve();

    await rescan;
    assert.strictEqual((await completion)?.status, "complete");
    assert.strictEqual(store.get(analysis.id)?.status, "complete");
    assert.strictEqual((await readManifest(analysis)).status, "complete");
  });

  it("lets cancellation win while completion is awaiting artifacts without reopening the analysis", async () => {
    const storage = await makeStorage();
    const artifactRead = deferred();
    const continueRead = deferred();
    let deferArtifacts = false;
    const store = makeStore(storage, {
      ids: ["cancel-wins"],
      fileSystem: {
        readFile: async (filePath, encoding) => {
          const content = await fs.readFile(filePath, encoding);
          if (deferArtifacts && filePath.endsWith("standardized-output.json")) {
            deferArtifacts = false;
            artifactRead.resolve();
            await continueRead.promise;
          }
          return content;
        },
      },
    });
    const analysis = await store.allocateRunning("model.vgf", "p");
    const generated = await createArtifacts(analysis);

    deferArtifacts = true;
    const completion = store.complete(analysis.id, generated);
    await artifactRead.promise;
    assert.strictEqual(await store.cancel(analysis.id), true);
    continueRead.resolve();

    assert.strictEqual(await completion, undefined);
    assert.strictEqual(store.get(analysis.id)?.status, "cancelled");
    assert.strictEqual((await readManifest(analysis)).status, "cancelled");
  });

  it("lets completion win before a later cancellation attempt", async () => {
    const storage = await makeStorage();
    const store = makeStore(storage, { ids: ["complete-wins"] });
    const analysis = await store.allocateRunning("model.vgf", "p");

    assert.strictEqual((await store.complete(analysis.id, await createArtifacts(analysis)))?.status, "complete");
    assert.strictEqual(await store.cancel(analysis.id), false);
    assert.strictEqual((await readManifest(analysis)).status, "complete");
  });

  it("rereads ownership immediately before cancellation and preserves a live foreign owner", async () => {
    const storage = await makeStorage();
    const store = makeStore(storage, {
      ownerPid: 100,
      ids: ["ownership-changed"],
      alivePids: [100, 200],
    });
    const analysis = await store.allocateRunning("model.vgf", "p");
    const manifest = await readManifest(analysis);
    manifest.ownerPid = 200;
    await writeManifest(analysis.analysisDir, manifest);

    assert.strictEqual(await store.cancel(analysis.id), false);
    assert.strictEqual(store.get(analysis.id)?.status, "running");
    assert.strictEqual(store.get(analysis.id)?.ownerPid, 200);
    assert.strictEqual((await readManifest(analysis)).ownerPid, 200);
  });

  it("retries transient manifest replace failures without unlinking the existing manifest", async () => {
    const storage = await makeStorage();
    const waits: number[] = [];
    let injectFailures = false;
    let remainingFailures = 2;
    const store = makeStore(storage, {
      ids: ["rename-retry"],
      fileSystem: {
        rename: async (oldPath, newPath) => {
          if (injectFailures && remainingFailures-- > 0) {
            throw fileSystemError("EPERM", "manifest is temporarily busy");
          }
          await fs.rename(oldPath, newPath);
        },
      },
      waitBeforeManifestRetry: async (attempt) => {
        waits.push(attempt);
      },
    });
    const analysis = await store.allocateRunning("model.vgf", "p");

    injectFailures = true;
    assert.strictEqual(await store.fail(analysis.id, "failed"), true);
    assert.deepStrictEqual(waits, [1, 2]);
    assert.strictEqual((await readManifest(analysis)).status, "failed");
  });

  it("cleans temporary manifests after bounded rename retry exhaustion", async () => {
    const storage = await makeStorage();
    const waits: number[] = [];
    let injectFailure = false;
    const store = makeStore(storage, {
      ids: ["rename-exhausted"],
      fileSystem: {
        rename: async (oldPath, newPath) => {
          if (injectFailure) {
            throw fileSystemError("EBUSY", "manifest remains busy");
          }
          await fs.rename(oldPath, newPath);
        },
      },
      waitBeforeManifestRetry: async (attempt) => {
        waits.push(attempt);
      },
    });
    const analysis = await store.allocateRunning("model.vgf", "p");

    injectFailure = true;
    await assert.rejects(store.fail(analysis.id, "failed"), /manifest remains busy/);
    assert.deepStrictEqual(waits, [1, 2, 3, 4]);
    assert.strictEqual((await readManifest(analysis)).status, "running");
    assert.deepStrictEqual(
      (await fs.readdir(analysis.analysisDir)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  });

  it("rejects traversal, absolute, drive-relative, and Windows absolute artifact paths", async () => {
    const storage = await makeStorage();
    const analysesRoot = path.join(storage, "analysis-runs");
    const invalidPaths = [
      path.join("..", "outside.html"),
      path.resolve(storage, "outside.html"),
      "C:relative.html",
      "C:\\outside\\index.html",
    ];
    await fs.mkdir(analysesRoot, { recursive: true });
    for (const [index, invalidPath] of invalidPaths.entries()) {
      const id = `invalid-path-${index}`;
      const analysisDir = path.join(analysesRoot, id);
      await fs.mkdir(analysisDir);
      await writeManifest(analysisDir, {
        version: 1,
        id,
        modelPath: "model.vgf",
        targetProfile: "p",
        status: "complete",
        startedAt: new Date(index).toISOString(),
        artifacts: {
          htmlPath: invalidPath,
          standardizedOutputPath: "standardized-output.json",
          entityNodeMappingsPath: "entity-node-mappings.json",
        },
      });
    }
    const logs: string[] = [];
    const store = makeStore(storage, { logs });

    await store.load();

    assert.deepStrictEqual(store.analyses, []);
    assert.strictEqual(logs.length, invalidPaths.length);
    assert.ok(logs.every((message) => message.includes("Manifest")));
  });

  it("rejects artifact symlink or junction escapes during completion and persisted load", async (testContext) => {
    const storage = await makeStorage();
    const store = makeStore(storage, { ids: ["linked-artifacts"] });
    const analysis = await store.allocateRunning("model.vgf", "p");
    const outside = path.join(storage, "outside-model-explorer");
    const outsideBundle = path.join(outside, "bundle");
    await fs.mkdir(outsideBundle, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(outsideBundle, "index.html"), "<html></html>"),
      fs.writeFile(path.join(outside, "standardized-output.json"), "{}"),
      fs.writeFile(path.join(outside, "entity-node-mappings.json"), "{}"),
    ]);
    const outputRoot = path.join(analysis.analysisDir, "mlia-output");
    const linkedRoot = path.join(outputRoot, "model-explorer");
    await fs.mkdir(outputRoot, { recursive: true });
    try {
      await fs.symlink(outside, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EACCES") {
        testContext.skip(`Cannot create a test symlink/junction: ${(error as Error).message}`);
        return;
      }
      throw error;
    }
    const linkedArtifacts = {
      htmlPath: path.join(linkedRoot, "bundle", "index.html"),
      standardizedOutputPath: path.join(linkedRoot, "standardized-output.json"),
      entityNodeMappingsPath: path.join(linkedRoot, "entity-node-mappings.json"),
    };

    await assert.rejects(store.complete(analysis.id, linkedArtifacts), /outside the analysis directory/);
    assert.strictEqual(store.get(analysis.id)?.status, "running");

    const manifest = await readManifest(analysis);
    manifest.status = "complete";
    delete manifest.ownerPid;
    manifest.artifacts = {
      htmlPath: path.join("mlia-output", "model-explorer", "bundle", "index.html"),
      standardizedOutputPath: path.join("mlia-output", "model-explorer", "standardized-output.json"),
      entityNodeMappingsPath: path.join("mlia-output", "model-explorer", "entity-node-mappings.json"),
    };
    await writeManifest(analysis.analysisDir, manifest);

    const reloaded = makeStore(storage);
    await reloaded.load();
    assert.strictEqual(reloaded.get(analysis.id)?.status, "failed");
    assert.match(reloaded.get(analysis.id)?.error ?? "", /outside the analysis directory/);
    assert.strictEqual((await readManifest(analysis)).status, "failed");
  });
});

describe("AnalysisStore in-memory overlay selection", () => {
  const selectedOverlay = {
    resultIndex: 0,
    resultKind: "performance",
    category: "metric" as const,
    name: "dram_read_bytes",
    unit: "bytes",
    breakdownQualifiers: {},
    metricQualifiers: {},
  };

  it("remembers A → B → A choices and preserves them across same-ID replacement", async () => {
    const storage = await makeStorage();
    const store = makeStore(storage, { ids: ["analysis-a", "analysis-b"] });
    const first = await store.allocateRunning("a.vgf", "p", new Date(1));
    const second = await store.allocateRunning("b.vgf", "p", new Date(2));
    await store.complete(first.id, await createArtifacts(first));
    await store.complete(second.id, await createArtifacts(second));

    await store.setCurrent(first.id);
    assert.strictEqual(await store.setOverlaySelection(first.id, {
      kind: "overlay",
      overlay: selectedOverlay,
    }), true);
    await store.setCurrent(second.id);
    assert.strictEqual(await store.setOverlaySelection(second.id, { kind: "none" }), true);
    await store.setCurrent(first.id);

    assert.deepStrictEqual(store.currentAnalysis?.overlaySelection, {
      kind: "overlay",
      overlay: selectedOverlay,
    });
    const beforeReplacement = store.currentAnalysis;
    await store.rescan();
    assert.notStrictEqual(store.currentAnalysis, beforeReplacement);
    assert.deepStrictEqual(store.get(first.id)?.overlaySelection, {
      kind: "overlay",
      overlay: selectedOverlay,
    });
    assert.deepStrictEqual(store.get(second.id)?.overlaySelection, { kind: "none" });

    const fresh = makeStore(storage);
    await fresh.load();
    assert.strictEqual(fresh.get(first.id)?.overlaySelection, undefined);
    assert.strictEqual(fresh.get(second.id)?.overlaySelection, undefined);
  });

  it("loads overlay metadata only from mlia-output/model-explorer/manifest.json", async () => {
    const storage = await makeStorage();
    const store = makeStore(storage, { ids: ["overlay-manifest"] });
    const analysis = await store.allocateRunning("model.vgf", "p");
    const artifacts = await createArtifacts(analysis);
    const analysisManifest = await readManifest(analysis);
    analysisManifest.nodeDataOverlayKeysAndDisplayNames = [{
      overlayKey: selectedOverlay,
      displayName: "wrong analysis manifest entry",
    }];
    await writeManifest(analysis.analysisDir, analysisManifest);
    const overlayManifestPath = path.join(
      path.dirname(artifacts.standardizedOutputPath),
      "manifest.json",
    );
    await fs.writeFile(overlayManifestPath, JSON.stringify({
      nodeDataOverlayKeysAndDisplayNames: [{
        overlayKey: selectedOverlay,
        displayName: "dram_read_bytes (bytes)",
      }],
    }), "utf8");

    const completed = await store.complete(analysis.id, artifacts);
    assert.strictEqual(
      completed?.modelExplorerOverlayCatalog?.displayNameByOverlayId.values().next().value,
      "dram_read_bytes (bytes)",
    );
    assert.strictEqual((await readManifest(analysis)).version, 1);
  });

  it("does not let a relocated standardized-output artifact redirect overlay metadata", async () => {
    const storage = await makeStorage();
    const store = makeStore(storage, { ids: ["relocated-standardized-output"] });
    const analysis = await store.allocateRunning("model.vgf", "p");
    const artifacts = await createArtifacts(analysis);
    const relocatedDir = path.join(analysis.analysisDir, "relocated-output");
    await fs.mkdir(relocatedDir);
    const relocatedStandardizedOutputPath = path.join(relocatedDir, "standardized-output.json");
    await fs.rename(artifacts.standardizedOutputPath, relocatedStandardizedOutputPath);
    await fs.writeFile(path.join(relocatedDir, "manifest.json"), JSON.stringify({
      nodeDataOverlayKeysAndDisplayNames: [{
        overlayKey: selectedOverlay,
        displayName: "redirected sibling manifest",
      }],
    }), "utf8");
    await fs.writeFile(
      path.join(analysis.analysisDir, "mlia-output", "model-explorer", "manifest.json"),
      JSON.stringify({
        nodeDataOverlayKeysAndDisplayNames: [{
          overlayKey: selectedOverlay,
          displayName: "canonical manifest",
        }],
      }),
      "utf8",
    );

    const completed = await store.complete(analysis.id, {
      ...artifacts,
      standardizedOutputPath: relocatedStandardizedOutputPath,
    });

    assert.strictEqual(
      completed?.modelExplorerOverlayCatalog?.displayNameByOverlayId.values().next().value,
      "canonical manifest",
    );
  });

  it("ignores overlay updates for missing, deleted, and incomplete analyses", async () => {
    const storage = await makeStorage();
    const store = makeStore(storage, { ids: ["running", "deleted"] });
    const running = await store.allocateRunning("running.vgf", "p");
    assert.strictEqual(await store.setOverlaySelection("missing", { kind: "none" }), false);
    assert.strictEqual(await store.setOverlaySelection(running.id, { kind: "none" }), false);

    const deleted = await store.allocateRunning("deleted.vgf", "p");
    await store.fail(deleted.id, "failed");
    await store.delete(deleted.id);
    assert.strictEqual(await store.setOverlaySelection(deleted.id, { kind: "none" }), false);
  });
});

describe("AnalysisStore destructive operations", () => {
  it("closes before removing a non-running directory and removes it before updating the store", async () => {
    const storage = await makeStorage();
    const store = makeStore(storage, { ids: ["delete-me"] });
    const analysis = await store.allocateRunning("model.vgf", "p");
    await store.fail(analysis.id, "failed");
    const observations: string[] = [];
    store.subscribe(() => {
      if (!store.get(analysis.id)) {
        observations.push(fsSync.existsSync(analysis.analysisDir) ? "store-first" : "directory-first");
      }
    });

    const deleted = await store.delete(analysis.id, () => {
      observations.push(fsSync.existsSync(analysis.analysisDir) ? "closed-before-remove" : "closed-after-remove");
    });

    assert.deepStrictEqual(deleted, { status: "deleted", analysisId: analysis.id });
    assert.deepStrictEqual(observations.slice(-2), ["closed-before-remove", "directory-first"]);
    assert.strictEqual(store.get(analysis.id), undefined);
  });

  it("refuses deletion when a fresh manifest says a live process owns the analysis", async () => {
    const storage = await makeStorage();
    const store = makeStore(storage, { ownerPid: 100, ids: ["became-active"], alivePids: [100, 200] });
    const analysis = await store.allocateRunning("model.vgf", "p");
    await store.fail(analysis.id, "initial failure");
    const manifest = await readManifest(analysis);
    manifest.status = "running";
    manifest.ownerPid = 200;
    delete manifest.finishedAt;
    delete manifest.error;
    await writeManifest(analysis.analysisDir, manifest);

    assert.deepStrictEqual(await store.delete(analysis.id), {
      status: "notDeleted",
      reason: "The stored analysis run is owned by a running extension host.",
    });
    assert.strictEqual((await fs.stat(analysis.analysisDir)).isDirectory(), true);
    assert.strictEqual(store.get(analysis.id)?.status, "running");
  });

  it("clear-all snapshots directories and revalidates each manifest before deleting it", async () => {
    const storage = await makeStorage();
    const store = makeStore(storage, {
      ownerPid: 100,
      ids: ["a-delete", "z-becomes-active"],
      alivePids: [100, 200],
    });
    const first = await store.allocateRunning("first.vgf", "p", new Date(1));
    const second = await store.allocateRunning("second.vgf", "p", new Date(2));
    await store.fail(first.id, "failed");
    await store.fail(second.id, "failed");
    const secondManifest = await readManifest(second);

    const outcome = await store.clearAll((analysis) => {
      if (analysis.id === first.id) {
        fsSync.writeFileSync(
          path.join(second.analysisDir, "manifest.json"),
          `${JSON.stringify({
            ...secondManifest,
            status: "running",
            finishedAt: undefined,
            ownerPid: 200,
            error: undefined,
          })}\n`,
          "utf8",
        );
      }
    });

    assert.deepStrictEqual(outcome.deletedIds, [first.id]);
    assert.strictEqual(outcome.skipped.length, 1);
    assert.strictEqual(outcome.skipped[0].analysisId, second.id);
    assert.match(outcome.skipped[0].reason, /live process 200/);
    await assert.rejects(fs.stat(first.analysisDir), /ENOENT/);
    assert.strictEqual((await fs.stat(second.analysisDir)).isDirectory(), true);
  });

  it("preserves the record and current selection when a single directory removal fails", async () => {
    const storage = await makeStorage();
    let failRemoval = false;
    const store = makeStore(storage, {
      ids: ["remove-fails"],
      fileSystem: {
        rm: async (filePath, options) => {
          if (failRemoval && filePath.endsWith("remove-fails") && options.force === false) {
            throw fileSystemError("EACCES", "directory is in use");
          }
          await fs.rm(filePath, options);
        },
      },
    });
    const analysis = await store.allocateRunning("model.vgf", "p");
    await store.complete(analysis.id, await createArtifacts(analysis));
    await store.setCurrent(analysis.id);
    const closed: string[] = [];

    failRemoval = true;
    const outcome = await store.delete(analysis.id, (value) => closed.push(value.id));

    assert.strictEqual(outcome.status, "removeFailed");
    if (outcome.status === "removeFailed") {
      assert.match(outcome.reason, /directory is in use/);
      assert.strictEqual(outcome.analysis.id, analysis.id);
    }
    assert.deepStrictEqual(closed, [analysis.id]);
    assert.strictEqual(store.get(analysis.id)?.status, "complete");
    assert.strictEqual(store.currentAnalysis?.id, analysis.id);
    assert.strictEqual((await fs.stat(analysis.analysisDir)).isDirectory(), true);

    failRemoval = false;
    assert.deepStrictEqual(await store.delete(analysis.id), {
      status: "deleted",
      analysisId: analysis.id,
    });
  });

  it("clear-all closes and removes completed panels and clears current state", async () => {
    const storage = await makeStorage();
    const store = makeStore(storage, { ids: ["clear-a", "clear-b"] });
    const first = await store.allocateRunning("first.vgf", "p", new Date(1));
    const second = await store.allocateRunning("second.vgf", "p", new Date(2));
    await store.complete(first.id, await createArtifacts(first));
    await store.complete(second.id, await createArtifacts(second));
    await store.setCurrent(second.id);
    const closed: string[] = [];

    const outcome = await store.clearAll((analysis) => closed.push(analysis.id));

    assert.deepStrictEqual(outcome, { deletedIds: [first.id, second.id], skipped: [] });
    assert.deepStrictEqual(closed, [first.id, second.id]);
    assert.deepStrictEqual(store.analyses, []);
    assert.strictEqual(store.currentAnalysis, undefined);
  });
});
