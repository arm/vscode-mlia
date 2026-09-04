import * as assert from "assert";
import { describe, it } from "node:test";

import { OverlayKey, overlayKeyId } from "../overlayCatalog";
import { SourceAnnotationIndex } from "../sourceAnnotations";
import {
  buildSourceLines,
  projectSourceMetric,
  SourceLineMetricAggregate,
  SourceLineResultRecord,
} from "../sourceLines";

interface EntityOptions {
  file?: string;
  line?: number;
  parents?: string[];
  children?: string[];
}

function entity(id: string, kind: string, options: EntityOptions = {}): Record<string, unknown> {
  return {
    id,
    kind,
    parent_ids: options.parents ?? [],
    child_ids: options.children ?? [],
    ...(options.file === undefined
      ? {}
      : { attributes: { file: options.file, line: options.line } }),
  };
}

function stack(id: string, line: number, children: string[], options: EntityOptions = {}) {
  return entity(id, "code_stack", {
    file: options.file ?? "/build/model.py",
    line,
    parents: options.parents,
    children,
  });
}

function op(id: string, parents: string[] = []) {
  return entity(id, "source_operator", { parents });
}

interface MetricOptions {
  unit?: string;
  qualifiers?: Record<string, unknown>;
  aggregation?: string;
  samples?: number;
  unavailable?: boolean;
}

function metric(name: string, value: number | undefined, options: MetricOptions = {}) {
  return value === undefined || options.unavailable
    ? {
        name,
        unit: options.unit ?? "cycles",
        availability: "unavailable",
        reason: "not reported",
        qualifiers: options.qualifiers ?? {},
      }
    : {
        name,
        value,
        unit: options.unit ?? "cycles",
        qualifiers: options.qualifiers ?? {},
        ...(options.aggregation === undefined ? {} : { aggregation: options.aggregation }),
        ...(options.samples === undefined ? {} : { samples: options.samples }),
      };
}

function breakdown(
  entityId: string,
  metrics: unknown[],
  qualifiers: Record<string, unknown> = {},
) {
  return { entity_id: entityId, metrics, qualifiers };
}

function outputResult(
  entities: unknown[],
  breakdowns: unknown[] = [],
  metrics: unknown[] = [],
) {
  if (entities.some((value) =>
    typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "code_line"
  )) {
    return { entities, breakdowns, metrics };
  }
  const groups = new Map<string, { file: string; line: number; stackIds: string[] }>();
  for (const value of entities) {
    if (typeof value !== "object" || value === null) {
      continue;
    }
    const candidate = value as {
      id?: unknown;
      kind?: unknown;
      attributes?: { file?: unknown; line?: unknown };
    };
    if (
      candidate.kind !== "code_stack" ||
      typeof candidate.id !== "string" ||
      typeof candidate.attributes?.file !== "string" ||
      typeof candidate.attributes.line !== "number"
    ) {
      continue;
    }
    const key = `${candidate.attributes.file.length}:${candidate.attributes.file}:${candidate.attributes.line}`;
    const group = groups.get(key) ?? {
      file: candidate.attributes.file,
      line: candidate.attributes.line,
      stackIds: [],
    };
    group.stackIds.push(candidate.id);
    groups.set(key, group);
  }
  const lineEntities: unknown[] = [];
  const lineBreakdowns: unknown[] = [];
  for (const [index, group] of [...groups.values()].sort((left, right) =>
    left.file.localeCompare(right.file) || left.line - right.line
  ).entries()) {
    const entityId = `code_line/${index}`;
    lineEntities.push(entity(entityId, "code_line", {
      file: group.file,
      line: group.line,
      children: [...group.stackIds].sort(),
    }));
    if (group.stackIds.length === 1) {
      for (const value of breakdowns) {
        if (
          typeof value === "object" && value !== null &&
          (value as { entity_id?: unknown }).entity_id === group.stackIds[0]
        ) {
          lineBreakdowns.push({ ...(value as Record<string, unknown>), entity_id: entityId });
        }
      }
    }
  }
  return {
    entities: [...entities, ...lineEntities],
    breakdowns: [...breakdowns, ...lineBreakdowns],
    metrics,
  };
}

function build(
  entities: unknown[],
  breakdowns: unknown[],
  visibleIds: string[],
): readonly SourceLineResultRecord[] {
  return buildSourceLines(
    { results: [outputResult(entities, breakdowns)] },
    { results: [{ resultIndex: 0, mappings: visibleIds.map((entityId) => ({ entityId })) }] },
  );
}

function line(records: readonly SourceLineResultRecord[], lineNumber = 1): SourceLineResultRecord {
  const result = records.find((record) => record.line === lineNumber);
  assert.ok(result, `Expected source line ${lineNumber}`);
  return result;
}

function aggregate(record: SourceLineResultRecord, name: string): SourceLineMetricAggregate {
  const result = record.metrics.find((item) => item.name === name);
  assert.ok(result, `Expected metric ${name}`);
  return result;
}

function reasonCodes(metricValue: SourceLineMetricAggregate): string[] {
  return metricValue.reasons.map(({ code }) => code);
}

function assertMutationRejected(mutation: () => void): void {
  assert.throws(mutation, TypeError);
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferredBoolean(): { promise: Promise<boolean>; resolve: (value: boolean) => void } {
  let resolve!: (value: boolean) => void;
  return {
    promise: new Promise<boolean>((complete) => { resolve = complete; }),
    resolve,
  };
}

describe("buildSourceLines input, scoping, and grouping", () => {
  it("returns no records for invalid or malformed top-level input", () => {
    assert.deepStrictEqual(buildSourceLines(undefined, undefined), []);
    assert.deepStrictEqual(buildSourceLines({ results: {} }, { results: [] }), []);
    assert.deepStrictEqual(buildSourceLines({ results: [] }, { results: [{}] }), []);
  });

  it("reads the model total cycles from each result's standard metrics list", () => {
    const output = {
      results: [
        outputResult(
          [stack("code_stack/shared", 1, ["op/a"]), op("op/a")],
          [breakdown("code_stack/shared", [metric("total_cycles", 25)])],
          [metric("total_cycles", 100)],
        ),
        outputResult(
          [stack("code_stack/shared", 2, ["op/b"]), op("op/b")],
          [breakdown("code_stack/shared", [metric("total_cycles", 50)])],
          [metric("total_cycles", 200, { qualifiers: { phase: "warm" } })],
        ),
      ],
    };
    const mappings = {
      results: [
        { resultIndex: 0, mappings: [{ entityId: "code_stack/shared" }] },
        { resultIndex: 1, mappings: [{ entityId: "code_stack/shared" }] },
      ],
    };

    const records = buildSourceLines(output, mappings);

    assert.deepStrictEqual(records.map(({ resultIndex, modelMetrics }) => ({
      resultIndex,
      modelMetrics,
    })), [
      {
        resultIndex: 0,
        modelMetrics: [{ name: "total_cycles", value: 100, unit: "cycles", qualifiers: {} }],
      },
      {
        resultIndex: 1,
        modelMetrics: [{
          name: "total_cycles",
          value: 200,
          unit: "cycles",
          qualifiers: { phase: "warm" },
        }],
      },
    ]);
    assertMutationRejected(() => (
      records[1].modelMetrics[0].qualifiers as { phase: string }
    ).phase = "cold");
  });

  it("omits an unavailable or ambiguous result-level total cycle metric", () => {
    const entities = [stack("code_stack/shared", 1, ["op/a"]), op("op/a")];
    const breakdowns = [breakdown("code_stack/shared", [metric("total_cycles", 25)])];
    const output = {
      results: [
        outputResult(entities, breakdowns, [metric("total_cycles", undefined)]),
        outputResult(entities, breakdowns, [
          metric("total_cycles", 100),
          metric("total_cycles", 100),
        ]),
      ],
    };
    const mappings = {
      results: [0, 1].map((resultIndex) => ({
        resultIndex,
        mappings: [{ entityId: "code_stack/shared" }],
      })),
    };

    assert.deepStrictEqual(
      buildSourceLines(output, mappings).map(({ modelMetrics }) => modelMetrics),
      [[], []],
    );
  });

  it("keeps repeated entity IDs scoped while default projection selects only result 0", () => {
    const output = {
      results: [
        outputResult(
          [stack("code_stack/shared", 1, ["op/a"]), op("op/a")],
          [breakdown("code_stack/shared", [metric("total_cycles", 2)])],
        ),
        outputResult(
          [stack("code_stack/shared", 2, ["op/b"]), op("op/b")],
          [breakdown("code_stack/shared", [metric("total_cycles", 20)])],
        ),
      ],
    };
    const mappings = {
      results: [
        { resultIndex: 1, mappings: [{ entityId: "code_stack/shared" }] },
        { resultIndex: 0, mappings: [{ entityId: "code_stack/shared" }] },
      ],
    };

    const records = buildSourceLines(output, mappings);

    assert.deepStrictEqual(records.map(({ resultIndex, line: sourceLine, totalCycles }) => ({
      resultIndex,
      line: sourceLine,
      value: totalCycles.value,
    })), [
      { resultIndex: 0, line: 1, value: 2 },
      { resultIndex: 1, line: 2, value: 20 },
    ]);
    assert.strictEqual(records[0].color.hex, "#7a522d");
    assert.strictEqual(records[1].color.hex, "#757575");
  });

  it("uses every code line while retaining mapped and unmapped stack references", () => {
    const records = build(
      [
        stack("code_stack/b", 7, ["op/b"]),
        stack("code_stack/unmapped", 8, ["op/f"]),
        stack("code_stack/a", 7, ["op/a"]),
        op("op/a"),
        op("op/b"),
        op("op/f"),
      ],
      [],
      ["code_stack/b", "code_stack/a", "source_operator/not-a-stack"],
    );

    assert.deepStrictEqual(records.map(({ line: sourceLine, entities }) => ({
      line: sourceLine,
      entities,
    })), [
      {
        line: 7,
        entities: [
          { resultIndex: 0, entityId: "code_line/0" },
          { resultIndex: 0, entityId: "code_stack/a" },
          { resultIndex: 0, entityId: "code_stack/b" },
        ],
      },
      {
        line: 8,
        entities: [
          { resultIndex: 0, entityId: "code_line/1" },
          { resultIndex: 0, entityId: "code_stack/unmapped" },
        ],
      },
    ]);
  });

  it("is deterministic and does not mutate caller-owned data", () => {
    const entities = [
      stack("code_stack/z", 2, ["op/z"]),
      op("op/z"),
      stack("code_stack/a", 1, ["op/a"]),
      op("op/a"),
    ];
    const breakdowns = [
      breakdown("code_stack/z", [metric("z", 2), metric("a", 1)]),
      breakdown("code_stack/a", [metric("total_cycles", 3)]),
    ];
    const output = { results: [outputResult(entities, breakdowns)] };
    const mappings = {
      results: [{
        resultIndex: 0,
        mappings: [{ entityId: "code_stack/z" }, { entityId: "code_stack/a" }],
      }],
    };
    const before = JSON.stringify({ output, mappings });

    const forward = buildSourceLines(output, mappings);
    const reversed = buildSourceLines(
      { results: [outputResult([...entities].reverse(), [...breakdowns].reverse())] },
      { results: [{ resultIndex: 0, mappings: [...mappings.results[0].mappings].reverse() }] },
    );

    assert.strictEqual(JSON.stringify({ output, mappings }), before);
    assert.deepStrictEqual(reversed, forward);
    assert.deepStrictEqual(forward.map(({ line: sourceLine }) => sourceLine), [1, 2]);
  });

  it("returns deeply frozen raw records without sharing caller-owned metadata", () => {
    const qualifier = { nested: { labels: ["original"] } };
    const records = build(
      [stack("code_stack/a", 1, ["op/a"]), op("op/a")],
      [breakdown("code_stack/a", [metric("total_cycles", 3, { qualifiers: qualifier })])],
      ["code_stack/a"],
    );
    const before = structuredClone(records);

    assertMutationRejected(() => ((records as unknown as SourceLineResultRecord[]).pop()));
    assertMutationRejected(() => ((records[0] as unknown as { line: number }).line = 99));
    assertMutationRejected(() => (
      records[0].totalCycles.metricQualifiers as unknown as { nested: { labels: string[] } }
    ).nested.labels.push("changed"));
    qualifier.nested.labels.push("caller-change");

    assert.deepStrictEqual(records, before);
  });

  it("preserves special JSON qualifier keys without prototype effects or caller mutation", () => {
    const metricQualifiers = JSON.parse(
      '{"__proto__":{"nested":{"labels":["metric"]}},"constructor":"metric-constructor","prototype":"metric-prototype"}',
    ) as Record<string, unknown>;
    const breakdownQualifiers = JSON.parse(
      '{"__proto__":{"nested":{"labels":["breakdown"]}}}',
    ) as Record<string, unknown>;
    const inputBefore = JSON.stringify({ metricQualifiers, breakdownQualifiers });

    const record = line(build(
      [stack("code_stack/a", 1, ["op/a"]), op("op/a")],
      [breakdown(
        "code_stack/a",
        [metric("work", 3, { qualifiers: metricQualifiers })],
        breakdownQualifiers,
      )],
      ["code_stack/a"],
    ));
    const work = aggregate(record, "work");
    const clonedMetric = work.metricQualifiers as Record<string, unknown>;
    const clonedBreakdown = work.breakdownQualifiers as Record<string, unknown>;

    assert.strictEqual(JSON.stringify({ metricQualifiers, breakdownQualifiers }), inputBefore);
    assert.strictEqual(Object.isFrozen(metricQualifiers), false);
    assert.strictEqual(Object.isFrozen(metricQualifiers.__proto__ as object), false);
    assert.strictEqual(Object.isFrozen(breakdownQualifiers), false);
    assert.strictEqual(Object.getPrototypeOf(clonedMetric), Object.prototype);
    assert.strictEqual(Object.getPrototypeOf(clonedBreakdown), Object.prototype);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(clonedMetric, "__proto__"), true);
    assert.strictEqual(Object.prototype.propertyIsEnumerable.call(clonedMetric, "__proto__"), true);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(clonedBreakdown, "__proto__"), true);
    assert.strictEqual(Object.prototype.propertyIsEnumerable.call(clonedBreakdown, "__proto__"), true);
    assert.deepStrictEqual(Object.keys(clonedMetric), ["__proto__", "constructor", "prototype"]);
    assert.strictEqual(clonedMetric.constructor, "metric-constructor");
    assert.strictEqual(clonedMetric.prototype, "metric-prototype");
    assertMutationRejected(() => (
      clonedMetric.__proto__ as { nested: { labels: string[] } }
    ).nested.labels.push("changed"));
    assertMutationRejected(() => (
      clonedBreakdown.__proto__ as { nested: { labels: string[] } }
    ).nested.labels.push("changed"));

    (metricQualifiers.__proto__ as { nested: { labels: string[] } }).nested.labels.push("caller-change");
    (breakdownQualifiers.__proto__ as { nested: { labels: string[] } }).nested.labels.push("caller-change");
    assert.deepStrictEqual(
      (clonedMetric.__proto__ as { nested: { labels: string[] } }).nested.labels,
      ["metric"],
    );
    assert.deepStrictEqual(
      (clonedBreakdown.__proto__ as { nested: { labels: string[] } }).nested.labels,
      ["breakdown"],
    );
  });
});

describe("source overlay presentations", () => {
  it("falls back to a check reason detail when its description is empty", () => {
    const records = buildSourceLines(
      {
        results: [{
          ...outputResult([stack("code_stack/a", 1, ["op/a"]), op("op/a")]),
          checks: [{
            entity_id: "code_stack/a",
            status: "warning",
            details: { reasons: [{ description: "", detail: "Review the fallback detail" }] },
          }],
        }],
      },
      { results: [{ resultIndex: 0, mappings: [{ entityId: "code_stack/a" }] }] },
    );

    assert.deepStrictEqual(records[0].overlayPresentations.find(
      ({ category }) => category === "checks",
    ), {
      category: "checks",
      value: "Review the fallback detail",
      tooltip: "MLIA checks for this source line: Review the fallback detail",
      color: {
        hex: "#f9a825",
        opacity: 0.18,
        rgba: "rgba(249, 168, 37, 0.18)",
        basis: "checks",
      },
    });
  });
});

describe("source-line caller and called relationships", () => {
  it("normalizes parent-only, child-only, and redundant links", () => {
    const records = build(
      [
        stack("code_stack/a", 1, []),
        stack("code_stack/b", 2, [], { parents: ["code_stack/a"] }),
        stack("code_stack/c", 3, ["code_stack/d"]),
        stack("code_stack/d", 4, []),
        stack("code_stack/e", 5, ["code_stack/f", "code_stack/f"]),
        stack("code_stack/f", 6, [], { parents: ["code_stack/e", "code_stack/e"] }),
      ],
      [],
      ["code_stack/a", "code_stack/b", "code_stack/c", "code_stack/d", "code_stack/e", "code_stack/f"],
    );

    assert.deepStrictEqual(line(records, 1).called, [{ resultIndex: 0, entityId: "code_stack/b" }]);
    assert.deepStrictEqual(line(records, 2).callers, [{ resultIndex: 0, entityId: "code_stack/a" }]);
    assert.deepStrictEqual(line(records, 3).called, [{ resultIndex: 0, entityId: "code_stack/d" }]);
    assert.deepStrictEqual(line(records, 6).callers, [{ resultIndex: 0, entityId: "code_stack/e" }]);
  });

  it("collapses through unmapped stacks to the nearest mapped relatives", () => {
    const records = build(
      [
        stack("code_stack/caller", 1, ["code_stack/hidden"]),
        stack("code_stack/hidden", 20, ["code_stack/called"], { parents: ["code_stack/caller"] }),
        stack("code_stack/called", 2, [], { parents: ["code_stack/hidden"] }),
      ],
      [],
      ["code_stack/caller", "code_stack/called"],
    );

    assert.deepStrictEqual(line(records, 1).called, [{ resultIndex: 0, entityId: "code_stack/called" }]);
    assert.deepStrictEqual(line(records, 2).callers, [{ resultIndex: 0, entityId: "code_stack/caller" }]);
  });

  it("retains visible same-source-line relationships in raw records", () => {
    const records = build(
      [
        stack("code_stack/a", 4, ["code_stack/b"]),
        stack("code_stack/b", 4, [], { parents: ["code_stack/a"] }),
      ],
      [],
      ["code_stack/a", "code_stack/b"],
    );

    assert.deepStrictEqual(records[0].callers, [{ resultIndex: 0, entityId: "code_stack/a" }]);
    assert.deepStrictEqual(records[0].called, [{ resultIndex: 0, entityId: "code_stack/b" }]);
  });
});

describe("source-line metrics from standardized code_line entities", () => {
  it("uses every code line independently of Model Explorer stack mappings", () => {
    const record = line(build(
      [stack("code_stack/a", 1, ["op/a"]), op("op/a")],
      [breakdown("code_stack/a", [metric("total_cycles", 7)])],
      [],
    ));

    assert.strictEqual(record.totalCycles.value, 7);
    assert.strictEqual(record.totalCycles.status, "complete");
    assert.deepStrictEqual(record.entities, [
      { resultIndex: 0, entityId: "code_line/0" },
      { resultIndex: 0, entityId: "code_stack/a" },
    ]);
    assert.deepStrictEqual(record.totalCycles.contributors, [
      { resultIndex: 0, entityId: "code_line/0" },
    ]);
  });

  it("reads final non-additive metrics without reinterpreting them", () => {
    const records = buildSourceLines(
      { results: [outputResult([
        entity("code_line/final", "code_line", { file: "/build/model.py", line: 1 }),
      ], [breakdown("code_line/final", [
        metric("maximum", 9, { aggregation: "max", samples: 3 }),
      ])])] },
      { results: [] },
    );

    assert.deepStrictEqual(records[0].metrics[0], {
      name: "maximum",
      unit: "cycles",
      breakdownQualifiers: {},
      metricQualifiers: {},
      aggregation: "max",
      samples: 3,
      value: 9,
      status: "complete",
      contributors: [{ resultIndex: 0, entityId: "code_line/final" }],
      missingEntityReferences: [],
      ambiguousEntityReferences: [],
      coveredLeafIds: [],
      uncoveredLeafIds: [],
      reasons: [],
    });
  });

  it("retains unavailable final line metrics", () => {
    const records = buildSourceLines(
      { results: [outputResult([
        entity("code_line/final", "code_line", { file: "/build/model.py", line: 1 }),
      ], [breakdown("code_line/final", [metric("total_cycles", undefined)])])] },
      { results: [] },
    );

    assert.strictEqual(records[0].totalCycles.status, "unavailable");
    assert.deepStrictEqual(reasonCodes(records[0].totalCycles), ["missing_metric"]);
  });
});

describe("metric identity, availability, and metadata", () => {
  it("includes unit, breakdown qualifiers, and metric qualifiers in identity", () => {
    const record = line(build(
      [stack("code_stack/a", 1, ["op/a"]), op("op/a")],
      [
        breakdown("code_stack/a", [
          metric("work", 2, { unit: "cycles", qualifiers: { engine: "npu" } }),
          metric("work", 3, { unit: "bytes", qualifiers: { engine: "npu" } }),
        ], { scenario: "warm" }),
        breakdown("code_stack/a", [
          metric("work", 4, { unit: "cycles", qualifiers: { engine: "cpu" } }),
        ], { scenario: "cold" }),
      ],
      ["code_stack/a"],
    ));

    assert.strictEqual(record.metrics.length, 3);
    assert.deepStrictEqual(record.metrics.map((item) => ({
      value: item.value,
      unit: item.unit,
      breakdown: item.breakdownQualifiers,
      metric: item.metricQualifiers,
    })), [
      { value: 3, unit: "bytes", breakdown: { scenario: "warm" }, metric: { engine: "npu" } },
      { value: 4, unit: "cycles", breakdown: { scenario: "cold" }, metric: { engine: "cpu" } },
      { value: 2, unit: "cycles", breakdown: { scenario: "warm" }, metric: { engine: "npu" } },
    ]);
  });

  it("distinguishes empty qualifiers from qualifiers with an own __proto__ key", () => {
    const protoQualifiers = JSON.parse(
      '{"__proto__":{"variant":"special"}}',
    ) as Record<string, unknown>;
    const record = line(build(
      [stack("code_stack/a", 1, ["op/a"]), op("op/a")],
      [breakdown("code_stack/a", [
        metric("work", 1),
        metric("work", 2, { qualifiers: protoQualifiers }),
      ])],
      ["code_stack/a"],
    ));

    assert.strictEqual(record.metrics.length, 2);
    assert.deepStrictEqual(record.metrics.map(({ value }) => value).sort(), [1, 2]);
    const qualified = record.metrics.find(({ value }) => value === 2);
    assert.ok(qualified);
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(qualified.metricQualifiers, "__proto__"),
      true,
    );
    assert.deepStrictEqual(qualified.metricQualifiers.__proto__, { variant: "special" });
  });

  it("does not choose among multiple total_cycles identities", () => {
    const record = line(build(
      [stack("code_stack/a", 1, ["op/a"]), op("op/a")],
      [
        breakdown("code_stack/a", [metric("total_cycles", 2)], { run: "cold" }),
        breakdown("code_stack/a", [metric("total_cycles", 3)], { run: "warm" }),
      ],
      ["code_stack/a"],
    ));

    assert.strictEqual(record.totalCycles.status, "unavailable");
    assert.deepStrictEqual(reasonCodes(record.totalCycles), ["conflicting_metric_identity"]);
  });
});

describe("source-line heatmap colors", () => {
  it("uses Model Explorer floor interpolation for minimum, midpoint, and maximum", () => {
    const records = build(
      [
        stack("code_stack/min", 1, ["op/min"]), op("op/min"),
        stack("code_stack/mid", 2, ["op/mid"]), op("op/mid"),
        stack("code_stack/max", 3, ["op/max"]), op("op/max"),
      ],
      [
        breakdown("code_stack/min", [metric("total_cycles", 0)]),
        breakdown("code_stack/mid", [metric("total_cycles", 5)]),
        breakdown("code_stack/max", [metric("total_cycles", 10)]),
      ],
      ["code_stack/min", "code_stack/mid", "code_stack/max"],
    );

    assert.deepStrictEqual(records.map(({ color }) => ({ hex: color.hex, opacity: color.opacity })), [
      { hex: "#2e7d32", opacity: 0.28 },
      { hex: "#7a522d", opacity: 0.28 },
      { hex: "#c62828", opacity: 0.28 },
    ]);
  });

  it("normalizes opposite-sign finite extremes without producing non-finite colors", () => {
    const records = build(
      [
        stack("code_stack/min", 1, ["op/min"]), op("op/min"),
        stack("code_stack/mid", 2, ["op/mid"]), op("op/mid"),
        stack("code_stack/max", 3, ["op/max"]), op("op/max"),
      ],
      [
        breakdown("code_stack/min", [metric("total_cycles", -Number.MAX_VALUE)]),
        breakdown("code_stack/mid", [metric("total_cycles", 0)]),
        breakdown("code_stack/max", [metric("total_cycles", Number.MAX_VALUE)]),
      ],
      ["code_stack/min", "code_stack/mid", "code_stack/max"],
    );

    assert.deepStrictEqual(records.map(({ color }) => ({ hex: color.hex, rgba: color.rgba })), [
      { hex: "#2e7d32", rgba: "rgba(46, 125, 50, 0.28)" },
      { hex: "#7a522d", rgba: "rgba(122, 82, 45, 0.28)" },
      { hex: "#c62828", rgba: "rgba(198, 40, 40, 0.28)" },
    ]);
  });

  it("uses the gradient midpoint when min equals max", () => {
    const record = line(build(
      [stack("code_stack/a", 1, ["op/a"]), op("op/a")],
      [breakdown("code_stack/a", [metric("total_cycles", 4)])],
      ["code_stack/a"],
    ));

    assert.deepStrictEqual(record.color, {
      hex: "#7a522d",
      opacity: 0.28,
      rgba: "rgba(122, 82, 45, 0.28)",
      basis: "total_cycles",
    });
  });

  it("uses a neutral fallback without a total", () => {
    const absent = line(build(
      [stack("code_stack/a", 1, ["op/a"]), op("op/a")],
      [],
      ["code_stack/a"],
    ));

    assert.deepStrictEqual(absent.totalCycles.uncoveredLeafIds, ["op/a"]);
    assert.deepStrictEqual(absent.color, {
      hex: "#757575",
      opacity: 0.08,
      rgba: "rgba(117, 117, 117, 0.08)",
      basis: "unavailable",
    });
  });
});

describe("SourceAnnotationIndex source-line indexing", () => {
  it("remaps raw records through the same projection used by diagnostics", async () => {
    const index = new SourceAnnotationIndex({
      uriForFile: (file) => `file://${file.replace(/\\/gu, "/")}`,
    });
    const output = {
      results: [outputResult(
        [stack("code_stack/a", 3, ["op/a"]), op("op/a")],
        [breakdown("code_stack/a", [metric("total_cycles", 7)])],
      )],
    };
    const mappings = {
      results: [{ resultIndex: 0, mappings: [{ entityId: "code_stack/a" }] }],
    };
    index.updateSourceFileMap({ "/build": "C:/old" });
    index.setAnalysis({}, output, mappings);
    const oldRecord = index.sourceLineRecordsForUri("file://C:/old/model.py")[0];

    index.updateSourceFileMap({ "/build": "D:/new" });
    await flushAsync();
    const newRecord = index.sourceLineRecordsForUri("file://D:/new/model.py")[0];
    const diagnosticLocation = index.sourceMappingDiagnostics[0].locations[0];
    const unindexedLocation = index.mappedSourceLocation("/build/not-indexed.py", 99);

    assert.deepStrictEqual(index.sourceLineRecordsForUri("file://C:/old/model.py"), []);
    assert.strictEqual(
      unindexedLocation.localFile.replace(/\\/gu, "/"),
      "D:/new/not-indexed.py",
    );
    assert.strictEqual(newRecord.totalCycles, oldRecord.totalCycles);
    assert.strictEqual(newRecord.file, "/build/model.py");
    assert.strictEqual(newRecord.localFile.replace(/\\/gu, "/"), "D:/new/model.py");
    assert.strictEqual(newRecord.mappedLocation, diagnosticLocation.mappedLocation);
    assert.strictEqual(newRecord.localFile, diagnosticLocation.localFile);
    assert.strictEqual(newRecord.uri, diagnosticLocation.uri);
    assert.strictEqual(newRecord.line, diagnosticLocation.line);
    assert.strictEqual(
      index.sourceLineRecordForEntity({ resultIndex: 0, entityId: "code_stack/a" }),
      newRecord,
    );
  });

  it("does not expose caller-mutable index arrays", () => {
    const index = new SourceAnnotationIndex({
      uriForFile: (file) => `file://${file.replace(/\\/gu, "/")}`,
    });
    index.setAnalysis(
      {},
      { results: [outputResult(
        [stack("code_stack/a", 3, ["op/a"]), op("op/a")],
        [breakdown("code_stack/a", [metric("total_cycles", 7)])],
      )] },
      { results: [{ resultIndex: 0, mappings: [{ entityId: "code_stack/a" }] }] },
    );

    const uri = "file:///build/model.py";
    const records = index.sourceLineRecordsForUri(uri) as unknown as SourceLineResultRecord[];
    records.splice(0, records.length);

    assert.strictEqual(index.sourceLineRecordsForUri(uri).length, 1);
  });

  it("retains and deeply freezes __proto__ qualifier values in mapped records", () => {
    const metricQualifiers = JSON.parse(
      '{"__proto__":{"labels":["metric"]}}',
    ) as Record<string, unknown>;
    const breakdownQualifiers = JSON.parse(
      '{"__proto__":{"labels":["breakdown"]}}',
    ) as Record<string, unknown>;
    const index = new SourceAnnotationIndex({
      uriForFile: (file) => `file://${file.replace(/\\/gu, "/")}`,
    });
    index.setAnalysis(
      {},
      { results: [outputResult(
        [stack("code_stack/a", 3, ["op/a"]), op("op/a")],
        [breakdown(
          "code_stack/a",
          [metric("work", 7, { qualifiers: metricQualifiers })],
          breakdownQualifiers,
        )],
      )] },
      { results: [{ resultIndex: 0, mappings: [{ entityId: "code_stack/a" }] }] },
    );

    const record = index.sourceLineRecordsForUri("file:///build/model.py")[0];
    const work = aggregate(record, "work");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(work.metricQualifiers, "__proto__"), true);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(work.breakdownQualifiers, "__proto__"), true);
    assertMutationRejected(() => (
      work.metricQualifiers.__proto__ as { labels: string[] }
    ).labels.push("changed"));
    assertMutationRejected(() => (
      work.breakdownQualifiers.__proto__ as { labels: string[] }
    ).labels.push("changed"));
    assert.strictEqual(Object.isFrozen(metricQualifiers), false);
    assert.strictEqual(Object.isFrozen(metricQualifiers.__proto__ as object), false);
    assert.strictEqual(Object.isFrozen(breakdownQualifiers), false);
  });

  it("deeply protects mapped source-line records from runtime mutation", () => {
    const index = new SourceAnnotationIndex({
      uriForFile: (file) => `file://${file.replace(/\\/gu, "/")}`,
    });
    index.setAnalysis(
      {},
      { results: [outputResult(
        [
          stack("code_stack/root", 3, ["code_stack/child", "op/b"]),
          stack("code_stack/child", 3, ["op/a"]),
          op("op/a"),
          op("op/b"),
        ],
        [breakdown("code_stack/child", [
          metric("total_cycles", 3, {
            qualifiers: { detail: { labels: ["original"] } },
          }),
        ], { context: { phases: ["warm"] } })],
      )] },
      {
        results: [{
          resultIndex: 0,
          mappings: [{ entityId: "code_stack/root" }, { entityId: "code_stack/child" }],
        }],
      },
    );

    const uri = "file:///build/model.py";
    const record = index.sourceLineRecordsForUri(uri)[0];
    const recordsBefore = structuredClone(index.sourceLineRecordsForUri(uri));

    const mutations: (() => void)[] = [
      () => ((record as unknown as { line: number }).line = 99),
      () => ((record as unknown as { localFile: string }).localFile = "changed.py"),
      () => ((record.totalCycles as unknown as { value: number }).value = 99),
      () => ((record.entities as unknown as { resultIndex: number; entityId: string }[]).push({
        resultIndex: record.entities[0].resultIndex,
        entityId: record.entities[0].entityId,
      })),
      () => ((record.entities[0] as unknown as { entityId: string }).entityId = "changed"),
      () => ((record.metrics as unknown as SourceLineMetricAggregate[]).push(record.totalCycles)),
      () => ((record.metrics[0] as unknown as { status: string }).status = "unavailable"),
      () => ((record.totalCycles.contributors[0] as unknown as { entityId: string }).entityId = "changed"),
      () => ((record.totalCycles.missingEntityReferences[0] as unknown as { entityId: string }).entityId = "changed"),
      () => ((record.totalCycles.ambiguousEntityReferences as unknown as object[]).push({})),
      () => ((record.totalCycles.coveredLeafIds as unknown as string[]).push("changed")),
      () => ((record.totalCycles.uncoveredLeafIds as unknown as string[]).push("changed")),
      () => ((record.totalCycles.reasons[0] as unknown as { code: string }).code = "unresolved_hierarchy"),
      () => ((record.totalCycles.reasons[0].entityReferences[0] as unknown as { entityId: string }).entityId = "changed"),
      () => ((record.totalCycles.reasons[0].leafIds as unknown as string[]).push("changed")),
      () => ((record.callers[0] as unknown as { entityId: string }).entityId = "changed"),
      () => ((record.called[0] as unknown as { entityId: string }).entityId = "changed"),
      () => ((record.color as unknown as { hex: string }).hex = "#000000"),
      () => ((record.totalCycles.breakdownQualifiers as unknown as {
        context: { phases: string[] };
      }).context.phases.push("cold")),
      () => ((record.totalCycles.metricQualifiers as unknown as {
        detail: { labels: string[] };
      }).detail.labels.push("changed")),
    ];
    for (const mutation of mutations) {
      assertMutationRejected(mutation);
    }

    assert.strictEqual(index.sourceLineRecordsForUri(uri)[0], record);
    assert.deepStrictEqual(index.sourceLineRecordsForUri(uri), recordsBefore);
  });
  it("reports entity counts and deduplicated accessible and missing source locations", async () => {
    const index = new SourceAnnotationIndex({
      uriForFile: (file) => `file://${file.replace(/\\/gu, "/")}`,
      isFileAccessible: async (file) => !file.endsWith("missing.py"),
    });
    index.updateSourceFileMap({ "/build": "C:/src", "/other": "C:/src" });
    index.setAnalysis(
      {},
      { results: [outputResult([
        stack("code_stack/a", 3, [], { file: "/build/a.py" }),
        stack("code_stack/b", 3, [], { file: "/other/a.py" }),
        stack("code_stack/c", 9, [], { file: "/build/missing.py" }),
        stack("code_stack/d", 9, [], { file: "/other/missing.py" }),
        entity("code_stack/no-source", "code_stack"),
        stack("code_stack/unmapped", 12, [], { file: "/build/unmapped.py" }),
      ])] },
      { results: [{
        resultIndex: 0,
        mappings: [
          { entityId: "code_stack/a" },
          { entityId: "code_stack/b" },
          { entityId: "code_stack/c" },
          { entityId: "code_stack/d" },
          { entityId: "code_stack/no-source" },
          { entityId: "code_stack/a" },
        ],
      }] },
    );

    await flushAsync();

    const diagnostics = index.sourceMappingDiagnostics[0];
    assert.deepStrictEqual({
      reported: diagnostics.reportedCodeStacks,
      mapped: diagnostics.mappedCodeStacks,
      withSource: diagnostics.sourceLocatedCodeStacks,
      distinctLocations: diagnostics.distinctSourceLocations,
      accessibleLocations: diagnostics.accessibleSourceLocations,
      pending: diagnostics.accessibilityPending,
      sourceFiles: diagnostics.sourceFiles,
      locations: diagnostics.locations.map(({ localFile, line }) => ({
        localFile: localFile.replace(/\\/gu, "/"),
        line,
      })),
    }, {
      reported: 6,
      mapped: 5,
      withSource: 4,
      distinctLocations: 2,
      accessibleLocations: 1,
      pending: false,
      sourceFiles: ["/build/a.py", "/build/missing.py"],
      locations: [{ localFile: "C:/src/a.py", line: 3 }],
    });
    assert.strictEqual(
      index.sourceLocationForId(diagnostics.locations[0].id),
      diagnostics.locations[0],
    );
    assertMutationRejected(() => (
      diagnostics.locations as unknown as object[]
    ).push({}));
    assertMutationRejected(() => (
      diagnostics.locations[0] as unknown as { line: number }
    ).line = 99);
  });

  it("keeps reported and mapped counts scoped to each standardized result", async () => {
    const index = new SourceAnnotationIndex({
      uriForFile: (file) => file,
      isFileAccessible: async () => true,
    });
    index.setAnalysis(
      {},
      { results: [
        outputResult([stack("code_stack/result-zero", 3, [])]),
        outputResult([stack("code_stack/result-one", 7, [])]),
      ] },
      { results: [{
        resultIndex: 1,
        mappings: [{ entityId: "code_stack/result-one" }],
      }] },
    );

    await flushAsync();

    assert.deepStrictEqual(index.sourceMappingDiagnostics.map((diagnostics) => ({
      resultIndex: diagnostics.resultIndex,
      reported: diagnostics.reportedCodeStacks,
      mapped: diagnostics.mappedCodeStacks,
      withSource: diagnostics.sourceLocatedCodeStacks,
      distinctLocations: diagnostics.distinctSourceLocations,
      accessibleLocations: diagnostics.accessibleSourceLocations,
    })), [
      {
        resultIndex: 0,
        reported: 1,
        mapped: 0,
        withSource: 0,
        distinctLocations: 0,
        accessibleLocations: 0,
      },
      {
        resultIndex: 1,
        reported: 1,
        mapped: 1,
        withSource: 1,
        distinctLocations: 1,
        accessibleLocations: 1,
      },
    ]);
  });

  it("keeps mapped locations stable when the source file map is unchanged", async () => {
    let accessibilityChecks = 0;
    const index = new SourceAnnotationIndex({
      uriForFile: (file) => file,
      isFileAccessible: async () => {
        accessibilityChecks += 1;
        return true;
      },
    });
    const sourceFileMap = { "/build": "C:/src" };
    index.updateSourceFileMap(sourceFileMap);
    index.setAnalysis(
      {},
      { results: [outputResult([stack("code_stack/a", 3, [])])] },
      { results: [{ resultIndex: 0, mappings: [{ entityId: "code_stack/a" }] }] },
    );
    await flushAsync();
    const firstLocation = index.mappedSourceLocation("/build/model.py", 3);
    const firstLocationId = index.sourceMappingDiagnostics[0].locations[0].id;

    index.updateSourceFileMap({ ...sourceFileMap });
    await flushAsync();

    assert.strictEqual(index.mappedSourceLocation("/build/model.py", 3), firstLocation);
    assert.strictEqual(index.sourceMappingDiagnostics[0].locations[0].id, firstLocationId);
    assert.strictEqual(accessibilityChecks, 1);
    index.dispose();
  });

  it("revalidates after remapping and ignores stale validation completions", async () => {
    const pending = new Map<string, ReturnType<typeof deferredBoolean>>();
    const index = new SourceAnnotationIndex({
      uriForFile: (file) => file,
      isFileAccessible: (file) => {
        const deferred = deferredBoolean();
        pending.set(file.replace(/\\/gu, "/"), deferred);
        return deferred.promise;
      },
    });
    index.updateSourceFileMap({ "/build": "C:/old" });
    const owner = {};
    index.setAnalysis(
      owner,
      { results: [outputResult([stack("code_stack/a", 3, [])])] },
      { results: [{ resultIndex: 0, mappings: [{ entityId: "code_stack/a" }] }] },
    );
    index.updateSourceFileMap({ "/build": "D:/new" });

    pending.get("D:/new/model.py")?.resolve(true);
    await flushAsync();
    assert.strictEqual(index.sourceMappingDiagnostics[0].accessibleSourceLocations, 1);
    assert.strictEqual(
      index.sourceMappingDiagnostics[0].locations[0].localFile.replace(/\\/gu, "/"),
      "D:/new/model.py",
    );

    pending.get("C:/old/model.py")?.resolve(false);
    await flushAsync();
    assert.strictEqual(index.sourceMappingDiagnostics[0].accessibleSourceLocations, 1);
    assert.strictEqual(
      index.sourceMappingDiagnostics[0].locations[0].localFile.replace(/\\/gu, "/"),
      "D:/new/model.py",
    );

    index.setAnalysis(
      {},
      { results: [outputResult([
        stack("code_stack/stale-analysis", 5, [], { file: "/build/stale.py" }),
      ])] },
      { results: [{ resultIndex: 0, mappings: [{ entityId: "code_stack/stale-analysis" }] }] },
    );
    index.setAnalysis(
      {},
      { results: [outputResult([
        stack("code_stack/current-analysis", 8, [], { file: "/build/current.py" }),
      ])] },
      { results: [{ resultIndex: 0, mappings: [{ entityId: "code_stack/current-analysis" }] }] },
    );
    pending.get("D:/new/current.py")?.resolve(true);
    await flushAsync();
    pending.get("D:/new/stale.py")?.resolve(false);
    await flushAsync();
    assert.strictEqual(index.sourceMappingDiagnostics[0].accessibleSourceLocations, 1);
    assert.strictEqual(
      index.sourceMappingDiagnostics[0].locations[0].localFile.replace(/\\/gu, "/"),
      "D:/new/current.py",
    );

    index.updateSourceFileMap({ "/build": "E:/disposed" });
    const stale = pending.get("E:/disposed/current.py");
    index.dispose();
    stale?.resolve(true);
    await flushAsync();
    assert.deepStrictEqual(index.sourceMappingDiagnostics, []);
  });
});


describe("source metric projection", () => {
  function metricOverlay(
    name: string,
    unit = "cycles",
    options: {
      resultIndex?: number;
      resultKind?: string;
      breakdownQualifiers?: OverlayKey["breakdownQualifiers"];
      metricQualifiers?: OverlayKey["metricQualifiers"];
    } = {},
  ): OverlayKey {
    return {
      resultIndex: options.resultIndex ?? 0,
      resultKind: options.resultKind ?? "result",
      category: "metric",
      name,
      unit,
      breakdownQualifiers: options.breakdownQualifiers ?? {},
      metricQualifiers: options.metricQualifiers ?? {},
    };
  }

  function metricSelectionFixture(): readonly SourceLineResultRecord[] {
    return build(
      [
        stack("code_stack/low", 1, ["op/low"]),
        op("op/low"),
        stack("code_stack/high", 2, ["op/high"]),
        op("op/high"),
      ],
      [
        breakdown("code_stack/low", [
          metric("total_cycles", 10),
          metric("dram_read_bytes", 100, { unit: "bytes" }),
        ]),
        breakdown("code_stack/high", [
          metric("total_cycles", 20),
          metric("dram_read_bytes", 900, { unit: "bytes" }),
        ]),
      ],
      ["code_stack/low", "code_stack/high"],
    );
  }

  it("uses the canonical result-0 total_cycles overlay as the initial projection", () => {
    const records = metricSelectionFixture();

    assert.deepStrictEqual(records.map(({ selectedMetric, color }) => ({
      name: selectedMetric.name,
      value: selectedMetric.value,
      basis: color.basis,
    })), [
      { name: "total_cycles", value: 10, basis: "total_cycles" },
      { name: "total_cycles", value: 20, basis: "total_cycles" },
    ]);
  });

  it("reprojects selected values and heatmap colors without reparsing standardized output", () => {
    const records = metricSelectionFixture();
    const selected = metricOverlay("dram_read_bytes", "bytes");

    const projected = projectSourceMetric(records, selected);

    assert.deepStrictEqual(projected.map(({ selectedMetric }) => ({
      name: selectedMetric.name,
      value: selectedMetric.value,
      unit: selectedMetric.unit,
    })), [
      { name: "dram_read_bytes", value: 100, unit: "bytes" },
      { name: "dram_read_bytes", value: 900, unit: "bytes" },
    ]);
    assert.deepStrictEqual(projected.map(({ color }) => ({ hex: color.hex, basis: color.basis })), [
      { hex: "#2e7d32", basis: overlayKeyId(selected) },
      { hex: "#c62828", basis: overlayKeyId(selected) },
    ]);
    assert.strictEqual(records[0].selectedMetric.name, "total_cycles");
  });

  it("refuses to project an otherwise matching metric with the wrong result kind", () => {
    const records = metricSelectionFixture();
    const selected = metricOverlay("dram_read_bytes", "bytes", { resultKind: "compatibility" });

    const projected = projectSourceMetric(records, selected);

    assert.deepStrictEqual(projected.map(({ selectedOverlay, selectedMetric, color }) => ({
      selectedOverlayId: overlayKeyId(selectedOverlay as OverlayKey),
      name: selectedMetric.name,
      unit: selectedMetric.unit,
      status: selectedMetric.status,
      value: selectedMetric.value,
      basis: color.basis,
    })), [1, 2].map(() => ({
      selectedOverlayId: overlayKeyId(selected),
      name: "dram_read_bytes",
      unit: "bytes",
      status: "unavailable",
      value: undefined,
      basis: "unavailable",
    })));
  });

  it("keeps unavailable catalog metrics selectable without projecting them as source values", () => {
    const records = build(
      [
        stack("code_stack/low", 1, ["op/low"]),
        op("op/low"),
        stack("code_stack/high", 2, ["op/high"]),
        op("op/high"),
      ],
      [
        breakdown("code_stack/low", [
          metric("total_cycles", 10),
          metric("unavailable_only", undefined, { unit: "items" }),
        ]),
        breakdown("code_stack/high", [
          metric("total_cycles", 20),
          metric("partially_available", 900, { unit: "items" }),
          metric("unavailable_only", undefined, { unit: "items" }),
        ]),
      ],
      ["code_stack/low", "code_stack/high"],
    );
    const index = new SourceAnnotationIndex({
      uriForFile: () => "source-uri",
      buildSourceLines: () => records,
    });
    const cycles = metricOverlay("total_cycles");
    index.setAnalysis({}, {}, {}, { kind: "overlay", overlay: cycles });

    const unavailable = metricOverlay("unavailable_only", "items");
    assert.strictEqual(index.selectOverlay(unavailable), true);
    assert.strictEqual(overlayKeyId(index.selectedOverlayKey as OverlayKey), overlayKeyId(unavailable));
    assert.deepStrictEqual(
      index.sourceLineRecordsForUri("source-uri").map(({ selectedOverlay, selectedMetric, color }) => ({
        selectedOverlayId: overlayKeyId(selectedOverlay as OverlayKey),
        name: selectedMetric.name,
        unit: selectedMetric.unit,
        status: selectedMetric.status,
        value: selectedMetric.value,
        basis: color.basis,
      })),
      [1, 2].map(() => ({
        selectedOverlayId: overlayKeyId(unavailable),
        name: "unavailable_only",
        unit: "items",
        status: "unavailable",
        value: undefined,
        basis: "unavailable",
      })),
    );

    const partial = metricOverlay("partially_available", "items");
    assert.strictEqual(index.selectOverlay(partial), true);
    assert.deepStrictEqual(
      index.sourceLineRecordsForUri("source-uri").map(({ line: sourceLine, selectedMetric, color }) => ({
        line: sourceLine,
        status: selectedMetric.status,
        value: selectedMetric.value,
        color: color.hex,
        basis: color.basis,
      })),
      [
        {
          line: 1,
          status: "unavailable",
          value: undefined,
          color: "#757575",
          basis: "unavailable",
        },
        {
          line: 2,
          status: "complete",
          value: 900,
          color: "#7a522d",
          basis: overlayKeyId(partial),
        },
      ],
    );
  });

  it("leaves projection unselected and neutral when total_cycles is missing", () => {
    const records = build(
      [
        stack("code_stack/low", 1, ["op/low"]),
        op("op/low"),
        stack("code_stack/high", 2, ["op/high"]),
        op("op/high"),
      ],
      [
        breakdown("code_stack/low", [metric("dram_read_bytes", 100, { unit: "bytes" })]),
        breakdown("code_stack/high", [metric("dram_read_bytes", 900, { unit: "bytes" })]),
      ],
      ["code_stack/low", "code_stack/high"],
    );

    assert.deepStrictEqual(records.map(({ selectedMetric, color }) => ({
      name: selectedMetric.name,
      status: selectedMetric.status,
      value: selectedMetric.value,
      color: color.hex,
      basis: color.basis,
    })), [
      { name: "total_cycles", status: "unavailable", value: undefined, color: "#757575", basis: "unavailable" },
      { name: "total_cycles", status: "unavailable", value: undefined, color: "#757575", basis: "unavailable" },
    ]);

    const index = new SourceAnnotationIndex({
      uriForFile: () => "source-uri",
      buildSourceLines: () => records,
    });
    index.setAnalysis({}, {}, {});
    assert.strictEqual(index.selectedOverlayKey, undefined);

    const dram = metricOverlay("dram_read_bytes", "bytes");
    assert.strictEqual(index.selectOverlay(dram), true);
    assert.deepStrictEqual(
      index.sourceLineRecordsForUri("source-uri").map(({ selectedMetric, color }) => ({
        name: selectedMetric.name,
        value: selectedMetric.value,
        color: color.hex,
        basis: color.basis,
      })),
      [
        { name: "dram_read_bytes", value: 100, color: "#2e7d32", basis: overlayKeyId(dram) },
        { name: "dram_read_bytes", value: 900, color: "#c62828", basis: overlayKeyId(dram) },
      ],
    );
  });

  it("leaves projection neutral when canonical total_cycles overlays are ambiguous", () => {
    const records = build(
      [
        stack("code_stack/low", 1, ["op/low"]),
        op("op/low"),
        stack("code_stack/high", 2, ["op/high"]),
        op("op/high"),
      ],
      [
        breakdown("code_stack/low", [
          metric("total_cycles", 10),
          metric("total_cycles", 100, { unit: "ticks" }),
        ]),
        breakdown("code_stack/high", [
          metric("total_cycles", 20),
          metric("total_cycles", 200, { unit: "ticks" }),
        ]),
      ],
      ["code_stack/low", "code_stack/high"],
    );

    assert.deepStrictEqual(records.map(({ selectedMetric, color }) => ({
      status: selectedMetric.status,
      reasons: reasonCodes(selectedMetric),
      color: color.hex,
      basis: color.basis,
    })), [
      {
        status: "unavailable",
        reasons: ["conflicting_metric_identity"],
        color: "#757575",
        basis: "unavailable",
      },
      {
        status: "unavailable",
        reasons: ["conflicting_metric_identity"],
        color: "#757575",
        basis: "unavailable",
      },
    ]);

    const cycles = metricOverlay("total_cycles");
    const explicitlyProjected = projectSourceMetric(records, cycles);
    assert.deepStrictEqual(explicitlyProjected.map(({ selectedMetric, color }) => ({
      unit: selectedMetric.unit,
      value: selectedMetric.value,
      color: color.hex,
      basis: color.basis,
    })), [
      { unit: "cycles", value: 10, color: "#2e7d32", basis: "total_cycles" },
      { unit: "cycles", value: 20, color: "#c62828", basis: "total_cycles" },
    ]);
  });

  it("does not treat a qualified total_cycles overlay as the canonical default", () => {
    const records = build(
      [stack("code_stack/a", 1, ["op/a"]), op("op/a")],
      [breakdown("code_stack/a", [metric("total_cycles", 10)], { phase: "warm" })],
      ["code_stack/a"],
    );

    assert.strictEqual(records[0].selectedMetric.status, "unavailable");
    assert.strictEqual(records[0].color.basis, "unavailable");

    const index = new SourceAnnotationIndex({
      uriForFile: () => "source-uri",
      buildSourceLines: () => records,
    });
    index.setAnalysis({}, {}, {});
    assert.strictEqual(index.selectedOverlayKey, undefined);
  });

  it("scopes a metric overlay to its result index", () => {
    const records = buildSourceLines(
      {
        results: [
          outputResult(
            [stack("code_stack/result-zero", 1, ["op/zero"]), op("op/zero")],
            [breakdown("code_stack/result-zero", [metric("total_cycles", 10)])],
          ),
          outputResult(
            [stack("code_stack/result-one", 2, ["op/one"]), op("op/one")],
            [breakdown("code_stack/result-one", [metric("result_one_only", 900, { unit: "items" })])],
          ),
        ],
      },
      {
        results: [
          { resultIndex: 0, mappings: [{ entityId: "code_stack/result-zero" }] },
          { resultIndex: 1, mappings: [{ entityId: "code_stack/result-one" }] },
        ],
      },
    );
    const selected = metricOverlay("result_one_only", "items", { resultIndex: 1 });

    const projected = projectSourceMetric(records, selected);

    assert.deepStrictEqual(projected.map(({ resultIndex, selectedMetric, color }) => ({
      resultIndex,
      name: selectedMetric.name,
      value: selectedMetric.value,
      basis: color.basis,
    })), [
      { resultIndex: 0, name: "result_one_only", value: undefined, basis: "unavailable" },
      { resultIndex: 1, name: "result_one_only", value: 900, basis: overlayKeyId(selected) },
    ]);
  });

  it("does not project non-metric or later-result overlays onto the result-0 source UI", () => {
    const records = metricSelectionFixture();
    const index = new SourceAnnotationIndex({
      uriForFile: () => "source-uri",
      buildSourceLines: () => records,
    });
    const cycles = metricOverlay("total_cycles");
    index.setAnalysis({}, {}, {}, { kind: "overlay", overlay: cycles });

    const placement: OverlayKey = {
      ...cycles,
      category: "placement",
      name: "placement",
      unit: "",
    };
    assert.strictEqual(index.selectOverlay(placement), true);
    assert.strictEqual(index.selectedOverlayKey?.category, "placement");
    assert.deepStrictEqual(
      index.sourceLineRecordsForUri("source-uri").map(({ color }) => color.basis),
      ["unavailable", "unavailable"],
    );

    const later = metricOverlay("dram_read_bytes", "bytes", { resultIndex: 1 });
    assert.strictEqual(index.selectOverlay(later), true);
    assert.strictEqual(index.selectedOverlayKey?.resultIndex, 1);
    assert.deepStrictEqual(
      index.sourceLineRecordsForUri("source-uri").map(({ color }) => color.basis),
      ["unavailable", "unavailable"],
    );
  });

  it("counts source metrics that exist only in later results as usable", () => {
    const records = buildSourceLines(
      {
        results: [
          outputResult(
            [stack("code_stack/result-zero", 1, ["op/result-zero"]), op("op/result-zero")],
          ),
          outputResult(
            [stack("code_stack/result-one", 2, ["op/result-one"]), op("op/result-one")],
            [breakdown("code_stack/result-one", [
              metric("result_one_only", 5, { unit: "items" }),
            ])],
          ),
        ],
      },
      {
        results: [
          { resultIndex: 0, mappings: [{ entityId: "code_stack/result-zero" }] },
          { resultIndex: 1, mappings: [{ entityId: "code_stack/result-one" }] },
        ],
      },
    );
    const index = new SourceAnnotationIndex({
      uriForFile: () => "source-uri",
      buildSourceLines: () => records,
    });

    index.setAnalysis({}, {}, {});

    assert.strictEqual(index.hasUsableSourceAnnotations, true);
    assert.strictEqual(index.selectedOverlayKey, undefined);
  });

  it("updates an annotation index selection without rebuilding source lines", () => {
    const built = metricSelectionFixture();
    let builds = 0;
    const index = new SourceAnnotationIndex({
      uriForFile: () => "source-uri",
      buildSourceLines: () => {
        builds += 1;
        return built;
      },
    });
    const cycles = metricOverlay("total_cycles");
    index.setAnalysis({}, {}, {}, { kind: "overlay", overlay: cycles });
    const selected = metricOverlay("dram_read_bytes", "bytes");

    assert.strictEqual(index.selectOverlay(selected), true);

    assert.strictEqual(builds, 1);
    assert.strictEqual(index.selectedOverlayKey?.name, "dram_read_bytes");
    assert.deepStrictEqual(
      index.sourceLineRecordsForUri("source-uri").map(({ selectedMetric }) => selectedMetric.value),
      [100, 900],
    );
  });
});
