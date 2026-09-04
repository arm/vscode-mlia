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
  it("uses the bundled extension entry point without runtime npm dependencies", () => {
    assert.strictEqual(manifest.main, "./dist/extension.js");
    assert.strictEqual(manifest.scripts["vscode:prepublish"], "npm run bundle");
    assert.strictEqual(manifest.dependencies, undefined);
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
        command: "mlia-vscode.showMliaInfo",
        when: "view == mlia.newAnalysis",
        group: "navigation@1",
      },
      {
        command: "mlia-vscode.refreshPythonVenv",
        when: "view == mlia.newAnalysis",
        group: "navigation@2",
      },
      {
        command: "mlia-vscode.openSettings",
        when: "view == mlia.newAnalysis",
        group: "navigation@3",
      },
      {
        command: "mlia-vscode.openCurrentModelExplorer",
        when: "view == mlia.currentAnalysis && mlia.currentAnalysisCanOpenModelExplorer",
        group: "navigation@1",
      },
      {
        command: "mlia-vscode.openAnalysesFolder",
        when: "view == mlia.analyses",
        group: "navigation@1",
      },
      {
        command: "mlia-vscode.clearAllAnalyses",
        when: "view == mlia.analyses",
        group: "navigation@2",
      },
    ]);
    assert.deepStrictEqual(
      manifest.contributes.commands.find(({ command }) => command === "mlia-vscode.showMliaInfo"),
      {
        command: "mlia-vscode.showMliaInfo",
        title: "Show MLIA Information",
        icon: "$(info)",
      },
    );
    assert.deepStrictEqual(
      manifest.contributes.commands.find(({ command }) => command === "mlia-vscode.openSettings"),
      {
        command: "mlia-vscode.openSettings",
        title: "Open MLIA Settings",
        icon: "$(gear)",
      },
    );
    assert.deepStrictEqual(
      manifest.contributes.commands.find(
        ({ command }) => command === "mlia-vscode.openCurrentModelExplorer",
      ),
      {
        command: "mlia-vscode.openCurrentModelExplorer",
        title: "Open Model Explorer",
        icon: "$(open-preview)",
      },
    );
  });

  it("disables environment refresh commands while a refresh is running", () => {
    assert.deepStrictEqual(
      manifest.contributes.commands
        .filter(({ command }) =>
          command === "mlia-vscode.refreshPythonVenv" ||
          command === "mlia-vscode.forceRefreshPythonVenv"
        )
        .map(({ command, enablement }) => ({ command, enablement })),
      [
        {
          command: "mlia-vscode.refreshPythonVenv",
          enablement: "!mlia.environmentRefreshing",
        },
        {
          command: "mlia-vscode.forceRefreshPythonVenv",
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
          "mlia-vscode.syncModelExplorerSelectionToCode",
          "mlia-vscode.autoOpenModelExplorer",
          "mlia-vscode.showCodeLens",
          "mlia-vscode.showHeatmap",
        ].map((key) => [key, manifest.contributes.configuration.properties[key]]),
      ),
      {
        "mlia-vscode.syncModelExplorerSelectionToCode": {
          type: "boolean",
          default: true,
          scope: "window",
          description: "Open the corresponding source location when a user selects a node in any MLIA Model Explorer panel.",
        },
        "mlia-vscode.autoOpenModelExplorer": {
          type: "boolean",
          default: true,
          scope: "window",
          description:
            "Automatically open Model Explorer while an analysis runs and when it completes. " +
            "Completed analyses are still persisted and made current when disabled.",
        },
        "mlia-vscode.showCodeLens": {
          type: "boolean",
          default: true,
          scope: "window",
          description: "Show MLIA analysis metrics and source navigation actions as CodeLens items.",
        },
        "mlia-vscode.showHeatmap": {
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
      manifest.contributes.configuration.properties["mlia-vscode.targetProfile"],
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
      manifest.contributes.configuration.properties["mlia-vscode.configFileContents"],
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
      manifest.contributes.configuration.properties["mlia-vscode.extraCommandLineArgs"],
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
        ({ command }) => command === "mlia-vscode.openCurrentAnalysis",
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
        "mlia-vscode.refreshPythonVenv",
        "mlia-vscode.forceRefreshPythonVenv",
        "mlia-vscode.showMliaInfo",
        "mlia-vscode.openSettings",
        "mlia-vscode.openCurrentModelExplorer",
        "mlia-vscode.checkPerformance",
        "mlia-vscode.cancelAnalysis",
        "mlia-vscode.deleteAnalysis",
        "mlia-vscode.openAnalysisFolder",
        "mlia-vscode.openAnalysesFolder",
        "mlia-vscode.clearAllAnalyses",
      ],
    );
  });

  it("shows cancel only for running analyses owned by this extension host", () => {
    assert.deepStrictEqual(action("mlia-vscode.cancelAnalysis"), {
      command: "mlia-vscode.cancelAnalysis",
      when: "view == mlia.analyses && viewItem == analysis.running.controllable.other",
      group: "inline@1",
    });
  });

  it("shows the run-folder action for every analysis", () => {
    assert.deepStrictEqual(action("mlia-vscode.openAnalysisFolder"), {
      command: "mlia-vscode.openAnalysisFolder",
      when: "view == mlia.analyses",
      group: "inline@2",
    });
  });

  it("shows delete only for non-running analyses", () => {
    assert.deepStrictEqual(action("mlia-vscode.deleteAnalysis"), {
      command: "mlia-vscode.deleteAnalysis",
      when: "view == mlia.analyses && !(viewItem =~ /analysis\\.running/)",
      group: "inline@3",
    });
  });

  it("contributes analysis-folder commands and the clear-all command", () => {
    assert.deepStrictEqual(
      manifest.contributes.commands.filter(({ command }) =>
        command === "mlia-vscode.openAnalysisFolder" ||
        command === "mlia-vscode.openAnalysesFolder" ||
        command === "mlia-vscode.clearAllAnalyses"
      ),
      [
        {
          command: "mlia-vscode.openAnalysisFolder",
          title: "Open Analysis Run Folder",
          icon: "$(folder-opened)",
        },
        {
          command: "mlia-vscode.openAnalysesFolder",
          title: "Open Analysis Runs Folder",
          icon: "$(folder-opened)",
        },
        {
          command: "mlia-vscode.clearAllAnalyses",
          title: "Clear All Analysis Runs",
          icon: "$(clear-all)",
        },
      ],
    );
  });
});
