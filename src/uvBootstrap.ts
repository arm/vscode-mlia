import { createHash, randomUUID } from "crypto";
import { constants as fsConstants, createReadStream, createWriteStream } from "fs";
import * as fs from "fs/promises";
import * as https from "https";
import * as path from "path";
import { pipeline } from "stream/promises";
import { x as extractTar } from "tar";
import * as yauzl from "yauzl";

export const managedUvVersion = "0.11.32";
export const managedUvChecksumManifestSha256 =
  "459439f17ac1aee2aa91ef423bf2b23fe0f7d99dbc1b84f9983ef1fc3af3371e";

export type LinuxLibc = "gnu" | "musl";
export type UvArchiveKind = "tar.gz" | "zip";

export interface UvAsset {
  readonly target: string;
  readonly archiveName: string;
  readonly archiveKind: UvArchiveKind;
}

export interface EnsureManagedUvOptions {
  readonly globalStoragePath: string;
  readonly force?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly linuxLibc?: LinuxLibc;
  readonly asset?: UvAsset;
  readonly checksumManifestSha256?: string;
  readonly download?: (url: string, destination: string) => Promise<void>;
  readonly extract?: (
    archivePath: string,
    destination: string,
    kind: UvArchiveKind,
  ) => Promise<void>;
  readonly log?: (message: string) => void;
  readonly progress?: (message: string) => void;
}

interface UvInstallMetadata {
  readonly version: string;
  readonly archiveName: string;
  readonly checksumManifestSha256: string;
  readonly archiveSha256: string;
}

const releaseBaseUrl = `https://github.com/astral-sh/uv/releases/download/${managedUvVersion}`;
const installPromises = new Map<string, Promise<string>>();

const assets: Readonly<Record<string, Omit<UvAsset, "target">>> = {
  "aarch64-apple-darwin": {
    archiveName: "uv-aarch64-apple-darwin.tar.gz",
    archiveKind: "tar.gz",
  },
  "x86_64-apple-darwin": {
    archiveName: "uv-x86_64-apple-darwin.tar.gz",
    archiveKind: "tar.gz",
  },
  "aarch64-pc-windows-msvc": {
    archiveName: "uv-aarch64-pc-windows-msvc.zip",
    archiveKind: "zip",
  },
  "i686-pc-windows-msvc": {
    archiveName: "uv-i686-pc-windows-msvc.zip",
    archiveKind: "zip",
  },
  "x86_64-pc-windows-msvc": {
    archiveName: "uv-x86_64-pc-windows-msvc.zip",
    archiveKind: "zip",
  },
  "aarch64-unknown-linux-gnu": {
    archiveName: "uv-aarch64-unknown-linux-gnu.tar.gz",
    archiveKind: "tar.gz",
  },
  "aarch64-unknown-linux-musl": {
    archiveName: "uv-aarch64-unknown-linux-musl.tar.gz",
    archiveKind: "tar.gz",
  },
  "x86_64-unknown-linux-gnu": {
    archiveName: "uv-x86_64-unknown-linux-gnu.tar.gz",
    archiveKind: "tar.gz",
  },
  "x86_64-unknown-linux-musl": {
    archiveName: "uv-x86_64-unknown-linux-musl.tar.gz",
    archiveKind: "tar.gz",
  },
};

export function uvAssetForPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  linuxLibc: LinuxLibc = detectLinuxLibc(),
): UvAsset {
  const target = uvTarget(platform, arch, linuxLibc);
  const asset = assets[target];
  if (!asset) {
    throw new Error(`MLIA cannot bootstrap uv on ${platform}/${arch}${platform === "linux" ? `/${linuxLibc}` : ""}.`);
  }
  return { target, ...asset };
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
  const checksumManifestSha256 =
    options.checksumManifestSha256 ?? managedUvChecksumManifestSha256;
  const installDir = path.dirname(executablePath);
  if (
    !options.force &&
    await hasValidInstallation(
      installDir,
      executablePath,
      asset,
      checksumManifestSha256,
    )
  ) {
    options.log?.(`Using managed uv ${managedUvVersion}: ${executablePath}`);
    return executablePath;
  }

  const uvRoot = managedUvRoot(options.globalStoragePath);
  const stagingDir = path.join(uvRoot, `.staging-${process.pid}-${randomUUID()}`);
  const checksumManifestPath = path.join(stagingDir, "sha256.sum");
  const archivePath = path.join(stagingDir, asset.archiveName);
  const extractedRoot = path.join(stagingDir, "extracted");
  const extractedPayloadRoot = path.join(
    extractedRoot,
    archivePayloadDirectoryName(asset),
  );
  const platform = options.platform ?? process.platform;
  const extractedExecutable = path.join(extractedPayloadRoot, uvExecutableName(platform));
  const download = options.download ?? downloadFile;
  const extract = options.extract ?? extractArchive;
  const checksumManifestUrl = `${releaseBaseUrl}/sha256.sum`;
  const archiveUrl = `${releaseBaseUrl}/${asset.archiveName}`;

  await fs.mkdir(stagingDir, { recursive: true });
  try {
    options.progress?.(`Downloading uv ${managedUvVersion} checksums`);
    options.log?.(`Downloading uv checksum manifest: ${checksumManifestUrl}`);
    await download(checksumManifestUrl, checksumManifestPath);

    options.progress?.("Verifying uv checksum manifest");
    const actualManifestSha256 = await fileSha256(checksumManifestPath);
    if (actualManifestSha256 !== checksumManifestSha256) {
      throw new Error(
        "Downloaded uv checksum manifest failed SHA-256 verification: " +
          `expected ${checksumManifestSha256}, got ${actualManifestSha256}.`,
      );
    }
    const checksumManifest = await fs.readFile(checksumManifestPath, "utf8");
    const archiveSha256 = parseUvChecksumManifest(checksumManifest, asset.archiveName);

    options.progress?.(`Downloading uv ${managedUvVersion}`);
    options.log?.(`Downloading managed uv: ${archiveUrl}`);
    await download(archiveUrl, archivePath);

    options.progress?.("Verifying uv download");
    const actualArchiveSha256 = await fileSha256(archivePath);
    if (actualArchiveSha256 !== archiveSha256) {
      throw new Error(
        "Downloaded uv archive failed SHA-256 verification: " +
          `expected ${archiveSha256}, got ${actualArchiveSha256}.`,
      );
    }

    options.progress?.("Installing managed uv");
    await fs.mkdir(extractedRoot, { recursive: true });
    await extract(archivePath, extractedRoot, asset.archiveKind);
    await fs.access(extractedExecutable, fsConstants.F_OK);
    if (process.platform !== "win32") {
      await fs.chmod(extractedExecutable, 0o755);
    }
    await writeInstallMetadata(
      extractedPayloadRoot,
      asset,
      checksumManifestSha256,
      archiveSha256,
    );

    await fs.mkdir(uvRoot, { recursive: true });
    await fs.rm(installDir, { recursive: true, force: true });
    await fs.rename(extractedPayloadRoot, installDir);
    options.log?.(`Installed managed uv ${managedUvVersion}: ${executablePath}`);
    return executablePath;
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
  }
}

export function parseUvChecksumManifest(
  content: string,
  archiveName: string,
): string {
  const hashes = content.split(/\r?\n/u).flatMap((line) => {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/iu.exec(line.trim());
    return match?.[2] === archiveName ? [match[1].toLowerCase()] : [];
  });
  if (hashes.length !== 1) {
    throw new Error(
      `Verified uv checksum manifest contains ${hashes.length} entries for ${archiveName}; expected exactly one.`,
    );
  }
  return hashes[0];
}

async function hasValidInstallation(
  installDir: string,
  executablePath: string,
  asset: UvAsset,
  checksumManifestSha256: string,
): Promise<boolean> {
  try {
    const [metadataText] = await Promise.all([
      fs.readFile(path.join(installDir, "vscode-mlia-uv.json"), "utf8"),
      fs.access(executablePath, fsConstants.F_OK),
    ]);
    const metadata = JSON.parse(metadataText) as Partial<UvInstallMetadata>;
    return metadata.version === managedUvVersion &&
      metadata.archiveName === asset.archiveName &&
      metadata.checksumManifestSha256 === checksumManifestSha256 &&
      typeof metadata.archiveSha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(metadata.archiveSha256);
  } catch {
    return false;
  }
}

async function writeInstallMetadata(
  installDir: string,
  asset: UvAsset,
  checksumManifestSha256: string,
  archiveSha256: string,
): Promise<void> {
  const metadata: UvInstallMetadata = {
    version: managedUvVersion,
    archiveName: asset.archiveName,
    checksumManifestSha256,
    archiveSha256,
  };
  await fs.writeFile(
    path.join(installDir, "vscode-mlia-uv.json"),
    `${JSON.stringify(metadata, undefined, 2)}\n`,
    "utf8",
  );
}

function managedUvExecutablePath(
  globalStoragePath: string,
  asset: UvAsset,
  platform: NodeJS.Platform,
): string {
  return path.join(
    managedUvRoot(globalStoragePath),
    asset.target,
    uvExecutableName(platform),
  );
}

function uvExecutableName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "uv.exe" : "uv";
}

function archivePayloadDirectoryName(asset: UvAsset): string {
  const suffix = asset.archiveKind === "zip" ? ".zip" : ".tar.gz";
  if (!asset.archiveName.endsWith(suffix)) {
    throw new Error(`Unexpected uv archive name: ${asset.archiveName}`);
  }
  return asset.archiveName.slice(0, -suffix.length);
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

async function extractArchive(
  archivePath: string,
  destination: string,
  kind: UvArchiveKind,
): Promise<void> {
  if (kind === "zip") {
    await extractZipArchive(archivePath, destination);
    return;
  }
  await extractTar({ file: archivePath, cwd: destination, gzip: true });
}

async function extractZipArchive(archivePath: string, destination: string): Promise<void> {
  const destinationRoot = path.resolve(destination);
  const zipFile = await openZipFile(archivePath);
  try {
    await new Promise<void>((resolve, reject) => {
      zipFile.once("error", reject);
      zipFile.once("end", resolve);
      zipFile.on("entry", (entry: yauzl.Entry) => {
        handleZipEntry(zipFile, entry, destinationRoot).then(
          () => zipFile.readEntry(),
          reject,
        );
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

async function handleZipEntry(
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry,
  destinationRoot: string,
): Promise<void> {
  const entryPath = path.resolve(destinationRoot, entry.fileName);
  const relativePath = path.relative(destinationRoot, entryPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Zip archive entry escapes destination: ${entry.fileName}`);
  }

  if (entry.fileName.endsWith("/")) {
    await fs.mkdir(entryPath, { recursive: true });
    return;
  }

  await fs.mkdir(path.dirname(entryPath), { recursive: true });
  const readStream = await openZipReadStream(zipFile, entry);
  await pipeline(readStream, createWriteStream(entryPath, { flags: "wx" }));
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
