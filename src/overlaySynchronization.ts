import {
  defaultOverlayKey,
  OverlayCategory,
  OverlayKey,
  OverlayQualifierValue,
  overlayKeyId,
} from "./overlayCatalog";

export type OverlaySelection =
  | { readonly kind: "overlay"; readonly overlay: OverlayKey }
  | { readonly kind: "none" };

export type ModelExplorerOverlayIntent =
  | { readonly kind: "overlay"; readonly effectiveName: string }
  | { readonly kind: "none" };

export type OverlaySyncFailureReporter = (message: string) => void;

export interface ModelExplorerOverlayCatalog {
  readonly displayNameByOverlayId: ReadonlyMap<string, string>;
  readonly overlayByDisplayName: ReadonlyMap<string, OverlayKey>;
  readonly diagnostics: readonly string[];
}

const emptyCatalog: ModelExplorerOverlayCatalog = {
  displayNameByOverlayId: new Map(),
  overlayByDisplayName: new Map(),
  diagnostics: [],
};

export function emptyModelExplorerOverlayCatalog(): ModelExplorerOverlayCatalog {
  return emptyCatalog;
}

/** Parse the generated Model Explorer manifest without losing JSON number spelling. */
export function parseModelExplorerOverlayManifest(text: string): ModelExplorerOverlayCatalog {
  let root: JsonNode;
  try {
    root = new JsonParser(text).parse();
  } catch (error) {
    return catalogWithDiagnostic(`Invalid Model Explorer manifest JSON: ${errorMessage(error)}`);
  }
  if (root.kind !== "object") {
    return catalogWithDiagnostic("Model Explorer manifest must be a JSON object.");
  }
  const entries = root.properties.get("nodeDataOverlayKeysAndDisplayNames");
  if (!entries || entries.kind !== "array") {
    return catalogWithDiagnostic(
      "Model Explorer manifest nodeDataOverlayKeysAndDisplayNames must be an array.",
    );
  }

  const parsed: Array<{ overlay: OverlayKey; displayName: string }> = [];
  const diagnostics: string[] = [];
  const taintedDisplayNames = new Set<string>();
  const taintedOverlayIds = new Set<string>();
  for (const [index, entry] of entries.items.entries()) {
    if (entry.kind !== "object") {
      diagnostics.push(`Overlay manifest entry ${index} is not an object.`);
      continue;
    }
    const displayNameNode = entry.properties.get("displayName");
    const overlayNode = entry.properties.get("overlayKey");
    const displayName = displayNameNode?.kind === "string" && displayNameNode.value.length > 0
      ? displayNameNode.value
      : undefined;
    const parsedOverlay = overlayNode?.kind === "object"
      ? parseOverlayKeyNode(overlayNode)
      : undefined;
    if (!displayName) {
      if (parsedOverlay?.ok) {
        taintedOverlayIds.add(overlayKeyId(parsedOverlay.overlay));
      }
      diagnostics.push(`Overlay manifest entry ${index} has an invalid displayName.`);
      continue;
    }
    if (!parsedOverlay?.ok) {
      taintedDisplayNames.add(displayName);
      diagnostics.push(
        parsedOverlay
          ? `Overlay manifest entry ${index} is invalid: ${parsedOverlay.reason}`
          : `Overlay manifest entry ${index} has an invalid overlayKey.`,
      );
      continue;
    }
    if (parsedOverlay.numberAmbiguous) {
      taintedDisplayNames.add(displayName);
      taintedOverlayIds.add(overlayKeyId(parsedOverlay.overlay));
      diagnostics.push(
        `Overlay manifest entry ${index} has qualifier numbers that cannot retain exact identity in JavaScript.`,
      );
      continue;
    }
    parsed.push({ overlay: parsedOverlay.overlay, displayName });
  }

  const names = groupBy(parsed, ({ displayName }) => displayName);
  const overlayIds = groupBy(parsed, ({ overlay }) => overlayKeyId(overlay));
  const displayNameByOverlayId = new Map<string, string>();
  const overlayByDisplayName = new Map<string, OverlayKey>();
  for (const item of parsed) {
    const id = overlayKeyId(item.overlay);
    if (taintedDisplayNames.has(item.displayName) || (names.get(item.displayName)?.length ?? 0) !== 1) {
      continue;
    }
    if (taintedOverlayIds.has(id) || (overlayIds.get(id)?.length ?? 0) !== 1) {
      continue;
    }
    displayNameByOverlayId.set(id, item.displayName);
    overlayByDisplayName.set(item.displayName, item.overlay);
  }
  for (const [name, matches] of names) {
    if (matches.length > 1) {
      diagnostics.push(`Model Explorer overlay display name '${name}' is duplicated.`);
    }
  }
  for (const [id, matches] of overlayIds) {
    if (matches.length > 1) {
      diagnostics.push(`Model Explorer structured overlay key ${id} is duplicated or ambiguous.`);
    }
  }
  return { displayNameByOverlayId, overlayByDisplayName, diagnostics };
}

export function selectedOverlay(
  selection: OverlaySelection | undefined,
  catalog: readonly OverlayKey[],
): OverlayKey | undefined {
  if (selection?.kind === "none") {
    return undefined;
  }
  const requested = selection?.kind === "overlay"
    ? selection.overlay
    : defaultOverlayKey(catalog);
  if (!requested) {
    return undefined;
  }
  const id = overlayKeyId(requested);
  return catalog.find((candidate) => overlayKeyId(candidate) === id);
}

export function modelExplorerIntentForSelection(
  selection: OverlaySelection | undefined,
  vscodeCatalog: readonly OverlayKey[],
  modelExplorerCatalog: ModelExplorerOverlayCatalog,
  reportFailure?: OverlaySyncFailureReporter,
): ModelExplorerOverlayIntent {
  if (selection?.kind === "none") {
    return { kind: "none" };
  }

  const requested = selection?.kind === "overlay"
    ? selection.overlay
    : defaultOverlayKey(vscodeCatalog);
  if (!requested) {
    reportFailure?.("VS Code has no unambiguous default overlay to project.");
    return { kind: "none" };
  }

  const id = overlayKeyId(requested);
  const overlay = vscodeCatalog.find((candidate) => overlayKeyId(candidate) === id);
  if (!overlay) {
    reportFailure?.(`The selected VS Code overlay is absent from its current catalog: ${id}`);
    return { kind: "none" };
  }

  const effectiveName = modelExplorerCatalog.displayNameByOverlayId.get(id);
  if (effectiveName === undefined) {
    reportFailure?.(`The selected VS Code overlay has no unambiguous Model Explorer manifest mapping: ${id}`);
    return { kind: "none" };
  }
  return { kind: "overlay", effectiveName };
}

export function selectionForModelExplorerIntent(
  intent: ModelExplorerOverlayIntent,
  vscodeCatalog: readonly OverlayKey[],
  modelExplorerCatalog: ModelExplorerOverlayCatalog,
  reportFailure?: OverlaySyncFailureReporter,
): OverlaySelection {
  if (intent.kind === "none") {
    return { kind: "none" };
  }
  const manifestOverlay = modelExplorerCatalog.overlayByDisplayName.get(intent.effectiveName);
  if (!manifestOverlay) {
    reportFailure?.(
      `Model Explorer effective overlay name has no unambiguous manifest mapping: ${JSON.stringify(intent.effectiveName)}`,
    );
    return { kind: "none" };
  }
  const id = overlayKeyId(manifestOverlay);
  const matches = vscodeCatalog.filter((overlay) => overlayKeyId(overlay) === id);
  if (matches.length === 0) {
    reportFailure?.(`The Model Explorer overlay is absent from the VS Code catalog: ${id}`);
    return { kind: "none" };
  }
  if (matches.length > 1) {
    reportFailure?.(`The Model Explorer overlay is ambiguous in the VS Code catalog: ${id}`);
    return { kind: "none" };
  }
  return { kind: "overlay", overlay: matches[0] };
}

export function sameOverlaySelection(
  left: OverlaySelection | undefined,
  right: OverlaySelection | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  if (left.kind === "none" || right.kind === "none") {
    return left.kind === right.kind;
  }
  return overlayKeyId(left.overlay) === overlayKeyId(right.overlay);
}

function catalogWithDiagnostic(message: string): ModelExplorerOverlayCatalog {
  return {
    displayNameByOverlayId: new Map(),
    overlayByDisplayName: new Map(),
    diagnostics: [message],
  };
}

function groupBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const groupKey = key(value);
    const items = grouped.get(groupKey) ?? [];
    items.push(value);
    grouped.set(groupKey, items);
  }
  return grouped;
}

type ParsedOverlay =
  | { ok: true; overlay: OverlayKey; numberAmbiguous: boolean }
  | { ok: false; reason: string };

function parseOverlayKeyNode(node: ObjectJsonNode): ParsedOverlay {
  const resultIndex = node.properties.get("resultIndex");
  const resultKind = node.properties.get("resultKind");
  const category = node.properties.get("category");
  const name = node.properties.get("name");
  const unit = node.properties.get("unit");
  const breakdown = node.properties.get("breakdownQualifiers");
  const metric = node.properties.get("metricQualifiers");
  if (
    resultIndex?.kind !== "number" ||
    resultKind?.kind !== "string" || resultKind.value.length === 0 ||
    category?.kind !== "string" || !isOverlayCategory(category.value) ||
    name?.kind !== "string" || name.value.length === 0 ||
    unit?.kind !== "string" ||
    breakdown?.kind !== "object" ||
    metric?.kind !== "object"
  ) {
    return { ok: false, reason: "structured key fields have invalid types or values" };
  }
  if (!/^(?:0|[1-9][0-9]*)$/u.test(resultIndex.raw) || !Number.isSafeInteger(resultIndex.value)) {
    return { ok: false, reason: "resultIndex must be a non-negative safe JSON integer" };
  }
  const parsedBreakdown = qualifierObjectFromNode(breakdown);
  const parsedMetric = qualifierObjectFromNode(metric);
  if (!parsedBreakdown.ok || !parsedMetric.ok) {
    return { ok: false, reason: "qualifiers must contain only finite JSON values" };
  }
  return {
    ok: true,
    overlay: {
      resultIndex: resultIndex.value,
      resultKind: resultKind.value,
      category: category.value,
      name: name.value,
      unit: unit.value,
      breakdownQualifiers: parsedBreakdown.value,
      metricQualifiers: parsedMetric.value,
    },
    numberAmbiguous: parsedBreakdown.numberAmbiguous || parsedMetric.numberAmbiguous,
  };
}

function qualifierObjectFromNode(node: ObjectJsonNode): {
  ok: true;
  value: Record<string, OverlayQualifierValue>;
  numberAmbiguous: boolean;
} | { ok: false } {
  const value: Record<string, OverlayQualifierValue> = {};
  let numberAmbiguous = false;
  for (const [key, child] of [...node.properties].sort(([left], [right]) => left.localeCompare(right))) {
    const parsed = qualifierValueFromNode(child);
    if (!parsed.ok) {
      return { ok: false };
    }
    Object.defineProperty(value, key, {
      value: parsed.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    numberAmbiguous ||= parsed.numberAmbiguous;
  }
  return { ok: true, value, numberAmbiguous };
}

function qualifierValueFromNode(node: JsonNode): {
  ok: true;
  value: OverlayQualifierValue;
  numberAmbiguous: boolean;
} | { ok: false } {
  switch (node.kind) {
    case "null":
      return { ok: true, value: null, numberAmbiguous: false };
    case "boolean":
    case "string":
      return { ok: true, value: node.value, numberAmbiguous: false };
    case "number":
      return Number.isFinite(node.value)
        ? { ok: true, value: node.value, numberAmbiguous: numberTokenIsAmbiguous(node) }
        : { ok: false };
    case "array": {
      const value: OverlayQualifierValue[] = [];
      let numberAmbiguous = false;
      for (const child of node.items) {
        const parsed = qualifierValueFromNode(child);
        if (!parsed.ok) {
          return { ok: false };
        }
        value.push(parsed.value);
        numberAmbiguous ||= parsed.numberAmbiguous;
      }
      return { ok: true, value, numberAmbiguous };
    }
    case "object": {
      const parsed = qualifierObjectFromNode(node);
      return parsed.ok
        ? { ok: true, value: parsed.value, numberAmbiguous: parsed.numberAmbiguous }
        : parsed;
    }
  }
}

function numberTokenIsAmbiguous(node: NumberJsonNode): boolean {
  const integerToken = /^-?(?:0|[1-9][0-9]*)$/u.test(node.raw);
  if (integerToken) {
    return Object.is(node.value, -0) || !Number.isSafeInteger(node.value);
  }
  if (Number.isInteger(node.value)) {
    // Python keeps integer and floating-point qualifier identities distinct, while
    // JavaScript collapses (for example) 1 and 1.0 to the same Number.
    return true;
  }
  return false;
}

function isOverlayCategory(value: string): value is OverlayCategory {
  return value === "placement" || value === "status" || value === "metric" ||
    value === "checks" || value === "advice";
}

type JsonNode =
  | ObjectJsonNode
  | { kind: "array"; items: JsonNode[] }
  | { kind: "string"; value: string }
  | NumberJsonNode
  | { kind: "boolean"; value: boolean }
  | { kind: "null" };

interface ObjectJsonNode {
  kind: "object";
  properties: Map<string, JsonNode>;
}

interface NumberJsonNode {
  kind: "number";
  value: number;
  raw: string;
}

class JsonParser {
  private index = 0;

  public constructor(private readonly text: string) {}

  public parse(): JsonNode {
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.text.length) {
      throw new Error(`unexpected text at offset ${this.index}`);
    }
    return value;
  }

  private parseValue(): JsonNode {
    this.skipWhitespace();
    const character = this.text[this.index];
    if (character === "{") {
      return this.parseObject();
    }
    if (character === "[") {
      return this.parseArray();
    }
    if (character === '"') {
      return { kind: "string", value: this.parseString() };
    }
    if (character === "t" && this.consumeLiteral("true")) {
      return { kind: "boolean", value: true };
    }
    if (character === "f" && this.consumeLiteral("false")) {
      return { kind: "boolean", value: false };
    }
    if (character === "n" && this.consumeLiteral("null")) {
      return { kind: "null" };
    }
    return this.parseNumber();
  }

  private parseObject(): ObjectJsonNode {
    this.index += 1;
    const properties = new Map<string, JsonNode>();
    this.skipWhitespace();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return { kind: "object", properties };
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.index] !== '"') {
        throw new Error(`expected object key at offset ${this.index}`);
      }
      const key = this.parseString();
      if (properties.has(key)) {
        throw new Error(`duplicate object key '${key}'`);
      }
      this.skipWhitespace();
      if (this.text[this.index] !== ":") {
        throw new Error(`expected ':' at offset ${this.index}`);
      }
      this.index += 1;
      properties.set(key, this.parseValue());
      this.skipWhitespace();
      const delimiter = this.text[this.index];
      this.index += 1;
      if (delimiter === "}") {
        return { kind: "object", properties };
      }
      if (delimiter !== ",") {
        throw new Error(`expected ',' or '}' at offset ${this.index - 1}`);
      }
    }
  }

  private parseArray(): JsonNode {
    this.index += 1;
    const items: JsonNode[] = [];
    this.skipWhitespace();
    if (this.text[this.index] === "]") {
      this.index += 1;
      return { kind: "array", items };
    }
    for (;;) {
      items.push(this.parseValue());
      this.skipWhitespace();
      const delimiter = this.text[this.index];
      this.index += 1;
      if (delimiter === "]") {
        return { kind: "array", items };
      }
      if (delimiter !== ",") {
        throw new Error(`expected ',' or ']' at offset ${this.index - 1}`);
      }
    }
  }

  private parseString(): string {
    const start = this.index;
    this.index += 1;
    let escaped = false;
    while (this.index < this.text.length) {
      const character = this.text[this.index];
      this.index += 1;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        return JSON.parse(this.text.slice(start, this.index)) as string;
      } else if (character < " ") {
        throw new Error(`control character in string at offset ${this.index - 1}`);
      }
    }
    throw new Error(`unterminated string at offset ${start}`);
  }

  private parseNumber(): NumberJsonNode {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(
      this.text.slice(this.index),
    );
    if (!match) {
      throw new Error(`expected JSON value at offset ${this.index}`);
    }
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) {
      throw new Error(`non-finite JSON number at offset ${this.index - match[0].length}`);
    }
    return { kind: "number", value, raw: match[0] };
  }

  private consumeLiteral(value: string): boolean {
    if (!this.text.startsWith(value, this.index)) {
      return false;
    }
    this.index += value.length;
    return true;
  }

  private skipWhitespace(): void {
    while (
      this.text[this.index] === " " ||
      this.text[this.index] === "\t" ||
      this.text[this.index] === "\r" ||
      this.text[this.index] === "\n"
    ) {
      this.index += 1;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
