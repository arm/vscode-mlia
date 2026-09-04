import * as assert from "assert";
import { describe, it } from "node:test";

import {
  buildOverlayCatalog,
  defaultOverlayKey,
  OverlayKey,
  overlayKeyId,
} from "../overlayCatalog";

function summary(key: OverlayKey) {
  return {
    resultIndex: key.resultIndex,
    resultKind: key.resultKind,
    category: key.category,
    name: key.name,
    unit: key.unit,
    breakdownQualifiers: key.breakdownQualifiers,
    metricQualifiers: key.metricQualifiers,
  };
}

describe("buildOverlayCatalog", () => {
  it("catalogs every supported category, result index, and result kind from standardized output", () => {
    const catalog = buildOverlayCatalog({
      results: [
        {
          kind: "performance",
          entities: [
            { id: "op/0", placement: "NPU", status: "estimated" },
            { id: "model", placement: "CPU" },
          ],
          metrics: [
            { name: "model_cycles", unit: "cycles", value: 1000, qualifiers: {} },
          ],
          breakdowns: [
            {
              entity_id: "op/0",
              qualifiers: { phase: "warm" },
              metrics: [
                { name: "total_cycles", unit: "cycles", value: 10, qualifiers: {} },
                {
                  name: "unavailable_only",
                  unit: "items",
                  availability: "unavailable",
                  qualifiers: { engine: "npu" },
                },
              ],
            },
          ],
          checks: [{ id: "check-0" }],
          advice: [{ id: "advice-0", message: "Tune this" }],
        },
        {
          kind: "compatibility",
          entities: [{ id: "op/1", placement: "CPU" }],
          breakdowns: [{
            entity_id: "op/1",
            metrics: [{ name: "supported", unit: "ratio", value: 1 }],
          }],
          advice: [{ id: "global", message: "Global advice" }],
        },
      ],
    });

    assert.deepStrictEqual(catalog.map(summary), [
      {
        resultIndex: 0,
        resultKind: "performance",
        category: "metric",
        name: "total_cycles",
        unit: "cycles",
        breakdownQualifiers: { phase: "warm" },
        metricQualifiers: {},
      },
      {
        resultIndex: 0,
        resultKind: "performance",
        category: "placement",
        name: "placement",
        unit: "",
        breakdownQualifiers: {},
        metricQualifiers: {},
      },
      {
        resultIndex: 0,
        resultKind: "performance",
        category: "status",
        name: "status",
        unit: "",
        breakdownQualifiers: {},
        metricQualifiers: {},
      },
      {
        resultIndex: 0,
        resultKind: "performance",
        category: "metric",
        name: "unavailable_only",
        unit: "items",
        breakdownQualifiers: { phase: "warm" },
        metricQualifiers: { engine: "npu" },
      },
      {
        resultIndex: 0,
        resultKind: "performance",
        category: "checks",
        name: "checks",
        unit: "",
        breakdownQualifiers: {},
        metricQualifiers: {},
      },
      {
        resultIndex: 0,
        resultKind: "performance",
        category: "advice",
        name: "advice",
        unit: "",
        breakdownQualifiers: {},
        metricQualifiers: {},
      },
      {
        resultIndex: 1,
        resultKind: "compatibility",
        category: "placement",
        name: "placement",
        unit: "",
        breakdownQualifiers: {},
        metricQualifiers: {},
      },
      {
        resultIndex: 1,
        resultKind: "compatibility",
        category: "metric",
        name: "supported",
        unit: "ratio",
        breakdownQualifiers: {},
        metricQualifiers: {},
      },
      {
        resultIndex: 1,
        resultKind: "compatibility",
        category: "advice",
        name: "advice",
        unit: "",
        breakdownQualifiers: {},
        metricQualifiers: {},
      },
    ]);
  });

  it("defaults across results to total_cycles and then op_cycles", () => {
    const laterResult = buildOverlayCatalog({
      results: [
        { breakdowns: [{ metrics: [{ name: "work", value: 1 }] }] },
        {
          kind: "performance",
          breakdowns: [{
            entity_id: "op/1",
            metrics: [
              { name: "op_cycles", unit: "cycles", value: 20 },
              { name: "total_cycles", unit: "cycles", value: 10 },
            ],
          }],
        },
      ],
    });
    assert.strictEqual(defaultOverlayKey(laterResult)?.resultIndex, 1);
    assert.strictEqual(defaultOverlayKey(laterResult)?.name, "total_cycles");

    const earlierResultOpCycles = buildOverlayCatalog({
      results: [
        { breakdowns: [{ metrics: [{ name: "op_cycles", unit: "cycles", value: 20 }] }] },
        { breakdowns: [{ metrics: [{ name: "total_cycles", unit: "cycles", value: 10 }] }] },
      ],
    });
    assert.strictEqual(defaultOverlayKey(earlierResultOpCycles)?.resultIndex, 0);
    assert.strictEqual(defaultOverlayKey(earlierResultOpCycles)?.name, "op_cycles");

    const ambiguous = buildOverlayCatalog({
      results: [{
        breakdowns: [{
          metrics: [
            { name: "total_cycles", unit: "cycles", value: 1 },
            { name: "total_cycles", unit: "ticks", value: 2 },
          ],
        }],
      }],
    });
    assert.strictEqual(defaultOverlayKey(ambiguous), undefined);
  });

  it("rejects malformed qualifier identities without losing valid sibling overlays", () => {
    const catalog = buildOverlayCatalog({
      results: [{
        breakdowns: [
          {
            qualifiers: "invalid",
            metrics: [{ name: "discarded_breakdown", value: 1 }],
          },
          {
            qualifiers: {},
            metrics: [
              { name: "discarded_metric", value: 1, qualifiers: ["invalid"] },
              { name: "kept", value: 2, qualifiers: { nested: [true, null, 3] } },
            ],
          },
        ],
      }],
    });

    assert.deepStrictEqual(catalog.map(({ name }) => name), ["kept"]);
  });

  it("returns deeply frozen keys with canonical qualifier identity", () => {
    const qualifiers = { z: [2, { b: true }], a: "first" };
    const catalog = buildOverlayCatalog({
      results: [{
        kind: "performance",
        breakdowns: [{
          entity_id: "op/0",
          metrics: [{ name: "work", unit: "items", value: 1, qualifiers }],
        }],
      }],
    });
    const key = catalog[0];
    const reordered: OverlayKey = {
      ...key,
      metricQualifiers: { a: "first", z: [2, { b: true }] },
    };

    assert.strictEqual(overlayKeyId(key), overlayKeyId(reordered));
    assert.strictEqual(Object.isFrozen(catalog), true);
    assert.strictEqual(Object.isFrozen(key), true);
    assert.strictEqual(Object.isFrozen(key.metricQualifiers), true);
    assert.strictEqual(Object.isFrozen(key.metricQualifiers.z as object), true);
    assert.strictEqual(Object.isFrozen(qualifiers), false);
  });

  it("returns an empty catalog for malformed top-level output", () => {
    assert.deepStrictEqual(buildOverlayCatalog(undefined), []);
    assert.deepStrictEqual(buildOverlayCatalog({ results: {} }), []);
  });
});
