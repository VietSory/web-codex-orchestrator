import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const RELEASE_REPOSITORY = "VietSory/web-codex-orchestrator";
const COMPANION_ASSET = "wco-browser-companion-windows-x64.exe";
const COMPANION_SHA_ASSET = `${COMPANION_ASSET}.sha256`;
const MAX_COMPANION_BYTES = 256 * 1024 * 1024;
const MAX_SHA_BYTES = 4 * 1024;

export interface BrowserCompanionInstallation {
  executable: string;
  source: "explicit" | "installed" | "downloaded";
  version?: string;
  sha256?: string;
}

interface DownloadResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

interface BrowserCompanionInstallMetadata {
  schema_version: 1;
  version: string;
  sha256: string;
  asset: typeof COMPANION_ASSET;
  repository: typeof RELEASE_REPOSITORY;
}

export interface BrowserCompanionBootstrapOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: (url: string, init?: { redirect?: "follow" }) => Promise<DownloadResponse>;
  packageVersion?: string;
  /** Programmatic/test-only destination override; normal CLI setup uses LOCALAPPDATA. */
  installPath?: string;
}

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function truthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
}

function wslPath(value: string, direction: "-u" | "-w"): string {
  const result = spawnSync("wslpath", [direction, value], { encoding: "utf8", shell: false });
  const output = result.status === 0 ? result.stdout.trim() : "";
  if (!output || output.includes("\u0000")) {
    throw codedError("WEB_CHATGPT_COMPANION_PATH_UNTRANSLATABLE", `Cannot translate WCO browser companion path: ${value}`);
  }
  return output;
}

function discoverWindowsLocalAppData(env: NodeJS.ProcessEnv): string | null {
  if (process.platform === "win32") {
    const value = env.LOCALAPPDATA?.trim();
    return value && isWindowsAbsolutePath(value) ? value : null;
  }
  if (process.platform !== "linux") return null;
  const result = spawnSync("cmd.exe", ["/d", "/s", "/c", "echo %LOCALAPPDATA%"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  const value = result.status === 0 ? result.stdout.trim() : "";
  return value && isWindowsAbsolutePath(value) ? value : null;
}

export function defaultBrowserCompanionInstallPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const localAppData = discoverWindowsLocalAppData(env);
  if (!localAppData) return null;
  const windowsPath = path.win32.join(localAppData, "WCO", "browser-companion", "wco-browser-companion.exe");
  try {
    return process.platform === "linux" ? wslPath(windowsPath, "-u") : windowsPath;
  } catch {
    return null;
  }
}

export function browserCompanionInstallMetadataPath(executable: string): string {
  return path.join(path.dirname(executable), "installation.json");
}

async function packageVersion(): Promise<string> {
  let source: string;
  try {
    source = await readFile(new URL("../../package.json", import.meta.url), "utf8");
  } catch (error) {
    throw codedError(
      "WEB_CHATGPT_COMPANION_VERSION_UNAVAILABLE",
      `WCO package metadata is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try { parsed = JSON.parse(source) as unknown; } catch {
    throw codedError("WEB_CHATGPT_COMPANION_VERSION_UNAVAILABLE", "WCO package metadata is invalid JSON.");
  }
  const version = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>).version
    : undefined;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw codedError("WEB_CHATGPT_COMPANION_VERSION_UNAVAILABLE", "WCO package version is missing or invalid.");
  }
  return version;
}

function releaseAssetUrl(version: string, asset: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw codedError("WEB_CHATGPT_COMPANION_VERSION_UNAVAILABLE", `Unsafe WCO package version '${version}'.`);
  }
  return `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${version}/${asset}`;
}

async function boundedBytes(response: DownloadResponse, maximum: number, label: string): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0 || size > maximum) {
      throw codedError("WEB_CHATGPT_COMPANION_DOWNLOAD_INVALID", `${label} has an invalid or oversized Content-Length.`);
    }
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > maximum) {
    throw codedError("WEB_CHATGPT_COMPANION_DOWNLOAD_INVALID", `${label} is empty or exceeds ${maximum} bytes.`);
  }
  return bytes;
}

function parseExpectedSha(source: string): string {
  if (Buffer.byteLength(source, "utf8") > MAX_SHA_BYTES) {
    throw codedError("WEB_CHATGPT_COMPANION_CHECKSUM_INVALID", "Companion checksum document is oversized.");
  }
  const line = source.trim();
  const match = /^([0-9a-fA-F]{64})(?:\s+\*?wco-browser-companion-windows-x64\.exe)?$/.exec(line);
  if (!match?.[1]) {
    throw codedError("WEB_CHATGPT_COMPANION_CHECKSUM_INVALID", "Companion checksum document is malformed.");
  }
  return match[1].toLowerCase();
}

function explicitExecutable(env: NodeJS.ProcessEnv): string | null {
  const value = env.WCO_CHATGPT_WEB_COMPANION_EXECUTABLE?.trim();
  if (!value) return null;
  if (value.includes("\u0000")) {
    throw codedError("WEB_CHATGPT_COMPANION_EXECUTABLE_INVALID", "Explicit WCO companion executable path is invalid.");
  }
  const hostPath = process.platform === "linux" && isWindowsAbsolutePath(value) ? wslPath(value, "-u") : path.resolve(value);
  if (!existsSync(hostPath)) {
    throw codedError("WEB_CHATGPT_COMPANION_NOT_INSTALLED", `Explicit WCO companion executable does not exist: ${value}`);
  }
  return hostPath;
}

function parseInstalledMetadata(value: unknown, expectedVersion: string): BrowserCompanionInstallMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !["schema_version", "version", "sha256", "asset", "repository"].includes(key))) return null;
  if (
    item.schema_version !== 1
    || item.version !== expectedVersion
    || typeof item.sha256 !== "string"
    || !/^[0-9a-f]{64}$/i.test(item.sha256)
    || item.asset !== COMPANION_ASSET
    || item.repository !== RELEASE_REPOSITORY
  ) return null;
  return item as unknown as BrowserCompanionInstallMetadata;
}

async function verifyInstalledCompanion(executable: string, expectedVersion: string): Promise<BrowserCompanionInstallation | null> {
  try {
    const metadataPath = browserCompanionInstallMetadataPath(executable);
    const [binaryInfo, metadataInfo] = await Promise.all([lstat(executable), lstat(metadataPath)]);
    if (
      !binaryInfo.isFile()
      || binaryInfo.isSymbolicLink()
      || binaryInfo.size <= 0
      || binaryInfo.size > MAX_COMPANION_BYTES
      || !metadataInfo.isFile()
      || metadataInfo.isSymbolicLink()
      || metadataInfo.size <= 0
      || metadataInfo.size > MAX_SHA_BYTES
    ) return null;
    const metadata = parseInstalledMetadata(JSON.parse(await readFile(metadataPath, "utf8")) as unknown, expectedVersion);
    if (!metadata) return null;
    const binary = await readFile(executable);
    const actualSha = crypto.createHash("sha256").update(binary).digest("hex");
    if (actualSha !== metadata.sha256.toLowerCase()) return null;
    return { executable, source: "installed", version: expectedVersion, sha256: actualSha };
  } catch {
    return null;
  }
}

export async function ensureWcoBrowserCompanionInstalled(
  options: BrowserCompanionBootstrapOptions = {},
): Promise<BrowserCompanionInstallation> {
  const env = options.env ?? process.env;
  const explicit = explicitExecutable(env);
  if (explicit) return { executable: explicit, source: "explicit" };

  if (truthy(env.CI)) {
    throw codedError(
      "WEB_CHATGPT_COMPANION_BOOTSTRAP_DISABLED",
      "WCO browser companion bootstrap is disabled in CI; CI must not download or launch the user's browser transport.",
    );
  }

  const target = options.installPath ? path.resolve(options.installPath) : defaultBrowserCompanionInstallPath(env);
  if (!target) {
    throw codedError(
      "WEB_CHATGPT_COMPANION_WINDOWS_HOST_UNAVAILABLE",
      "WCO could not resolve the Windows LOCALAPPDATA companion destination. Run WCO from WSL with Windows interop enabled.",
    );
  }

  const version = options.packageVersion ?? await packageVersion();
  if (existsSync(target)) {
    const installed = await verifyInstalledCompanion(target, version);
    if (installed) return installed;
  }

  const fetcher = options.fetch ?? (async (url: string, init?: { redirect?: "follow" }) => await fetch(url, init) as unknown as DownloadResponse);
  const binaryUrl = releaseAssetUrl(version, COMPANION_ASSET);
  const shaUrl = releaseAssetUrl(version, COMPANION_SHA_ASSET);
  const [binaryResponse, shaResponse] = await Promise.all([
    fetcher(binaryUrl, { redirect: "follow" }),
    fetcher(shaUrl, { redirect: "follow" }),
  ]);
  if (!binaryResponse.ok) {
    throw codedError("WEB_CHATGPT_COMPANION_DOWNLOAD_FAILED", `WCO companion release asset download failed with HTTP ${binaryResponse.status}.`);
  }
  if (!shaResponse.ok) {
    throw codedError("WEB_CHATGPT_COMPANION_DOWNLOAD_FAILED", `WCO companion checksum download failed with HTTP ${shaResponse.status}.`);
  }

  const [binary, shaSource] = await Promise.all([
    boundedBytes(binaryResponse, MAX_COMPANION_BYTES, "WCO companion release asset"),
    shaResponse.text(),
  ]);
  if (Buffer.byteLength(shaSource, "utf8") > MAX_SHA_BYTES) {
    throw codedError("WEB_CHATGPT_COMPANION_CHECKSUM_INVALID", "Companion checksum document is oversized.");
  }
  const expectedSha = parseExpectedSha(shaSource);
  const actualSha = crypto.createHash("sha256").update(binary).digest("hex");
  if (actualSha !== expectedSha) {
    throw codedError(
      "WEB_CHATGPT_COMPANION_CHECKSUM_MISMATCH",
      `WCO companion checksum mismatch: expected ${expectedSha}, received ${actualSha}.`,
    );
  }

  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const temporaryExecutable = path.join(directory, `.wco-browser-companion-${nonce}.tmp`);
  const temporaryMetadata = path.join(directory, `.wco-browser-companion-${nonce}.json.tmp`);
  const metadataPath = browserCompanionInstallMetadataPath(target);
  try {
    await writeFile(temporaryExecutable, binary, { flag: "wx", mode: 0o700 });
    await writeFile(temporaryMetadata, `${JSON.stringify({
      schema_version: 1,
      version,
      sha256: actualSha,
      asset: COMPANION_ASSET,
      repository: RELEASE_REPOSITORY,
    }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporaryExecutable, target);
    await rename(temporaryMetadata, metadataPath);
  } catch (error) {
    await rm(temporaryExecutable, { force: true }).catch(() => undefined);
    await rm(temporaryMetadata, { force: true }).catch(() => undefined);
    throw codedError(
      "WEB_CHATGPT_COMPANION_INSTALL_FAILED",
      `Could not atomically install WCO browser companion: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { executable: target, source: "downloaded", version, sha256: actualSha };
}
