import { deepFreeze } from "./deepFreeze";

export type OverlayCategory = "placement" | "status" | "metric" | "checks" | "advice";

export type OverlayQualifierValue =
  | null
  | string
  | boolean
  | number
  | readonly OverlayQualifierValue[]
  | { readonly [key: string]: OverlayQualifierValue };

export type OverlayQualifiers = Readonly<Record<string, OverlayQualifierValue>>;

/** Stable semantic identity for one logical standardized-output overlay. */
export interface OverlayKey {
  readonly resultIndex: number;
  readonly resultKind: string;
  readonly category: OverlayCategory;
  readonly name: string;
  readonly unit: string;
  readonly breakdownQualifiers: OverlayQualifiers;
  readonly metricQualifiers: OverlayQualifiers;
}

/**
 * VS Code's overlay catalog is authoritative for its own UI. It may contain overlays
 * unavailable in Model Explorer, and Model Explorer may likewise have unmatched
 * manifest entries; those differences will be handled explicitly by later synchronization.
 */
export function buildOverlayCatalog(standardizedOutput: unknown): readonly OverlayKey[] {
  const results = objectArrayProperty(standardizedOutput, "results");
  if (!results) {
    return deepFreeze([] as OverlayKey[]);
  }

  const catalog = new Map<string, OverlayKey>();
  for (const [resultIndex, value] of results.entries()) {
    if (!isRecord(value)) {
      continue;
    }
    const resultKind = typeof value.kind === "string" && value.kind.length > 0
      ? value.kind
      : "result";
    const add = (key: OverlayKey): void => {
      catalog.set(overlayKeyId(key), key);
    };
    const unqualified = (category: Exclude<OverlayCategory, "metric">): OverlayKey => ({
      resultIndex,
      resultKind,
      category,
      name: category,
      unit: "",
      breakdownQualifiers: {},
      metricQualifiers: {},
    });

    const entities = Array.isArray(value.entities) ? value.entities : [];
    if (entities.some((entity) => isRecord(entity) && entity.placement != null)) {
      add(unqualified("placement"));
    }
    if (entities.some((entity) => isRecord(entity) && entity.status != null)) {
      add(unqualified("status"));
    }

    // Only entity-associated breakdown values are overlays. Top-level result
    // metrics describe the model as a whole and are presented separately as
    // model statistics in the Current Analysis Run view.
    if (Array.isArray(value.breakdowns)) {
      for (const breakdown of value.breakdowns) {
        if (!isRecord(breakdown)) {
          continue;
        }
        const breakdownQualifiers = qualifierObject(breakdown.qualifiers);
        if (!breakdownQualifiers) {
          continue;
        }
        addMetrics(
          catalog,
          resultIndex,
          resultKind,
          breakdown.metrics,
          breakdownQualifiers,
        );
      }
    }

    if (Array.isArray(value.checks) && value.checks.length > 0) {
      add(unqualified("checks"));
    }
    if (Array.isArray(value.advice) && value.advice.length > 0) {
      add(unqualified("advice"));
    }
  }

  return deepFreeze([...catalog.values()].sort(compareOverlayKeys));
}

export function defaultOverlayKey(catalog: readonly OverlayKey[]): OverlayKey | undefined {
  const resultIndexes = [...new Set(catalog.map(({ resultIndex }) => resultIndex))].sort(
    (left, right) => left - right,
  );
  for (const resultIndex of resultIndexes) {
    for (const preferredName of ["total_cycles", "op_cycles"]) {
      const candidates = catalog.filter((overlay) =>
        overlay.resultIndex === resultIndex &&
        overlay.category === "metric" &&
        overlay.name === preferredName &&
        Object.keys(overlay.breakdownQualifiers).length === 0 &&
        Object.keys(overlay.metricQualifiers).length === 0
      );
      if (candidates.length > 0) {
        return candidates.length === 1 ? candidates[0] : undefined;
      }
    }
  }
  return undefined;
}

export function overlayKeyId(key: OverlayKey): string {
  return canonicalJson([
    key.resultIndex,
    key.resultKind,
    key.category,
    key.name,
    key.unit,
    key.breakdownQualifiers,
    key.metricQualifiers,
  ]);
}

function addMetrics(
  catalog: Map<string, OverlayKey>,
  resultIndex: number,
  resultKind: string,
  values: unknown,
  breakdownQualifiers: OverlayQualifiers,
): void {
  if (!Array.isArray(values)) {
    return;
  }
  for (const value of values) {
    if (!isRecord(value) || typeof value.name !== "string") {
      continue;
    }
    const metricQualifiers = qualifierObject(value.qualifiers);
    if (!metricQualifiers) {
      continue;
    }
    const key: OverlayKey = {
      resultIndex,
      resultKind,
      category: "metric",
      name: value.name,
      unit: typeof value.unit === "string" ? value.unit : "",
      breakdownQualifiers,
      metricQualifiers,
    };
    catalog.set(overlayKeyId(key), key);
  }
}

const categoryOrder: Record<OverlayCategory, number> = {
  placement: 0,
  status: 1,
  metric: 2,
  checks: 3,
  advice: 4,
};

function compareOverlayKeys(left: OverlayKey, right: OverlayKey): number {
  const leftDefault = left.category === "metric" && left.name === "total_cycles" ? 0 : 1;
  const rightDefault = right.category === "metric" && right.name === "total_cycles" ? 0 : 1;
  return left.resultIndex - right.resultIndex ||
    left.resultKind.localeCompare(right.resultKind) ||
    leftDefault - rightDefault ||
    categoryOrder[left.category] - categoryOrder[right.category] ||
    left.name.localeCompare(right.name) ||
    left.unit.localeCompare(right.unit) ||
    overlayKeyId(left).localeCompare(overlayKeyId(right));
}

const INVALID_QUALIFIER = Symbol("invalid qualifier");

function qualifierObject(value: unknown): OverlayQualifiers | undefined {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const clone = cloneQualifierValue(value, new Set<object>());
  return clone === INVALID_QUALIFIER || !isRecord(clone) ? undefined : clone;
}

function cloneQualifierValue(
  value: unknown,
  ancestors: Set<object>,
): OverlayQualifierValue | typeof INVALID_QUALIFIER {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    return INVALID_QUALIFIER;
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    const cloned: OverlayQualifierValue[] = [];
    for (const item of value) {
      const clone = cloneQualifierValue(item, ancestors);
      if (clone === INVALID_QUALIFIER) {
        ancestors.delete(value);
        return INVALID_QUALIFIER;
      }
      cloned.push(clone);
    }
    ancestors.delete(value);
    return cloned;
  }
  const cloned: Record<string, OverlayQualifierValue> = {};
  for (const key of Object.keys(value).sort()) {
    const clone = cloneQualifierValue((value as Readonly<Record<string, unknown>>)[key], ancestors);
    if (clone === INVALID_QUALIFIER) {
      ancestors.delete(value);
      return INVALID_QUALIFIER;
    }
    Object.defineProperty(cloned, key, {
      value: clone,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  ancestors.delete(value);
  return cloned;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function objectArrayProperty(value: unknown, property: string): unknown[] | undefined {
  return isRecord(value) && Array.isArray(value[property])
    ? value[property] as unknown[]
    : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
