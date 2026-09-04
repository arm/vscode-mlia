import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, it } from "node:test";

import {
  CommandExecutionError,
  CommandRunner,
  LongRunningCommandStarter,
  parseMliaTargets,
  getEntityNodeMappingsPath,
  getMliaConfigPath,
  getModelExplorerHtmlPath,
  getStandardizedOutputPath,
  parseRuntimeEnv,
  refreshPythonRuntime,
  runMliaCheckPerformance,
} from "../pythonRuntime";
import { getManagedUvPath, managedUvEnvironment } from "../uvBootstrap";

const tempDirs: string[] = [];

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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mlia-vscode-test-"));
  tempDirs.push(root);

  const extensionPath = path.join(root, "extension");
  const globalStoragePath = path.join(root, "storage");
  const runtimeResourcePath = path.join(extensionPath, "resources", "python-runtime");

  await fs.mkdir(runtimeResourcePath, { recursive: true });
  await fs.writeFile(
    path.join(runtimeResourcePath, "pyproject.toml"),
    `[project]\nname = "mlia-vscode-runtime"\nversion = "0.0.0"\ndependencies = ["mlia"]\n`,
    "utf8",
  );

  return { extensionPath, globalStoragePath, uvExecutable: "uv" };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
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
        return { stdout: JSON.stringify(targetDiscovery()), stderr: "" };
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
    });
    assert.deepStrictEqual(calls, [
      `uv venv ${path.join(fixture.globalStoragePath, "python", ".venv")}`,
      "uv sync",
      "uv run mlia --version",
      "uv run python -c import json; from mlia.api import list_targets; print(json.dumps(list_targets()))",
    ]);
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
        return { stdout: JSON.stringify(targetDiscovery(["ethos-u55"])), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    const result = await refreshPythonRuntime({ ...fixture, runCommand });

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(calls, [
      "uv sync",
      "uv run mlia --version",
      "uv run python -c import json; from mlia.api import list_targets; print(json.dumps(list_targets()))",
    ]);
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
        return { stdout: JSON.stringify(targetDiscovery(["ethos-u55"])), stderr: "" };
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
      `[project]\nname = "mlia-vscode-runtime"\nversion = "0.0.0"\ndependencies = ["mlia"]\n`,
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
        return { stdout: "[]", stderr: "" };
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

describe("runMliaCheckPerformance", () => {
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
