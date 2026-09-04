import * as assert from "assert";
import { describe, it } from "node:test";

import {
  classifyManagedEnvironment,
  inspectManagedPath,
  ManagedPathInspection,
} from "../environmentState";

const present: ManagedPathInspection = { kind: "present" };
const missing: ManagedPathInspection = { kind: "missing" };

function fileSystemError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

describe("managed environment inspection", () => {
  it("distinguishes present, missing, and inaccessible paths", async () => {
    assert.deepStrictEqual(
      await inspectManagedPath(async () => ({ type: "directory" })),
      present,
    );
    assert.deepStrictEqual(
      await inspectManagedPath(async () => { throw fileSystemError("FileNotFound"); }),
      missing,
    );
    assert.deepStrictEqual(
      await inspectManagedPath(async () => { throw fileSystemError("ENOENT"); }),
      missing,
    );

    const denied = fileSystemError("NoPermissions");
    assert.deepStrictEqual(
      await inspectManagedPath(async () => { throw denied; }),
      { kind: "error", error: denied },
    );
  });

  it("classifies first-time, incomplete, complete, and failed inspections", () => {
    const error: ManagedPathInspection = {
      kind: "error",
      error: fileSystemError("NoPermissions"),
    };

    assert.strictEqual(classifyManagedEnvironment(missing, missing), "setupRequired");
    assert.strictEqual(classifyManagedEnvironment(present, missing), "incomplete");
    assert.strictEqual(classifyManagedEnvironment(missing, present), "incomplete");
    assert.strictEqual(classifyManagedEnvironment(present, present), "complete");
    assert.strictEqual(classifyManagedEnvironment(error, present), "inspectionFailed");
    assert.strictEqual(classifyManagedEnvironment(missing, error), "inspectionFailed");
  });
});
