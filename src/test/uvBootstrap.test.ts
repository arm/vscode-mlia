import * as assert from "assert";
import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, it } from "node:test";

import {
  ensureManagedUv,
  getManagedUvPath,
  managedUvChecksumManifestSha256,
  managedUvEnvironment,
  managedUvVersion,
  parseUvChecksumManifest,
  UvAsset,
  uvAssetForPlatform,
} from "../uvBootstrap";

const tempDirs: string[] = [];

async function makeStorage(): Promise<string> {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-mlia-uv-test-"));
  tempDirs.push(storage);
  return storage;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function testAsset(): UvAsset {
  return {
    target: "test",
    archiveName: "uv-test.zip",
    archiveKind: "zip",
  };
}

function checksumManifest(asset: UvAsset, archiveContent: string): string {
  return `${sha256(archiveContent)} *${asset.archiveName}\n`;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("uvAssetForPlatform", () => {
  it("selects release assets for supported platforms", () => {
    assert.deepStrictEqual(
      uvAssetForPlatform("win32", "x64"),
      {
        target: "x86_64-pc-windows-msvc",
        archiveName: "uv-x86_64-pc-windows-msvc.zip",
        archiveKind: "zip",
      },
    );
    assert.strictEqual(
      uvAssetForPlatform("darwin", "arm64").archiveName,
      "uv-aarch64-apple-darwin.tar.gz",
    );
    assert.strictEqual(
      uvAssetForPlatform("linux", "x64", "musl").archiveName,
      "uv-x86_64-unknown-linux-musl.tar.gz",
    );
  });

  it("rejects unsupported platforms and architectures", () => {
    assert.throws(
      () => uvAssetForPlatform("freebsd", "x64"),
      /cannot bootstrap uv on freebsd\/x64/,
    );
  });
});

describe("parseUvChecksumManifest", () => {
  it("returns the one exact archive checksum", () => {
    const expected = "a".repeat(64);
    assert.strictEqual(
      parseUvChecksumManifest(
        `${"b".repeat(64)} *other.zip\n${expected.toUpperCase()}  uv-test.zip\n`,
        "uv-test.zip",
      ),
      expected,
    );
  });

  it("rejects missing and duplicate archive entries", () => {
    assert.throws(
      () => parseUvChecksumManifest(`${"a".repeat(64)} *other.zip\n`, "uv-test.zip"),
      /contains 0 entries/,
    );
    assert.throws(
      () => parseUvChecksumManifest(
        `${"a".repeat(64)} *uv-test.zip\n${"b".repeat(64)} *uv-test.zip\n`,
        "uv-test.zip",
      ),
      /contains 2 entries/,
    );
  });
});

describe("managedUvEnvironment", () => {
  it("keeps uv caches, tools, and managed Python under extension storage", () => {
    const storage = path.join(os.tmpdir(), "extension-storage");
    const environment = managedUvEnvironment(storage);

    for (const [name, value] of Object.entries(environment)) {
      if (name.startsWith("UV_") && name.endsWith("_DIR")) {
        assert.strictEqual(path.isAbsolute(value), true);
        assert.strictEqual(path.relative(storage, value).startsWith(".."), false);
      }
    }
    assert.strictEqual(environment.UV_NO_MODIFY_PATH, "1");
    assert.strictEqual(environment.UV_PYTHON_INSTALL_BIN, "0");
    assert.strictEqual(environment.UV_MANAGED_PYTHON, "1");
  });
});

describe("ensureManagedUv", () => {
  it("installs the archive-prefixed release payload after verification and reuses uv", async () => {
    const storage = await makeStorage();
    const archiveContent = "verified uv archive";
    const asset = testAsset();
    const manifestContent = checksumManifest(asset, archiveContent);
    let downloads = 0;
    let extractions = 0;

    const options = {
      globalStoragePath: storage,
      platform: "win32" as const,
      arch: "x64",
      asset,
      checksumManifestSha256: sha256(manifestContent),
      download: async (url: string, destination: string) => {
        downloads += 1;
        await fs.writeFile(
          destination,
          url.endsWith("/sha256.sum") ? manifestContent : archiveContent,
          "utf8",
        );
      },
      extract: async (_archivePath: string, destination: string) => {
        extractions += 1;
        const payload = path.join(destination, "uv-test");
        await fs.mkdir(payload, { recursive: true });
        await fs.writeFile(path.join(payload, "uv.exe"), "executable", "utf8");
      },
    };

    const executable = await ensureManagedUv(options);
    assert.strictEqual(
      executable,
      path.join(storage, "tools", "uv", managedUvVersion, asset.target, "uv.exe"),
    );
    assert.strictEqual(await fs.readFile(executable, "utf8"), "executable");
    assert.strictEqual(downloads, 2);
    assert.strictEqual(extractions, 1);

    const reused = await ensureManagedUv({
      ...options,
      download: async () => {
        throw new Error("must not redownload a valid installation");
      },
      extract: async () => {
        throw new Error("must not re-extract a valid installation");
      },
    });
    assert.strictEqual(reused, executable);
    assert.strictEqual(downloads, 2);
    assert.strictEqual(extractions, 1);
  });

  it("rejects a checksum manifest whose pinned SHA-256 does not match", async () => {
    const storage = await makeStorage();
    const asset = testAsset();
    let downloads = 0;

    await assert.rejects(
      ensureManagedUv({
        globalStoragePath: storage,
        platform: "win32",
        arch: "x64",
        asset,
        checksumManifestSha256: sha256("expected manifest"),
        download: async (_url, destination) => {
          downloads += 1;
          await fs.writeFile(destination, "tampered manifest", "utf8");
        },
        extract: async () => {
          throw new Error("must not extract after manifest verification fails");
        },
      }),
      /checksum manifest failed SHA-256 verification/,
    );
    assert.strictEqual(downloads, 1);
  });

  it("rejects an archive whose manifest-provided SHA-256 does not match", async () => {
    const storage = await makeStorage();
    const asset = testAsset();
    const manifestContent = checksumManifest(asset, "expected archive");

    await assert.rejects(
      ensureManagedUv({
        globalStoragePath: storage,
        platform: "win32",
        arch: "x64",
        asset,
        checksumManifestSha256: sha256(manifestContent),
        download: async (url, destination) => {
          await fs.writeFile(
            destination,
            url.endsWith("/sha256.sum") ? manifestContent : "tampered archive",
            "utf8",
          );
        },
        extract: async () => {
          throw new Error("must not extract an unverified archive");
        },
      }),
      /uv archive failed SHA-256 verification/,
    );

    await assert.rejects(fs.stat(path.dirname(
      path.join(storage, "tools", "uv", managedUvVersion, asset.target, "uv.exe"),
    )), /ENOENT/);
  });

  it("force reinstalls an existing managed executable", async () => {
    const storage = await makeStorage();
    const archiveContent = "verified uv archive";
    const asset = testAsset();
    const manifestContent = checksumManifest(asset, archiveContent);
    let installedContent = "first";

    const install = (force = false) => ensureManagedUv({
      globalStoragePath: storage,
      platform: "win32",
      arch: "x64",
      asset,
      checksumManifestSha256: sha256(manifestContent),
      force,
      download: async (url, destination) => {
        await fs.writeFile(
          destination,
          url.endsWith("/sha256.sum") ? manifestContent : archiveContent,
          "utf8",
        );
      },
      extract: async (_archivePath, destination) => {
        const payload = path.join(destination, "uv-test");
        await fs.mkdir(payload, { recursive: true });
        await fs.writeFile(path.join(payload, "uv.exe"), installedContent, "utf8");
      },
    });

    const executable = await install();
    assert.strictEqual(await fs.readFile(executable, "utf8"), "first");
    installedContent = "second";
    await install(true);
    assert.strictEqual(await fs.readFile(executable, "utf8"), "second");
  });
});

describe("getManagedUvPath", () => {
  it("returns the platform executable below extension global storage", () => {
    assert.strictEqual(
      getManagedUvPath("C:/storage", "win32", "arm64"),
      path.join(
        "C:/storage",
        "tools",
        "uv",
        managedUvVersion,
        "aarch64-pc-windows-msvc",
        "uv.exe",
      ),
    );
  });

  it("pins one checksum manifest hash for the release", () => {
    assert.match(managedUvChecksumManifestSha256, /^[0-9a-f]{64}$/u);
  });
});
