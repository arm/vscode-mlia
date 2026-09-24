import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { describe, it } from "node:test";

interface MenuContribution {
  command: string;
  when?: string;
  group?: string;
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"),
) as {
  main: string;
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies: Record<string, string>;
  activationEvents: string[];
  contributes: {
    views: { mlia: Array<{ id: string; name: string; initialSize?: number }> };
    commands: Array<{ command: string; title: string; icon?: string; enablement?: string }>;
    menus: { "view/item/context": MenuContribution[] };
    configuration: {
      properties: Record<string, {
        type: string;
        items?: { type: string };
        default: unknown;
        scope?: string;
        editPresentation?: string;
        description?: string;
      }>;
    };
  };
};

function action(command: string): MenuContribution | undefined {
  return manifest.contributes.menus["view/item/context"].find((item) => item.command === command);
}

describe("extension packaging", () => {
  it("bundles runtime dependencies without packaging node_modules", () => {
    assert.strictEqual(manifest.main, "./dist/extension.js");
    assert.strictEqual(manifest.scripts["vscode:prepublish"], "npm run bundle");
    assert.deepStrictEqual(Object.keys(manifest.dependencies ?? {}).sort(), ["tar", "yauzl"]);
    for (const name of ["tar", "yauzl"]) {
      assert.strictEqual(manifest.devDependencies[name], undefined);
    }
    assert.strictEqual(manifest.scripts.package, "vsce package --no-dependencies");
    assert.strictEqual(manifest.scripts["package:extension"], "vsce package --no-dependencies");
  });
});

describe("extension activation", () => {
  it("activates when VS Code restores a Model Explorer panel", () => {
    assert.deepStrictEqual(manifest.activationEvents, ["onWebviewPanel:mliaModelExplorer"]);
  });
});

describe("MLIA views", () => {
  it("gives the New Analysis view enough initial space for its controls", () => {
    assert.deepStrictEqual(
      manifest.contributes.views.mlia.map(({ id, name, initialSize }) => ({ id, name, initialSize })),
      [
        { id: "mlia.newAnalysis", name: "New Analysis", initialSize: 2 },
        { id: "mlia.currentAnalysis", name: "Current Analysis Run", initialSize: 3 },
        { id: "mlia.analyses", name: "Analysis Runs", initialSize: 4 },
      ],
    );
  });

  it("contributes the expected MLIA view-title actions", () => {
    const titleActions = (manifest.contributes.menus as unknown as { "view/title": MenuContribution[] })["view/title"];
    assert.deepStrictEqual(titleActions, [
      {
        command: "vscode-mlia.showMliaInfo",
        when: "view == mlia.newAnalysis",
        group: "navigation@1",
      },
      {
        command: "vscode-mlia.refreshPythonVenv",
        when: "view == mlia.newAnalysis",
        group: "navigation@2",
      },
      {
        command: "vscode-mlia.openSettings",
        when: "view == mlia.newAnalysis",
        group: "navigation@3",
      },
      {
        command: "vscode-mlia.openCurrentModelExplorer",
        when: "view == mlia.currentAnalysis && mlia.currentAnalysisCanOpenModelExplorer",
        group: "navigation@1",
      },
      {
        command: "vscode-mlia.openAnalysesFolder",
        when: "view == mlia.analyses",
        group: "navigation@1",
      },
      {
        command: "vscode-mlia.clearAllAnalyses",
        when: "view == mlia.analyses",
        group: "navigation@2",
      },
    ]);
    assert.deepStrictEqual(
      manifest.contributes.commands.find(({ command }) => command === "vscode-mlia.showMliaInfo"),
      {
        command: "vscode-mlia.showMliaInfo",
        title: "Show MLIA Information",
        icon: "$(info)",
      },
    );
    assert.deepStrictEqual(
      manifest.contributes.commands.find(({ command }) => command === "vscode-mlia.openSettings"),
      {
        command: "vscode-mlia.openSettings",
        title: "Open MLIA Settings",
        icon: "$(gear)",
      },
    );
    assert.deepStrictEqual(
      manifest.contributes.commands.find(
        ({ command }) => command === "vscode-mlia.openCurrentModelExplorer",
      ),
      {
        command: "vscode-mlia.openCurrentModelExplorer",
        title: "Open Model Explorer",
        icon: "$(open-preview)",
      },
    );
  });

  it("disables environment refresh commands while a refresh is running", () => {
    assert.deepStrictEqual(
      manifest.contributes.commands
        .filter(({ command }) =>
          command === "vscode-mlia.refreshPythonVenv" ||
          command === "vscode-mlia.forceRefreshPythonVenv"
        )
        .map(({ command, enablement }) => ({ command, enablement })),
      [
        {
          command: "vscode-mlia.refreshPythonVenv",
          enablement: "!mlia.environmentRefreshing",
        },
        {
          command: "vscode-mlia.forceRefreshPythonVenv",
          enablement: "!mlia.environmentRefreshing",
        },
      ],
    );
  });
});

describe("MLIA settings", () => {
  it("declares independent window-scoped Model Explorer and source overlay settings", () => {
    assert.deepStrictEqual(
      Object.fromEntries(
        [
          "vscode-mlia.syncModelExplorerSelectionToCode",
          "vscode-mlia.autoOpenModelExplorer",
          "vscode-mlia.showCodeLens",
          "vscode-mlia.showHeatmap",
        ].map((key) => [key, manifest.contributes.configuration.properties[key]]),
      ),
      {
        "vscode-mlia.syncModelExplorerSelectionToCode": {
          type: "boolean",
          default: true,
          scope: "window",
          description: "Open the corresponding source location when a user selects a node in any MLIA Model Explorer panel.",
        },
        "vscode-mlia.autoOpenModelExplorer": {
          type: "boolean",
          default: true,
          scope: "window",
          description:
            "Automatically open Model Explorer while an analysis runs and when it completes. " +
            "Completed analyses are still persisted and made current when disabled.",
        },
        "vscode-mlia.showCodeLens": {
          type: "boolean",
          default: true,
          scope: "window",
          description: "Show MLIA analysis metrics and source navigation actions as CodeLens items.",
        },
        "vscode-mlia.showHeatmap": {
          type: "boolean",
          default: true,
          scope: "window",
          description: "Show MLIA analysis heatmap colors in source editors.",
        },
      },
    );
  });

  it("clarifies that target profile changes only affect new analyses", () => {
    assert.deepStrictEqual(
      manifest.contributes.configuration.properties["vscode-mlia.targetProfile"],
      {
        type: "string",
        default: "",
        scope: "window",
        description:
          "Target profile used for new MLIA analyses. Existing analyses are unaffected. " +
          "Select it from the New Analysis view after refreshing the environment.",
      },
    );
  });

  it("declares MLIA configuration contents as multiline text", () => {
    assert.deepStrictEqual(
      manifest.contributes.configuration.properties["vscode-mlia.configFileContents"],
      {
        type: "string",
        default: [
          "# MLIA configuration for analyses started by this VS Code extension.",
          "# Changes apply only to new analyses.",
          "# Supported core settings: https://github.com/Arm/mlia#configuration",
          "",
          "[[filtering.collapse]]",
          'kind = "code_stack"',
          'attribute = "file"',
          "globs = [",
          '    "**/site-packages/torch/**",',
          '    "**/site-packages/executorch/**",',
          "]",
          "",
        ].join("\n"),
        scope: "window",
        editPresentation: "multilineText",
        description:
          "Contents of the MLIA TOML configuration file used by analyses started from VS Code. " +
          "The extension writes this text to its managed runtime and applies it through the MLIA watchdog " +
          "before each analysis.",
      },
    );
  });

  it("declares extra MLIA command-line arguments as a string array", () => {
    assert.deepStrictEqual(
      manifest.contributes.configuration.properties["vscode-mlia.extraCommandLineArgs"],
      {
        type: "array",
        items: { type: "string" },
        default: [],
        scope: "window",
        description:
          "Extra command-line arguments appended unchanged to MLIA analyses started by VS Code. " +
          "Intended for advanced users.",
      },
    );
  });
});

describe("CodeLens commands", () => {
  it("does not contribute the obsolete current-analysis CodeLens command", () => {
    assert.strictEqual(
      manifest.contributes.commands.some(
        ({ command }) => command === "vscode-mlia.openCurrentAnalysis",
      ),
      false,
    );
  });
});

describe("analysis run actions", () => {
  it("contributes only the supported command palette actions", () => {
    assert.deepStrictEqual(
      manifest.contributes.commands.map(({ command }) => command),
      [
        "vscode-mlia.refreshPythonVenv",
        "vscode-mlia.forceRefreshPythonVenv",
        "vscode-mlia.showMliaInfo",
        "vscode-mlia.openSettings",
        "vscode-mlia.openCurrentModelExplorer",
        "vscode-mlia.checkPerformance",
        "vscode-mlia.cancelAnalysis",
        "vscode-mlia.deleteAnalysis",
        "vscode-mlia.openAnalysisFolder",
        "vscode-mlia.openAnalysesFolder",
        "vscode-mlia.clearAllAnalyses",
      ],
    );
  });

  it("shows cancel only for running analyses owned by this extension host", () => {
    assert.deepStrictEqual(action("vscode-mlia.cancelAnalysis"), {
      command: "vscode-mlia.cancelAnalysis",
      when: "view == mlia.analyses && viewItem == analysis.running.controllable.other",
      group: "inline@1",
    });
  });

  it("shows the run-folder action for every analysis", () => {
    assert.deepStrictEqual(action("vscode-mlia.openAnalysisFolder"), {
      command: "vscode-mlia.openAnalysisFolder",
      when: "view == mlia.analyses",
      group: "inline@2",
    });
  });

  it("shows delete only for non-running analyses", () => {
    assert.deepStrictEqual(action("vscode-mlia.deleteAnalysis"), {
      command: "vscode-mlia.deleteAnalysis",
      when: "view == mlia.analyses && !(viewItem =~ /analysis\\.running/)",
      group: "inline@3",
    });
  });

  it("contributes analysis-folder commands and the clear-all command", () => {
    assert.deepStrictEqual(
      manifest.contributes.commands.filter(({ command }) =>
        command === "vscode-mlia.openAnalysisFolder" ||
        command === "vscode-mlia.openAnalysesFolder" ||
        command === "vscode-mlia.clearAllAnalyses"
      ),
      [
        {
          command: "vscode-mlia.openAnalysisFolder",
          title: "Open Analysis Run Folder",
          icon: "$(folder-opened)",
        },
        {
          command: "vscode-mlia.openAnalysesFolder",
          title: "Open Analysis Runs Folder",
          icon: "$(folder-opened)",
        },
        {
          command: "vscode-mlia.clearAllAnalyses",
          title: "Clear All Analysis Runs",
          icon: "$(clear-all)",
        },
      ],
    );
  });
});
