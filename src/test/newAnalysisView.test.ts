import * as assert from "assert";
import { describe, it } from "node:test";

import {
  NewAnalysisState,
  NewAnalysisViewProvider,
  renderNewAnalysis,
} from "../newAnalysisView";

function readyState(
  overrides: Partial<Extract<NewAnalysisState, { kind: "ready" }>> = {},
): Extract<NewAnalysisState, { kind: "ready" }> {
  return {
    kind: "ready",
    version: "1.2.3",
    targets: [
      {
        name: "neural-technology",
        prettyName: "Neural Technology",
        profiles: ["a", "b"],
        backends: [
          {
            name: "estimator",
            prettyName: "Estimator",
            default: true,
            selectable: true,
            capabilities: {
              estimation: ["performance", "compatibility"],
              profiling: [],
            },
          },
          {
            name: "profiling",
            prettyName: "Profiling",
            default: false,
            selectable: false,
            capabilities: {
              estimation: [],
              profiling: ["performance"],
            },
          },
        ],
      },
    ],
    selectedTargetProfile: "a",
    analysisMode: "estimation",
    analysisOptions: { performance: true, compatibility: false },
    analysisInputs: { modelPath: "models/model.vgf", profilingDataPaths: [] },
    ...overrides,
  };
}

describe("renderNewAnalysis", () => {
  it("renders startup and actionable environment setup states", () => {
    assert.match(renderNewAnalysis({ kind: "starting" }), /Starting MLIA/);
    const setupRequired = renderNewAnalysis({ kind: "setupRequired" });
    assert.match(
      setupRequired,
      /Set up the MLIA environment to get started\./,
    );
    assert.match(setupRequired, /data-command="refreshEnvironment">Refresh MLIA Environment/);
    const incomplete = renderNewAnalysis({ kind: "incomplete" });
    assert.match(
      incomplete,
      /MLIA environment setup is incomplete\. Refresh to repair it\./,
    );
    assert.match(incomplete, /data-command="refreshEnvironment">Refresh MLIA Environment/);
    const available = renderNewAnalysis({ kind: "available" });
    assert.match(
      available,
      /MLIA environment found, but its version and target profiles have not been loaded\./,
    );
    assert.match(available, /data-command="refreshEnvironment">Refresh MLIA Environment/);
  });

  it("renders Estimation with a required model and no profiling field", () => {
    const html = renderNewAnalysis(readyState());
    assert.match(html, /data-mode="estimation"[^>]*aria-selected="true"/);
    assert.match(html, /id="model-path"[^>]*placeholder="Source model \(required\)"/);
    assert.doesNotMatch(html, /id="profiling-data-path"/);
    assert.match(html, /<optgroup label="Neural Technology">/);
    assert.match(html, /id="analysis-performance" type="checkbox" checked/);
    assert.match(html, /id="analysis-compatibility" type="checkbox">/);
    assert.match(html, /data-command="runAnalysis">Run Analysis<\/button>/);
  });

  it("renders Profiling with required profiling data, optional model and capability-disabled Compatibility", () => {
    const html = renderNewAnalysis(readyState({
      analysisMode: "profiling",
      analysisInputs: {
        profilingDataPaths: ["captures/run-a", "captures/run-b"],
        modelPath: "model.vgf",
      },
      analysisOptions: { performance: true, compatibility: true },
    }));
    assert.match(html, /id="profiling-data"[^>]*data-path-list="true"/);
    assert.match(html, /value="captures\/run-a"/);
    assert.match(html, /value="captures\/run-b"/);
    assert.doesNotMatch(html, /Add profiling data|data-path-list-action="add"/);
    assert.match(html, />\[0\]<\/span>/);
    assert.match(html, />\[1\]<\/span>/);
    assert.match(html, />\[2\]<\/span>/);
    assert.match(
      html,
      /path-list-button path-list-reorder path-list-button-hidden"[^>]*data-path-list-action="moveUp"[^>]*data-index="0"/,
    );
    assert.match(
      html,
      /path-list-button path-list-reorder path-list-button-hidden"[^>]*data-path-list-action="moveDown"[^>]*data-index="1"/,
    );
    assert.doesNotMatch(html, /VGF|graph segment/);
    assert.match(html, /id="model-path"[^>]*placeholder="Source model \(optional\)"/);
    assert.match(html, /id="analysis-compatibility" type="checkbox" disabled/);
    assert.match(html, /data-command="runAnalysis">Run Analysis<\/button>/);
  });

  it("does not reserve reorder controls for a single populated path", () => {
    const html = renderNewAnalysis(readyState({
      analysisMode: "profiling",
      analysisInputs: { profilingDataPaths: ["captures/run"] },
    }));
    const pathListTag = html.match(/<div id="profiling-data"[^>]*>/u)?.[0];
    assert.ok(pathListTag);
    assert.doesNotMatch(pathListTag, /data-reorderable/);
  });

  it("filters profiles that do not support the selected mode", () => {
    const state = readyState();
    state.targets.push({
      name: "estimation-only",
      prettyName: "Estimation Only",
      profiles: ["estimate"],
      backends: [{
        name: "backend",
        prettyName: "Backend",
        default: true,
        selectable: true,
        capabilities: { estimation: ["performance"], profiling: [] },
      }],
    });
    const html = renderNewAnalysis({ ...state, analysisMode: "profiling" });
    assert.doesNotMatch(html, /value="estimate"/);
  });

  it("requires the mode-specific input", () => {
    assert.match(
      renderNewAnalysis(readyState({ analysisInputs: { profilingDataPaths: [] } })),
      /data-command="runAnalysis" disabled/,
    );
    assert.match(
      renderNewAnalysis(readyState({
        analysisMode: "profiling",
        analysisInputs: { modelPath: "model.vgf", profilingDataPaths: [] },
      })),
      /data-command="runAnalysis" disabled/,
    );
  });

  it("requires a target profile and selected supported analysis category", () => {
    assert.match(
      renderNewAnalysis(readyState({ selectedTargetProfile: undefined })),
      /data-command="runAnalysis" disabled/,
    );
    assert.match(
      renderNewAnalysis(readyState({ analysisOptions: { performance: false, compatibility: false } })),
      /data-command="runAnalysis" disabled/,
    );
  });

  it("escapes input paths", () => {
    const html = renderNewAnalysis(readyState({
      analysisInputs: { modelPath: "a&b/<model>", profilingDataPaths: [] },
    }));
    assert.match(html, /value="a&amp;b\/&lt;model&gt;"/);
  });

  it("escapes failure messages and exposes recovery actions", () => {
    const html = renderNewAnalysis({ kind: "failed", message: "Failed <bad>" });
    assert.match(html, /Failed &lt;bad&gt;/);
    assert.match(html, /data-command="refreshEnvironment"/);
    assert.match(html, /data-command="showLog"/);
  });
});


describe("NewAnalysisViewProvider profiling path editing", () => {
  it("browses, clears, and reorders paths while preserving their array order", async () => {
    let receiveMessage: ((message: unknown) => void) | undefined;
    const selectedInputs: Array<{ modelPath?: string; profilingDataPaths: string[] }> = [];
    const provider = new NewAnalysisViewProvider({
      refreshEnvironment: () => undefined,
      runAnalysis: () => undefined,
      showLog: () => undefined,
      selectTargetProfile: () => undefined,
      selectAnalysisMode: () => undefined,
      selectAnalysisOptions: () => undefined,
      selectAnalysisInputs: (inputs) => selectedInputs.push(inputs),
      pickModelPath: async () => undefined,
      pickProfilingDataPath: async () => "capture-c",
    });
    const webview = {
      options: {} as { enableScripts?: boolean },
      html: "",
      onDidReceiveMessage: (listener: (message: unknown) => void) => {
        receiveMessage = listener;
        return { dispose: () => undefined };
      },
    };
    provider.resolveWebviewView({ webview } as never);
    provider.setState(readyState({
      analysisMode: "profiling",
      analysisInputs: { profilingDataPaths: ["capture-a", "capture-b"] },
    }));

    receiveMessage?.({
      command: "editProfilingDataPaths",
      pathListAction: "moveDown",
      index: 0,
      profilingDataPaths: ["capture-a", "capture-b"],
    });
    assert.deepStrictEqual(selectedInputs.at(-1)?.profilingDataPaths, [
      "capture-b",
      "capture-a",
    ]);

    receiveMessage?.({
      command: "editProfilingDataPaths",
      pathListAction: "remove",
      index: 0,
      profilingDataPaths: ["capture-b", "capture-a"],
    });
    assert.deepStrictEqual(selectedInputs.at(-1)?.profilingDataPaths, ["capture-a"]);

    receiveMessage?.({
      command: "editProfilingDataPaths",
      pathListAction: "browse",
      index: 1,
      profilingDataPaths: ["capture-a"],
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(selectedInputs.at(-1)?.profilingDataPaths, [
      "capture-a",
      "capture-c",
    ]);

    receiveMessage?.({
      command: "editProfilingDataPaths",
      pathListAction: "remove",
      index: 0,
      profilingDataPaths: ["typed-path"],
    });
    assert.deepStrictEqual(selectedInputs.at(-1)?.profilingDataPaths, []);
  });
});
