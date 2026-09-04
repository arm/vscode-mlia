import * as assert from "assert";
import { describe, it } from "node:test";

import { OverlayKey, overlayKeyId } from "../overlayCatalog";
import {
  modelExplorerIntentForSelection,
  parseModelExplorerOverlayManifest,
  selectionForModelExplorerIntent,
} from "../overlaySynchronization";

function overlay(
  name: string,
  qualifiers: OverlayKey["metricQualifiers"] = {},
): OverlayKey {
  return {
    resultIndex: 0,
    resultKind: "performance",
    category: "metric",
    name,
    unit: "cycles",
    breakdownQualifiers: {},
    metricQualifiers: qualifiers,
  };
}

function manifest(entries: unknown[]): string {
  return JSON.stringify({
    schema_version: "0.1.0",
    nodeDataOverlayKeysAndDisplayNames: entries,
  });
}

function entry(key: OverlayKey, displayName: string): unknown {
  return { overlayKey: key, displayName };
}

describe("overlay synchronization catalog", () => {
  it("translates exact structured identities and exact effective display names both ways", () => {
    const cycles = overlay("total_cycles", {
      config: { enabled: true, shape: [1, 2.5, null] },
    });
    const catalog = parseModelExplorerOverlayManifest(manifest([
      entry(cycles, "total_cycles (cycles) [config=…]"),
    ]));

    assert.deepStrictEqual(
      modelExplorerIntentForSelection(
        { kind: "overlay", overlay: cycles },
        [cycles],
        catalog,
      ),
      { kind: "overlay", effectiveName: "total_cycles (cycles) [config=…]" },
    );
    assert.deepStrictEqual(
      selectionForModelExplorerIntent(
        { kind: "overlay", effectiveName: "total_cycles (cycles) [config=…]" },
        [cycles],
        catalog,
      ),
      { kind: "overlay", overlay: cycles },
    );
    assert.strictEqual(catalog.diagnostics.length, 0);
  });

  it("preserves special qualifier keys as exact own properties", () => {
    const qualifiers: Record<string, OverlayKey["metricQualifiers"][string]> = {};
    Object.defineProperty(qualifiers, "__proto__", {
      value: { nested: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const special = overlay("special", qualifiers);
    const catalog = parseModelExplorerOverlayManifest(manifest([
      entry(special, "special qualifier"),
    ]));
    const parsed = catalog.overlayByDisplayName.get("special qualifier");

    assert.ok(parsed);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(parsed.metricQualifiers, "__proto__"), true);
    assert.deepStrictEqual(parsed.metricQualifiers.__proto__, { nested: true });
    assert.strictEqual(overlayKeyId(parsed), overlayKeyId(special));
  });

  it("maps None and unmatched entries symmetrically without parsing display names", () => {
    const vscodeOnly = overlay("vscode_only");
    const modelExplorerOnly = overlay("model_explorer_only");
    const catalog = parseModelExplorerOverlayManifest(manifest([
      entry(modelExplorerOnly, "looks exactly like vscode_only (cycles)"),
    ]));
    const failures: string[] = [];

    assert.deepStrictEqual(
      modelExplorerIntentForSelection(
        { kind: "overlay", overlay: vscodeOnly },
        [vscodeOnly],
        catalog,
        (message) => failures.push(message),
      ),
      { kind: "none" },
    );
    assert.deepStrictEqual(
      selectionForModelExplorerIntent(
        { kind: "overlay", effectiveName: "looks exactly like vscode_only (cycles)" },
        [vscodeOnly],
        catalog,
        (message) => failures.push(message),
      ),
      { kind: "none" },
    );
    assert.deepStrictEqual(
      selectionForModelExplorerIntent(
        { kind: "overlay", effectiveName: "missing effective name" },
        [vscodeOnly],
        catalog,
        (message) => failures.push(message),
      ),
      { kind: "none" },
    );
    assert.deepStrictEqual(
      selectionForModelExplorerIntent(
        { kind: "none" },
        [vscodeOnly],
        catalog,
        (message) => failures.push(message),
      ),
      { kind: "none" },
    );
    assert.deepStrictEqual(failures.length, 3);
    assert.ok(failures.some((message) => message.includes("no unambiguous Model Explorer manifest mapping")));
    assert.ok(failures.some((message) => message.includes("absent from the VS Code catalog")));
    assert.ok(failures.some((message) => message.includes("missing effective name")));
  });

  it("rejects malformed entries and taints duplicate names and duplicate structured keys", () => {
    const first = overlay("first");
    const second = overlay("second");
    const duplicateName = parseModelExplorerOverlayManifest(manifest([
      entry(first, "duplicate"),
      entry(second, "duplicate"),
    ]));
    assert.strictEqual(duplicateName.overlayByDisplayName.size, 0);
    assert.ok(duplicateName.diagnostics.some((message) => message.includes("duplicated")));

    const duplicateKey = parseModelExplorerOverlayManifest(manifest([
      entry(first, "first name"),
      entry(first, "second name"),
    ]));
    assert.strictEqual(duplicateKey.displayNameByOverlayId.has(overlayKeyId(first)), false);
    assert.strictEqual(duplicateKey.overlayByDisplayName.size, 0);

    const malformedTaintsName = parseModelExplorerOverlayManifest(manifest([
      entry(first, "shared"),
      { displayName: "shared", overlayKey: { resultIndex: "bad" } },
      { displayName: "valid sibling", overlayKey: second },
    ]));
    assert.strictEqual(malformedTaintsName.overlayByDisplayName.has("shared"), false);
    assert.strictEqual(
      overlayKeyId(malformedTaintsName.overlayByDisplayName.get("valid sibling") as OverlayKey),
      overlayKeyId(second),
    );

    const malformedDisplayTaintsKey = parseModelExplorerOverlayManifest(manifest([
      entry(first, "valid"),
      { displayName: "", overlayKey: first },
    ]));
    assert.strictEqual(malformedDisplayTaintsKey.overlayByDisplayName.has("valid"), false);
  });

  it("fails closed for JSON numbers whose Python identity collapses in JavaScript", () => {
    const integer = overlay("latency", { value: 1 });
    const safeFloat = overlay("latency", { value: 1.5 });
    const raw = `{
      "nodeDataOverlayKeysAndDisplayNames": [
        {"overlayKey": ${JSON.stringify(integer)}, "displayName": "integral"},
        {"overlayKey": ${JSON.stringify(integer).replace('"value":1', '"value":1.0')}, "displayName": "integral-float"},
        {"overlayKey": ${JSON.stringify(safeFloat)}, "displayName": "safe-float"},
        {"overlayKey": ${JSON.stringify(integer).replace('"value":1', '"value":9007199254740993')}, "displayName": "unsafe-integer"}
      ]
    }`;
    const catalog = parseModelExplorerOverlayManifest(raw);

    assert.strictEqual(catalog.overlayByDisplayName.has("integral"), false);
    assert.strictEqual(catalog.overlayByDisplayName.has("integral-float"), false);
    assert.strictEqual(catalog.overlayByDisplayName.has("unsafe-integer"), false);
    assert.deepStrictEqual(
      catalog.overlayByDisplayName.get("safe-float"),
      safeFloat,
    );
    assert.ok(catalog.diagnostics.some((message) => message.includes("cannot retain exact identity")));
  });

  it("returns an empty catalog for absent, invalid, or non-array manifest metadata", () => {
    for (const value of [
      "not json",
      "[]",
      "{}",
      JSON.stringify({ nodeDataOverlayKeysAndDisplayNames: {} }),
    ]) {
      const catalog = parseModelExplorerOverlayManifest(value);
      assert.strictEqual(catalog.displayNameByOverlayId.size, 0);
      assert.strictEqual(catalog.overlayByDisplayName.size, 0);
      assert.ok(catalog.diagnostics.length > 0);
    }
  });
});
