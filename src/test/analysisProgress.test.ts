import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { describe, it } from "node:test";
import type * as vscode from "vscode";

import { AnalysisProgressHost, showAnalysisProgress } from "../analysisProgress";
import { cancelAnalysis, startAnalysis } from "../analysisLifecycle";
import { Analysis, AnalysisArtifacts, AnalysisStore } from "../analysisStore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function analysis(id = "first"): Analysis {
  return {
    id,
    modelPath: `${id}.tflite`,
    profilingDataPaths: [],
    targetProfile: "neural-technology",
    analysisMode: "estimation",
    analysisOptions: { performance: true, compatibility: true },
    status: "running",
    startedAt: new Date(0),
    analysisDir: `/runs/${id}`,
  };
}

function hostFixture(alreadyCancelled = false) {
  const notifications: Array<{
    options: vscode.ProgressOptions;
    reports: Array<{ message?: string; increment?: number }>;
    cancel: () => void;
    closed: boolean;
    listenerCount: () => number;
  }> = [];
  const host: AnalysisProgressHost = {
    ProgressLocation: { Notification: 15 },
    window: {
      withProgress: (options, task) => {
        const listeners = new Set<() => void>();
        let isCancellationRequested = alreadyCancelled;
        const notification = {
          options,
          reports: [] as Array<{ message?: string; increment?: number }>,
          cancel: () => {
            isCancellationRequested = true;
            for (const listener of listeners) {
              listener();
            }
          },
          closed: false,
          listenerCount: () => listeners.size,
        };
        notifications.push(notification);
        return Promise.resolve(task(
          { report: (value) => notification.reports.push(value) },
          {
            get isCancellationRequested() { return isCancellationRequested; },
            onCancellationRequested: (listener) => {
              const callback = () => listener(undefined);
              listeners.add(callback);
              return { dispose: () => { listeners.delete(callback); } };
            },
          },
        )).finally(() => { notification.closed = true; });
      },
    },
  };
  return { host, notifications };
}

function fixture(alreadyCancelled = false) {
  const state = hostFixture(alreadyCancelled);
  const completion = deferred<boolean>();
  const cancelled: string[] = [];
  const errors: string[] = [];
  const options = {
    analysis: analysis(),
    completion: completion.promise,
    cancel: async (id: string) => { cancelled.push(id); return true; },
    reportError: (message: string) => { errors.push(message); },
  };
  return { ...state, completion, cancelled, errors, options };
}

describe("analysis progress notifications", () => {
  it("shows a cancellable notification without a made-up percentage until completion", async () => {
    const state = fixture();
    const showing = showAnalysisProgress(state.host, state.options);
    const notification = state.notifications[0];
    assert.deepStrictEqual(notification.options, {
      location: 15,
      title: "Running MLIA performance + compatibility analysis: first.tflite (neural-technology)",
      cancellable: true,
    });
    await flush();
    assert.strictEqual(notification.closed, false);
    assert.strictEqual(notification.listenerCount(), 1);
    assert.deepStrictEqual(notification.reports, []);
    state.completion.resolve(true);
    await showing;
    assert.strictEqual(notification.closed, true);
    assert.strictEqual(notification.listenerCount(), 0);
    notification.cancel();
    assert.deepStrictEqual(state.cancelled, []);
    assert.deepStrictEqual(state.errors, []);
  });

  it("closes on a failed lifecycle outcome without reporting the failure twice", async () => {
    const state = fixture();
    const showing = showAnalysisProgress(state.host, state.options);
    state.completion.resolve(false);
    await showing;
    assert.strictEqual(state.notifications[0].closed, true);
    assert.strictEqual(state.notifications[0].listenerCount(), 0);
    assert.deepStrictEqual(state.errors, []);
  });

  it("handles an unexpected rejected completion and disposes its listener", async () => {
    const state = fixture();
    const showing = showAnalysisProgress(state.host, state.options);
    state.completion.reject(new Error("unexpected lifecycle failure"));
    await showing;
    assert.strictEqual(state.notifications[0].closed, true);
    assert.strictEqual(state.notifications[0].listenerCount(), 0);
    assert.deepStrictEqual(state.errors, ["MLIA progress notification failed: unexpected lifecycle failure"]);
  });

  it("requests cancellation once but waits for the run to settle before closing", async () => {
    const state = fixture();
    const showing = showAnalysisProgress(state.host, state.options);
    const notification = state.notifications[0];
    notification.cancel();
    notification.cancel();
    await flush();
    assert.deepStrictEqual(state.cancelled, ["first"]);
    assert.deepStrictEqual(notification.reports, [{ message: "Cancelling…" }]);
    assert.strictEqual(notification.closed, false);
    state.completion.resolve(false);
    await showing;
    assert.strictEqual(notification.closed, true);
    assert.strictEqual(notification.listenerCount(), 0);
  });

  it("honours a token cancelled before the notification task starts", async () => {
    const state = fixture(true);
    const showing = showAnalysisProgress(state.host, state.options);
    await flush();
    assert.deepStrictEqual(state.cancelled, ["first"]);
    state.completion.resolve(false);
    await showing;
    assert.strictEqual(state.notifications[0].listenerCount(), 0);
  });

  it("waits for pending cancellation cleanup even if completion wins the race", async () => {
    const state = fixture();
    const cancellation = deferred<boolean>();
    const showing = showAnalysisProgress(state.host, {
      ...state.options,
      cancel: () => cancellation.promise,
    });
    state.notifications[0].cancel();
    state.completion.resolve(true);
    await flush();
    assert.strictEqual(state.notifications[0].listenerCount(), 0);
    assert.strictEqual(state.notifications[0].closed, false);
    cancellation.resolve(false);
    await showing;
    assert.strictEqual(state.notifications[0].closed, true);
    assert.deepStrictEqual(state.errors, []);
  });

  it("reports cancellation errors without hiding a run that is still active", async () => {
    const state = fixture();
    const showing = showAnalysisProgress(state.host, {
      ...state.options,
      cancel: async () => { throw new Error("manifest is locked"); },
    });
    state.notifications[0].cancel();
    await flush();
    assert.deepStrictEqual(state.errors, ["Could not cancel MLIA analysis 'first.tflite': manifest is locked"]);
    assert.strictEqual(state.notifications[0].closed, false);
    assert.strictEqual(state.notifications[0].reports.at(-1)?.message,
      "Cancellation failed; waiting for the analysis to finish.");
    state.completion.resolve(true);
    await showing;
    assert.strictEqual(state.notifications[0].listenerCount(), 0);
  });

  for (const source of ["notification", "sidebar"] as const) {
    it(`uses real lifecycle cancellation from the ${source} without cancelling a newer current run`, async () => {
      const storage = await fs.mkdtemp(path.join(os.tmpdir(), "mlia-progress-test-"));
      try {
        const store = new AnalysisStore({ globalStoragePath: storage, isProcessAlive: () => true });
        const commands = new Map<string, { stop: () => void }>();
        const completion = deferred<AnalysisArtifacts>();
        let stopped = 0;
        const panels = {
          openRunning: () => undefined,
          open: async () => undefined,
          update: async () => undefined,
          showError: () => undefined,
          close: () => undefined,
        };
        const result = await startAnalysis({
          store, panels, runningCommands: commands,
          modelPath: "first.tflite", profilingDataPaths: [], targetProfile: "profile",
          analysisMode: "estimation", analysisOptions: { performance: true, compatibility: false },
          autoOpen: false,
          start: () => ({
            command: { stop: () => { stopped += 1; completion.reject(new Error("process stopped")); } },
            completion: completion.promise,
          }),
          synchronousFailureMessage: (message) => message,
          asynchronousFailureMessage: (message) => message,
        });
        assert.ok(result.ok);
        const state = hostFixture();
        const errors: string[] = [];
        const showing = showAnalysisProgress(state.host, {
          analysis: result.analysis,
          completion: result.settled,
          cancel: (id) => cancelAnalysis(store, commands, id),
          reportError: (message) => { errors.push(message); },
        });
        const newer = await store.allocateRunning("second.tflite", "profile");
        commands.set(newer.id, { stop: () => assert.fail("cancelled the wrong run") });
        if (source === "notification") {
          state.notifications[0].cancel();
        } else {
          assert.strictEqual(await cancelAnalysis(store, commands, result.analysis.id), true);
        }
        await showing;
        assert.strictEqual(stopped, 1);
        assert.strictEqual(store.get(result.analysis.id)?.status, "cancelled");
        assert.strictEqual(store.currentAnalysis?.id, newer.id);
        assert.strictEqual(store.get(newer.id)?.status, "running");
        assert.strictEqual(commands.has(result.analysis.id), false);
        assert.strictEqual(commands.has(newer.id), true);
        assert.strictEqual(state.notifications[0].closed, true);
        assert.strictEqual(state.notifications[0].listenerCount(), 0);
        assert.deepStrictEqual(errors, []);
      } finally {
        await fs.rm(storage, { recursive: true, force: true });
      }
    });
  }
});
