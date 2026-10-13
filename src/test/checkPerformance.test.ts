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
    analysisMode: "estimation",
    authorizeEula: async () => ({ proceed: true, acceptEula: false }),
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
  for (const acceptEula of [false, true]) {
    it(`passes the EULA decision to launch (acceptEula=${acceptEula})`, async () => {
      const requests: unknown[] = [];
      const launches: boolean[] = [];
      await checkPerformance(makeOptions({
        analysisMode: "profiling",
        authorizeEula: async (profile, mode) => {
          requests.push([profile, mode]);
          return { proceed: true, acceptEula };
        },
        runMliaCheckPerformance: async (_inputs, _profile, _checks, accepted) => {
          launches.push(accepted);
          return successfulCheckResult();
        },
      }));
      assert.deepStrictEqual(requests, [["neural-technology", "profiling"]]);
      assert.deepStrictEqual(launches, [acceptEula]);
    });
  }

  it("shows EULA retry guidance without launching when consent is cancelled", async () => {
    const messages: string[] = [];
    await checkPerformance(makeOptions({
      authorizeEula: async () => ({ proceed: false }),
      runMliaCheckPerformance: async () => { throw new Error("must not launch"); },
      showErrorMessage: async (message) => { messages.push(message); return undefined; },
    }));
    assert.deepStrictEqual(messages, [
      "EULA acceptance is required. Run the analysis again and accept the EULA to continue.",
    ]);
  });

  it("waits for consent before starting the analysis", async () => {
    let accept!: () => void;
    let launches = 0;
    const checking = checkPerformance(makeOptions({
      authorizeEula: () => new Promise((resolve) => {
        accept = () => resolve({ proceed: true, acceptEula: true });
      }),
      runMliaCheckPerformance: async () => { launches += 1; return successfulCheckResult(); },
    }));
    await Promise.resolve();
    assert.strictEqual(launches, 0);
    accept();
    await checking;
    assert.strictEqual(launches, 1);
  });

  it("reports licence retrieval or persistence errors without starting a run", async () => {
    const messages: string[] = [];
    let shownLog = false;
    await checkPerformance(makeOptions({
      authorizeEula: async () => { throw new Error("licence unavailable"); },
      runMliaCheckPerformance: async () => { throw new Error("must not launch"); },
      showErrorMessage: async (message) => { messages.push(message); return "Show Log"; },
      showLog: () => { shownLog = true; },
    }));
    assert.deepStrictEqual(messages, ["Unable to start MLIA analysis: licence unavailable"]);
    assert.strictEqual(shownLog, true);
  });

  it("validates input before asking for consent", async () => {
    for (const invalid of [
      { analysisInputs: { profilingDataPaths: [] } },
      { targetProfile: undefined },
      { analysisOptions: { performance: false, compatibility: false } },
    ]) {
      await checkPerformance(makeOptions({
        ...invalid,
        authorizeEula: async () => { throw new Error("must not request consent"); },
        showErrorMessage: async () => { throw new Error("unexpected consent error"); },
      }));
    }
  });

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
