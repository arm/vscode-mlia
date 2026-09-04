import * as assert from "assert";
import { describe, it } from "node:test";

import { MappedSourceLineResultRecord, SourceAnnotationIndex } from "../sourceAnnotations";
import { SourceCodeLensAction } from "../sourceCodeLens";
import {
  executeSourceOverlayAction,
  SourceOverlayActionController,
  SourceOverlayOpenOutcome,
} from "../sourceOverlayActions";
import {
  SourceEntityReference,
  SourceLineMetricAggregate,
  SourceLineResultRecord,
} from "../sourceLines";

interface TestAnalysis {
  id: string;
}

interface PreparedSource {
  record: MappedSourceLineResultRecord;
}

function stack(id: string, file: string, line: number, child: string) {
  return {
    id,
    kind: "code_stack",
    parent_ids: [],
    child_ids: [child],
    attributes: { file, line },
  };
}

function op(id: string) {
  return { id, kind: "source_operator", parent_ids: [], child_ids: [] };
}

function breakdown(entityId: string, value: number) {
  return {
    entity_id: entityId,
    qualifiers: {},
    metrics: [{ name: "total_cycles", unit: "cycles", value, qualifiers: {} }],
  };
}

const output = {
  results: [
    {
      entities: [
        {
          id: "code_line/current",
          kind: "code_line",
          parent_ids: [],
          child_ids: ["code_stack/current", "code_stack/same-line"],
          attributes: { file: "/build/main.py", line: 5 },
        },
        stack("code_stack/current", "/build/main.py", 5, "op/current"),
        op("op/current"),
        {
          id: "code_line/caller",
          kind: "code_line",
          parent_ids: [],
          child_ids: ["code_stack/caller"],
          attributes: { file: "/build/main.py", line: 3 },
        },
        stack("code_stack/caller", "/build/main.py", 3, "op/caller"),
        op("op/caller"),
        {
          id: "code_line/cross-file",
          kind: "code_line",
          parent_ids: [],
          child_ids: ["code_stack/cross-file"],
          attributes: { file: "/build/lib.py", line: 9 },
        },
        stack("code_stack/cross-file", "/build/lib.py", 9, "op/cross-file"),
        op("op/cross-file"),
        stack("code_stack/same-line", "/build/main.py", 5, "op/same-line"),
        op("op/same-line"),
        {
          id: "code_stack/no-location",
          kind: "code_stack",
          parent_ids: [],
          child_ids: ["op/no-location"],
        },
        op("op/no-location"),
      ],
      breakdowns: [
        breakdown("code_line/current", 10),
        breakdown("code_line/caller", 3),
        breakdown("code_line/cross-file", 9),
      ],
    },
    {
      entities: [
        {
          id: "code_line/result-one",
          kind: "code_line",
          parent_ids: [],
          child_ids: ["code_stack/result-one"],
          attributes: { file: "/build/other.py", line: 1 },
        },
        stack("code_stack/result-one", "/build/other.py", 1, "op/result-one"),
        op("op/result-one"),
      ],
      breakdowns: [breakdown("code_line/result-one", 1)],
    },
  ],
};

const mappings = {
  results: [
    {
      resultIndex: 0,
      mappings: [
        "code_stack/current",
        "code_stack/caller",
        "code_stack/cross-file",
        "code_stack/same-line",
        "code_stack/no-location",
      ].map((entityId) => ({ entityId })),
    },
    { resultIndex: 1, mappings: [{ entityId: "code_stack/result-one" }] },
  ],
};

function reference(entityId: string, resultIndex = 0): SourceEntityReference {
  return { entityId, resultIndex };
}

function action(
  kind: "entity" | "relationship",
  entity: SourceEntityReference,
  analysisId = "analysis",
): SourceCodeLensAction {
  return { analysisId, kind, entity };
}

interface FixtureOptions {
  current?: TestAnalysis;
  index?: SourceAnnotationIndex;
  openOutcome?: SourceOverlayOpenOutcome | false;
  openError?: Error;
  prepared?: boolean;
  selectable?: boolean;
  revealed?: boolean;
  selected?: boolean;
  onPrepare?: () => void | Promise<void>;
  onOpen?: () => void | Promise<void>;
  onReveal?: () => void | Promise<void>;
  onSelect?: () => void | Promise<void>;
}

function defaultIndex(): SourceAnnotationIndex {
  const index = new SourceAnnotationIndex({
    uriForFile: (file) => `file://${file.replace(/\\/gu, "/")}`,
  });
  index.updateSourceFileMap({ "/build": "C:/source" });
  index.setAnalysis({}, output, mappings);
  return index;
}

function fixture(options: FixtureOptions = {}) {
  const index = options.index ?? defaultIndex();
  let current: TestAnalysis | undefined = options.current === undefined
    ? { id: "analysis" }
    : options.current;
  const opened: TestAnalysis[] = [];
  const prepared: MappedSourceLineResultRecord[] = [];
  const selected: Array<{ analysis: TestAnalysis; entity: SourceEntityReference }> = [];
  const revealed: Array<{ analysis: TestAnalysis; record: MappedSourceLineResultRecord }> = [];
  const events: string[] = [];
  const controller = new SourceOverlayActionController<TestAnalysis, PreparedSource>(index, {
    currentAnalysis: () => current,
    openAnalysis: async (analysis) => {
      events.push("open");
      opened.push(analysis);
      await options.onOpen?.();
      if (options.openError) {
        throw options.openError;
      }
      return options.openOutcome ?? "ready";
    },
    canSelectEntity: () => options.selectable ?? true,
    selectEntity: async (analysis, entity) => {
      events.push("select");
      selected.push({ analysis, entity });
      await options.onSelect?.();
      return options.selected ?? true;
    },
    prepareSource: async (_analysis, record) => {
      events.push("prepare");
      prepared.push(record);
      await options.onPrepare?.();
      return options.prepared === false ? undefined : { record };
    },
    revealSource: async (analysis, record) => {
      events.push("reveal");
      revealed.push({ analysis, record });
      await options.onReveal?.();
      return options.revealed ?? true;
    },
  });
  return {
    controller,
    events,
    opened,
    prepared,
    selected,
    revealed,
    setCurrent: (analysis: TestAnalysis | undefined) => {
      current = analysis;
    },
  };
}

function completeMetric(value = 1): SourceLineMetricAggregate {
  return {
    name: "total_cycles",
    unit: "cycles",
    breakdownQualifiers: {},
    metricQualifiers: {},
    value,
    status: "complete",
    contributors: [],
    missingEntityReferences: [],
    ambiguousEntityReferences: [],
    coveredLeafIds: [],
    uncoveredLeafIds: [],
    reasons: [],
  };
}

function indexedRecord(file: string, line: number, entity: SourceEntityReference): SourceLineResultRecord {
  const metric = completeMetric();
  return {
    file,
    line,
    resultIndex: entity.resultIndex,
    resultKind: "result",
    entities: [entity],
    metrics: [metric],
    modelMetrics: [],
    totalCycles: metric,
    overlayPresentations: [],
    selectedMetric: metric,
    color: {
      hex: "#123456",
      opacity: 0.28,
      rgba: "rgba(18, 52, 86, 0.28)",
      basis: "total_cycles",
    },
    callers: [],
    called: [],
  };
}

describe("SourceOverlayActionController", () => {
  it("opens the scoped analysis and selects an exact result-scoped center entity", async () => {
    const { controller, events, opened, selected, revealed } = fixture();
    const entity = reference("code_stack/current");

    assert.strictEqual(await controller.execute(action("entity", entity)), true);
    assert.deepStrictEqual(events, ["open", "select"]);
    assert.deepStrictEqual(opened, [{ id: "analysis" }]);
    assert.deepStrictEqual(selected, [{ analysis: { id: "analysis" }, entity }]);
    assert.deepStrictEqual(revealed, []);
  });

  it("makes the registered center-action command resolve false when panel opening rejects", async () => {
    const state = fixture({ openError: new Error("panel load failed") });
    const entity = reference("code_stack/current");

    assert.strictEqual(
      await executeSourceOverlayAction(state.controller, action("entity", entity)),
      false,
    );
    assert.deepStrictEqual(state.events, ["open"]);
    assert.deepStrictEqual(state.opened, [{ id: "analysis" }]);
    assert.deepStrictEqual(state.prepared, []);
    assert.deepStrictEqual(state.revealed, []);
    assert.deepStrictEqual(state.selected, []);
  });

  it("preflights, reveals, opens, and selects a unique relationship deterministically", async () => {
    const { controller, events, selected, revealed } = fixture();
    const entity = reference("code_stack/caller");

    assert.strictEqual(await controller.execute(action("relationship", entity)), true);
    assert.deepStrictEqual(events, ["prepare", "reveal", "open", "select"]);
    assert.deepStrictEqual(revealed.map(({ record }) => ({
      uri: record.uri,
      localFile: record.localFile.replace(/\\/gu, "/"),
      line: record.line,
      resultIndex: record.resultIndex,
    })), [{
      uri: "file://C:/source/main.py",
      localFile: "C:/source/main.py",
      line: 3,
      resultIndex: 0,
    }]);
    assert.deepStrictEqual(selected.map(({ entity: selectedEntity }) => selectedEntity), [entity]);
  });

  it("supports cross-file and same-line relationship targets", async () => {
    const crossFile = fixture();
    assert.strictEqual(
      await crossFile.controller.execute(action("relationship", reference("code_stack/cross-file"))),
      true,
    );
    assert.deepStrictEqual(crossFile.revealed.map(({ record }) => ({
      localFile: record.localFile.replace(/\\/gu, "/"),
      line: record.line,
    })), [{ localFile: "C:/source/lib.py", line: 9 }]);

    const sameLine = fixture();
    assert.strictEqual(
      await sameLine.controller.execute(action("relationship", reference("code_stack/same-line"))),
      true,
    );
    assert.strictEqual(sameLine.revealed[0].record.line, 5);
  });

  it("rejects an action whose analysis changed before invocation", async () => {
    const state = fixture({ current: { id: "new-analysis" } });

    assert.strictEqual(
      await state.controller.execute(action("entity", reference("code_stack/current"), "old-analysis")),
      false,
    );
    assert.deepStrictEqual(state.events, []);
  });

  it("revalidates analysis identity after awaited source preparation", async () => {
    let state: ReturnType<typeof fixture>;
    state = fixture({ onPrepare: () => state.setCurrent({ id: "other" }) });

    assert.strictEqual(
      await state.controller.execute(action("relationship", reference("code_stack/caller"))),
      false,
    );
    assert.deepStrictEqual(state.events, ["prepare"]);
  });

  it("revalidates analysis identity after awaited panel loading, leaving the source revealed", async () => {
    let state: ReturnType<typeof fixture>;
    state = fixture({ onOpen: () => state.setCurrent({ id: "other" }) });

    assert.strictEqual(
      await state.controller.execute(action("relationship", reference("code_stack/caller"))),
      false,
    );
    assert.deepStrictEqual(state.events, ["prepare", "reveal", "open"]);
  });

  it("does not open visible UI when source preflight fails", async () => {
    const state = fixture({ prepared: false });

    assert.strictEqual(
      await state.controller.execute(action("relationship", reference("code_stack/caller"))),
      false,
    );
    assert.deepStrictEqual(state.events, ["prepare"]);
    assert.deepStrictEqual(state.opened, []);
    assert.deepStrictEqual(state.revealed, []);
    assert.deepStrictEqual(state.selected, []);
  });

  it("stops before selection when source reveal fails", async () => {
    const state = fixture({ revealed: false });

    assert.strictEqual(
      await state.controller.execute(action("relationship", reference("code_stack/caller"))),
      false,
    );
    assert.deepStrictEqual(state.events, ["prepare", "reveal"]);
    assert.deepStrictEqual(state.opened, []);
    assert.deepStrictEqual(state.selected, []);
  });

  it("reports a loaded-panel selection failure after source was already revealed", async () => {
    const state = fixture({ selected: false });

    assert.strictEqual(
      await state.controller.execute(action("relationship", reference("code_stack/caller"))),
      false,
    );
    assert.deepStrictEqual(state.events, ["prepare", "reveal", "open", "select"]);
  });

  it("does not select when the analysis changes during source reveal", async () => {
    let state: ReturnType<typeof fixture>;
    state = fixture({ onReveal: () => state.setCurrent({ id: "other" }) });

    assert.strictEqual(
      await state.controller.execute(action("relationship", reference("code_stack/caller"))),
      false,
    );
    assert.deepStrictEqual(state.events, ["prepare", "reveal"]);
    assert.deepStrictEqual(state.opened, []);
  });

  it("does not post a second selection when a new relationship panel embedded the initial selection", async () => {
    const state = fixture({ openOutcome: "selected" });

    assert.strictEqual(
      await state.controller.execute(action("relationship", reference("code_stack/caller"))),
      true,
    );
    assert.deepStrictEqual(state.events, ["prepare", "reveal", "open"]);
    assert.strictEqual(state.revealed.length, 1);
    assert.deepStrictEqual(state.selected, []);
  });

  it("leaves the source revealed when the later panel operation returns false", async () => {
    const state = fixture({ openOutcome: false });

    assert.strictEqual(
      await state.controller.execute(action("relationship", reference("code_stack/caller"))),
      false,
    );
    assert.deepStrictEqual(state.events, ["prepare", "reveal", "open"]);
    assert.strictEqual(state.revealed.length, 1);
    assert.strictEqual(state.opened.length, 1);
    assert.deepStrictEqual(state.selected, []);
  });

  it("leaves the relationship source revealed when later panel opening rejects", async () => {
    const state = fixture({ openError: new Error("panel load failed") });

    assert.strictEqual(
      await state.controller.execute(action("relationship", reference("code_stack/caller"))),
      false,
    );
    assert.deepStrictEqual(state.events, ["prepare", "reveal", "open"]);
    assert.strictEqual(state.revealed.length, 1);
    assert.strictEqual(state.opened.length, 1);
    assert.deepStrictEqual(state.selected, []);
  });

  it("supports later-result actions while rejecting unmapped and unselectable actions", async () => {
    const missing = fixture();
    assert.strictEqual(
      await missing.controller.execute(action("relationship", reference("code_stack/no-location"))),
      false,
    );
    assert.deepStrictEqual(missing.events, []);

    const resultOne = fixture();
    const resultOneEntity = reference("code_stack/result-one", 1);
    assert.strictEqual(
      await resultOne.controller.execute(action("relationship", resultOneEntity)),
      true,
    );
    assert.deepStrictEqual(resultOne.events, ["prepare", "reveal", "open", "select"]);
    assert.strictEqual(resultOne.revealed[0].record.resultIndex, 1);
    assert.deepStrictEqual(resultOne.selected.map(({ entity }) => entity), [resultOneEntity]);

    const unselectable = fixture({ selectable: false });
    assert.strictEqual(
      await unselectable.controller.execute(action("relationship", reference("code_stack/caller"))),
      false,
    );
    assert.deepStrictEqual(unselectable.events, []);
  });

  it("rejects a result-scoped entity indexed at multiple source records", async () => {
    const entity = reference("code_stack/ambiguous");
    const index = new SourceAnnotationIndex({
      uriForFile: (file) => `file://${file}`,
      buildSourceLines: () => [
        indexedRecord("/build/a.py", 1, entity),
        indexedRecord("/build/b.py", 2, entity),
      ],
    });
    index.setAnalysis({}, {}, {});
    const state = fixture({ index });

    assert.strictEqual(
      await state.controller.execute(action("relationship", entity)),
      false,
    );
    assert.deepStrictEqual(state.events, []);
  });
});
