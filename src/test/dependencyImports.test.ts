import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { ESLint } from "eslint";

const projectRoot = path.resolve(__dirname, "../..");
const configPath = path.join(projectRoot, "eslint.config.cjs");
const config = require(configPath);
const dependencyRule = "import-x/no-extraneous-dependencies";
const resolutionRule = "import-x/no-unresolved";

// Minimal installed packages let the real resolver distinguish a missing module
// from an installed but undeclared or development-only dependency.
async function installFixturePackage(root: string, name: string): Promise<void> {
  const directory = path.join(root, "node_modules", name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({
    name, version: "1.0.0", main: "index.js", types: "index.d.ts",
    dependencies: name === "fixture-runtime" ? { "fixture-transitive": "1.0.0" } : {},
  }));
  await fs.writeFile(path.join(directory, "index.js"), "exports.value = 1;\n");
  await fs.writeFile(path.join(directory, "feature.js"), "exports.value = 2;\n");
  await fs.writeFile(path.join(directory, "index.d.ts"), "export interface Options { value: number }\n");
}

describe("dependency import policy", () => {
  let root: string;
  let eslint: ESLint;

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mlia-import-policy-"));
    await fs.mkdir(path.join(root, "src/test"), { recursive: true });
    await fs.mkdir(path.join(root, "scripts"), { recursive: true });
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
      name: "import-policy-fixture", version: "1.0.0",
      dependencies: { "fixture-runtime": "1.0.0", "@fixture/runtime": "1.0.0" },
      devDependencies: { "fixture-build": "1.0.0", "@fixture/build": "1.0.0" },
      optionalDependencies: { "fixture-optional": "1.0.0" },
      peerDependencies: { "fixture-peer": "1.0.0" },
      bundledDependencies: ["fixture-bundled"],
    }));
    for (const name of ["fixture-runtime", "@fixture/runtime", "fixture-build", "@fixture/build",
      "fixture-transitive", "fixture-undeclared", "fixture-optional", "fixture-peer", "fixture-bundled"]) {
      await installFixturePackage(root, name);
    }
    eslint = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: config });
  });

  after(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  const cases = [
    { name: "allows a declared production package", source: 'import { value } from "fixture-runtime";' },
    { name: "allows a scoped production package", source: 'import { value } from "@fixture/runtime";' },
    { name: "allows a production package subpath", source: 'import { value } from "fixture-runtime/feature";' },
    { name: "allows Node built-ins", source: 'import * as fs from "node:fs"; import * as path from "path";' },
    { name: "allows the VS Code host module", source: 'import * as vscode from "vscode";' },
    { name: "allows erased type-only development imports", source: 'import type { Options } from "fixture-build";' },
    { name: "allows inline type-only development imports", source: 'import { type Options } from "fixture-build";' },
    { name: "allows development imports in tests", file: "src/test/example.test.ts", source: 'import { value } from "fixture-build";' },
    { name: "allows development imports in build scripts", file: "scripts/build.cjs", source: 'const tools = require("fixture-build");' },
    { name: "allows development imports in the lint configuration", file: "eslint.config.cjs", source: 'const tools = require("fixture-build");' },
    { name: "rejects a development-only runtime import", source: 'import { value } from "fixture-build";', rule: dependencyRule },
    { name: "rejects a scoped development-only runtime import", source: 'import { value } from "@fixture/build";', rule: dependencyRule },
    { name: "rejects a development-only CommonJS require", source: 'const tools = require("fixture-build");', rule: dependencyRule },
    { name: "rejects a development-only literal dynamic import", source: 'const tools = import("fixture-build");', rule: dependencyRule },
    { name: "rejects a development-only re-export", source: 'export { value } from "fixture-build";', rule: dependencyRule },
    { name: "rejects a development import in TSX runtime code", file: "src/component.tsx", source: 'import { value } from "fixture-build";', rule: dependencyRule },
    { name: "rejects an installed undeclared package", source: 'import { value } from "fixture-undeclared";', rule: dependencyRule },
    { name: "rejects a direct import of a transitive-only package", source: 'import { value } from "fixture-transitive";', rule: dependencyRule },
    { name: "rejects an optional-only dependency", source: 'import { value } from "fixture-optional";', rule: dependencyRule },
    { name: "rejects a peer-only dependency", source: 'import { value } from "fixture-peer";', rule: dependencyRule },
    { name: "rejects a bundled-only dependency", source: 'import { value } from "fixture-bundled";', rule: dependencyRule },
    { name: "rejects an uninstalled undeclared package", source: 'import { value } from "fixture-missing";', rule: resolutionRule },
    { name: "rejects undeclared imports even in tests", file: "src/test/example.test.ts", source: 'import { value } from "fixture-undeclared";', rule: dependencyRule },
  ];

  for (const example of cases) {
    it(example.name, async () => {
      const [result] = await eslint.lintText(example.source, {
        filePath: path.join(root, example.file ?? "src/runtime.ts"),
      });
      const diagnostics = JSON.stringify(result.messages);
      assert.equal(result.fatalErrorCount, 0, diagnostics);
      if (example.rule) {
        assert.ok(result.messages.some(message => message.ruleId === example.rule && message.severity === 2), diagnostics);
      } else {
        assert.equal(result.errorCount, 0, diagnostics);
        assert.equal(result.warningCount, 0, diagnostics);
      }
    });
  }
});

it("the actual bundle command blocks a misclassified runtime package and succeeds after correction", {
  timeout: 60_000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mlia-bundle-dependencies-"));
  const modules = path.join(root, "node_modules");
  let linked = false;
  try {
    // Use the real toolchain and configuration, not a copy of the checks.
    await fs.symlink(path.join(projectRoot, "node_modules"), modules, process.platform === "win32" ? "junction" : "dir");
    linked = true;
    await fs.writeFile(path.join(root, "eslint.config.cjs"), `module.exports = require(${JSON.stringify(configPath)});\n`);
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src/extension.ts"), 'export { x } from "tar";\n');
    const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
    const tarVersion = manifest.dependencies.tar;
    delete manifest.dependencies.tar;
    manifest.devDependencies.tar = tarVersion;
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify(manifest));

    const bundle = () => {
      const npmCli = process.env.npm_execpath;
      const command = npmCli ? process.execPath : process.platform === "win32" ? "cmd.exe" : "npm";
      const args = npmCli ? [npmCli, "--prefix", root, "run", "bundle"]
        : process.platform === "win32" ? ["/d", "/s", "/c", "npm run bundle"]
        : ["run", "bundle"];
      return spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 25_000 });
    };
    const rejected = bundle();
    assert.ifError(rejected.error);
    assert.notEqual(rejected.status, null, rejected.stderr);
    assert.notEqual(rejected.status, 0, rejected.stdout);
    assert.match(rejected.stdout + rejected.stderr, /import-x\/no-extraneous-dependencies/);
    await assert.rejects(fs.stat(path.join(root, "dist/extension.js")), { code: "ENOENT" });

    manifest.dependencies.tar = tarVersion;
    delete manifest.devDependencies.tar;
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
    const accepted = bundle();
    assert.ifError(accepted.error);
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
    const built = require(path.join(root, "dist/extension.js"));
    assert.equal(typeof built.x, "function");
  } finally {
    if (linked) await fs.unlink(modules);
    await fs.rm(root, { recursive: true, force: true });
  }
});
