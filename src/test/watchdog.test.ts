import * as assert from "assert";
import { spawnSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, it } from "node:test";

const tempDirs: string[] = [];
const errorSummaryPrefix = "MLIA_WATCHDOG_ERROR_SUMMARY: ";

interface WatchdogResult {
  status: number | null;
  stderr: string;
}

async function runWatchdog(statements: string[]): Promise<WatchdogResult> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mlia-watchdog-test-"));
  tempDirs.push(root);
  const cliDir = path.join(root, "mlia", "cli");
  await fs.mkdir(cliDir, { recursive: true });
  await fs.writeFile(path.join(root, "mlia", "__init__.py"), "", "utf8");
  await fs.writeFile(path.join(cliDir, "__init__.py"), "", "utf8");
  await fs.writeFile(
    path.join(cliDir, "main.py"),
    [
      "import sys",
      "from mlia.cli import settings",
      "",
      "def main():",
      ...statements.map((statement) => `    ${statement}`),
      "",
    ].join("\n"),
    "utf8",
  );

  await fs.writeFile(path.join(cliDir, "settings.py"), "_CONFIG_PATH = None\n", "utf8");
  const configPath = path.join(root, "managed-config.toml");
  await fs.writeFile(configPath, "managed = true\n", "utf8");

  const watchdogPath = path.resolve(
    __dirname,
    "..",
    "..",
    "resources",
    "python-runtime",
    "mlia_watchdog.py",
  );
  const watchdogArgs = [
    watchdogPath,
    "--parent-pid",
    String(process.pid),
    "--config-file",
    configPath,
    "--",
    "check",
  ];
  const configuredPython = process.env.PYTHON;
  const command = configuredPython ?? "uv";
  const args = configuredPython
    ? watchdogArgs
    : ["run", "--no-project", "python", ...watchdogArgs];
  const pythonPath = process.env.PYTHONPATH
    ? `${root}${path.delimiter}${process.env.PYTHONPATH}`
    : root;
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: pythonPath },
    windowsHide: true,
  });
  assert.strictEqual(result.error, undefined);
  return {
    status: result.status,
    stderr: result.stderr,
  };
}

function finalNonEmptyLine(text: string): string | undefined {
  return text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).at(-1);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("MLIA watchdog", () => {
  it("applies the extension-managed MLIA configuration before execution", async () => {
    const result = await runWatchdog([
      'assert settings._CONFIG_PATH.read_text(encoding="utf-8") == "managed = true\\n"',
    ]);

    assert.strictEqual(result.status, 0);
  });

  it("summarizes an explicit MLIA CLI error after its existing stderr output", async () => {
    const result = await runWatchdog([
      'sys.stderr.write(b"Error: Explicit failure.\\n")',
      "raise SystemExit(7)",
    ]);

    assert.strictEqual(result.status, 7);
    assert.match(result.stderr, /Error: Explicit failure\./);
    assert.strictEqual(
      finalNonEmptyLine(result.stderr),
      `${errorSummaryPrefix}Explicit failure.`,
    );
  });

  it("prints an escaped exception traceback followed by its single-line summary", async () => {
    const result = await runWatchdog([
      'raise RuntimeError("Implicit failure\\nwith details")',
    ]);

    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /Traceback \(most recent call last\):/);
    assert.strictEqual(
      finalNonEmptyLine(result.stderr),
      `${errorSummaryPrefix}Implicit failure with details`,
    );
  });

  it("does not invent a summary for an unexplained non-zero exit", async () => {
    const result = await runWatchdog(["raise SystemExit(3)"]);

    assert.strictEqual(result.status, 3);
    assert.strictEqual(result.stderr.includes(errorSummaryPrefix), false);
  });

  it("does not emit an error summary after successful completion", async () => {
    const result = await runWatchdog(["return"]);

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stderr.includes(errorSummaryPrefix), false);
  });
});
