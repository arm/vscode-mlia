import * as assert from "assert";
import { describe, it } from "node:test";

import {
  activateAnalysis,
  activateAnalysisCommand,
  analysisActivationCommand,
} from "../analysisActivation";
import { AnalysisPanelManager } from "../analysisPanels";
import { Analysis } from "../analysisStore";
import {
  ModelExplorerWebview,
  ModelExplorerWebviewOptions,
  PreparedModelExplorerPage,
} from "../modelExplorerWebview";

function analysis(status: Analysis["status"] = "complete"): Analysis {
  return {
    id: "analysis-a",
    modelPath: "C:/models/a.vgf",
    profilingDataPaths: [],
    targetProfile: "profile",
    analysisMode: "estimation",
    analysisOptions: { performance: true, compatibility: false },
    status,
    startedAt: new Date(0),
    analysisDir: "C:/analysis-runs/analysis-a",
    ...(status === "complete"
      ? {
          artifacts: {
            htmlPath: "model-explorer.html",
            standardizedOutputPath: "standardized-output.json",
            entityNodeMappingsPath: "entity-node-mappings.json",
          },
        }
      : {}),
  };
}

function panelFixture() {
  const created: ModelExplorerWebviewOptions[] = [];
  const reveals: Array<{ viewColumn: unknown; preserveFocus: unknown }> = [];
  let prepareCalls = 0;
  let commits = 0;
  const errors: string[] = [];
  const manager = new AnalysisPanelManager({
    showLog: () => undefined,
    shouldSyncSelectionToCode: () => true,
    showSelectedEntities: () => undefined,
    resolveAnalysis: async () => undefined,
    overlayUserIntentChanged: () => undefined,
    createWebview: (options) => {
      created.push(options);
      let disposeListener: () => void = () => undefined;
      return {
        panel: {
          viewColumn: 2,
          reveal: (viewColumn: unknown, preserveFocus: unknown) => {
            reveals.push({ viewColumn, preserveFocus });
          },
          dispose: () => disposeListener(),
          onDidDispose: (listener: () => void) => {
            disposeListener = listener;
            return { dispose: () => undefined };
          },
        },
        prepareModelExplorer: async () => {
          prepareCalls += 1;
          return {
            html: "<html></html>",
            standardizedOutput: {},
            entityNodeMappings: {},
          } satisfies PreparedModelExplorerPage;
        },
        showPreparedModelExplorer: () => {
          commits += 1;
        },
        showError: (message: string) => errors.push(message),
        selectNode: async () => true,
        setOverlayIntent: async () => true,
      } as unknown as ModelExplorerWebview;
    },
  });
  return {
    manager,
    created,
    reveals,
    prepareCalls: () => prepareCalls,
    commits: () => commits,
    errors,
  };
}

function acceptingStore(completed: Analysis, events: string[] = []) {
  return {
    get: (id: string) => id === completed.id ? completed : undefined,
    setCurrent: async (id: string) => {
      events.push(`current:${id}`);
      return true;
    },
  };
}

describe("analysis activation", () => {
  for (const status of ["running", "complete", "failed", "cancelled", "interrupted"] as const) {
    it(`selects and opens a ${status} analysis while preserving sidebar focus`, async () => {
      const selected = analysis(status);
      assert.deepStrictEqual(analysisActivationCommand(selected), {
        command: activateAnalysisCommand,
        title: "Open Analysis Run and Set as Current",
        arguments: [selected.id],
      });
      const events: string[] = [];
      assert.strictEqual(await activateAnalysis(acceptingStore(selected, events), {
        open: async (value, focus) => { events.push(`open:${value.id}:${focus}`); },
      }, selected.id), true);
      assert.deepStrictEqual(events, ["current:analysis-a", "open:analysis-a:preserve"]);
    });
  }

  it("sets a completed analysis as current before opening its panel while preserving focus", async () => {
    const completed = analysis();
    const events: string[] = [];
    const store = acceptingStore(completed, events);
    const panels = {
      open: async (selected: Analysis, focus: string) => {
        events.push(`open:${selected.id}:${focus}`);
      },
    };

    assert.strictEqual(
      await activateAnalysis(store, panels, completed.id),
      true,
    );
    assert.deepStrictEqual(events, ["current:analysis-a", "open:analysis-a:preserve"]);
  });

  it("makes a failed analysis current before opening its error", async () => {
    const failed = { ...analysis("failed"), error: "stored failure" };
    const events: string[] = [];
    const store = {
      get: (id: string) => id === failed.id ? failed : undefined,
      setCurrent: async (id: string) => {
        events.push(`current:${id}`);
        return true;
      },
    };
    const panels = {
      open: async (selected: Analysis, focus: string) => {
        events.push(`open:${selected.id}:${focus}`);
      },
    };

    assert.strictEqual(await activateAnalysis(store, panels, failed.id), true);
    assert.deepStrictEqual(events, ["current:analysis-a", "open:analysis-a:preserve"]);
  });

  it("creates and reveals a new panel for tree activation without taking sidebar focus", async () => {
    const completed = analysis();
    const state = panelFixture();

    assert.strictEqual(
      await activateAnalysis(acceptingStore(completed), state.manager, completed.id),
      true,
    );

    assert.deepStrictEqual(state.created.map(({ focus }) => focus), ["preserve"]);
    assert.deepStrictEqual(state.reveals, [{ viewColumn: 2, preserveFocus: true }]);
    assert.strictEqual(state.prepareCalls(), 1);
    assert.strictEqual(state.commits(), 1);
  });

  it("reveals an existing panel for tree activation without taking sidebar focus", async () => {
    const completed = analysis();
    const state = panelFixture();
    await state.manager.open(completed, "focus");
    state.reveals.length = 0;

    assert.strictEqual(
      await activateAnalysis(acceptingStore(completed), state.manager, completed.id),
      true,
    );

    assert.deepStrictEqual(state.created.map(({ focus }) => focus), ["focus"]);
    assert.deepStrictEqual(state.reveals, [{ viewColumn: 2, preserveFocus: true }]);
    assert.strictEqual(state.prepareCalls(), 1);
    assert.strictEqual(state.commits(), 1);
  });

  it("does not open missing or rejected selections", async () => {
    let openCalls = 0;
    const panels = {
      open: async () => {
        openCalls += 1;
      },
    };

    assert.strictEqual(await activateAnalysis({
      get: () => undefined,
      setCurrent: async () => true,
    }, panels, "removed-during-selection"), false);
    assert.strictEqual(
      await activateAnalysis(
        {
          get: () => analysis(),
          setCurrent: async () => false,
        },
        panels,
        "analysis-a",
      ),
      false,
    );
    assert.strictEqual(await activateAnalysis({
      get: () => undefined,
      setCurrent: async () => true,
    }, panels, undefined), false);
    assert.strictEqual(openCalls, 0);
  });
});
