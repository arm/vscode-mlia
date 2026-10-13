import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import { afterEach, describe, it } from "node:test";

import {
  CommandExecutionError,
  CommandRunner,
  defaultCommandRunner,
  defaultLongRunningCommandStarter,
  LongRunningCommandStarter,
  parseMliaTargets,
  getEntityNodeMappingsPath,
  getMliaConfigPath,
  getModelExplorerHtmlPath,
  getStandardizedOutputPath,
  parseRuntimeEnv,
  refreshPythonRuntime,
  queryMliaEulaText,
  queryMliaEnvironment,
  parseMliaEnvironment,
  runMliaCheckPerformance,
} from "../pythonRuntime";
import { getManagedUvPath, managedUvEnvironment } from "../uvBootstrap";
import { requiredEula } from "../eula";

const tempDirs: string[] = [];
const packageVersions = { mlia: "1.2.3", "mlia-neural-technology": "2.0.0" };

function environmentDiscovery(profiles?: string[]): string {
  return JSON.stringify({ targets: targetDiscovery(profiles), packageVersions });
}

function targetDiscovery(profiles = ["ethos-u55", "ethos-u65"]): object[] {
  return [{
    target: "neural-technology",
    pretty_name: "Neural Technology",
    profiles,
    backends: [
      {
        name: "estimator",
        pretty_name: "Estimator",
        default: true,
        selectable: true,
        capabilities: {
          estimation: ["performance", "compatibility"],
          profiling: [],
        },
      },
      {
        name: "profiling",
        pretty_name: "Profiling",
        default: false,
        selectable: false,
        capabilities: {
          estimation: [],
          profiling: ["performance"],
        },
      },
    ],
  }];
}

async function makeFixture(): Promise<{
  extensionPath: string;
  globalStoragePath: string;
  uvExecutable: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-mlia-test-"));
  tempDirs.push(root);

  const extensionPath = path.join(root, "extension");
  const globalStoragePath = path.join(root, "storage");
  const runtimeResourcePath = path.join(extensionPath, "resources", "python-runtime");

  await fs.mkdir(runtimeResourcePath, { recursive: true });
  await fs.writeFile(
    path.join(runtimeResourcePath, "pyproject.toml"),
    `[project]\nname = "vscode-mlia-runtime"\nversion = "0.0.0"\ndependencies = ["mlia"]\n`,
    "utf8",
  );

  return { extensionPath, globalStoragePath, uvExecutable: "uv" };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("background command stdin", () => {
  const readStdin = `
    const timeout = setTimeout(() => {
      process.stderr.write("stdin remained open");
      process.exit(2);
    }, 2000);
    process.stdin.on("end", () => {
      clearTimeout(timeout);
      process.stdout.write("stdin reached EOF");
      process.stderr.write("diagnostic output");
    });
    process.stdin.resume();
  `;

  it("gives analysis processes immediate EOF while capturing stdout and stderr", async () => {
    const output: string[] = [];
    const command = defaultLongRunningCommandStarter(
      process.execPath, ["-e", readStdin], os.tmpdir(), (text) => output.push(text),
    );
    const result = await command.wait();
    assert.deepStrictEqual(result, {
      exitCode: 0,
      stdout: "stdin reached EOF",
      stderr: "diagnostic output",
    });
    assert.strictEqual(command.stdout(), result.stdout);
    assert.strictEqual(command.stderr(), result.stderr);
    assert.ok(output.join("").includes(result.stdout));
    assert.ok(output.join("").includes(result.stderr));
  });

  it("also closes stdin for short-lived environment and discovery commands", async () => {
    const output: string[] = [];
    const result = await defaultCommandRunner(
      process.execPath, ["-e", readStdin], os.tmpdir(), (text) => output.push(text),
    );
    assert.deepStrictEqual(result, {
      stdout: "stdin reached EOF",
      stderr: "diagnostic output",
    });
    assert.ok(output.join("").includes(result.stdout));
    assert.ok(output.join("").includes(result.stderr));
  });
});

describe("MLIA environment discovery", () => {
  it("returns targets and all package versions together", () => {
    assert.deepStrictEqual(parseMliaEnvironment(environmentDiscovery()), {
      targets: parseMliaTargets(JSON.stringify(targetDiscovery())), packageVersions,
    });
    for (const response of ["not json", "[]", '{}', '{"targets":[],"packageVersions":{"mlia":""}}']) {
      assert.throws(() => parseMliaEnvironment(response), /MLIA environment query/);
    }
  });

  it("discovers real distribution metadata without importing optional MLIA packages", async () => {
    const fixture = await makeFixture();
    const modules = path.join(fixture.extensionPath, "discovery-fixture");
    await fs.mkdir(path.join(modules, "mlia"), { recursive: true });
    await fs.writeFile(path.join(modules, "mlia", "__init__.py"), "");
    await fs.writeFile(path.join(modules, "mlia", "api.py"), "def list_targets(): return []\n");
    for (const [name, version] of [["mlia", "1.2.3"], ["MLIA_Neural.Technology", "2.0.0"], ["requests", "3.0.0"]]) {
      const info = path.join(modules, `${name}-${version}.dist-info`);
      await fs.mkdir(info);
      await fs.writeFile(path.join(info, "METADATA"), `Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n`);
    }
    const runCommand: CommandRunner = (_command, args, cwd, output, options) => defaultCommandRunner(
      process.env.PYTHON ?? "uv",
      process.env.PYTHON ? ["-S", ...args.slice(2)] : ["run", "--no-project", "python", "-S", ...args.slice(2)],
      cwd, output, options,
    );
    const details = await queryMliaEnvironment(modules, "uv", runCommand, {}, { PYTHONPATH: modules });
    assert.deepStrictEqual(details, { targets: [], packageVersions });
  });
});

describe("parseMliaTargets", () => {
  it("preserves the target, backend and mode capability hierarchy", () => {
    assert.deepStrictEqual(parseMliaTargets(JSON.stringify(targetDiscovery())), [
      {
        name: "neural-technology",
        prettyName: "Neural Technology",
        profiles: ["ethos-u55", "ethos-u65"],
        backends: [
          {
            name: "estimator",
            prettyName: "Estimator",
            default: true,
            selectable: true,
            capabilities: {
              estimation: ["performance", "compatibility"],
              profiling: [],
            },
          },
          {
            name: "profiling",
            prettyName: "Profiling",
            default: false,
            selectable: false,
            capabilities: {
              estimation: [],
              profiling: ["performance"],
            },
          },
        ],
      },
    ]);
  });

  it("throws for invalid or incomplete discovery JSON", () => {
    assert.throws(() => parseMliaTargets("not-json"), /invalid JSON/);
    assert.throws(() => parseMliaTargets(JSON.stringify({})), /unexpected JSON/);
    assert.throws(() => parseMliaTargets(JSON.stringify([{}])), /incomplete target entry/);
    const invalid = targetDiscovery() as Array<Record<string, unknown>>;
    invalid[0].backends = [{}];
    assert.throws(() => parseMliaTargets(JSON.stringify(invalid)), /incomplete backend entry/);
  });
});

describe("parseRuntimeEnv", () => {
  it("parses comments, plain values, and quoted values", () => {
    assert.deepStrictEqual(
      parseRuntimeEnv("# comment\nFOO=bar\nJSON_VALUE={...}\nQUOTED=\"hello world\"\nSINGLE='x y'\n"),
      {
        FOO: "bar",
        JSON_VALUE: "{...}",
        QUOTED: "hello world",
        SINGLE: "x y",
      },
    );
  });

  it("rejects malformed lines", () => {
    assert.throws(() => parseRuntimeEnv("NO_SEPARATOR"), /expected KEY=VALUE/);
  });

  it("rejects invalid variable names", () => {
    assert.throws(() => parseRuntimeEnv("1_BAD=value"), /invalid variable name/);
  });
});

describe("refreshPythonRuntime", () => {
  it("creates a missing venv, syncs packages, verifies MLIA, and returns target profiles", async () => {
    const fixture = await makeFixture();
    const calls: string[] = [];
    const runCommand: CommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (args.includes("--version")) {
        return { stdout: "MLIA 1.2.3\n", stderr: "" };
      }
      if (args.includes("-c")) {
        return { stdout: environmentDiscovery(), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    const result = await refreshPythonRuntime({ ...fixture, runCommand });

    assert.deepStrictEqual(result, {
      ok: true,
      status: "ready",
      runtimeDir: path.join(fixture.globalStoragePath, "python"),
      version: "MLIA 1.2.3",
      targets: parseMliaTargets(JSON.stringify(targetDiscovery())),
      packageVersions,
    });
    assert.deepStrictEqual(calls.slice(0, 3), [
      `uv venv ${path.join(fixture.globalStoragePath, "python", ".venv")}`,
      "uv sync",
      "uv run mlia --version",
    ]);
    assert.strictEqual(calls.length, 4);
    assert.ok(calls[3].startsWith("uv run python -c "));
  });

  it("puts the bundled flat index before development indexes and retains remote fallback", async () => {
    const fixture = await makeFixture();
    const resources = path.join(fixture.extensionPath, "resources", "python-runtime");
    const wheelhouse = path.join(resources, "wheelhouse");
    await fs.mkdir(wheelhouse);
    const dev = '[[tool.uv.index]]\nname = "internal"\nurl = "https://example.invalid/simple"\n';
    await fs.writeFile(path.join(resources, "pyproject.dev.toml"), dev);
    const generated: string[] = [];
    const logs: string[] = [];
    const runCommand: CommandRunner = async (_command, args, cwd) => {
      if (args[0] === "sync") {
        generated.push(await fs.readFile(path.join(cwd, "pyproject.toml"), "utf8"));
      }
      return { stdout: args.includes("-c") ? environmentDiscovery([]) : "MLIA test", stderr: "" };
    };
    const result = await refreshPythonRuntime({ ...fixture, runCommand, log: (text) => logs.push(text) });
    assert.strictEqual(result.ok, true);
    const base = await fs.readFile(path.join(resources, "pyproject.toml"), "utf8");
    assert.deepStrictEqual(generated, [
      '[[tool.uv.index]]\nname = "bundled"\nurl = ' + JSON.stringify(pathToFileURL(wheelhouse).href) +
      '\nformat = "flat"\n\n' + base.trimEnd() + "\n\n" + dev.trim() + "\n",
    ]);
    assert.ok(logs.includes(`Using bundled Python wheelhouse: ${wheelhouse}`));
  });

  it("removes the bundled index when refreshing a public distribution in the same storage", async () => {
    const fixture = await makeFixture();
    const resources = path.join(fixture.extensionPath, "resources", "python-runtime");
    const wheelhouse = path.join(resources, "wheelhouse");
    await fs.mkdir(wheelhouse);
    const runCommand: CommandRunner = async (_command, args) => ({
      stdout: args.includes("-c") ? environmentDiscovery([]) : "MLIA test", stderr: "",
    });
    assert.strictEqual((await refreshPythonRuntime({ ...fixture, runCommand })).ok, true);
    await fs.rmdir(wheelhouse);
    assert.strictEqual((await refreshPythonRuntime({ ...fixture, runCommand })).ok, true);
    assert.strictEqual(
      await fs.readFile(path.join(fixture.globalStoragePath, "python", "pyproject.toml"), "utf8"),
      await fs.readFile(path.join(resources, "pyproject.toml"), "utf8"),
    );
  });

  it("encodes spaces and URL-sensitive characters in the wheelhouse location", async () => {
    const fixture = await makeFixture();
    const extensionPath = fixture.extensionPath + " space # café";
    await fs.rename(fixture.extensionPath, extensionPath);
    const resources = path.join(extensionPath, "resources", "python-runtime");
    const wheelhouse = path.join(resources, "wheelhouse");
    await fs.mkdir(wheelhouse);
    const result = await refreshPythonRuntime({ ...fixture, extensionPath, runCommand: async (_command, args) => ({
      stdout: args.includes("-c") ? environmentDiscovery([]) : "MLIA test", stderr: "",
    }) });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(
      await fs.readFile(path.join(fixture.globalStoragePath, "python", "pyproject.toml"), "utf8"),
      '[[tool.uv.index]]\nname = "bundled"\nurl = ' + JSON.stringify(pathToFileURL(wheelhouse).href) +
      '\nformat = "flat"\n\n' + await fs.readFile(path.join(resources, "pyproject.toml"), "utf8"),
    );
  });

  it("fails before running uv when the wheelhouse path is not a directory", async () => {
    const fixture = await makeFixture();
    await fs.writeFile(path.join(fixture.extensionPath, "resources", "python-runtime", "wheelhouse"), "not a directory");
    let calls = 0;
    const result = await refreshPythonRuntime({ ...fixture, runCommand: async () => {
      calls += 1;
      return { stdout: "", stderr: "" };
    } });
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.strictEqual(result.stage, "prepare");
      assert.match(result.message, /wheelhouse is not a directory/);
    }
    assert.strictEqual(calls, 0);
  });

  it("invalidates the lock only when the generated project or bundled wheel contents change", async () => {
    const fixture = await makeFixture();
    const resources = path.join(fixture.extensionPath, "resources", "python-runtime");
    const wheelhouse = path.join(resources, "wheelhouse");
    await fs.mkdir(wheelhouse);
    const wheel = path.join(wheelhouse, "mlia-1.0.0-py3-none-any.whl");
    await fs.writeFile(wheel, "first wheel content");
    const retained: boolean[] = [];
    const runCommand: CommandRunner = async (_command, args, cwd) => {
      if (args[0] === "sync") {
        const lock = path.join(cwd, "uv.lock");
        retained.push(await fs.stat(lock).then(() => true, () => false));
        await fs.writeFile(lock, "test-generated lock");
      }
      return { stdout: args.includes("-c") ? environmentDiscovery([]) : "MLIA test", stderr: "" };
    };
    const refresh = async () => assert.strictEqual((await refreshPythonRuntime({ ...fixture, runCommand })).ok, true);
    await refresh();
    await refresh();
    await fs.writeFile(wheel, "other wheel content");
    await refresh();
    await fs.rm(wheelhouse, { recursive: true });
    await refresh();
    await refresh();
    await fs.appendFile(path.join(resources, "pyproject.toml"), "# release change\n");
    await refresh();
    assert.deepStrictEqual(retained, [false, true, false, false, true, false]);
  });

  it("reuses an existing venv", async () => {
    const fixture = await makeFixture();
    await fs.mkdir(path.join(fixture.globalStoragePath, "python", ".venv"), { recursive: true });
    const calls: string[] = [];
    const runCommand: CommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (args.includes("--version")) {
        return { stdout: "MLIA 1.2.3\n", stderr: "" };
      }
      if (args.includes("-c")) {
        return { stdout: environmentDiscovery(["ethos-u55"]), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    const result = await refreshPythonRuntime({ ...fixture, runCommand });

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(calls.slice(0, 2), [
      "uv sync --reinstall",
      "uv run mlia --version",
    ]);
    assert.strictEqual(calls.length, 3);
    assert.ok(calls[2].startsWith("uv run python -c "));
  });

  it("deletes the existing runtime directory when forceRecreateVenv is set", async () => {
    const fixture = await makeFixture();
    const runtimeDir = path.join(fixture.globalStoragePath, "python");
    const staleVenvFile = path.join(runtimeDir, ".venv", "stale.txt");
    const staleLockFile = path.join(runtimeDir, "uv.lock");
    const staleGeneratedFile = path.join(runtimeDir, "stale-generated-file.txt");
    await fs.mkdir(path.dirname(staleVenvFile), { recursive: true });
    await fs.writeFile(staleVenvFile, "stale", "utf8");
    await fs.writeFile(staleLockFile, "stale lock", "utf8");
    await fs.writeFile(staleGeneratedFile, "stale generated file", "utf8");
    const calls: string[] = [];
    const runCommand: CommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (args.includes("--version")) {
        return { stdout: "MLIA 1.2.3\n", stderr: "" };
      }
      if (args.includes("-c")) {
        return { stdout: environmentDiscovery(["ethos-u55"]), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    const result = await refreshPythonRuntime({ ...fixture, forceRecreateVenv: true, runCommand });

    assert.strictEqual(result.ok, true);
    await assert.rejects(fs.stat(staleVenvFile), /ENOENT/);
    await assert.rejects(fs.stat(staleLockFile), /ENOENT/);
    await assert.rejects(fs.stat(staleGeneratedFile), /ENOENT/);
    assert.strictEqual(
      await fs.readFile(path.join(runtimeDir, "pyproject.toml"), "utf8"),
      `[project]\nname = "vscode-mlia-runtime"\nversion = "0.0.0"\ndependencies = ["mlia"]\n`,
    );
    assert.deepStrictEqual(calls[0], `uv venv ${path.join(runtimeDir, ".venv")}`);
    assert.deepStrictEqual(calls[1], "uv sync --reinstall");
  });

  it("reports noTargetProfiles as a successful warning status", async () => {
    const fixture = await makeFixture();
    const runCommand: CommandRunner = async (_command, args) => {
      if (args.includes("--version")) {
        return { stdout: "MLIA 1.2.3\n", stderr: "" };
      }
      if (args.includes("-c")) {
        return { stdout: JSON.stringify({ targets: [], packageVersions }), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    const result = await refreshPythonRuntime({ ...fixture, runCommand });

    assert.deepStrictEqual(result, {
      ok: true,
      status: "noTargetProfiles",
      runtimeDir: path.join(fixture.globalStoragePath, "python"),
      version: "MLIA 1.2.3",
      targets: [],
      packageVersions,
    });
  });

  it("reports command failures with the failing stage", async () => {
    const fixture = await makeFixture();
    const runCommand: CommandRunner = async (command, args, cwd) => {
      if (args[0] === "sync") {
        throw new CommandExecutionError("sync failed", command, args, cwd, 1, "", "sync failed");
      }
      return { stdout: "", stderr: "" };
    };

    const result = await refreshPythonRuntime({ ...fixture, runCommand });

    assert.deepStrictEqual(result, {
      ok: false,
      kind: "commandFailed",
      runtimeDir: path.join(fixture.globalStoragePath, "python"),
      stage: "sync",
      message: "sync failed",
    });
  });

  it("reports invalid target profile JSON", async () => {
    const fixture = await makeFixture();
    const runCommand: CommandRunner = async (_command, args) => {
      if (args.includes("--version")) {
        return { stdout: "MLIA 1.2.3\n", stderr: "" };
      }
      if (args.includes("-c")) {
        return { stdout: "not-json", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    const result = await refreshPythonRuntime({ ...fixture, runCommand });

    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.strictEqual(result.kind, "invalidTargetJson");
      assert.strictEqual(result.stage, "queryTargets");
      assert.match(result.message, /invalid JSON/);
    }
  });

  it("reports IO errors", async () => {
    const fixture = await makeFixture();
    await fs.rm(path.join(fixture.extensionPath, "resources", "python-runtime", "pyproject.toml"));

    const result = await refreshPythonRuntime({ ...fixture, runCommand: async () => ({ stdout: "", stderr: "" }) });

    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.strictEqual(result.kind, "io");
      assert.strictEqual(result.stage, "prepare");
      assert.match(result.message, /pyproject\.toml/);
    }
  });
});

describe("getModelExplorerHtmlPath", () => {
  it("returns the generated standalone Model Explorer HTML path", () => {
    assert.strictEqual(
      getModelExplorerHtmlPath("C:/scratch/model"),
      path.join("C:/scratch/model", "mlia-output", "model-explorer", "bundle", "index.html"),
    );
  });
});

describe("getStandardizedOutputPath", () => {
  it("returns the Model Explorer copy of MLIA standardized output", () => {
    assert.strictEqual(
      getStandardizedOutputPath("C:/scratch/model"),
      path.join("C:/scratch/model", "mlia-output", "model-explorer", "standardized-output.json"),
    );
  });
});

describe("getEntityNodeMappingsPath", () => {
  it("returns the Model Explorer entity-node mappings path", () => {
    assert.strictEqual(
      getEntityNodeMappingsPath("C:/scratch/model"),
      path.join("C:/scratch/model", "mlia-output", "model-explorer", "entity-node-mappings.json"),
    );
  });
});

describe("queryMliaEulaText", () => {
  it("reads terms using the managed runtime and the mapped Python property", async () => {
    const fixture = await makeFixture();
    const definition = requiredEula("neural-technology", "estimation")!;
    const text = "Licence text: café < & >\nsecond line";
    const calls: unknown[] = [];
    assert.strictEqual(await queryMliaEulaText({
      ...fixture,
      uvExecutable: undefined,
      definition,
      packageVersion: "2.0.0",
      runCommand: async (command, args, cwd, _output, options) => {
        calls.push({ command, prefix: args.slice(0, 3), source: args.slice(-3), cwd, env: options?.env });
        return { stdout: JSON.stringify({ text, packageVersion: "2.0.0" }), stderr: "" };
      },
    }), text);
    assert.deepStrictEqual(calls, [{
      command: getManagedUvPath(fixture.globalStoragePath),
      prefix: ["run", "python", "-c"],
      source: [definition.pythonModule, definition.pythonProperty, definition.packageName],
      cwd: path.join(fixture.globalStoragePath, "python"),
      env: { ...managedUvEnvironment(fixture.globalStoragePath), PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    }]);
  });

  it("rejects malformed or empty licence responses", async () => {
    const fixture = await makeFixture();
    for (const stdout of ["not json", "null", "{}", '{"text":123}', '{"text":"  "}']) {
      await assert.rejects(queryMliaEulaText({
        ...fixture,
        definition: requiredEula("neural-technology", "estimation")!,
        packageVersion: "2.0.0",
        runCommand: async () => ({ stdout, stderr: "" }),
      }), /Unable to read.*EULA/);
    }
  });

  it("executes the real query against a Python module and reports a missing licence", async () => {
    const fixture = await makeFixture();
    const runtime = path.join(fixture.globalStoragePath, "python");
    const moduleDir = path.join(fixture.extensionPath, "test-modules");
    await fs.mkdir(runtime, { recursive: true });
    await fs.mkdir(moduleDir);
    const distInfo = path.join(moduleDir, "fixture_eula-2.0.0.dist-info");
    await fs.mkdir(distInfo);
    await fs.writeFile(path.join(distInfo, "METADATA"), "Metadata-Version: 2.1\nName: fixture-eula\nVersion: 2.0.0\n");
    await fs.writeFile(path.join(moduleDir, "fixture_eula.py"),
      'from pathlib import Path\nTERMS_FILE = Path(__file__).with_name("terms.txt")\n');
    const terms = path.join(moduleDir, "terms.txt");
    await fs.writeFile(terms, "Actual fixture terms: café\n");
    await fs.writeFile(path.join(fixture.extensionPath, "resources", "python-runtime", ".env"),
      `PYTHONPATH=${moduleDir}\n`);
    const options = {
      ...fixture,
      packageVersion: "2.0.0",
      definition: {
        ...requiredEula("neural-technology", "estimation")!,
        packageName: "fixture-eula",
        pythonModule: "fixture_eula",
        pythonProperty: "TERMS_FILE",
      },
      runCommand: ((_command, args, cwd, output, settings) => defaultCommandRunner(
        process.env.PYTHON ?? "uv",
        process.env.PYTHON ? args.slice(2) : ["run", "--no-project", ...args.slice(1)],
        cwd, output, settings,
      )) as CommandRunner,
    };
    assert.strictEqual(await queryMliaEulaText(options), "Actual fixture terms: café\n");
    await assert.rejects(queryMliaEulaText({ ...options, packageVersion: "1.0.0" }), /differs from the cached version/);
    await fs.rm(terms);
    await assert.rejects(queryMliaEulaText(options), /Unable to read.*EULA/);
  });
});

describe("runMliaCheckPerformance", () => {
  for (const [accepted, extraArgs, expectedCount] of [
    [false, [], 0],
    [true, [], 1],
    [false, ["--i-agree-to-the-contained-eula"], 1],
  ] as const) {
    it(`adds EULA acceptance only from consent or explicit user arguments (${accepted}, ${extraArgs.length})`, async () => {
      const fixture = await makeFixture();
      const outputDir = path.join(fixture.globalStoragePath, "run");
      await fs.mkdir(outputDir, { recursive: true });
      let launched: string[] = [];
      await runMliaCheckPerformance({
        ...fixture, outputDir,
        modelPath: "model.tflite", profilingDataPaths: [], targetProfile: "neural-technology",
        analysisOptions: { performance: true, compatibility: false }, configContent: "",
        acceptEula: accepted, extraArgs,
        startCommand: (_command, args) => {
          launched = args;
          return { stdout: () => "", stderr: () => "", stop: () => undefined,
            wait: async () => ({ exitCode: 1, stdout: "", stderr: "test launch only" }) };
        },
      });
      assert.ok(launched.includes("--noninteractive"));
      assert.strictEqual(launched.filter((arg) => arg === "--i-agree-to-the-contained-eula").length, expectedCount);
      if (extraArgs.length) {
        assert.deepStrictEqual(launched.slice(-extraArgs.length), [...extraArgs]);
      }
    });
  }

  it("uses the already allocated persistent output directory and waits for generated HTML", async () => {
    const fixture = await makeFixture();
    await fs.writeFile(
      path.join(fixture.extensionPath, "resources", "python-runtime", ".env"),
      "PYTHONPATH=C:/torch-regor/src\nNE_MODEL_PATH=C:/nepal/bin/nepal.exe\nPYTHONIOENCODING=local\n",
      "utf8",
    );
    const outputDir = path.join(fixture.globalStoragePath, "analysis-runs", "analysis-id");
    await fs.mkdir(outputDir, { recursive: true });
    const calls: string[][] = [];
    const environments: Array<Record<string, string> | undefined> = [];
    const startCommand: LongRunningCommandStarter = (command, args, _cwd, _output, options) => {
      calls.push([command, ...args]);
      environments.push(options?.env);
      return {
        stdout: () => "",
        stderr: () => "",
        wait: async () => {
          const bundleDir = path.join(outputDir, "mlia-output", "model-explorer", "bundle");
          await fs.mkdir(bundleDir, { recursive: true });
          await fs.writeFile(path.join(bundleDir, "index.html"), "<html>Model Explorer</html>", "utf8");
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        stop: () => undefined,
      };
    };

    const result = await runMliaCheckPerformance({
      extensionPath: fixture.extensionPath,
      globalStoragePath: fixture.globalStoragePath,
      modelPath: "C:/models/model.tflite",
      profilingDataPaths: [
        "relative/captures/profile-a",
        "relative/captures/profile-b",
      ],
      targetProfile: "neural-technology",
      analysisOptions: { performance: true, compatibility: true },
      configContent: "[filtering]\ncollapse = []\n",
      extraArgs: ["--foo", "bar value"],
      startCommand,
      outputDir,
      parentPid: 1234,
    });

    assert.deepStrictEqual(result, {
      ok: true,
      runtimeDir: path.join(fixture.globalStoragePath, "python"),
    });
    assert.strictEqual(
      await fs.readFile(getMliaConfigPath(fixture.globalStoragePath), "utf8"),
      "[filtering]\ncollapse = []\n",
    );
    assert.deepStrictEqual(environments, [{
      PYTHONPATH: "C:/torch-regor/src",
      NE_MODEL_PATH: "C:/nepal/bin/nepal.exe",
      ...managedUvEnvironment(fixture.globalStoragePath),
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    }]);
    assert.deepStrictEqual(calls, [[
      getManagedUvPath(fixture.globalStoragePath),
      "run",
      "python",
      path.join(fixture.extensionPath, "resources", "python-runtime", "mlia_watchdog.py"),
      "--parent-pid",
      "1234",
      "--config-file",
      getMliaConfigPath(fixture.globalStoragePath),
      "--",
      "check",
      "C:/models/model.tflite",
      "--target-profile",
      "neural-technology",
      "--performance",
      "--compatibility",
      "--profiling-data",
      "relative/captures/profile-a",
      "--profiling-data",
      "relative/captures/profile-b",
      "--output-dir",
      outputDir,
      "--model-explorer",
      "files",
      "--debug",
      "--noninteractive",
      "--foo",
      "bar value",
    ]]);
  });

  it("rejects an analysis with no selected type before launch", async () => {
    const fixture = await makeFixture();
    const outputDir = path.join(fixture.globalStoragePath, "analysis-runs", "analysis-id");
    await fs.mkdir(outputDir, { recursive: true });
    let launches = 0;

    const result = await runMliaCheckPerformance({
      extensionPath: fixture.extensionPath,
      globalStoragePath: fixture.globalStoragePath,
      modelPath: "C:/models/model.tflite",
      profilingDataPaths: [],
      targetProfile: "neural-technology",
      analysisOptions: { performance: false, compatibility: false },
      configContent: "",
      outputDir,
      startCommand: () => {
        launches += 1;
        throw new Error("must not launch");
      },
    });

    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.message, /Select at least one MLIA analysis type/);
    }
    assert.strictEqual(launches, 0);
  });

  it("appends advanced user arguments unchanged", async () => {
    const fixture = await makeFixture();
    const outputDir = path.join(fixture.globalStoragePath, "analysis-runs", "analysis-id");
    await fs.mkdir(outputDir, { recursive: true });
    const extraArgs = [
      "--output-dir",
      "C:/other",
      "--model-explorer=open",
      "--performance",
      "--compatibility",
    ];
    let launchedArgs: string[] = [];
    const startCommand: LongRunningCommandStarter = (_command, args) => {
      launchedArgs = args;
      return {
        stdout: () => "",
        stderr: () => "",
        wait: async () => {
          const bundleDir = path.join(outputDir, "mlia-output", "model-explorer", "bundle");
          await fs.mkdir(bundleDir, { recursive: true });
          await fs.writeFile(path.join(bundleDir, "index.html"), "<html></html>", "utf8");
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        stop: () => undefined,
      };
    };

    const result = await runMliaCheckPerformance({
      extensionPath: fixture.extensionPath,
      globalStoragePath: fixture.globalStoragePath,
      profilingDataPaths: ["profiles/profile.json"],
      targetProfile: "neural-technology",
      analysisOptions: { performance: true, compatibility: false },
      configContent: "",
      extraArgs,
      outputDir,
      startCommand,
    });

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(
      launchedArgs.slice(launchedArgs.indexOf("check"), launchedArgs.indexOf("--output-dir")),
      [
        "check",
        "--target-profile",
        "neural-technology",
        "--performance",
        "--profiling-data",
        "profiles/profile.json",
      ],
    );
    assert.deepStrictEqual(launchedArgs.slice(-extraArgs.length), extraArgs);
    assert.ok(launchedArgs.includes("--noninteractive"));
    assert.ok(!launchedArgs.includes("--i-agree-to-the-contained-eula"));
    assert.ok(!launchedArgs.includes("--accept-eula"));
  });

  it("turns EULA-required errors into extension guidance while retaining raw log output", async () => {
    const fixture = await makeFixture();
    const outputDir = path.join(fixture.globalStoragePath, "run");
    await fs.mkdir(outputDir, { recursive: true });
    for (const summary of [
      "EULA acceptance required for one or more backends. Pass accept_eula=True to proceed.",
      "EULA acceptance required for backend(s): nx-performance-estimator. Pass accept_eula=True (or --accept-eula in the CLI) to proceed.",
    ]) {
      const stderr = `MLIA_WATCHDOG_ERROR_SUMMARY: ${summary}`;
      const logs: string[] = [];
      const result = await runMliaCheckPerformance({
        ...fixture, outputDir,
        modelPath: "model.tflite", profilingDataPaths: [], targetProfile: "neural-technology",
        analysisOptions: { performance: true, compatibility: false }, configContent: "",
        log: (text) => logs.push(text),
        startCommand: (_command, _args, _cwd, output) => {
          output(stderr);
          return { stdout: () => "", stderr: () => stderr, stop: () => undefined,
            wait: async () => ({ exitCode: 1, stdout: "", stderr }) };
        },
      });
      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.strictEqual(result.message,
          "EULA acceptance is required. Run the analysis again and accept the EULA to continue.");
      }
      assert.ok(logs.join("\n").includes(summary));
    }
  });

  it("uses the watchdog error summary from the final stderr line", async () => {
    const fixture = await makeFixture();
    const outputDir = path.join(fixture.globalStoragePath, "analysis-runs", "analysis-id");
    await fs.mkdir(outputDir, { recursive: true });
    const stderr = [
      "Traceback details remain available in the log.",
      "MLIA_WATCHDOG_ERROR_SUMMARY: Profiling data does not match the expected capture layout.",
    ].join("\n");
    const startCommand: LongRunningCommandStarter = () => ({
      stdout: () => "",
      stderr: () => stderr,
      wait: async () => ({ stdout: "", stderr, exitCode: 2 }),
      stop: () => undefined,
    });

    const result = await runMliaCheckPerformance({
      extensionPath: fixture.extensionPath,
      globalStoragePath: fixture.globalStoragePath,
      modelPath: "C:/models/model.tflite",
      profilingDataPaths: [],
      targetProfile: "neural-technology",
      analysisOptions: { performance: true, compatibility: false },
      configContent: "",
      startCommand,
      outputDir,
      parentPid: 1234,
    });

    assert.deepStrictEqual(result, {
      ok: false,
      kind: "commandFailed",
      runtimeDir: path.join(fixture.globalStoragePath, "python"),
      stage: "checkPerformance",
      message: "Profiling data does not match the expected capture layout.",
    });
  });

  it("uses a generic exit-code error when no valid final watchdog summary exists", async () => {
    const fixture = await makeFixture();
    const outputDir = path.join(fixture.globalStoragePath, "analysis-runs", "analysis-id");
    await fs.mkdir(outputDir, { recursive: true });
    const invalidStderrValues = [
      "check failed",
      "MLIA_WATCHDOG_ERROR_SUMMARY: Earlier summary\ntrailing output",
      "MLIA_WATCHDOG_ERROR_SUMMARY:   ",
    ];

    for (const stderr of invalidStderrValues) {
      const result = await runMliaCheckPerformance({
        extensionPath: fixture.extensionPath,
        globalStoragePath: fixture.globalStoragePath,
        modelPath: "C:/models/model.tflite",
        profilingDataPaths: [],
        targetProfile: "neural-technology",
        analysisOptions: { performance: true, compatibility: false },
        configContent: "",
        outputDir,
        parentPid: 1234,
        startCommand: () => ({
          stdout: () => "",
          stderr: () => stderr,
          wait: async () => ({ stdout: "", stderr, exitCode: 7 }),
          stop: () => undefined,
        }),
      });

      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.strictEqual(
          result.message,
          "MLIA exited with code 7. No error summary was provided.",
        );
      }
    }
  });
});
