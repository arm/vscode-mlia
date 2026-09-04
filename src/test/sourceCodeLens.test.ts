import * as assert from "assert";
import { describe, it } from "node:test";

import { MappedSourceLineResultRecord } from "../sourceAnnotations";
import {
  sourceCodeLensCommand,
  SourceCodeLensProducer,
  sourceCodeLensDescriptors,
  sourceOverlayActionCommand,
} from "../sourceCodeLens";
import {
  showCodeLensConfiguration,
  SourceVisibilityController,
} from "../sourceVisibility";
import {
  SourceEntityReference,
  SourceLineMetricAggregate,
  SourceLineMetricReasonCode,
  SourceLineMetricStatus,
  SourceLineQualifiers,
  SourceModelMetric,
} from "../sourceLines";

const analysisId = "analysis-7";

function reference(entityId: string, resultIndex = 0): SourceEntityReference {
  return { entityId, resultIndex };
}

function totalCycles(
  status: SourceLineMetricStatus,
  options: {
    value?: number;
    unit?: string;
    reasons?: SourceLineMetricReasonCode[];
  } = {},
): SourceLineMetricAggregate {
  return {
    name: "total_cycles",
    unit: options.unit ?? "cycles",
    breakdownQualifiers: {},
    metricQualifiers: {},
    ...(options.value === undefined ? {} : { value: options.value }),
    status,
    contributors: [],
    missingEntityReferences: [],
    ambiguousEntityReferences: [],
    coveredLeafIds: [],
    uncoveredLeafIds: [],
    reasons: (options.reasons ?? []).map((code) => ({
      code,
      entityReferences: [],
      leafIds: [],
    })),
  };
}

function modelMetric(
  value: number,
  unit = "cycles",
  qualifiers: SourceLineQualifiers = {},
): SourceModelMetric {
  return { name: "total_cycles", value, unit, qualifiers };
}

function record(options: {
  line?: number;
  resultIndex?: number;
  entities?: SourceEntityReference[];
  callers?: SourceEntityReference[];
  called?: SourceEntityReference[];
  totalCycles?: SourceLineMetricAggregate;
  selectedModelMetric?: SourceModelMetric;
} = {}): MappedSourceLineResultRecord {
  const resultIndex = options.resultIndex ?? 0;
  const metric = options.totalCycles ?? totalCycles("complete", { value: 42 });
  const line = options.line ?? 7;
  return {
    file: "/build/model.py",
    mappedLocation: {
      sourceFile: "/build/model.py",
      localFile: "C:/source/model.py",
      uri: "file:///C:/source/model.py",
      line,
    },
    localFile: "C:/source/model.py",
    uri: "file:///C:/source/model.py",
    line,
    resultIndex,
    resultKind: "result",
    entities: options.entities ?? [reference("code_stack/current", resultIndex)],
    metrics: [metric],
    modelMetrics: options.selectedModelMetric ? [options.selectedModelMetric] : [],
    totalCycles: metric,
    overlayPresentations: [],
    selectedOverlay: {
      resultIndex,
      resultKind: "result",
      category: "metric",
      name: metric.name,
      unit: metric.unit,
      breakdownQualifiers: metric.breakdownQualifiers,
      metricQualifiers: metric.metricQualifiers,
    },
    selectedMetric: metric,
    ...(options.selectedModelMetric === undefined
      ? {}
      : { selectedModelMetric: options.selectedModelMetric }),
    color: {
      hex: "#123456",
      opacity: 0.28,
      rgba: "rgba(18, 52, 86, 0.28)",
      basis: "total_cycles",
    },
    callers: options.callers ?? [],
    called: options.called ?? [],
  };
}

function descriptors(records: readonly MappedSourceLineResultRecord[], lineCount?: number) {
  return sourceCodeLensDescriptors(records, analysisId, lineCount);
}

describe("source CodeLens descriptors", () => {
  it("keeps one provider live, rereads visibility, and refreshes it on configuration changes", () => {
    let enabled = false;
    let refreshes = 0;
    const producer = new SourceCodeLensProducer(() => enabled);
    producer.onDidRefresh(() => {
      refreshes += 1;
    });
    const visibility = new SourceVisibilityController({
      refreshCodeLenses: () => producer.refresh(),
      setHeatmapEnabled: () => undefined,
      isHeatmapEnabled: () => true,
    });
    const provide = () => producer.provide([record()], analysisId, 10);
    const codeLensChanged = () => visibility.configurationChanged({
      affectsConfiguration: (section) => section === showCodeLensConfiguration,
    });

    assert.deepStrictEqual(provide(), []);
    enabled = true;
    codeLensChanged();
    assert.strictEqual(refreshes, 1);
    assert.deepStrictEqual(provide().map(({ kind, title }) => ({ kind, title })), [
      { kind: "overlay", title: "MLIA: 42 cycles" },
    ]);

    enabled = false;
    codeLensChanged();
    assert.strictEqual(refreshes, 2);
    assert.deepStrictEqual(provide(), []);

    enabled = true;
    codeLensChanged();
    assert.strictEqual(refreshes, 3);
    assert.deepStrictEqual(provide().map(({ title }) => title), ["MLIA: 42 cycles"]);
  });

  it("returns overlay, caller, and called items in visual order at one shared range", () => {
    const items = descriptors([record({
      callers: [reference("code_stack/caller")],
      called: [reference("code_stack/called")],
    })]);

    assert.deepStrictEqual(items.map(({ kind, line, title }) => ({ kind, line, title })), [
      { kind: "overlay", line: 6, title: "MLIA: 42 cycles" },
      { kind: "caller", line: 6, title: "← Called by" },
      { kind: "called", line: 6, title: "Calls into →" },
    ]);
    assert.ok(items.every(({ action }) => !action || action.analysisId === analysisId));
  });

  it("uses the selected overlay result and omits source lines outside the document", () => {
    const resultOne = record({ line: 1, resultIndex: 1 });
    const selectedOverlay = resultOne.selectedOverlay;
    assert.ok(selectedOverlay);

    assert.deepStrictEqual(
      descriptors([
        { ...record({ line: 2 }), selectedOverlay },
        resultOne,
        record({ line: 0, resultIndex: 1 }),
        record({ line: 3, resultIndex: 1 }),
      ], 2).map(({ line }) => line),
      [0],
    );
  });

  it("omits empty relationships and navigates to the first available target", () => {
    const none = descriptors([record()]);
    assert.deepStrictEqual(none.map(({ kind }) => kind), ["overlay"]);

    const unique = descriptors([record({
      callers: [reference("code_stack/caller")],
      called: [reference("code_stack/called")],
    })]);
    assert.deepStrictEqual(unique[1].action, {
      analysisId,
      kind: "relationship",
      entity: reference("code_stack/caller"),
    });
    assert.deepStrictEqual(unique[2].action, {
      analysisId,
      kind: "relationship",
      entity: reference("code_stack/called"),
    });

    const multiple = descriptors([record({
      callers: [reference("code_stack/a"), reference("code_stack/b")],
      called: [reference("code_stack/c"), reference("code_stack/d")],
    })]);
    assert.deepStrictEqual(
      multiple.map(({ kind, title, action }) => ({ kind, title, action })),
      [
        {
          kind: "overlay",
          title: "MLIA: 42 cycles",
          action: {
            analysisId,
            kind: "entity",
            entity: reference("code_stack/current"),
          },
        },
        {
          kind: "caller",
          title: "Called by (2)",
          action: {
            analysisId,
            kind: "relationship",
            entity: reference("code_stack/a"),
          },
        },
        {
          kind: "called",
          title: "Calls into (2)",
          action: {
            analysisId,
            kind: "relationship",
            entity: reference("code_stack/c"),
          },
        },
      ],
    );
  });

  it("uses complete, partial, and unavailable overlay titles with deterministic reason tooltips", () => {
    const items = descriptors([
      record({ line: 1, totalCycles: totalCycles("complete", { value: 12_345.5, unit: "cycles" }) }),
      record({
        line: 2,
        totalCycles: totalCycles("partial", {
          value: 7,
          unit: "ticks",
          reasons: ["missing_metric", "unresolved_hierarchy"],
        }),
      }),
      record({
        line: 3,
        totalCycles: totalCycles("unavailable", {
          unit: "",
          reasons: ["conflicting_metric_identity"],
        }),
      }),
    ]).filter(({ kind }) => kind === "overlay");

    assert.deepStrictEqual(items.map(({ title, tooltip }) => ({ title, tooltip })), [
      {
        title: "MLIA: 12,346 cycles",
        tooltip: "Complete MLIA total for this source line.",
      },
      {
        title: "MLIA: partial total — 7 ticks",
        tooltip: "Partial MLIA total: some cycle data is missing; source hierarchy coverage is unresolved.",
      },
      {
        title: "MLIA: total cycles unavailable",
        tooltip: "MLIA total unavailable: multiple total cycle metrics conflict.",
      },
    ]);
  });

  it("renders a selected non-default metric by name and unit", () => {
    const selectedMetric = {
      ...totalCycles("complete", { value: 2_048, unit: "bytes" }),
      name: "dram_read_bytes",
    };

    const item = descriptors([record({ totalCycles: selectedMetric })])[0];

    assert.deepStrictEqual({ title: item.title, tooltip: item.tooltip }, {
      title: "MLIA: dram read bytes — 2,048 bytes",
      tooltip: "Complete MLIA dram read bytes total for this source line.",
    });
  });

  it("shows each usable source-line total as a percentage of the result's model total", () => {
    const items = descriptors([
      record({
        line: 1,
        totalCycles: totalCycles("complete", { value: 42 }),
        selectedModelMetric: modelMetric(200),
      }),
      record({
        line: 2,
        totalCycles: totalCycles("partial", { value: 7, unit: "ticks" }),
        selectedModelMetric: modelMetric(14, "ticks"),
      }),
      record({
        line: 3,
        totalCycles: totalCycles("complete", { value: 1 }),
        selectedModelMetric: modelMetric(20_000),
      }),
      record({
        line: 4,
        totalCycles: totalCycles("complete", { value: 42, unit: "ticks" }),
        selectedModelMetric: modelMetric(200, "cycles"),
      }),
      record({
        line: 5,
        totalCycles: totalCycles("complete", { value: 42 }),
        selectedModelMetric: modelMetric(0),
      }),
    ]).filter(({ kind }) => kind === "overlay");

    assert.deepStrictEqual(items.map(({ title }) => title), [
      "MLIA: 42 cycles (21% of model)",
      "MLIA: partial total — 7 ticks (50% of model)",
      "MLIA: 1 cycles (<0.01% of model)",
      "MLIA: 42 ticks",
      "MLIA: 42 cycles",
    ]);
  });

  it("makes the overlay item navigate to the first code-stack entity", () => {
    const items = [
      record({ line: 1, entities: [] }),
      record({
        line: 2,
        entities: [
          reference("code_line/model.py:2"),
          reference("code_stack/one"),
          reference("code_stack/two"),
        ],
      }),
      record({ line: 3, entities: [reference("code_line/model.py:3")] }),
    ].map((item) => descriptors([item])[0]);

    assert.strictEqual(items[0].action, undefined);
    assert.deepStrictEqual(sourceCodeLensCommand(items[0]), {
      title: "MLIA: 42 cycles",
      command: "",
      tooltip: "Complete MLIA total for this source line.",
    });
    assert.deepStrictEqual(items[1].action, {
      analysisId,
      kind: "entity",
      entity: reference("code_stack/one"),
    });
    assert.deepStrictEqual(sourceCodeLensCommand(items[1]), {
      title: "MLIA: 42 cycles",
      command: sourceOverlayActionCommand,
      tooltip: "Complete MLIA total for this source line.",
      arguments: [{
        analysisId,
        kind: "entity",
        entity: reference("code_stack/one"),
      }],
    });
    assert.deepStrictEqual(items[2].action, {
      analysisId,
      kind: "entity",
      entity: reference("code_line/model.py:3"),
    });
    assert.deepStrictEqual(sourceCodeLensCommand(items[2]), {
      title: "MLIA: 42 cycles",
      command: sourceOverlayActionCommand,
      tooltip: "Complete MLIA total for this source line.",
      arguments: [{
        analysisId,
        kind: "entity",
        entity: reference("code_line/model.py:3"),
      }],
    });
    assert.ok(items.every(({ title }) => title === "MLIA: 42 cycles"));
  });

  it("makes a multiple-target relationship command navigate to its first target", () => {
    const [, caller] = descriptors([record({
      callers: [reference("code_stack/a"), reference("code_stack/b")],
    })]);
    assert.deepStrictEqual(sourceCodeLensCommand(caller), {
      title: "Called by (2)",
      command: sourceOverlayActionCommand,
      tooltip: "Go to the first calling source line.",
      arguments: [{
        analysisId,
        kind: "relationship",
        entity: reference("code_stack/a"),
      }],
    });
  });

  it("consumes already-collapsed relationships as given, including a same-line target", () => {
    const target = reference("code_stack/current");
    const items = descriptors([record({ callers: [target] })]);
    assert.deepStrictEqual(items[1].action, {
      analysisId,
      kind: "relationship",
      entity: target,
    });
  });
});
