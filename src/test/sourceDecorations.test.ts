import * as assert from "assert";
import { describe, it } from "node:test";

import { buildOverlayCatalog } from "../overlayCatalog";
import { SourceAnnotationIndex } from "../sourceAnnotations";
import { SourceCodeLensProducer } from "../sourceCodeLens";
import { DecorationEditor, SourceDecorationManager } from "../sourceDecorations";
import { TransientSourceLineBorder } from "../sourceNavigation";
import {
  showCodeLensConfiguration,
  showHeatmapConfiguration,
  SourceVisibilityController,
} from "../sourceVisibility";

interface TestDecoration {
  id: number;
  color: string;
  disposed: boolean;
}

interface AppliedDecoration {
  decoration: TestDecoration;
  lines: number[];
}

interface TestEditor extends DecorationEditor {
  applied: AppliedDecoration[];
}

function entity(
  id: string,
  kind: string,
  options: { file?: string; line?: number; children?: string[] } = {},
): Record<string, unknown> {
  return {
    id,
    kind,
    parent_ids: [],
    child_ids: options.children ?? [],
    ...(options.file === undefined
      ? {}
      : { attributes: { file: options.file, line: options.line } }),
  };
}

function metric(value: number) {
  return { name: "total_cycles", value, unit: "cycles", qualifiers: {} };
}

function breakdown(entityId: string, value: number) {
  return { entity_id: entityId, metrics: [metric(value)], qualifiers: {} };
}

const output = {
  results: [
    {
      entities: [
        entity("code_line/min", "code_line", {
          file: "/build/model.py", line: 2, children: ["code_stack/min"],
        }),
        entity("code_stack/min", "code_stack", { file: "/build/model.py", line: 2, children: ["op/min"] }),
        entity("op/min", "source_operator"),
        entity("code_line/max", "code_line", {
          file: "/build/model.py", line: 3, children: ["code_stack/max"],
        }),
        entity("code_stack/max", "code_stack", { file: "/build/model.py", line: 3, children: ["op/max"] }),
        entity("op/max", "source_operator"),
        entity("code_line/partial", "code_line", {
          file: "/build/model.py",
          line: 4,
          children: ["code_stack/partial-root", "code_stack/partial-child"],
        }),
        entity("code_stack/partial-root", "code_stack", {
          file: "/build/model.py",
          line: 4,
          children: ["code_stack/partial-child", "op/partial-b"],
        }),
        entity("code_stack/partial-child", "code_stack", {
          file: "/build/model.py",
          line: 4,
          children: ["op/partial-a"],
        }),
        entity("op/partial-a", "source_operator"),
        entity("op/partial-b", "source_operator"),
        entity("code_line/unavailable", "code_line", {
          file: "/build/model.py", line: 6, children: ["code_stack/unavailable"],
        }),
        entity("code_stack/unavailable", "code_stack", {
          file: "/build/model.py",
          line: 6,
          children: ["op/unavailable"],
        }),
        entity("op/unavailable", "source_operator"),
      ],
      breakdowns: [
        breakdown("code_line/min", 1),
        breakdown("code_line/max", 9),
        breakdown("code_line/partial", 3),
      ],
    },
    {
      entities: [
        entity("code_line/result-one", "code_line", {
          file: "/build/model.py", line: 1, children: ["code_stack/result-one"],
        }),
        entity("code_stack/result-one", "code_stack", {
          file: "/build/model.py",
          line: 1,
          children: ["op/result-one"],
        }),
        entity("op/result-one", "source_operator"),
      ],
      breakdowns: [breakdown("code_line/result-one", 100)],
    },
  ],
};

const mappings = {
  results: [
    {
      resultIndex: 0,
      mappings: [
        "code_stack/min",
        "code_stack/max",
        "code_stack/partial-root",
        "code_stack/partial-child",
        "code_stack/unavailable",
      ].map((entityId) => ({ entityId })),
    },
    { resultIndex: 1, mappings: [{ entityId: "code_stack/result-one" }] },
  ],
};

function fixture(): {
  annotations: SourceAnnotationIndex;
  decorations: SourceDecorationManager<TestEditor, TestDecoration>;
  created: TestDecoration[];
} {
  let nextId = 1;
  const created: TestDecoration[] = [];
  const annotations = new SourceAnnotationIndex({
    uriForFile: (file) => `file://${file.replace(/\\/gu, "/")}`,
  });
  const decorations = new SourceDecorationManager<TestEditor, TestDecoration>(
    {
      editorUri: (editor) => editor.uri,
      editorLineCount: (editor) => editor.lineCount,
      createDecoration: (color) => {
        const decoration = { id: nextId, color, disposed: false };
        nextId += 1;
        created.push(decoration);
        return decoration;
      },
      setDecoratedLines: (editor, decoration, lines) => {
        editor.applied.push({ decoration, lines: [...lines] });
      },
      disposeDecoration: (decoration) => {
        decoration.disposed = true;
      },
    },
    annotations,
  );
  return { annotations, decorations, created };
}

function editor(uri = "file:///build/model.py", lineCount = 10): TestEditor {
  return { uri, lineCount, applied: [] };
}

function nonEmptyApplications(value: TestEditor): Array<{ color: string; lines: number[] }> {
  return value.applied
    .filter(({ lines }) => lines.length > 0)
    .map(({ decoration, lines }) => ({ color: decoration.color, lines }));
}

describe("SourceDecorationManager", () => {
  it("uses each result-0 record's exact complete and unavailable RGBA color", () => {
    const { annotations, decorations } = fixture();
    const visible = editor();
    decorations.updateVisibleEditors([visible]);
    annotations.setAnalysis({}, output, mappings);

    assert.deepStrictEqual(nonEmptyApplications(visible).slice(-4), [
      { color: "rgba(46, 125, 50, 0.28)", lines: [1] },
      { color: "rgba(198, 40, 40, 0.28)", lines: [2] },
      { color: "rgba(84, 103, 47, 0.28)", lines: [3] },
      { color: "rgba(117, 117, 117, 0.08)", lines: [5] },
    ]);
    assert.ok(!nonEmptyApplications(visible).some(({ lines }) => lines.includes(0)));
  });

  it("switches heatmap presentation to a selected later result", () => {
    const { annotations, decorations, created } = fixture();
    const visible = editor();
    decorations.updateVisibleEditors([visible]);
    annotations.setAnalysis({}, output, mappings);
    const resultOneOverlay = buildOverlayCatalog(output).find(({ resultIndex, name }) =>
      resultIndex === 1 && name === "total_cycles"
    );
    assert.ok(resultOneOverlay);

    annotations.selectOverlay(resultOneOverlay);

    assert.deepStrictEqual(
      created.filter(({ disposed }) => !disposed).map(({ color }) => color),
      ["rgba(122, 82, 45, 0.28)"],
    );
    assert.deepStrictEqual(nonEmptyApplications(visible).at(-1), {
      color: "rgba(122, 82, 45, 0.28)",
      lines: [0],
    });
  });

  it("clears and disposes stale per-color decorations when analysis data is replaced", () => {
    const { annotations, decorations, created } = fixture();
    const visible = editor();
    decorations.updateVisibleEditors([visible]);
    annotations.setAnalysis({}, output, mappings);
    const firstDecorations = [...created];

    annotations.setAnalysis({}, { results: [{ entities: [] }] }, { results: [] });

    assert.ok(firstDecorations.every(({ disposed }) => disposed));
    for (const decoration of firstDecorations) {
      assert.ok(visible.applied.some((application) =>
        application.decoration === decoration && application.lines.length === 0
      ));
    }
  });

  it("clears and disposes heatmaps while disabled, tracks updates, and reapplies the latest annotations", () => {
    const { annotations, decorations, created } = fixture();
    const oldEditor = editor("file://C:/old/model.py");
    const newEditor = editor("file://D:/new/model.py");
    annotations.updateSourceFileMap({ "/build": "C:/old" });
    decorations.updateVisibleEditors([oldEditor]);
    annotations.setAnalysis({}, output, mappings);
    const activeDecorations = [...created];

    decorations.setEnabled(false);

    assert.ok(activeDecorations.every(({ disposed }) => disposed));
    assert.ok(oldEditor.applied.slice(-activeDecorations.length).every(({ lines }) => lines.length === 0));
    const createdWhileDisabled = created.length;
    decorations.updateVisibleEditors([newEditor]);
    annotations.updateSourceFileMap({ "/build": "D:/new" });
    assert.strictEqual(created.length, createdWhileDisabled);
    assert.deepStrictEqual(newEditor.applied, []);

    decorations.setEnabled(true);

    assert.strictEqual(created.length, createdWhileDisabled + 4);
    assert.deepStrictEqual(nonEmptyApplications(newEditor).slice(-4).map(({ lines }) => lines), [
      [1], [2], [3], [5],
    ]);
  });

  it("keeps heatmap, CodeLens, and the transient navigation border independent", () => {
    const { annotations, decorations, created } = fixture();
    const visible = editor();
    decorations.updateVisibleEditors([visible]);
    annotations.setAnalysis({}, output, mappings);

    let codeLensEnabled = true;
    let heatmapEnabled = true;
    let codeLensRefreshes = 0;
    const codeLenses = new SourceCodeLensProducer(() => codeLensEnabled);
    codeLenses.onDidRefresh(() => {
      codeLensRefreshes += 1;
    });
    const visibility = new SourceVisibilityController({
      refreshCodeLenses: () => codeLenses.refresh(),
      setHeatmapEnabled: (enabled) => decorations.setEnabled(enabled),
      isHeatmapEnabled: () => heatmapEnabled,
    });
    visibility.initialize();

    const borderApplications: string[][] = [];
    let borderDisposed = false;
    const border = new TransientSourceLineBorder<string, string, number>({
      setBorder: (_editor, ranges) => borderApplications.push([...ranges]),
      schedule: () => 1,
      cancel: () => undefined,
      disposeBorder: () => {
        borderDisposed = true;
      },
    }, 1_500);
    border.show("editor", "line-3");

    const provide = () => codeLenses.provide(
      annotations.sourceLineRecordsForUri(visible.uri),
      "analysis",
      visible.lineCount,
    );
    const change = (section: string) => visibility.configurationChanged({
      affectsConfiguration: (candidate) => candidate === section,
    });
    assert.ok(provide().length > 0);

    heatmapEnabled = false;
    change(showHeatmapConfiguration);
    assert.ok(created.every(({ disposed }) => disposed));
    assert.ok(provide().length > 0);
    assert.deepStrictEqual(borderApplications, [["line-3"]]);
    assert.strictEqual(borderDisposed, false);
    assert.strictEqual(codeLensRefreshes, 0);

    heatmapEnabled = true;
    change(showHeatmapConfiguration);
    const heatmapApplications = visible.applied.length;
    assert.strictEqual(created.filter(({ disposed }) => !disposed).length, 4);

    codeLensEnabled = false;
    change(showCodeLensConfiguration);
    assert.deepStrictEqual(provide(), []);
    assert.strictEqual(codeLensRefreshes, 1);
    assert.strictEqual(visible.applied.length, heatmapApplications);
    assert.strictEqual(created.filter(({ disposed }) => !disposed).length, 4);
    assert.deepStrictEqual(borderApplications, [["line-3"]]);
    assert.strictEqual(borderDisposed, false);

    codeLensEnabled = true;
    change(showCodeLensConfiguration);
    assert.ok(provide().length > 0);
    assert.strictEqual(codeLensRefreshes, 2);
    assert.strictEqual(visible.applied.length, heatmapApplications);
  });

  it("clears the old file and reapplies after a source-file-map reindex", () => {
    const { annotations, decorations } = fixture();
    const oldEditor = editor("file://C:/old/model.py");
    const newEditor = editor("file://D:/new/model.py");
    annotations.updateSourceFileMap({ "/build": "C:/old" });
    decorations.updateVisibleEditors([oldEditor, newEditor]);
    annotations.setAnalysis({}, output, mappings);

    annotations.updateSourceFileMap({ "/build": "D:/new" });

    assert.ok(oldEditor.applied.slice(-4).every(({ lines }) => lines.length === 0));
    assert.deepStrictEqual(nonEmptyApplications(newEditor).slice(-4).map(({ lines }) => lines), [
      [1], [2], [3], [5],
    ]);
  });

  it("clears editors that stop being visible and applies to newly visible editors", () => {
    const { annotations, decorations } = fixture();
    const first = editor();
    const second = editor();
    annotations.setAnalysis({}, output, mappings);
    decorations.updateVisibleEditors([first]);

    decorations.updateVisibleEditors([second]);

    assert.ok(first.applied.slice(-4).every(({ lines }) => lines.length === 0));
    assert.deepStrictEqual(nonEmptyApplications(second).slice(-4).map(({ lines }) => lines), [
      [1], [2], [3], [5],
    ]);
  });

  it("only clears the owning analysis and refreshes listeners for replacements", () => {
    const { annotations, decorations } = fixture();
    const owner = {};
    const visible = editor();
    decorations.updateVisibleEditors([visible]);
    annotations.setAnalysis(owner, output, mappings);
    const applications = visible.applied.length;

    annotations.clearAnalysis({});
    assert.strictEqual(visible.applied.length, applications);

    annotations.clearAnalysis(owner);
    assert.ok(visible.applied.slice(-4).every(({ lines }) => lines.length === 0));
  });

  it("does not decorate lines outside the current document", () => {
    const { annotations, decorations } = fixture();
    const visible = editor("file:///build/model.py", 3);
    decorations.updateVisibleEditors([visible]);
    annotations.setAnalysis({}, output, mappings);

    assert.deepStrictEqual(nonEmptyApplications(visible).slice(-2).map(({ lines }) => lines), [[1], [2]]);
  });

  it("clears visible editors and disposes every decoration type on disposal", () => {
    const { annotations, decorations, created } = fixture();
    const visible = editor();
    decorations.updateVisibleEditors([visible]);
    annotations.setAnalysis({}, output, mappings);

    decorations.dispose();

    assert.ok(created.every(({ disposed }) => disposed));
    assert.ok(visible.applied.slice(-created.length).every(({ lines }) => lines.length === 0));
    const applicationCount = visible.applied.length;
    annotations.updateSourceFileMap({ "/build": "C:/other" });
    assert.strictEqual(visible.applied.length, applicationCount);
  });
});
