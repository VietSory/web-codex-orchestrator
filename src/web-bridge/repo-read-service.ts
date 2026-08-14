import crypto from "node:crypto";
import { realpath } from "node:fs/promises";
import { spawnBounded, spawnBoundedBinary, type SpawnBounded, type SpawnBoundedBinary } from "../runtime/spawn-bounded.js";
import { assertRepositoryRelativePath } from "../web-authority/pack-reader.js";
import { WebBridgeError, parseRepositoryCommand, type RepositoryBinding, type RepositoryCommand } from "./contracts.js";
import { ReadCoverageStore, type ReadCoverageReceipt } from "./read-coverage-store.js";
import { ContentAddressedContextCache, emptyContextTransferMetrics, type ContextTransferMetrics } from "./context-cache.js";

export interface RepoReadLimits { maximum_paths: number; maximum_query_length: number; maximum_matches: number; maximum_read_files: number; maximum_file_bytes: number; maximum_total_bytes: number; timeout_ms: number; }
const DEFAULT_LIMITS: RepoReadLimits = { maximum_paths: 5_000, maximum_query_length: 256, maximum_matches: 500, maximum_read_files: 32, maximum_file_bytes: 1_048_576, maximum_total_bytes: 4_194_304, timeout_ms: 5_000 };
const MAX_TRANSMITTED_CONTEXT_BYTES = 65_536;
type ReadRegion = { path: string; start_byte: number; end_byte_exclusive: number };
type ReadFile = { path: string; content_base64: string; content_ref?: string; content_sha256: string; blob_sha: string; size_bytes: number; start_byte: number; end_byte_exclusive: number; total_bytes: number };
const SENSITIVE = [/(^|\/)\.env($|\.)/i, /(^|\/)[^/]*\.(pem|key)$/i, /(^|\/)id_rsa[^/]*$/i, /(^|\/)(credentials|secrets?)[^/]*$/i, /(^|\/)\.git(\/|$)/i];
function denySensitive(value: string): void { assertRepositoryRelativePath(value); if (SENSITIVE.some((pattern) => pattern.test(value))) throw new WebBridgeError("WEB_REPOSITORY_PATH_SENSITIVE", `Repository path '${value}' is denied by sensitive-path policy.`); }
function environment(): Record<string, string> { const result: Record<string, string> = { GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }; for (const key of ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot"]) if (process.env[key]) result[key] = process.env[key]!; return result; }
function failed(result: { exitCode: number | null; timedOut: boolean; cancelled: boolean; stdoutTruncated: boolean; stderrTruncated: boolean; spawnError?: unknown }): boolean { return Boolean(result.spawnError || result.timedOut || result.cancelled || result.stdoutTruncated || result.stderrTruncated || result.exitCode !== 0); }
function gitBlobObjectId(content: Buffer): string {
  const header = Buffer.from(`blob ${content.byteLength}\0`, "utf8");
  return crypto.createHash("sha1").update(header).update(content).digest("hex");
}

export class ExactRepositoryReadService {
  private readonly limits: RepoReadLimits;
  constructor(private readonly repositoryRoot: string, private readonly binding: RepositoryBinding, private readonly coverage: ReadCoverageStore, limits: Partial<RepoReadLimits> = {}, private readonly cache?: ContentAddressedContextCache, private readonly runText: SpawnBounded = spawnBounded, private readonly runBinary: SpawnBoundedBinary = spawnBoundedBinary) { this.limits = { ...DEFAULT_LIMITS, ...limits }; if (!/^[a-f0-9]{40}$/.test(binding.base_commit)) throw new WebBridgeError("WEB_REPOSITORY_BINDING_INVALID", "Base commit must be an exact lowercase Git object ID."); }
  private async text(args: string[], maximum: number): Promise<string> { const result = await this.runText({ executable: "git", args: ["-c", "core.hooksPath=/dev/null", ...args], cwd: await realpath(this.repositoryRoot), environment: environment(), timeoutMs: this.limits.timeout_ms, stdoutMaxBytes: maximum, stderrMaxBytes: 8_192, shell: false }); if (failed(result)) throw new WebBridgeError("WEB_REPOSITORY_READ_FAILED", "Bounded exact Git read failed."); return result.stdout; }
  private async binary(args: string[], maximum: number): Promise<Buffer> { const result = await this.runBinary({ executable: "git", args: ["-c", "core.hooksPath=/dev/null", ...args], cwd: await realpath(this.repositoryRoot), environment: environment(), timeoutMs: this.limits.timeout_ms, stdoutMaxBytes: maximum, stderrMaxBytes: 8_192, shell: false }); if (failed(result)) throw new WebBridgeError(result.stdoutTruncated ? "WEB_REPOSITORY_FILE_TOO_LARGE" : "WEB_REPOSITORY_READ_FAILED", "Bounded exact Git object read failed."); return result.stdout; }
  async verifyBinding(): Promise<void> { const head = (await this.text(["rev-parse", "--verify", `${this.binding.base_commit}^{commit}`], 128)).trim(); if (head !== this.binding.base_commit) throw new WebBridgeError("WEB_REPOSITORY_BINDING_DRIFT", "Exact base commit could not be re-attested."); }
  async summary(): Promise<{ repository_id: string; base_branch: string; base_commit: string; tree_sha: string }> { await this.verifyBinding(); const tree_sha = (await this.text(["rev-parse", `${this.binding.base_commit}^{tree}`], 128)).trim(); return { ...this.binding, tree_sha }; }
  async tree(prefix = "", maximumPaths = this.limits.maximum_paths): Promise<{ paths: string[]; truncated: boolean }> { await this.verifyBinding(); if (prefix) denySensitive(prefix); const maximum = Math.min(Math.max(1, maximumPaths), this.limits.maximum_paths); const args = ["ls-tree", "-r", "-z", "--name-only", this.binding.base_commit, ...(prefix ? ["--", prefix] : [])]; const raw = await this.binary(args, Math.min(this.limits.maximum_total_bytes, 8_388_608)); const all = raw.toString("utf8").split("\0").filter(Boolean).filter((item) => !SENSITIVE.some((pattern) => pattern.test(item))); return { paths: all.slice(0, maximum), truncated: all.length > maximum }; }
  async search(query: string, maximumMatches = this.limits.maximum_matches): Promise<{ matches: string[]; truncated: boolean }> { await this.verifyBinding(); if (!query || query.length > this.limits.maximum_query_length || /[\r\n\0]/.test(query)) throw new WebBridgeError("WEB_REPOSITORY_QUERY_INVALID", "Search query is invalid or exceeds its bound."); const maximum = Math.min(Math.max(1, maximumMatches), this.limits.maximum_matches); const result = await this.runText({ executable: "git", args: ["-c", "core.hooksPath=/dev/null", "grep", "-l", "-I", "-F", "-e", query, this.binding.base_commit, "--"], cwd: await realpath(this.repositoryRoot), environment: environment(), timeoutMs: this.limits.timeout_ms, stdoutMaxBytes: this.limits.maximum_total_bytes, stderrMaxBytes: 8_192, shell: false }); if (result.exitCode === 1 && !result.spawnError && !result.timedOut) return { matches: [], truncated: false }; if (failed(result)) throw new WebBridgeError("WEB_REPOSITORY_READ_FAILED", "Bounded exact Git search failed."); const prefix = `${this.binding.base_commit}:`; const all = result.stdout.split("\n").filter(Boolean).map((line) => line.startsWith(prefix) ? line.slice(prefix.length) : "").filter((location) => location && !SENSITIVE.some((pattern) => pattern.test(location))); return { matches: all.slice(0, maximum), truncated: all.length > maximum };
  }
  async read(jobId: string, requestId: string, paths: string[], now = () => new Date(), knownContent: Record<string, string> = {}): Promise<{ files: ReadFile[]; metrics: ContextTransferMetrics }> {
    return await this.readRegions(jobId, requestId, paths.map((path) => ({ path, start_byte: 0, end_byte_exclusive: -1 })), now, knownContent);
  }
  async readRegions(jobId: string, requestId: string, regions: ReadRegion[], now = () => new Date(), knownContent: Record<string, string> = {}): Promise<{ files: ReadFile[]; metrics: ContextTransferMetrics }> {
    await this.verifyBinding();
    if (regions.length < 1 || regions.length > this.limits.maximum_read_files) throw new WebBridgeError("WEB_REPOSITORY_READ_LIMIT", "Region read request exceeds bounds.");
    const keys = regions.map((region) => `${region.path}\0${region.start_byte}\0${region.end_byte_exclusive}`);
    if (new Set(keys).size !== keys.length) throw new WebBridgeError("WEB_REPOSITORY_READ_LIMIT", "Region read request contains duplicates.");
    const metrics = emptyContextTransferMetrics(); metrics.files_considered = new Set(regions.map((region) => region.path)).size;
    let total = 0; const files = [];
    for (const region of regions) {
      const item = region.path;
      denySensitive(item);
      if (!Number.isSafeInteger(region.start_byte) || !Number.isSafeInteger(region.end_byte_exclusive) || region.start_byte < 0 || region.end_byte_exclusive === 0 || region.end_byte_exclusive < -1) throw new WebBridgeError("WEB_REPOSITORY_REGION_INVALID", "Repository byte range is invalid.");
      const referenceKey = region.end_byte_exclusive === -1 ? item : `${item}:${region.start_byte}:${region.end_byte_exclusive}`;
      const known = knownContent[referenceKey];
      if (known !== undefined && !/^[a-f0-9]{64}$/.test(known)) throw new WebBridgeError("WEB_REPOSITORY_CONTEXT_REFERENCE_INVALID", "Known content digest is invalid.");
      const blob_sha = (await this.text(["rev-parse", `${this.binding.base_commit}:${item}`], 128)).trim();
      if (!/^[a-f0-9]{40}$/.test(blob_sha)) throw new WebBridgeError("WEB_REPOSITORY_BINDING_DRIFT", "Exact Git blob identity is invalid.");
      const cacheKey = `${this.binding.base_commit}\0${blob_sha}\0full`;
      let content = this.cache ? await this.cache.get(cacheKey) : null;
      if (content && gitBlobObjectId(content) !== blob_sha) {
        // Cache is performance state, never repository authority. A self-consistent
        // but stale/tampered record is discarded and rebuilt from the exact Git object.
        await this.cache?.evict(cacheKey);
        content = null;
      }
      if (content) metrics.cache_hits += 1;
      else {
        metrics.cache_misses += 1;
        content = await this.binary(["show", `${this.binding.base_commit}:${item}`], this.limits.maximum_file_bytes + 1);
        if (gitBlobObjectId(content) !== blob_sha) throw new WebBridgeError("WEB_REPOSITORY_BINDING_DRIFT", "Git object bytes do not match the exact blob identity.");
        await this.cache?.put(cacheKey, content);
      }
      if (content.byteLength > this.limits.maximum_file_bytes) throw new WebBridgeError("WEB_REPOSITORY_READ_LIMIT", "File read response exceeds byte bounds.");
      const end = region.end_byte_exclusive === -1 ? content.byteLength : region.end_byte_exclusive;
      if (region.start_byte >= end || end > content.byteLength) throw new WebBridgeError("WEB_REPOSITORY_REGION_INVALID", "Repository byte range is outside the exact blob.");
      const selected = content.subarray(region.start_byte, end);
      if (total + selected.byteLength > this.limits.maximum_total_bytes) throw new WebBridgeError("WEB_REPOSITORY_READ_LIMIT", "Region read response exceeds byte bounds.");
      total += selected.byteLength; metrics.files_read = new Set([...files.map((file) => file.path), item]).size; metrics.regions_read += 1; metrics.context_bytes_prepared += selected.byteLength;
      const content_sha256 = crypto.createHash("sha256").update(selected).digest("hex");
      const receipt: ReadCoverageReceipt = { schema_version: "1.0", job_id: jobId, request_id: requestId, base_commit: this.binding.base_commit, path: item, blob_sha, content_sha256, start_byte: region.start_byte, end_byte_exclusive: end, total_bytes: content.byteLength, observed_at: now().toISOString() };
      await this.coverage.append(receipt);
      if (known === content_sha256) {
        metrics.repeated_bytes_avoided += selected.byteLength;
        files.push({ path: item, content_base64: "", content_ref: `sha256:${content_sha256}`, content_sha256, blob_sha, size_bytes: selected.byteLength, start_byte: region.start_byte, end_byte_exclusive: end, total_bytes: content.byteLength });
      } else {
        if (metrics.context_bytes_transmitted + selected.byteLength > MAX_TRANSMITTED_CONTEXT_BYTES) throw new WebBridgeError("WEB_REPOSITORY_TRANSPORT_LIMIT", "Repository context exceeds the GPT Action response budget; request smaller exact regions or reuse content digests.");
        metrics.context_bytes_transmitted += selected.byteLength;
        files.push({ path: item, content_base64: selected.toString("base64"), content_sha256, blob_sha, size_bytes: selected.byteLength, start_byte: region.start_byte, end_byte_exclusive: end, total_bytes: content.byteLength });
      }
    }
    return { files, metrics };
  }
  async execute(jobId: string, requestId: string, input: RepositoryCommand | unknown): Promise<unknown> { const command = parseRepositoryCommand(input); if (command.operation === "summary") return await this.summary(); if (command.operation === "tree") return await this.tree(command.prefix ?? "", command.maximum_paths); if (command.operation === "search") return await this.search(command.query, command.maximum_matches); if (command.regions) return await this.readRegions(jobId, requestId, command.regions, () => new Date(), command.known_content_sha256); return await this.read(jobId, requestId, command.paths!, () => new Date(), command.known_content_sha256); }
}
