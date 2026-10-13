export type MliaPackageVersions = Record<string, string>;

/** Validate package metadata before using it for Info or EULA decisions. */
export function readMliaPackageVersions(value: unknown): MliaPackageVersions | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value);
  if (!entries.some(([name]) => name === "mlia") || entries.some(([name, version]) =>
    !/^mlia(?:-[a-z0-9]+)*$/.test(name) || typeof version !== "string" || !version.trim()
  )) {
    return undefined;
  }
  return Object.fromEntries(entries) as MliaPackageVersions;
}

export function formatMliaPackageVersions(versions: MliaPackageVersions): string {
  return "Installed MLIA packages:\n\n" + Object.entries(versions)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, version]) => `${name}: ${version}`)
    .join("\n");
}
