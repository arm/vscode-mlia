import * as assert from "assert";
import { describe, it } from "node:test";

import { checkPerformance } from "../checkPerformance";
import { MliaCheckPerformanceResult } from "../pythonRuntime";

function successfulCheckResult(): MliaCheckPerformanceResult {
  return { ok: true, runtimeDir: "C:/runtime" };
}

function makeOptions(overrides: Partial<Parameters<typeof checkPerformance>[0]> = {}): Parameters<typeof checkPerformance>[0] {
  return {
    targetProfile: "neural-technology",
    analysisOptions: { performance: true, compatibility: false },
    analysisInputs: { modelPath: "C:/models/model.tflite", profilingDataPaths: [] },
    showMissingTargetProfile: async () => undefined,
    runMliaCheckPerformance: async (): Promise<MliaCheckPerformanceResult> => successfulCheckResult(),
    showErrorMessage: async () => undefined,
    showLog: () => undefined,
    log: () => undefined,
    ...overrides,
  };
}

describe("checkPerformance", () => {
  it("does nothing when neither input is provided", async () => {
    let ranMlia = false;
    await checkPerformance(makeOptions({
      analysisInputs: { profilingDataPaths: [] },
      runMliaCheckPerformance: async () => {
        ranMlia = true;
        return successfulCheckResult();
      },
    }));
    assert.strictEqual(ranMlia, false);
  });

  it("uses the configured inputs, target profile and analysis options", async () => {
    const calls: Array<{
      analysisInputs: { modelPath?: string; profilingDataPaths: string[] };
      targetProfile: string;
      analysisOptions: { performance: boolean; compatibility: boolean };
    }> = [];
    await checkPerformance(makeOptions({
      targetProfile: "NX-peak-12SC-8NX-600MHz",
      analysisOptions: { performance: true, compatibility: true },
      analysisInputs: {
        modelPath: "relative/model.tflite",
        profilingDataPaths: ["relative/profile-a", "relative/profile-b"],
      },
      runMliaCheckPerformance: async (analysisInputs, targetProfile, analysisOptions) => {
        calls.push({ analysisInputs, targetProfile, analysisOptions });
        return successfulCheckResult();
      },
    }));
    assert.deepStrictEqual(calls, [{
      analysisInputs: {
        modelPath: "relative/model.tflite",
        profilingDataPaths: ["relative/profile-a", "relative/profile-b"],
      },
      targetProfile: "NX-peak-12SC-8NX-600MHz",
      analysisOptions: { performance: true, compatibility: true },
    }]);
  });

  it("reports a missing target profile without running MLIA", async () => {
    let reported = false;
    let ranMlia = false;
    await checkPerformance(makeOptions({
      targetProfile: undefined,
      showMissingTargetProfile: async () => {
        reported = true;
      },
      runMliaCheckPerformance: async () => {
        ranMlia = true;
        return successfulCheckResult();
      },
    }));
    assert.strictEqual(reported, true);
    assert.strictEqual(ranMlia, false);
  });

  it("does not run MLIA when no analysis type is selected", async () => {
    let ranMlia = false;
    await checkPerformance(makeOptions({
      analysisOptions: { performance: false, compatibility: false },
      runMliaCheckPerformance: async () => {
        ranMlia = true;
        return successfulCheckResult();
      },
    }));
    assert.strictEqual(ranMlia, false);
  });

  it("reports MLIA check failures and shows the log when requested", async () => {
    const logs: string[] = [];
    let showLogCalled = false;
    await checkPerformance(makeOptions({
      runMliaCheckPerformance: async () => ({
        ok: false,
        kind: "commandFailed",
        runtimeDir: "C:/runtime",
        stage: "checkPerformance",
        message: "check failed",
      }),
      showErrorMessage: async () => "Show Log",
      showLog: () => {
        showLogCalled = true;
      },
      log: (message) => logs.push(message),
    }));
    assert.deepStrictEqual(logs, ["ERROR: check failed"]);
    assert.strictEqual(showLogCalled, true);
  });
});
