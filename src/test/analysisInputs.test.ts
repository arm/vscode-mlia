import * as assert from "assert";
import { describe, it } from "node:test";

import {
  analysisInputDetails,
  analysisInputSummary,
  hasAnalysisInput,
} from "../analysisInputs";
import { analysisPresentation } from "../analysisPresentation";
import { Analysis } from "../analysisStore";

describe("analysis input formatting", () => {
  it("uses the model or first profiling data basename as the input summary", () => {
    assert.strictEqual(
      analysisInputSummary({ modelPath: "C:/models/model.vgf", profilingDataPaths: [] }),
      "model.vgf",
    );
    assert.strictEqual(
      analysisInputSummary({
        profilingDataPaths: ["relative/captures/profile.json", "relative/captures/profile-2.json"],
      }),
      "profile.json",
    );
    assert.strictEqual(analysisInputSummary({
      modelPath: "C:/models/model.vgf",
      profilingDataPaths: ["relative/captures/run-42", "relative/captures/run-43"],
    }), "model.vgf");
  });

  it("reports labelled full paths and detects whether any input is present", () => {
    const inputs = {
      modelPath: "relative/model.vgf",
      profilingDataPaths: ["relative/profile-a", "relative/profile-b"],
    };
    assert.deepStrictEqual(analysisInputDetails(inputs), [
      "Source model: relative/model.vgf",
      "Profiling data 1: relative/profile-a",
      "Profiling data 2: relative/profile-b",
    ]);
    assert.strictEqual(hasAnalysisInput({ profilingDataPaths: [] }), false);
    assert.strictEqual(hasAnalysisInput(inputs), true);
  });

  it("combines run metadata into consistent tree, tooltip, and panel presentation", () => {
    const analysis: Analysis = {
      id: "analysis-a",
      modelPath: "C:/models/model.vgf",
      profilingDataPaths: ["C:/captures/run-42"],
      targetProfile: "profile-a",
      analysisMode: "profiling",
      analysisOptions: { performance: true, compatibility: true },
      status: "complete",
      startedAt: new Date(0),
      analysisDir: "C:/analysis-runs/analysis-a",
    };

    assert.deepStrictEqual(analysisPresentation(analysis), {
      inputSummary: "model.vgf",
      mode: "Profiling",
      checks: "Performance + Compatibility",
      status: "Complete",
      treeDescription: "Profiling · Performance + Compatibility · profile-a · Complete",
      tooltipDetails: [
        "Source model: C:/models/model.vgf",
        "Profiling data: C:/captures/run-42",
        "Mode: Profiling",
        "Checks: Performance + Compatibility",
        "Target profile: profile-a",
      ],
      panelTitle: "MLIA: model.vgf · Profiling · profile-a",
    });
  });
});
