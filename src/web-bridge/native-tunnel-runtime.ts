import crypto from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yauzl from "yauzl";
import { WebBridgeError } from "./contracts.js";
import type { NativeOpenAiCredential } from "./native-openai-credential.js";

const RELEASE = "v0.0.11";
const ASSETS: Record<string, { name: string; sha256: string }> = {
  "linux:x64": { name: "tunnel-client-v0.0.11-linux-amd64.zip", sha256: "29adfe5c1399dfb9fda9383f230c324355912f50dc36e2e416b1f1322317b3c4" },
  "linux:arm64": { name: "tunnel-client-v0.0.11-linux-arm64.zip", sha256: "d8bba47b2a723799a372b0b87d7e4d69304093d3a28837237315fe5406d97e77" },
};
const MAX_ARCHIVE = 40 * 1024 * 1024;
const MAX_BINARY = 96 * 1024 * 1024;

interface TunnelManifest { schema_version: "1.0"; release: string; asset: string; archive_sha256: string; binary_sha256: string; }
export interface NativeTunnelProcess { child: ChildProcess; health_url: string; stop(): Promise<void>; }

function hash(value: Buffer): string { return crypto.createHash("sha256").update(value).digest("hex"); }
function asset(): { name: string; sha256: string } {
  const value = ASSETS[`${process.platform}:${process.arch}`];
  if (!value) throw new WebBridgeError("WEB_NATIVE_PLATFORM_UNSUPPORTED", "Official Secure MCP Tunnel bootstrap currently supports Linux/WSL x64 and arm64, matching WCO's Bubblewrap runtime requirement.");
  return value;
}
function shellWord(value: string): string { return `"${value.replace(/([\\"$`])/g, "\\$1")}"`; }

async function safeCache(directory: string): Promise<string> {
  const root = path.resolve(directory, "openai-tunnel", RELEASE);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(root) !== root) throw new WebBridgeError("WEB_NATIVE_TUNNEL_CACHE_UNSAFE", "Tunnel client cache path is unsafe.");
  await chmod(root, 0o700).catch(() => undefined);
  return root;
}

async function extractBinary(archive: Buffer): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    yauzl.fromBuffer(archive, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) { reject(new WebBridgeError("WEB_NATIVE_TUNNEL_ARCHIVE_INVALID", `Cannot open tunnel-client archive: ${error?.message ?? "unknown"}`)); return; }
      let found = false;
      zip.on("error", reject);
      zip.on("entry", (entry) => {
        if (found || /\/$/.test(entry.fileName) || path.posix.basename(entry.fileName) !== "tunnel-client") { zip.readEntry(); return; }
        if (entry.uncompressedSize < 1 || entry.uncompressedSize > MAX_BINARY) { reject(new WebBridgeError("WEB_NATIVE_TUNNEL_ARCHIVE_INVALID", "Tunnel-client binary exceeds its extraction bound.")); return; }
        found = true;
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) { reject(streamError ?? new Error("missing tunnel-client stream")); return; }
          const chunks: Buffer[] = []; let total = 0;
          stream.on("data", (chunk: Buffer) => { total += chunk.byteLength; if (total > MAX_BINARY) { stream.destroy(new Error("binary limit")); return; } chunks.push(chunk); });
          stream.on("error", reject);
          stream.on("end", () => resolve(Buffer.concat(chunks)));
        });
      });
      zip.on("end", () => { if (!found) reject(new WebBridgeError("WEB_NATIVE_TUNNEL_ARCHIVE_INVALID", "Tunnel-client binary is missing from the official archive.")); });
      zip.readEntry();
    });
  });
}

export async function ensureOfficialTunnelClient(cacheDirectory: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const root = await safeCache(cacheDirectory), binaryPath = path.join(root, "tunnel-client"), manifestPath = path.join(root, "manifest.json"), selected = asset();
  try {
    const [binary, rawManifest, info] = await Promise.all([readFile(binaryPath), readFile(manifestPath, "utf8"), lstat(binaryPath)]);
    const manifest = JSON.parse(rawManifest) as TunnelManifest;
    if (info.isFile() && !info.isSymbolicLink() && manifest.schema_version === "1.0" && manifest.release === RELEASE && manifest.asset === selected.name && manifest.archive_sha256 === selected.sha256 && manifest.binary_sha256 === hash(binary)) return binaryPath;
  } catch { /* disposable cache is rebuilt below */ }
  await rm(root, { recursive: true, force: true }); await mkdir(root, { recursive: true, mode: 0o700 });
  const url = `https://github.com/openai/tunnel-client/releases/download/${RELEASE}/${selected.name}`;
  const response = await fetchImpl(url, { redirect: "follow" });
  if (!response.ok) throw new WebBridgeError("WEB_NATIVE_TUNNEL_DOWNLOAD_FAILED", `Official tunnel-client download failed with HTTP ${response.status}.`);
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_ARCHIVE) throw new WebBridgeError("WEB_NATIVE_TUNNEL_ARCHIVE_INVALID", "Tunnel-client archive exceeds the download bound.");
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.byteLength > MAX_ARCHIVE || hash(archive) !== selected.sha256) throw new WebBridgeError("WEB_NATIVE_TUNNEL_DIGEST_MISMATCH", "Official tunnel-client archive digest does not match WCO's pinned release manifest.");
  const binary = await extractBinary(archive), binarySha = hash(binary), temporary = `${binaryPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, binary, { mode: 0o700, flag: "wx" }); await chmod(temporary, 0o700); await rename(temporary, binaryPath);
  await writeFile(manifestPath, `${JSON.stringify({ schema_version: "1.0", release: RELEASE, asset: selected.name, archive_sha256: selected.sha256, binary_sha256: binarySha } satisfies TunnelManifest)}\n`, { mode: 0o600 });
  return binaryPath;
}

function cliPath(): string { return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../cli/index.js"); }

export async function startNativeTunnel(options: { cacheDirectory: string; credential: NativeOpenAiCredential; fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<NativeTunnelProcess> {
  const binary = await ensureOfficialTunnelClient(options.cacheDirectory, options.fetchImpl ?? fetch);
  const runtimeDir = await safeCache(options.cacheDirectory), healthFile = path.join(runtimeDir, `health-${process.pid}-${crypto.randomUUID()}.url`);
  const mcpCommand = `${shellWord(process.execPath)} ${shellWord(cliPath())} web mcp`;
  const environment: NodeJS.ProcessEnv = { CONTROL_PLANE_API_KEY: options.credential.control_plane_api_key };
  for (const key of ["PATH", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]) if (process.env[key]) environment[key] = process.env[key];
  const child = spawn(binary, ["run", "--control-plane.tunnel-id", options.credential.tunnel_id, "--mcp.command", mcpCommand, "--health.listen-addr", "127.0.0.1:0", "--health.url-file", healthFile], { stdio: ["ignore", "ignore", "pipe"], env: environment, shell: false });
  let stderr = ""; child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < 16_384) stderr += chunk.toString("utf8").slice(0, 16_384 - stderr.length); });
  const deadline = Date.now() + (options.timeoutMs ?? 15_000); let health = "";
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`tunnel-client exited ${child.exitCode}: ${stderr.trim()}`);
      try { health = (await readFile(healthFile, "utf8")).trim(); } catch { /* not ready yet */ }
      if (health) {
        const url = new URL(health); if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error("unexpected health endpoint");
        const ready = await (options.fetchImpl ?? fetch)(new URL("/readyz", url)).catch(() => null);
        if (ready?.ok) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!health || Date.now() >= deadline) throw new Error("tunnel-client readiness timed out");
  } catch (error) {
    child.kill("SIGTERM");
    throw new WebBridgeError("WEB_NATIVE_TUNNEL_UNAVAILABLE", `Secure MCP Tunnel could not become ready: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    child,
    health_url: health,
    async stop() {
      if (child.exitCode !== null) return;
      await new Promise<void>((resolve) => { const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2_000); child.once("exit", () => { clearTimeout(timer); resolve(); }); child.kill("SIGTERM"); });
    },
  };
}

export async function stopNativeTunnel(runtime: NativeTunnelProcess | null | undefined): Promise<void> {
  if (runtime) await runtime.stop();
}

export const PINNED_TUNNEL_CLIENT_RELEASE = RELEASE;