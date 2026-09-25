import { createHash, randomUUID } from "crypto";
import { constants as fsConstants, createReadStream, createWriteStream } from "fs";
import * as fs from "fs/promises";
import * as https from "https";
import * as path from "path";
import { pipeline } from "stream/promises";
import * as yauzl from "yauzl";

export const managedUvVersion = "0.11.32";

export type LinuxLibc = "gnu" | "musl";

export interface UvAsset {
  readonly target: string;
  readonly wheelName: string;
  readonly downloadUrl: string;
  readonly sha256: string;
}

export interface EnsureManagedUvOptions {
  readonly globalStoragePath: string;
  readonly force?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly linuxLibc?: LinuxLibc;
  readonly asset?: UvAsset;
  readonly download?: (url: string, destination: string) => Promise<void>;
  readonly log?: (message: string) => void;
  readonly progress?: (message: string) => void;
}

interface UvInstallMetadata {
  readonly version: string;
  readonly wheelName: string;
  readonly wheelSha256: string;
}

interface WheelPin {
  readonly tag: string;
  readonly packagePath: string;
  readonly sha256: string;
}

const installPromises = new Map<string, Promise<string>>();

// PyPI's uv 0.11.32 wheels contain standalone binaries. Pin the files and hashes
// from https://pypi.org/pypi/uv/0.11.32/json; do not resolve packages at runtime.
// This statically linked aarch64 wheel supports both glibc and musl hosts.
const linuxArm64Wheel: WheelPin = {
  tag: "manylinux_2_17_aarch64.manylinux2014_aarch64.musllinux_1_1_aarch64",
  packagePath: "5d/61/0d6a8ee5066385fce65a5ef57939b1f63e9ff955afa07fa423c3e7e0abdb",
  sha256: "125c142363d0842c8506a057da56bae182e2aa3957344f57dd9ef20ea10f06b0",
};

const wheels: Readonly<Record<string, WheelPin>> = {
  "aarch64-apple-darwin": {
    tag: "macosx_11_0_arm64",
    packagePath: "60/43/ec2de11ef008e76a8d01c34d573c939c565694f72c0d008d200aa3a5eac3",
    sha256: "2a56d1abf16337350e878b2c869b256b8448ecc4a722b98f8d41e1b3680a587b",
  },
  "x86_64-apple-darwin": {
    tag: "macosx_10_12_x86_64",
    packagePath: "12/85/ef4d0f02f469cfad1d73c11bf31ac0a8f24da3c62d7f3305c50a5e51e814",
    sha256: "c82954b1bd507e767b1d996c2865ea3eb7d464a479ec0e4d60f0b8e2e07dee45",
  },
  "aarch64-pc-windows-msvc": {
    tag: "win_arm64",
    packagePath: "13/68/efb90a3e46c9f93e577b34e82467f232308a0ff3b12f807226caca6f72e2",
    sha256: "bf988bf510772785eac1edfc7cdedca074e8936b45e755b58f7f3e1e9ca86424",
  },
  "i686-pc-windows-msvc": {
    tag: "win32",
    packagePath: "00/f8/1f7cf58780bb1c5d6ea89126438971d8e61ad04d290e1c34ce1e8b136a83",
    sha256: "bb1ae8189e315499a77f3cc27cac5985ab1d8cb79baa82e368b6c1e574a7d9cf",
  },
  "x86_64-pc-windows-msvc": {
    tag: "win_amd64",
    packagePath: "57/60/a645cca710448004268b7731c4dc6fc7d084a7c620fc73ecc2127cb61661",
    sha256: "855632ee1d2a8491986efa54c562b806cd32477761889a1e13624b519d98a45e",
  },
  "aarch64-unknown-linux-gnu": linuxArm64Wheel,
  "aarch64-unknown-linux-musl": linuxArm64Wheel,
  "x86_64-unknown-linux-gnu": {
    tag: "manylinux_2_17_x86_64.manylinux2014_x86_64",
    packagePath: "90/b0/114463d056b6b328d45557001e848b8ab15539bd8f4fa7a457ccb83e2b5d",
    sha256: "3da76cd4e2697de30928b8a8524bd39183ac1e08cb7e72833807c022b7cba6c4",
  },
  "x86_64-unknown-linux-musl": {
    tag: "musllinux_1_1_x86_64",
    packagePath: "02/58/0a92505cfe2b02b1c2d6ded23e83763fe98b43fbe1a4e5cbd6866da3bdf7",
    sha256: "77f4356548ee8dc47efae154efd4e930c65570e7d4971c57bdef592f6eefb39c",
  },
};

export function uvAssetForPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  linuxLibc: LinuxLibc = detectLinuxLibc(),
): UvAsset {
  const target = uvTarget(platform, arch, linuxLibc);
  const wheel = wheels[target];
  if (!wheel) {
    throw new Error(`MLIA cannot bootstrap uv on ${platform}/${arch}${platform === "linux" ? `/${linuxLibc}` : ""}.`);
  }
  const wheelName = `uv-${managedUvVersion}-py3-none-${wheel.tag}.whl`;
  return {
    target,
    wheelName,
    downloadUrl: `https://files.pythonhosted.org/packages/${wheel.packagePath}/${wheelName}`,
    sha256: wheel.sha256,
  };
}

export function getManagedUvPath(
  globalStoragePath: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  linuxLibc: LinuxLibc = detectLinuxLibc(),
): string {
  const asset = uvAssetForPlatform(platform, arch, linuxLibc);
  return managedUvExecutablePath(globalStoragePath, asset, platform);
}

export function managedUvEnvironment(globalStoragePath: string): Record<string, string> {
  const toolsRoot = path.join(globalStoragePath, "tools");
  return {
    UV_CACHE_DIR: path.join(toolsRoot, "uv-cache"),
    UV_PYTHON_INSTALL_DIR: path.join(toolsRoot, "python-installations"),
    UV_PYTHON_BIN_DIR: path.join(toolsRoot, "python-bin"),
    UV_PYTHON_INSTALL_BIN: "0",
    UV_TOOL_DIR: path.join(toolsRoot, "uv-tools"),
    UV_TOOL_BIN_DIR: path.join(toolsRoot, "uv-tool-bin"),
    UV_NO_MODIFY_PATH: "1",
    UV_MANAGED_PYTHON: "1",
  };
}

export function ensureManagedUv(options: EnsureManagedUvOptions): Promise<string> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const linuxLibc = options.linuxLibc ?? detectLinuxLibc();
  const asset = options.asset ?? uvAssetForPlatform(platform, arch, linuxLibc);
  const executablePath = managedUvExecutablePath(options.globalStoragePath, asset, platform);
  const key = path.dirname(executablePath);
  const existing = installPromises.get(key);
  if (existing) {
    return existing;
  }
  const promise = installManagedUv(options, asset, executablePath)
    .finally(() => installPromises.delete(key));
  installPromises.set(key, promise);
  return promise;
}

async function installManagedUv(
  options: EnsureManagedUvOptions,
  asset: UvAsset,
  executablePath: string,
): Promise<string> {
  const installDir = path.dirname(executablePath);
  if (!options.force && await hasValidInstallation(installDir, executablePath, asset)) {
    options.log?.(`Using managed uv ${managedUvVersion}: ${executablePath}`);
    return executablePath;
  }

  const uvRoot = managedUvRoot(options.globalStoragePath);
  const stagingDir = path.join(uvRoot, `.staging-${process.pid}-${randomUUID()}`);
  const wheelPath = path.join(stagingDir, asset.wheelName);
  const payloadRoot = path.join(stagingDir, "payload");
  const executableName = path.basename(executablePath);
  const extractedExecutable = path.join(payloadRoot, executableName);
  const download = options.download ?? downloadFile;

  await fs.mkdir(stagingDir, { recursive: true });
  try {
    options.progress?.(`Downloading uv ${managedUvVersion}`);
    options.log?.(`Downloading managed uv wheel: ${asset.downloadUrl}`);
    await download(asset.downloadUrl, wheelPath);

    options.progress?.("Verifying uv download");
    const actualSha256 = await fileSha256(wheelPath);
    if (actualSha256 !== asset.sha256) {
      throw new Error(
        "Downloaded uv wheel failed SHA-256 verification: " +
          `expected ${asset.sha256}, got ${actualSha256}.`,
      );
    }

    options.progress?.("Installing managed uv");
    await fs.mkdir(payloadRoot, { recursive: true });
    await extractUvExecutable(wheelPath, extractedExecutable);
    if (process.platform !== "win32") {
      await fs.chmod(extractedExecutable, 0o755);
    }
    const metadata: UvInstallMetadata = {
      version: managedUvVersion,
      wheelName: asset.wheelName,
      wheelSha256: asset.sha256,
    };
    await fs.writeFile(
      path.join(payloadRoot, "vscode-mlia-uv.json"),
      `${JSON.stringify(metadata, undefined, 2)}\n`,
      "utf8",
    );

    await fs.rm(installDir, { recursive: true, force: true });
    await fs.rename(payloadRoot, installDir);
    options.log?.(`Installed managed uv ${managedUvVersion}: ${executablePath}`);
    return executablePath;
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
  }
}

async function hasValidInstallation(
  installDir: string,
  executablePath: string,
  asset: UvAsset,
): Promise<boolean> {
  try {
    const [metadataText] = await Promise.all([
      fs.readFile(path.join(installDir, "vscode-mlia-uv.json"), "utf8"),
      fs.access(executablePath, fsConstants.F_OK),
    ]);
    const metadata = JSON.parse(metadataText) as Partial<UvInstallMetadata>;
    return metadata.version === managedUvVersion &&
      metadata.wheelName === asset.wheelName &&
      metadata.wheelSha256 === asset.sha256;
  } catch {
    return false;
  }
}

function managedUvExecutablePath(
  globalStoragePath: string,
  asset: UvAsset,
  platform: NodeJS.Platform,
): string {
  return path.join(
    managedUvRoot(globalStoragePath),
    asset.target,
    platform === "win32" ? "uv.exe" : "uv",
  );
}

function managedUvRoot(globalStoragePath: string): string {
  return path.join(globalStoragePath, "tools", "uv", managedUvVersion);
}

function uvTarget(platform: NodeJS.Platform, arch: string, linuxLibc: LinuxLibc): string {
  if (platform === "win32") {
    const windowsArch = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : arch === "ia32" ? "i686" : arch;
    return `${windowsArch}-pc-windows-msvc`;
  }
  if (platform === "darwin") {
    const darwinArch = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : arch;
    return `${darwinArch}-apple-darwin`;
  }
  if (platform === "linux") {
    const linuxArch = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : arch;
    return `${linuxArch}-unknown-linux-${linuxLibc}`;
  }
  return `${arch}-${platform}`;
}

function detectLinuxLibc(): LinuxLibc {
  if (process.platform !== "linux") {
    return "gnu";
  }
  const report = process.report?.getReport();
  const header = typeof report === "object" && report !== null
    ? (report as { header?: { glibcVersionRuntime?: unknown } }).header
    : undefined;
  return typeof header?.glibcVersionRuntime === "string" ? "gnu" : "musl";
}

async function extractUvExecutable(wheelPath: string, executablePath: string): Promise<void> {
  const executableEntry = `uv-${managedUvVersion}.data/scripts/${path.basename(executablePath)}`;
  const zipFile = await openZipFile(wheelPath);
  let found = false;
  try {
    await new Promise<void>((resolve, reject) => {
      zipFile.once("error", reject);
      zipFile.once("end", () => {
        if (found) resolve();
        else reject(new Error(`uv wheel does not contain ${executableEntry}.`));
      });
      zipFile.on("entry", (entry: yauzl.Entry) => {
        // Never use wheel-supplied paths as output paths. Only the native uv
        // binary is needed; Python wrappers, uvx and metadata are not installed.
        if (entry.fileName !== executableEntry) {
          zipFile.readEntry();
          return;
        }
        const fileType = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (found || (fileType !== 0 && fileType !== 0o100000) || entry.uncompressedSize === 0) {
          reject(new Error(`uv wheel contains an invalid or duplicate executable: ${executableEntry}.`));
          return;
        }
        found = true;
        openZipReadStream(zipFile, entry)
          .then((stream) => pipeline(stream, createWriteStream(executablePath, { flags: "wx" })))
          .then(() => zipFile.readEntry(), reject);
      });
      zipFile.readEntry();
    });
  } finally {
    zipFile.close();
  }
}

function openZipFile(archivePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (error, zipFile) => {
      if (error) {
        reject(error);
        return;
      }
      if (!zipFile) {
        reject(new Error(`Failed to open zip archive: ${archivePath}`));
        return;
      }
      resolve(zipFile);
    });
  });
}

function openZipReadStream(
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry,
): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, readStream) => {
      if (error) {
        reject(error);
        return;
      }
      if (!readStream) {
        reject(new Error(`Failed to read zip archive entry: ${entry.fileName}`));
        return;
      }
      resolve(readStream);
    });
  });
}

async function fileSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function downloadFile(url: string, destination: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const response = await requestDownload(url, 5);
  await pipeline(response, createWriteStream(destination, { flags: "wx" }));
}

function requestDownload(url: string, redirectsRemaining: number): Promise<import("http").IncomingMessage> {
  return new Promise((resolve, reject) => {
    const requestHandle = https.get(url, {
      headers: { "User-Agent": `vscode-mlia uv-bootstrap/${managedUvVersion}` },
    }, (response) => {
      const statusCode = response.statusCode ?? 0;
      const location = response.headers.location;
      if (statusCode >= 300 && statusCode < 400 && location) {
        response.resume();
        if (redirectsRemaining <= 0) {
          reject(new Error(`Too many redirects while downloading uv from ${url}.`));
          return;
        }
        requestDownload(new URL(location, url).toString(), redirectsRemaining - 1).then(resolve, reject);
        return;
      }
      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`Failed to download uv from ${url}: HTTP ${statusCode}.`));
        return;
      }
      resolve(response);
    });
    requestHandle.setTimeout(60_000, () => requestHandle.destroy(new Error(`Timed out downloading uv from ${url}.`)));
    requestHandle.on("error", reject);
  });
}
