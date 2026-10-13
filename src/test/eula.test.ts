import * as assert from "assert";
import { describe, it } from "node:test";

import { EulaAcceptanceManager, EulaAcceptances, EulaAgreement, requiredEula } from "../eula";

function fixture() {
  let values: unknown = {};
  const writes: EulaAcceptances[] = [];
  let text = "Sample licence terms";
  let packageVersion: string | undefined = "1.0.0";
  let accept = true;
  let reads = 0;
  const prompts: EulaAgreement[] = [];
  const options = {
    readAcceptances: () => values,
    writeAcceptances: async (records: EulaAcceptances) => {
      values = { ...records };
      writes.push({ ...records });
    },
    getPackageVersion: (name: string) => name === "mlia-neural-technology" ? packageVersion : undefined,
    loadText: async () => { reads += 1; return text; },
    prompt: async (agreement: EulaAgreement) => { prompts.push(agreement); return accept; },
    now: () => new Date("2026-10-06T12:00:00.000Z"),
  };
  return {
    values: () => values, writes, options, prompts,
    setAcceptances: (records: unknown) => { values = records; },
    manager: new EulaAcceptanceManager(options),
    setText: (value: string) => { text = value; },
    setVersion: (value: string | undefined) => { packageVersion = value; },
    setAccept: (value: boolean) => { accept = value; },
    reads: () => reads,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("EULA requirements", () => {
  it("maps GCPE estimation profiles to their providing distribution", () => {
    for (const profile of ["neural-technology", "NX-peak-12SC-8NX-600MHz", "NX-sustained-12SC-8NX-350MHz"]) {
      assert.deepStrictEqual(requiredEula(profile, "estimation"), {
        id: "arm-gcpe",
        title: "Arm Graph Compiler Performance Estimator",
        packageName: "mlia-neural-technology",
        pythonModule: "mlia.backend.nx_performance_estimator.installer",
        pythonProperty: "DEFAULT_LICENSE_FILE",
      });
      assert.strictEqual(requiredEula(profile, "profiling"), undefined);
    }
    assert.strictEqual(requiredEula("ethos-u55-256", "estimation"), undefined);
    assert.strictEqual(requiredEula("custom.toml", "estimation"), undefined);
  });
});

describe("EulaAcceptanceManager", () => {
  it("does not query or grant acceptance for unmapped combinations", async () => {
    const state = fixture();
    state.setVersion(undefined);
    for (const [profile, mode] of [["unknown", "estimation"], ["neural-technology", "profiling"]] as const) {
      assert.deepStrictEqual(await state.manager.authorize(profile, mode), { proceed: true, acceptEula: false });
    }
    assert.strictEqual(state.reads(), 0);
    assert.deepStrictEqual(state.prompts, []);
    assert.deepStrictEqual(state.writes, []);
  });

  it("keys consent by package version and skips licence retrieval on subsequent runs", async () => {
    const state = fixture();
    assert.deepStrictEqual(await state.manager.authorize("neural-technology", "estimation"),
      { proceed: true, acceptEula: true });
    assert.strictEqual(state.prompts.length, 1);
    assert.strictEqual(state.prompts[0].text, "Sample licence terms");
    assert.strictEqual(state.prompts[0].packageVersion, "1.0.0");
    assert.deepStrictEqual(state.writes, [{ "arm-gcpe:1.0.0": "2026-10-06T12:00:00.000Z" }]);

    const reloaded = new EulaAcceptanceManager({
      ...state.options,
      loadText: async () => { throw new Error("must not query Python for accepted versions"); },
    });
    assert.deepStrictEqual(await reloaded.authorize("NX-peak-12SC-8NX-600MHz", "estimation"),
      { proceed: true, acceptEula: true });
    state.setText("Same-version development edit");
    assert.deepStrictEqual(await state.manager.authorize("neural-technology", "estimation"),
      { proceed: true, acceptEula: true });
    assert.strictEqual(state.prompts.length, 1);
    assert.strictEqual(state.reads(), 1);
  });

  it("reads setting resets and deletions on the next run without restarting", async () => {
    const state = fixture();
    await state.manager.authorize("neural-technology", "estimation");
    state.setAccept(false);
    state.setAcceptances({ "other-agreement:1.0.0": "2026-10-06T12:00:00.000Z" });
    assert.deepStrictEqual(await state.manager.authorize("neural-technology", "estimation"), { proceed: false });
    state.setAcceptances({});
    assert.deepStrictEqual(await state.manager.authorize("neural-technology", "estimation"), { proceed: false });
    assert.strictEqual(state.prompts.length, 3);
    assert.strictEqual(state.writes.length, 1);
  });

  it("honours valid user settings without loading licence text", async () => {
    const state = fixture();
    state.setAcceptances({ "arm-gcpe:1.0.0": "2026-10-06T12:00:00.000Z" });
    assert.deepStrictEqual(await state.manager.authorize("neural-technology", "estimation"),
      { proceed: true, acceptEula: true });
    assert.strictEqual(state.prompts.length, 0);
    assert.strictEqual(state.reads(), 0);
    assert.strictEqual(state.writes.length, 0);
  });

  it("merges consent with setting edits made while the prompt is open", async () => {
    const state = fixture();
    const existing = { "other-agreement:1.0.0": "2026-10-06T11:00:00.000Z" };
    const manager = new EulaAcceptanceManager({
      ...state.options,
      prompt: async () => { state.setAcceptances(existing); return true; },
    });
    await manager.authorize("neural-technology", "estimation");
    assert.deepStrictEqual(state.values(), { ...existing, "arm-gcpe:1.0.0": "2026-10-06T12:00:00.000Z" });
  });

  it("requires acceptance of a new package version even when the terms are unchanged", async () => {
    const state = fixture();
    await state.manager.authorize("neural-technology", "estimation");
    state.setVersion("2.0.0");
    state.setAccept(false);
    assert.deepStrictEqual(await state.manager.authorize("neural-technology", "estimation"), { proceed: false });
    assert.strictEqual(state.writes.length, 1);
    state.setAccept(true);
    assert.deepStrictEqual(await state.manager.authorize("neural-technology", "estimation"),
      { proceed: true, acceptEula: true });
    assert.deepStrictEqual(state.writes[1], {
      "arm-gcpe:1.0.0": "2026-10-06T12:00:00.000Z",
      "arm-gcpe:2.0.0": "2026-10-06T12:00:00.000Z",
    });
  });

  it("requires a refresh when the providing package has no cached version", async () => {
    const state = fixture();
    state.setVersion(undefined);
    await assert.rejects(state.manager.authorize("neural-technology", "estimation"), /Refresh MLIA Environment/);
    assert.strictEqual(state.reads(), 0);
    assert.strictEqual(state.writes.length, 0);
  });

  it("does not accept empty or unreadable terms for an unaccepted version", async () => {
    const state = fixture();
    state.setText(" \n\t");
    await assert.rejects(state.manager.authorize("neural-technology", "estimation"), /empty or unreadable/);
    const unavailable = new EulaAcceptanceManager({
      ...state.options,
      loadText: async () => { throw new Error("module not installed"); },
    });
    await assert.rejects(unavailable.authorize("neural-technology", "estimation"), /module not installed/);
    assert.strictEqual(state.prompts.length, 0);
    assert.strictEqual(state.writes.length, 0);
  });

  it("does not grant consent when saving fails and allows a later retry", async () => {
    const state = fixture();
    let fail = true;
    const manager = new EulaAcceptanceManager({
      ...state.options,
      writeAcceptances: async (records) => {
        if (fail) { throw new Error("settings update failed"); }
        await state.options.writeAcceptances(records);
      },
    });
    await assert.rejects(manager.authorize("neural-technology", "estimation"), /settings update failed/);
    assert.deepStrictEqual(state.values(), {});
    fail = false;
    assert.deepStrictEqual(await manager.authorize("neural-technology", "estimation"),
      { proceed: true, acceptEula: true });
    assert.strictEqual(state.prompts.length, 2);
  });

  it("ignores malformed settings and invalid timestamps", async () => {
    const state = fixture();
    state.setAccept(false);
    for (const value of [null, [], true, "invalid", { "arm-gcpe:1.0.0": 123 }, { "arm-gcpe:1.0.0": "invalid timestamp" }]) {
      state.setAcceptances(value);
      assert.deepStrictEqual(await state.manager.authorize("neural-technology", "estimation"), { proceed: false });
    }
    assert.strictEqual(state.writes.length, 0);
  });

  it("does not save acceptance if the environment changes while the prompt is open", async () => {
    const state = fixture();
    const manager = new EulaAcceptanceManager({
      ...state.options,
      prompt: async () => { state.setVersion("2.0.0"); return true; },
    });
    await assert.rejects(manager.authorize("neural-technology", "estimation"), /environment changed/);
    assert.strictEqual(state.writes.length, 0);
  });

  for (const accepted of [true, false]) {
    it(`shares concurrent licence queries and prompts (accepted=${accepted})`, async () => {
      const state = fixture();
      let resolvePrompt!: (value: boolean) => void;
      let promptCount = 0;
      const manager = new EulaAcceptanceManager({
        ...state.options,
        prompt: () => {
          promptCount += 1;
          return new Promise<boolean>((resolve) => { resolvePrompt = resolve; });
        },
      });
      const first = manager.authorize("neural-technology", "estimation");
      const second = manager.authorize("NX-peak-12SC-8NX-600MHz", "estimation");
      await flush();
      assert.strictEqual(promptCount, 1);
      assert.strictEqual(state.reads(), 1);
      resolvePrompt(accepted);
      const expected = accepted ? { proceed: true, acceptEula: true } : { proceed: false };
      assert.deepStrictEqual(await Promise.all([first, second]), [expected, expected]);
      assert.strictEqual(state.writes.length, accepted ? 1 : 0);
    });
  }
});
