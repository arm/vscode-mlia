import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";

import { refreshPythonRuntime } from "../pythonRuntime";

// Opt-in: exercise real uv resolution using tiny fixture distributions and a
// local HTTP index. Neither the resolver nor the extension runtime is mocked.
const uv = process.env.MLIA_TEST_UV;
const python = process.env.MLIA_TEST_PYTHON;

it("uses bundled wheels before remote versions, reconciles releases, and rejects incompatible bundles", {
  skip: !uv || !python,
  timeout: 120_000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mlia-wheelhouse-integration-"));
  const extensionPath = path.join(root, "extension space # café");
  const globalStoragePath = path.join(root, "storage");
  const resources = path.join(extensionPath, "resources", "python-runtime");
  const wheelhouse = path.join(resources, "wheelhouse");
  const remote = path.join(root, "remote");
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url ?? "");
    void (async () => {
      if (request.url === "/index") {
        const files = await fs.readdir(remote);
        response.setHeader("Content-Type", "text/html");
        response.end(files.map((file) => '<a href="/files/' + file + '">' + file + '</a>').join("\n"));
      } else {
        const file = path.basename(decodeURIComponent(request.url ?? ""));
        const data = await fs.readFile(path.join(remote, file));
        response.setHeader("Content-Type", "application/octet-stream");
        response.end(data);
      }
    })().catch(() => { response.statusCode = 404; response.end(); });
  });

  const buildWheel = async (directory: string, name: string, version: string, displayVersion = version) => {
    await fs.mkdir(directory, { recursive: true });
    // These are minimal test packages, not copies of MLIA's implementation.
    const script = [
      "import base64, csv, hashlib, io, pathlib, sys, zipfile",
      "directory, name, version, display_version = sys.argv[1:]",
      "dist = name.replace('-', '_')",
      "info = dist + '-' + version + '.dist-info'",
      "metadata = 'Metadata-Version: 2.3\\nName: ' + name + '\\nVersion: ' + version + '\\nRequires-Python: >=3.12,<3.13\\n'",
      "files = {}",
      "if name == 'mlia':",
      " metadata += 'Requires-Dist: wheelhouse-test-helper==1.0.0\\n'",
      " files['mlia/__init__.py'] = 'def main(): print(\"MLIA ' + display_version + '\")\\n'",
      " files['mlia/api.py'] = 'import wheelhouse_test_helper\\ndef list_targets(): return []\\n'",
      " files[info + '/entry_points.txt'] = '[console_scripts]\\nmlia = mlia:main\\n'",
      "else: files['wheelhouse_test_helper.py'] = 'VALUE = 1\\n'",
      "files[info + '/METADATA'] = metadata",
      "files[info + '/WHEEL'] = 'Wheel-Version: 1.0\\nGenerator: fixture\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n'",
      "rows = io.StringIO(newline='')",
      "writer = csv.writer(rows)",
      "with zipfile.ZipFile(pathlib.Path(directory) / (dist + '-' + version + '-py3-none-any.whl'), 'w') as archive:",
      " for file, text in files.items():",
      "  data = text.encode()",
      "  archive.writestr(file, data)",
      "  writer.writerow([file, 'sha256=' + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b'=').decode(), len(data)])",
      " writer.writerow([info + '/RECORD', '', ''])",
      " archive.writestr(info + '/RECORD', rows.getvalue())",
    ].join("\n");
    execFileSync(python!, ["-c", script, directory, name, version, displayVersion]);
  };

  try {
    await fs.mkdir(resources, { recursive: true });
    await buildWheel(remote, "mlia", "9.0.0");
    await buildWheel(remote, "wheelhouse-test-helper", "1.0.0");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const pyproject = (requirement = "mlia") => [
      "[project]", 'name = "wheelhouse-test-runtime"', 'version = "0.0.0"',
      'requires-python = ">=3.12,<3.13"', 'dependencies = ["' + requirement + '"]',
      "", "[[tool.uv.index]]", 'name = "test-public"',
      'url = "http://127.0.0.1:' + address.port + '/index"', 'format = "flat"', "default = true", "",
    ].join("\n");
    await fs.writeFile(path.join(resources, "pyproject.toml"), pyproject());
    // Reuse a supplied interpreter, but not an installed package environment or
    // uv cache. Refresh still invokes the real uv sync and run commands.
    await fs.mkdir(path.join(globalStoragePath, "python"), { recursive: true });
    execFileSync(uv!, ["venv", "--python", python!, path.join(globalStoragePath, "python", ".venv")]);
    const refresh = async (version: string) => {
      const logs: string[] = [];
      const result = await refreshPythonRuntime({ extensionPath, globalStoragePath, uvExecutable: uv, log: (text) => logs.push(text) });
      assert.ok(result.ok, JSON.stringify(result) + "\n" + logs.join("\n"));
      if (result.ok) assert.equal(result.version, "MLIA " + version);
    };
    await refresh("9.0.0");
    await buildWheel(wheelhouse, "mlia", "1.0.0");
    await refresh("1.0.0");
    await fs.rm(wheelhouse, { recursive: true });
    await refresh("9.0.0");
    await buildWheel(wheelhouse, "mlia", "1.0.0");
    await refresh("1.0.0");
    await fs.unlink(path.join(wheelhouse, "mlia-1.0.0-py3-none-any.whl"));
    await buildWheel(wheelhouse, "mlia", "2.0.0");
    await refresh("2.0.0");
    await buildWheel(wheelhouse, "mlia", "2.0.0", "2.0.0-rebuilt");
    await refresh("2.0.0-rebuilt");
    await fs.writeFile(path.join(resources, "pyproject.toml"), pyproject("mlia==9.0.0"));
    const rejected = await refreshPythonRuntime({ extensionPath, globalStoragePath, uvExecutable: uv });
    assert.equal(rejected.ok, false, "a public version must not replace an incompatible bundle");
    if (!rejected.ok) assert.equal(rejected.stage, "sync");
    await fs.writeFile(path.join(resources, "pyproject.toml"), pyproject());
    await refresh("2.0.0-rebuilt");
    assert.ok(requests.some((url) => url.includes("wheelhouse_test_helper-1.0.0")), "public transitive dependency fetched over HTTP");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
