import * as childProcess from "child_process";
import { createHash } from "crypto";
import * as fsSync from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import { pathToFileURL } from "url";

import {
  ensureManagedUv,
  getManagedUvPath,
  managedUvEnvironment,
} from "./uvBootstrap";

const runtimeInputsFileName = "runtime-inputs.sha256";

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface CommandRunnerOptions {
  env?: Record<string, string>;
}

export type CommandRunner = (
  command: string,
  args: string[],
  cwd: string,
  output: (text: string) => void,
  options?: CommandRunnerOptions,
) => Promise<CommandResult>;

export interface RunningCommandResult extends CommandResult {
  exitCode: number | null;
}

export interface RunningCommand {
  stdout: () => string;
  stderr: () => string;
  wait: () => Promise<RunningCommandResult>;
  stop: () => void;
}

export type LongRunningCommandStarter = (
  command: string,
  args: string[],
  cwd: string,
  output: (text: string) => void,
  options?: CommandRunnerOptions,
) => RunningCommand;

export type RefreshStage = "bootstrapUv" | "prepare" | "createVenv" | "sync" | "verify" | "queryTargets";
export type MliaCheckPerformanceStage = "checkPerformance";

export type MliaAnalysisMode = "estimation" | "profiling";
export type MliaAnalysisCategory = "performance" | "compatibility";

export interface MliaBackendCapabilities {
  estimation: MliaAnalysisCategory[];
  profiling: MliaAnalysisCategory[];
}

export interface MliaBackend {
  name: string;
  prettyName: string;
  default: boolean;
  selectable: boolean;
  capabilities: MliaBackendCapabilities;
}

export interface MliaTarget {
  name: string;
  prettyName: string;
  profiles: string[];
  backends: MliaBackend[];
}

export interface RefreshPythonRuntimeOptions {
  extensionPath: string;
  globalStoragePath: string;
  forceRecreateVenv?: boolean;
  uvExecutable?: string;
  runCommand?: CommandRunner;
  log?: (message: string) => void;
  progress?: (message: string) => void;
}

export type RefreshPythonRuntimeResult =
  | {
      ok: true;
      status: "ready" | "noTargetProfiles";
      runtimeDir: string;
      version: string;
      targets: MliaTarget[];
    }
  | {
      ok: false;
      kind: "commandFailed" | "invalidTargetJson" | "io" | "unknown";
      runtimeDir: string;
      stage: RefreshStage;
      message: string;
    };

export class CommandExecutionError extends Error {
  public constructor(
    message: string,
    public readonly command: string,
    public readonly args: string[],
    public readonly cwd: string,
    public readonly exitCode: number | null,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(message);
  }
}

class TargetProfileJsonError extends Error {}

export interface MliaAnalysisOptions {
  performance: boolean;
  compatibility: boolean;
}

export interface MliaCheckPerformanceOptions {
  extensionPath: string;
  globalStoragePath: string;
  modelPath?: string;
  profilingDataPaths: readonly string[];
  targetProfile: string;
  analysisOptions: MliaAnalysisOptions;
  configContent: string;
  extraArgs?: readonly string[];
  uvExecutable?: string;
  runCommand?: CommandRunner;
  startCommand?: LongRunningCommandStarter;
  outputDir: string;
  parentPid?: number;
  log?: (message: string) => void;
}

export type MliaCheckPerformanceResult =
  | {
      ok: true;
      runtimeDir: string;
    }
  | {
      ok: false;
      kind: "commandFailed" | "unknown";
      runtimeDir: string;
      stage: MliaCheckPerformanceStage;
      message: string;
    };

export interface StartedMliaCheckPerformance {
  runtimeDir: string;
  outputDir: string;
  modelExplorerHtmlPath: string;
  standardizedOutputPath: string;
  entityNodeMappingsPath: string;
  command: RunningCommand;
  completion: Promise<string>;
}

export async function refreshPythonRuntime(
  options: RefreshPythonRuntimeOptions,
): Promise<RefreshPythonRuntimeResult> {
  const runtimeDir = getPythonRuntimeDir(options.globalStoragePath);
  const runCommand = options.runCommand ?? defaultCommandRunner;
  let stage: RefreshStage = "bootstrapUv";

  try {
    const uvExecutable = options.uvExecutable ?? await ensureManagedUv({
      globalStoragePath: options.globalStoragePath,
      force: options.forceRecreateVenv,
      log: options.log,
      progress: options.progress,
    });
    const venvDir = path.join(runtimeDir, ".venv");

    log(options, "Refreshing MLIA Python venv");
    log(options, `Runtime directory: ${runtimeDir}`);

    stage = "prepare";
    if (options.forceRecreateVenv && (await pathExists(runtimeDir))) {
      progress(options, "Deleting existing Python runtime");
      log(options, `Deleting existing Python runtime directory: ${runtimeDir}`);
      await fs.rm(runtimeDir, { recursive: true, force: true });
    }

    await fs.mkdir(runtimeDir, { recursive: true });
    const runtimeEnv = {
      ...await readRuntimeEnv(options.extensionPath, options),
      ...managedUvEnvironment(options.globalStoragePath),
    };
    const runtimeInputs = await writeRuntimePyproject(options.extensionPath, runtimeDir, options);
    const hasVenv = await pathExists(venvDir);

    if (!hasVenv) {
      stage = "createVenv";
      progress(options, "Creating venv");
      await runRuntimeCommand(runCommand, uvExecutable, ["venv", venvDir], runtimeDir, options, runtimeEnv);
    } else {
      log(options, `Using existing venv: ${venvDir}`);
    }

    stage = "sync";
    progress(options, "Installing MLIA packages");
    const syncArgs = ["sync"];
    if (options.forceRecreateVenv || (runtimeInputs.changed && hasVenv)) {
      // Reinstall also refreshes uv's cache. This covers both force refreshes
      // and changed release inputs, including rebuilt same-version wheels.
      syncArgs.push("--reinstall");
    }
    await runRuntimeCommand(runCommand, uvExecutable, syncArgs, runtimeDir, options, runtimeEnv);

    stage = "verify";
    progress(options, "Verifying MLIA");
    const version = await runRuntimeCommand(runCommand, uvExecutable, ["run", "mlia", "--version"], runtimeDir, options, runtimeEnv);

    stage = "queryTargets";
    progress(options, "Querying MLIA target profiles");
    const targets = await queryMliaTargets(runtimeDir, uvExecutable, runCommand, options, runtimeEnv);
    await fs.writeFile(path.join(runtimeDir, runtimeInputsFileName), runtimeInputs.fingerprint, "utf8");
    const targetProfiles = targets.flatMap(({ profiles }) => profiles);
    log(options, `Found ${targetProfiles.length} MLIA target profile(s): ${targetProfiles.join(", ")}`);

    return {
      ok: true,
      status: targetProfiles.length === 0 ? "noTargetProfiles" : "ready",
      runtimeDir,
      version: version.stdout.trim(),
      targets,
    };
  } catch (error) {
    return failureResult(error, runtimeDir, stage);
  }
}

export async function runMliaCheckPerformance(
  options: MliaCheckPerformanceOptions,
): Promise<MliaCheckPerformanceResult> {
  const runtimeDir = getPythonRuntimeDir(options.globalStoragePath);
  const stage: MliaCheckPerformanceStage = "checkPerformance";

  try {
    const started = startMliaCheckPerformance(options);
    await started.completion;
    return { ok: true, runtimeDir };
  } catch (error) {
    if (error instanceof CommandExecutionError) {
      return {
        ok: false,
        kind: "commandFailed",
        runtimeDir,
        stage,
        message: error.message,
      };
    }

    return {
      ok: false,
      kind: "unknown",
      runtimeDir,
      stage,
      message: errorMessage(error),
    };
  }
}

export function startMliaCheckPerformance(options: MliaCheckPerformanceOptions): StartedMliaCheckPerformance {
  validateAnalysisOptions(options.analysisOptions);
  const runtimeDir = getPythonRuntimeDir(options.globalStoragePath);
  const configPath = writeRuntimeConfigSync(runtimeDir, options.configContent);
  const outputDir = options.outputDir;
  if (!fsSync.statSync(outputDir).isDirectory()) {
    throw new Error(`MLIA output path is not a directory: ${outputDir}`);
  }
  const startCommand = options.startCommand ?? defaultLongRunningCommandStarter;
  const uvExecutable = options.uvExecutable ?? getManagedUvPath(options.globalStoragePath);
  const runtimeEnv = {
    ...readRuntimeEnvSync(options.extensionPath, options),
    ...managedUvEnvironment(options.globalStoragePath),
  };
  if (!options.modelPath && options.profilingDataPaths.length === 0) {
    throw new Error("A source model or profiling data path is required.");
  }
  const mliaArgs = [
    "check",
    ...(options.modelPath ? [options.modelPath] : []),
    "--target-profile",
    options.targetProfile,
    ...(options.analysisOptions.performance ? ["--performance"] : []),
    ...(options.analysisOptions.compatibility ? ["--compatibility"] : []),
    ...options.profilingDataPaths.flatMap((profilingDataPath) => [
      "--profiling-data",
      profilingDataPath,
    ]),
    "--output-dir",
    outputDir,
    "--model-explorer",
    "files",
    "--debug",
    ...(options.extraArgs ?? []),
  ];
  const args = [
    "run",
    "python",
    path.join(options.extensionPath, "resources", "python-runtime", "mlia_watchdog.py"),
    "--parent-pid",
    String(options.parentPid ?? process.pid),
    "--config-file",
    configPath,
    "--",
    ...mliaArgs,
  ];
  const command = startRuntimeCommand(startCommand, uvExecutable, args, runtimeDir, options, {
    ...runtimeEnv,
    // Windows pipes are byte streams without an encoding label. Tell Python to
    // encode stdout/stderr as UTF-8 so Node's Buffer.toString("utf8") and VS Code's
    // Unicode output APIs interpret MLIA table output consistently.
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  });
  const modelExplorerHtmlPath = getModelExplorerHtmlPath(outputDir);
  const standardizedOutputPath = getStandardizedOutputPath(outputDir);
  const entityNodeMappingsPath = getEntityNodeMappingsPath(outputDir);
  return {
    runtimeDir,
    outputDir,
    modelExplorerHtmlPath,
    standardizedOutputPath,
    entityNodeMappingsPath,
    command,
    completion: waitForModelExplorerHtml(command, uvExecutable, args, runtimeDir, modelExplorerHtmlPath, options),
  };
}

function validateAnalysisOptions(options: MliaAnalysisOptions): void {
  if (!options.performance && !options.compatibility) {
    throw new Error("Select at least one MLIA analysis type.");
  }
}

export function getPythonRuntimeDir(globalStoragePath: string): string {
  return path.join(globalStoragePath, "python");
}

export function getMliaConfigPath(globalStoragePath: string): string {
  return path.join(getPythonRuntimeDir(globalStoragePath), "mlia-config.toml");
}

function writeRuntimeConfigSync(runtimeDir: string, content: string): string {
  fsSync.mkdirSync(runtimeDir, { recursive: true });
  const configPath = path.join(runtimeDir, "mlia-config.toml");
  fsSync.writeFileSync(configPath, content, "utf8");
  return configPath;
}

async function readRuntimeEnv(
  extensionPath: string,
  options: { log?: (message: string) => void },
): Promise<Record<string, string>> {
  const envPath = getRuntimeEnvPath(extensionPath);

  try {
    const content = await fs.readFile(envPath, "utf8");
    return parseAndLogRuntimeEnv(content, envPath, options);
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
    log(options, "No runtime environment file found");
    return {};
  }
}

function readRuntimeEnvSync(
  extensionPath: string,
  options: { log?: (message: string) => void },
): Record<string, string> {
  const envPath = getRuntimeEnvPath(extensionPath);

  try {
    const content = fsSync.readFileSync(envPath, "utf8");
    return parseAndLogRuntimeEnv(content, envPath, options);
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
    log(options, "No runtime environment file found");
    return {};
  }
}

function getRuntimeEnvPath(extensionPath: string): string {
  return path.join(extensionPath, "resources", "python-runtime", ".env");
}

function parseAndLogRuntimeEnv(
  content: string,
  envPath: string,
  options: { log?: (message: string) => void },
): Record<string, string> {
  const env = parseRuntimeEnv(content);
  log(options, `Loaded ${Object.keys(env).length} runtime environment variable(s): ${envPath}`);
  return env;
}

export function parseRuntimeEnv(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex < 1) {
      throw new Error(`Invalid runtime .env line ${index + 1}: expected KEY=VALUE`);
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw new Error(`Invalid runtime .env line ${index + 1}: invalid variable name '${key}'`);
    }

    env[key] = unquoteRuntimeEnvValue(value);
  }

  return env;
}

function unquoteRuntimeEnvValue(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value) as string;
  }

  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }

  return value;
}

async function writeRuntimePyproject(
  extensionPath: string,
  runtimeDir: string,
  options: RefreshPythonRuntimeOptions,
): Promise<{ fingerprint: string; changed: boolean }> {
  const pythonRuntimeResourceDir = path.join(extensionPath, "resources", "python-runtime");
  const basePath = path.join(pythonRuntimeResourceDir, "pyproject.toml");
  const devPath = path.join(pythonRuntimeResourceDir, "pyproject.dev.toml");
  const destinationPath = path.join(runtimeDir, "pyproject.toml");

  log(options, `Reading runtime pyproject: ${basePath}`);
  let content = await fs.readFile(basePath, "utf8");

  try {
    const devContent = await fs.readFile(devPath, "utf8");
    log(options, `Appending runtime development pyproject: ${devPath}`);
    content = `${content.trimEnd()}\n\n${devContent.trim()}\n`;
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
    log(options, "No runtime development pyproject found");
  }

  const wheelhousePath = path.join(pythonRuntimeResourceDir, "wheelhouse");
  let hasWheelhouse = false;
  try {
    const stat = await fs.stat(wheelhousePath);
    if (!stat.isDirectory()) {
      throw new Error(`Bundled Python wheelhouse is not a directory: ${wheelhousePath}`);
    }
    hasWheelhouse = true;
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  }

  const inputHash = createHash("sha256");
  if (hasWheelhouse) {
    // Hash actual wheel contents, not just names: replacing a same-version test
    // wheel must not leave uv using an earlier cached lockfile selection.
    const wheels = (await fs.readdir(wheelhousePath)).filter((file) => file.endsWith(".whl")).sort();
    for (const wheel of wheels) {
      const wheelHash = createHash("sha256");
      for await (const chunk of fsSync.createReadStream(path.join(wheelhousePath, wheel))) {
        wheelHash.update(chunk);
      }
      inputHash.update(JSON.stringify([wheel, wheelHash.digest("hex")]));
    }

    // A flat index participates in uv's first-index policy. Unlike a default
    // index, it leaves PyPI available for packages not included in the release.
    // Prepend it so development indexes cannot take precedence over the bundle.
    const index = [
      "[[tool.uv.index]]",
      'name = "bundled"',
      `url = ${JSON.stringify(pathToFileURL(wheelhousePath).href)}`,
      'format = "flat"',
      "",
      "",
    ].join("\n");
    content = index + content;
    log(options, `Using bundled Python wheelhouse: ${wheelhousePath}`);
  } else {
    log(options, "No bundled Python wheelhouse; using configured remote indexes");
  }

  const fingerprint = inputHash.update(content).digest("hex");
  const fingerprintPath = path.join(runtimeDir, runtimeInputsFileName);
  let previousFingerprint: string | undefined;
  try {
    previousFingerprint = await fs.readFile(fingerprintPath, "utf8");
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  }
  const changed = previousFingerprint !== fingerprint;
  if (changed) {
    // uv can retain a locked remote selection after a higher-priority index is
    // added. Re-resolve when release inputs change, but retain the lock on an
    // ordinary refresh of the same release.
    // Remove the success stamp before changing anything. A failed refresh,
    // even followed by a rollback to older inputs, must retry the reinstall.
    await fs.rm(fingerprintPath, { force: true });
    await fs.rm(path.join(runtimeDir, "uv.lock"), { force: true });
    log(options, "Runtime package inputs changed; discarding generated uv.lock");
  }
  await fs.writeFile(destinationPath, content, "utf8");
  return { fingerprint, changed };
}

async function queryMliaTargets(
  runtimeDir: string,
  uvExecutable: string,
  runCommand: CommandRunner,
  options: RefreshPythonRuntimeOptions,
  env: Record<string, string>,
): Promise<MliaTarget[]> {
  const pythonSnippet = [
    "import json",
    "from mlia.api import list_targets",
    "print(json.dumps(list_targets()))",
  ].join("; ");
  const result = await runRuntimeCommand(runCommand, uvExecutable, ["run", "python", "-c", pythonSnippet], runtimeDir, options, env);
  return parseMliaTargets(result.stdout);
}

export function parseMliaTargets(output: string): MliaTarget[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new TargetProfileJsonError(`MLIA target query returned invalid JSON: ${errorMessage(error)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new TargetProfileJsonError("MLIA target query returned unexpected JSON");
  }

  const categories = (value: unknown): MliaAnalysisCategory[] => {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new TargetProfileJsonError("MLIA target query returned invalid backend capabilities");
    }
    return value.filter(
      (item): item is MliaAnalysisCategory => item === "performance" || item === "compatibility",
    );
  };

  return parsed.map((entry): MliaTarget => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new TargetProfileJsonError("MLIA target query returned an invalid target entry");
    }
    const target = entry as Record<string, unknown>;
    if (
      typeof target.target !== "string" ||
      typeof target.pretty_name !== "string" ||
      !Array.isArray(target.profiles) ||
      target.profiles.some((profile) => typeof profile !== "string") ||
      !Array.isArray(target.backends)
    ) {
      throw new TargetProfileJsonError("MLIA target query returned an incomplete target entry");
    }

    const backends = target.backends.map((entry): MliaBackend => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new TargetProfileJsonError("MLIA target query returned an invalid backend entry");
      }
      const backend = entry as Record<string, unknown>;
      const capabilities = backend.capabilities;
      if (
        typeof backend.name !== "string" ||
        typeof backend.pretty_name !== "string" ||
        typeof backend.default !== "boolean" ||
        typeof backend.selectable !== "boolean" ||
        typeof capabilities !== "object" ||
        capabilities === null ||
        Array.isArray(capabilities)
      ) {
        throw new TargetProfileJsonError("MLIA target query returned an incomplete backend entry");
      }
      const modes = capabilities as Record<string, unknown>;
      return {
        name: backend.name,
        prettyName: backend.pretty_name,
        default: backend.default,
        selectable: backend.selectable,
        capabilities: {
          estimation: categories(modes.estimation),
          profiling: categories(modes.profiling),
        },
      };
    });

    return {
      name: target.target,
      prettyName: target.pretty_name,
      profiles: [...new Set(target.profiles as string[])].sort(),
      backends,
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return false;
    }

    throw error;
  }
}

async function runRuntimeCommand(
  runCommand: CommandRunner,
  command: string,
  args: string[],
  cwd: string,
  options: { log?: (message: string) => void },
  env: Record<string, string> = {},
): Promise<CommandResult> {
  const commandLine = formatCommandLine(command, args);
  log(options, `> ${commandLine}`);
  try {
    const result = await runCommand(command, args, cwd, (text) => output(options, text), { env });
    log(options, "< exited 0");
    return result;
  } catch (error) {
    if (error instanceof CommandExecutionError) {
      log(options, `< exited ${error.exitCode ?? "unknown"}`);
    }
    throw error;
  }
}

function startRuntimeCommand(
  startCommand: LongRunningCommandStarter,
  command: string,
  args: string[],
  cwd: string,
  options: { log?: (message: string) => void },
  env: Record<string, string> = {},
): RunningCommand {
  log(options, `> ${formatCommandLine(command, args)}`);
  return startCommand(command, args, cwd, (text) => output(options, text), { env });
}

async function waitForModelExplorerHtml(
  runningCommand: RunningCommand,
  command: string,
  args: string[],
  cwd: string,
  modelExplorerHtmlPath: string,
  options: { log?: (message: string) => void },
): Promise<string> {
  const result = await runningCommand.wait();
  if (result.exitCode !== 0) {
    throw mliaCommandExecutionError(command, args, cwd, result);
  }

  if (!(await pathExists(modelExplorerHtmlPath))) {
    throw new Error(`MLIA performance check completed without generating ${modelExplorerHtmlPath}.`);
  }

  log(options, `Model Explorer HTML: ${modelExplorerHtmlPath}`);
  return modelExplorerHtmlPath;
}

export function getModelExplorerHtmlPath(outputDir: string): string {
  return path.join(outputDir, "mlia-output", "model-explorer", "bundle", "index.html");
}

export function getStandardizedOutputPath(outputDir: string): string {
  return path.join(outputDir, "mlia-output", "model-explorer", "standardized-output.json");
}

export function getEntityNodeMappingsPath(outputDir: string): string {
  return path.join(outputDir, "mlia-output", "model-explorer", "entity-node-mappings.json");
}

export function defaultCommandRunner(
  command: string,
  args: string[],
  cwd: string,
  output: (text: string) => void,
  options: CommandRunnerOptions = {},
): Promise<CommandResult> {
  const runningCommand = defaultLongRunningCommandStarter(command, args, cwd, output, options);
  return runningCommand.wait().then((result) => {
    if (result.exitCode === 0) {
      return { stdout: result.stdout, stderr: result.stderr };
    }

    throw commandExecutionError(command, args, cwd, result);
  });
}

export function defaultLongRunningCommandStarter(
  command: string,
  args: string[],
  cwd: string,
  output: (text: string) => void,
  options: CommandRunnerOptions = {},
): RunningCommand {
  const child = childProcess.spawn(command, args, {
    cwd,
    env: { ...process.env, ...options.env },
    windowsHide: true,
  });

  let stdout = "";
  let stderr = "";
  let settledResult: RunningCommandResult | undefined;
  let waitPromise: Promise<RunningCommandResult> | undefined;
  let stopped = false;

  child.stdout.on("data", (data: Buffer) => {
    const text = data.toString();
    stdout += text;
    output(text);
  });

  child.stderr.on("data", (data: Buffer) => {
    const text = data.toString();
    stderr += text;
    output(text);
  });

  const wait = () => {
    waitPromise ??= new Promise<RunningCommandResult>((resolve, reject) => {
      child.on("error", (error) => reject(error));
      child.on("close", (code) => {
        settledResult = { stdout, stderr, exitCode: code };
        resolve(settledResult);
      });
    });
    return waitPromise;
  };

  return {
    stdout: () => stdout,
    stderr: () => stderr,
    wait,
    stop: () => {
      if (!settledResult && !stopped) {
        stopped = true;
        if (process.platform === "win32" && child.pid !== undefined) {
          childProcess.spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
          return;
        }
        child.kill();
      }
    },
  };
}

const watchdogErrorSummaryPrefix = "MLIA_WATCHDOG_ERROR_SUMMARY: ";

function mliaCommandExecutionError(
  command: string,
  args: string[],
  cwd: string,
  result: RunningCommandResult,
): CommandExecutionError {
  return new CommandExecutionError(
    mliaFailureMessage(result.stderr, result.exitCode),
    command,
    args,
    cwd,
    result.exitCode,
    result.stdout,
    result.stderr,
  );
}

function mliaFailureMessage(stderr: string, exitCode: number | null): string {
  const finalLine = stderr
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
  if (finalLine?.startsWith(watchdogErrorSummaryPrefix)) {
    const summary = finalLine.slice(watchdogErrorSummaryPrefix.length).trim();
    if (summary) {
      return summary;
    }
  }
  return `MLIA exited with code ${exitCode ?? "unknown"}. No error summary was provided.`;
}

function commandExecutionError(
  command: string,
  args: string[],
  cwd: string,
  result: RunningCommandResult,
): CommandExecutionError {
  return new CommandExecutionError(
    `${formatCommandLine(command, args)} failed with exit code ${result.exitCode}`,
    command,
    args,
    cwd,
    result.exitCode,
    result.stdout,
    result.stderr,
  );
}

function formatCommandLine(command: string, args: string[]): string {
  return [command, ...args].map(formatCommandArgument).join(" ");
}

function formatCommandArgument(argument: string): string {
  if (/^[A-Za-z0-9_./:=+@-]+$/u.test(argument)) {
    return argument;
  }

  return JSON.stringify(argument);
}

function failureResult(error: unknown, runtimeDir: string, stage: RefreshStage): RefreshPythonRuntimeResult {
  if (error instanceof CommandExecutionError) {
    return {
      ok: false,
      kind: "commandFailed",
      runtimeDir,
      stage,
      message: error.message,
    };
  }

  if (error instanceof TargetProfileJsonError) {
    return {
      ok: false,
      kind: "invalidTargetJson",
      runtimeDir,
      stage,
      message: error.message,
    };
  }

  if (isFileSystemError(error)) {
    return {
      ok: false,
      kind: "io",
      runtimeDir,
      stage,
      message: errorMessage(error),
    };
  }

  return {
    ok: false,
    kind: "unknown",
    runtimeDir,
    stage,
    message: errorMessage(error),
  };
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isFileSystemError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function log(options: { log?: (message: string) => void }, message: string): void {
  options.log?.(message);
}

function output(options: { log?: (message: string) => void }, text: string): void {
  const trimmed = text.replace(/[\r\n]+$/u, "");
  if (trimmed) {
    options.log?.(trimmed);
  }
}

function progress(options: { progress?: (message: string) => void }, message: string): void {
  options.progress?.(message);
}
