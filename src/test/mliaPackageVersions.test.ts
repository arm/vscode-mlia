import * as assert from "assert";
import { describe, it } from "node:test";

import { formatMliaPackageVersions, readMliaPackageVersions } from "../mliaPackageVersions";

describe("cached MLIA package versions", () => {
  it("validates complete metadata and rejects missing or corrupt caches", () => {
    const versions = { mlia: "0.12.3.dev3+abc", "mlia-neural-technology": "0.1.1.dev4+def" };
    assert.deepStrictEqual(readMliaPackageVersions(versions), versions);
    for (const invalid of [undefined, null, [], {}, { mlia: 1 }, { mlia: "" },
      { "mlia-neural-technology": "1.0" }, { mlia: "1.0", requests: "2.0" }]) {
      assert.strictEqual(readMliaPackageVersions(invalid), undefined);
    }
  });

  it("formats all cached packages for Info in stable name order", () => {
    assert.strictEqual(formatMliaPackageVersions({
      "mlia-neural-technology": "0.1.1",
      mlia: "0.12.3",
      "mlia-ethos-u": "0.1.2",
    }), "Installed MLIA packages:\n\nmlia: 0.12.3\nmlia-ethos-u: 0.1.2\nmlia-neural-technology: 0.1.1");
  });
});
