export type ManagedPathInspection =
  | { kind: "present" }
  | { kind: "missing" }
  | { kind: "error"; error: unknown };

export type ManagedEnvironmentInspection =
  | "complete"
  | "setupRequired"
  | "incomplete"
  | "inspectionFailed";

export async function inspectManagedPath(
  stat: () => PromiseLike<unknown>,
): Promise<ManagedPathInspection> {
  try {
    await stat();
    return { kind: "present" };
  } catch (error) {
    return isFileNotFoundError(error)
      ? { kind: "missing" }
      : { kind: "error", error };
  }
}

export function classifyManagedEnvironment(
  venv: ManagedPathInspection,
  uv: ManagedPathInspection,
): ManagedEnvironmentInspection {
  if (venv.kind === "error" || uv.kind === "error") {
    return "inspectionFailed";
  }
  if (venv.kind === "missing" && uv.kind === "missing") {
    return "setupRequired";
  }
  if (venv.kind === "missing" || uv.kind === "missing") {
    return "incomplete";
  }
  return "complete";
}

function isFileNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === "FileNotFound" || error.code === "ENOENT";
}
