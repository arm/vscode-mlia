import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  ensureManagedUv,
  EnsureManagedUvOptions,
  getManagedUvPath,
  LinuxLibc,
  managedUvEnvironment,
  managedUvVersion,
  UvAsset,
  uvAssetForPlatform,
} from "../uvBootstrap";
import { zipFixture } from "./zipFixture";

const tempDirs: string[] = [];
const scripts = `uv-${managedUvVersion}.data/scripts`;

async function makeStorage(): Promise<string> {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-mlia-uv-test-"));
  tempDirs.push(storage);
  return storage;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function testAsset(wheel: Buffer): UvAsset {
  return {
    target: "test",
    wheelName: `uv-${managedUvVersion}-py3-none-test.whl`,
    downloadUrl: "https://example.invalid/uv-test.whl",
    sha256: sha256(wheel),
  };
}

async function installOptions(wheel: Buffer, platform: NodeJS.Platform = "win32"): Promise<EnsureManagedUvOptions> {
  return {
    globalStoragePath: await makeStorage(),
    platform,
    asset: testAsset(wheel),
    download: async (_url, destination) => { await fs.writeFile(destination, wheel); },
  };
}

async function assertNoStaging(storage: string): Promise<void> {
  const names = await fs.readdir(path.join(storage, "tools", "uv", managedUvVersion));
  assert.equal(names.some(name => name.startsWith(".staging-")), false);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("uvAssetForPlatform", () => {
  const cases: Array<[NodeJS.Platform, string, LinuxLibc, string, string]> = [
    ["win32", "x64", "gnu", "x86_64-pc-windows-msvc", "win_amd64"],
    ["win32", "arm64", "gnu", "aarch64-pc-windows-msvc", "win_arm64"],
    ["win32", "ia32", "gnu", "i686-pc-windows-msvc", "win32"],
    ["darwin", "x64", "gnu", "x86_64-apple-darwin", "macosx_10_12_x86_64"],
    ["darwin", "arm64", "gnu", "aarch64-apple-darwin", "macosx_11_0_arm64"],
    ["linux", "x64", "gnu", "x86_64-unknown-linux-gnu", "manylinux_2_17_x86_64.manylinux2014_x86_64"],
    ["linux", "x64", "musl", "x86_64-unknown-linux-musl", "musllinux_1_1_x86_64"],
    ["linux", "arm64", "gnu", "aarch64-unknown-linux-gnu", "manylinux_2_17_aarch64.manylinux2014_aarch64.musllinux_1_1_aarch64"],
    ["linux", "arm64", "musl", "aarch64-unknown-linux-musl", "manylinux_2_17_aarch64.manylinux2014_aarch64.musllinux_1_1_aarch64"],
  ];
  for (const [platform, arch, libc, target, tag] of cases) {
    it(`selects a pinned wheel for ${target}`, () => {
      const asset = uvAssetForPlatform(platform, arch, libc);
      assert.equal(asset.target, target);
      assert.equal(asset.wheelName, `uv-${managedUvVersion}-py3-none-${tag}.whl`);
      const url = new URL(asset.downloadUrl);
      assert.equal(url.protocol, "https:");
      assert.equal(url.hostname, "files.pythonhosted.org");
      assert.equal(path.posix.basename(url.pathname), asset.wheelName);
      assert.match(asset.sha256, /^[0-9a-f]{64}$/u);
    });
  }

  it("rejects unsupported platforms and architectures", () => {
    assert.throws(() => uvAssetForPlatform("freebsd", "x64"), /cannot bootstrap uv on freebsd\/x64/);
    assert.throws(() => uvAssetForPlatform("linux", "ia32"), /cannot bootstrap uv on linux\/ia32/);
  });
});

describe("managedUvEnvironment", () => {
  it("keeps uv caches, tools, and managed Python under extension storage", () => {
    const storage = path.join(os.tmpdir(), "extension-storage");
    const environment = managedUvEnvironment(storage);
    for (const [name, value] of Object.entries(environment)) {
      if (name.startsWith("UV_") && name.endsWith("_DIR")) {
        assert.equal(path.isAbsolute(value), true);
        assert.equal(path.relative(storage, value).startsWith(".."), false);
      }
    }
    assert.equal(environment.UV_NO_MODIFY_PATH, "1");
    assert.equal(environment.UV_PYTHON_INSTALL_BIN, "0");
    assert.equal(environment.UV_MANAGED_PYTHON, "1");
  });
});

describe("ensureManagedUv", () => {
  for (const platform of ["win32", "linux", "darwin"] as const) {
    it(`extracts only the ${platform} executable from a verified wheel and reuses it`, async () => {
      const executableName = platform === "win32" ? "uv.exe" : "uv";
      const wheel = zipFixture([
        { name: "uv/__init__.py", content: "not needed" },
        { name: `${scripts}/${executableName}`, content: "executable" },
        { name: `${scripts}/uvx`, content: "not needed" },
        { name: `uv-${managedUvVersion}.dist-info/METADATA`, content: "not needed" },
      ]);
      const options = await installOptions(wheel, platform);
      const downloads: string[] = [];
      const executable = await ensureManagedUv({
        ...options,
        download: async (url, destination) => {
          downloads.push(url);
          await fs.writeFile(destination, wheel);
        },
      });
      assert.equal(executable, path.join(options.globalStoragePath, "tools", "uv", managedUvVersion, "test", executableName));
      assert.equal(await fs.readFile(executable, "utf8"), "executable");
      assert.deepEqual(downloads, [options.asset!.downloadUrl]);
      assert.deepEqual((await fs.readdir(path.dirname(executable))).sort(), [executableName, "vscode-mlia-uv.json"].sort());
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(path.dirname(executable), "vscode-mlia-uv.json"), "utf8")), {
        version: managedUvVersion,
        wheelName: options.asset!.wheelName,
        wheelSha256: options.asset!.sha256,
      });
      if (process.platform !== "win32") assert.equal((await fs.stat(executable)).mode & 0o777, 0o755);
      assert.equal(await ensureManagedUv({
        ...options,
        download: async () => { throw new Error("must not redownload a valid installation"); },
      }), executable);
      await assertNoStaging(options.globalStoragePath);
    });
  }

  it("rejects an incorrect pinned hash before attempting ZIP extraction", async () => {
    const wheel = zipFixture([{ name: `${scripts}/uv.exe`, content: "executable" }]);
    const options = await installOptions(wheel);
    await assert.rejects(ensureManagedUv({
      ...options,
      download: async (_url, destination) => { await fs.writeFile(destination, "not even a ZIP"); },
    }), /uv wheel failed SHA-256 verification/);
    await assertNoStaging(options.globalStoragePath);
    await assert.rejects(fs.stat(path.join(options.globalStoragePath, "tools", "uv", managedUvVersion, "test")), { code: "ENOENT" });
  });

  const badWheels = [
    { name: "missing executable", wheel: zipFixture([{ name: "uv.exe", content: "wrong location" }]), error: /does not contain/ },
    { name: "duplicate executable", wheel: zipFixture([
      { name: `${scripts}/uv.exe`, content: "first" },
      { name: `${scripts}/uv.exe`, content: "second" },
    ]), error: /invalid or duplicate/ },
    { name: "symlink executable", wheel: zipFixture([{ name: `${scripts}/uv.exe`, content: "other-file", mode: 0o120777 }]), error: /invalid or duplicate/ },
    { name: "directory executable", wheel: zipFixture([{ name: `${scripts}/uv.exe`, content: "directory", mode: 0o040755 }]), error: /invalid or duplicate/ },
    { name: "empty executable", wheel: zipFixture([{ name: `${scripts}/uv.exe`, content: "" }]), error: /invalid or duplicate/ },
    { name: "path traversal", wheel: zipFixture([{ name: "../../escaped.exe", content: "escape" }]), error: /invalid relative path/ },
    { name: "corrupt ZIP", wheel: Buffer.from("not a ZIP archive"), error: /end of central directory|file size|zip/i },
  ];
  for (const example of badWheels) {
    it(`rejects a wheel with ${example.name} and cleans staging`, async () => {
      const options = await installOptions(example.wheel);
      await assert.rejects(ensureManagedUv(options), example.error);
      await assertNoStaging(options.globalStoragePath);
      await assert.rejects(fs.stat(path.join(options.globalStoragePath, "tools", "uv", managedUvVersion, "test")), { code: "ENOENT" });
    });
  }

  it("reinstalls when the pinned wheel hash changes, even with the same filename", async () => {
    const first = zipFixture([{ name: `${scripts}/uv.exe`, content: "first" }]);
    const second = zipFixture([{ name: `${scripts}/uv.exe`, content: "second" }]);
    const options = await installOptions(first);
    const executable = await ensureManagedUv(options);
    await ensureManagedUv({
      ...options,
      asset: testAsset(second),
      download: async (_url, destination) => { await fs.writeFile(destination, second); },
    });
    assert.equal(await fs.readFile(executable, "utf8"), "second");
  });

  it("reinstalls when installation metadata or the executable is missing", async () => {
    const wheel = zipFixture([{ name: `${scripts}/uv.exe`, content: "executable" }]);
    const options = await installOptions(wheel);
    const executable = await ensureManagedUv(options);
    const metadataPath = path.join(path.dirname(executable), "vscode-mlia-uv.json");
    await fs.writeFile(metadataPath, JSON.stringify({ version: managedUvVersion }));
    await ensureManagedUv(options);
    assert.equal(JSON.parse(await fs.readFile(metadataPath, "utf8")).wheelSha256, sha256(wheel));
    await fs.unlink(executable);
    await ensureManagedUv(options);
    assert.equal(await fs.readFile(executable, "utf8"), "executable");
  });

  it("force reinstalls a valid installation but preserves it if a download fails", async () => {
    const wheel = zipFixture([{ name: `${scripts}/uv.exe`, content: "executable" }]);
    const options = await installOptions(wheel);
    const executable = await ensureManagedUv(options);
    await assert.rejects(ensureManagedUv({
      ...options, force: true,
      download: async () => { throw new Error("network failure"); },
    }), /network failure/);
    assert.equal(await fs.readFile(executable, "utf8"), "executable");
    let downloads = 0;
    await ensureManagedUv({
      ...options, force: true,
      download: async (_url, destination) => {
        downloads += 1;
        await fs.writeFile(destination, wheel);
      },
    });
    assert.equal(downloads, 1);
    assert.equal(await fs.readFile(executable, "utf8"), "executable");
    await assertNoStaging(options.globalStoragePath);
  });

  it("coalesces concurrent installation requests", async () => {
    const options = await installOptions(zipFixture([{ name: `${scripts}/uv.exe`, content: "executable" }]));
    let downloads = 0;
    const download = options.download!;
    const shared = { ...options, download: async (url: string, destination: string) => {
      downloads += 1;
      await download(url, destination);
    } };
    const paths = await Promise.all([ensureManagedUv(shared), ensureManagedUv(shared)]);
    assert.equal(paths[0], paths[1]);
    assert.equal(downloads, 1);
  });
});

describe("getManagedUvPath", () => {
  it("returns the platform executable below extension global storage", () => {
    assert.equal(getManagedUvPath("C:/storage", "win32", "arm64"), path.join(
      "C:/storage", "tools", "uv", managedUvVersion, "aarch64-pc-windows-msvc", "uv.exe",
    ));
  });
});

// Opt-in network validation uses the real downloader, wheel pins and extractor.
// On Linux also run the static musl binary, not just the glibc wheel.
for (const libc of (process.platform === "linux" ? ["gnu", "musl"] : ["gnu"]) as LinuxLibc[]) {
  it(`downloads and runs the pinned uv wheel on ${process.platform}/${process.arch}/${libc}`, {
    skip: process.env.MLIA_TEST_UV_BOOTSTRAP !== "1",
    timeout: 180_000,
  }, async () => {
    const options = { globalStoragePath: await makeStorage(), linuxLibc: libc };
    const executable = await ensureManagedUv(options);
    const version = execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 15_000 });
    assert.equal(version.trim().split(/\s+/u).slice(0, 2).join(" "), `uv ${managedUvVersion}`);
    assert.equal(await ensureManagedUv({
      ...options,
      download: async () => { throw new Error("must reuse downloaded uv"); },
    }), executable);
    assert.equal(await ensureManagedUv({ ...options, force: true }), executable);
    assert.equal(execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 15_000 }), version);
    await assertNoStaging(options.globalStoragePath);
  });
}
