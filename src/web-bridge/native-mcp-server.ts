import readline from "node:readline";
import path from "node:path";
import { loadTrustedConfig } from "../config/config-loader.js";
import { resolveWcoPaths } from "../setup/default-paths.js";
import { ContentAddressedContextCache } from "./context-cache.js";
import {
  contentDigest,
  parseRepositoryCommand,
  parseWebContractEnvelope,
  parseWebImplementationSubmission,
  parseWebVerdictEnvelope,
  WebBridgeError,
} from "./contracts.js";
import { ReadCoverageStore } from "./read-coverage-store.js";
import { RelayFileStore } from "./relay/file-store.js";
import { isRelayJobPending, type RelayJobRecord } from "./relay/protocol.js";
import { ExactRepositoryReadService } from "./repo-read-service.js";

const SERVER_NAME = "wco-web-native";
const SERVER_VERSION = "0.4.0";
const MODERN_PROTOCOL = "2026-07-28";
const LEGACY_PROTOCOL = "2025-11-25";
const MAX_STDIN_LINE_BYTES = 16 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}
interface RpcError { code: number; message: string; data?: unknown; }
interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

function object(value: unknown, label = "arguments"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WebBridgeError("WEB_NATIVE_TOOL_ARGUMENT_INVALID", `${label} must be an object.`);
  return value as Record<string, unknown>;
}
function closed(value: Record<string, unknown>, keys: readonly string[], label = "arguments"): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new WebBridgeError("WEB_NATIVE_TOOL_ARGUMENT_INVALID", `${label} contains unknown field '${key}'.`);
}
function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new WebBridgeError("WEB_NATIVE_TOOL_ARGUMENT_INVALID", `${label} is invalid.`);
  return value;
}
function optionalIdentifier(value: unknown, label: string): string | undefined { return value === undefined ? undefined : identifier(value, label); }
function newest(records: RelayJobRecord[], kind: "authoring" | "final_review"): RelayJobRecord | null {
  return records.filter((item) => item.kind === kind && isRelayJobPending(item)).at(-1) ?? null;
}
function result(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { resultType: "complete", content: [{ type: "text", text }], structuredContent: value, isError: false };
}
function failResult(error: unknown): Record<string, unknown> {
  const code = error instanceof WebBridgeError ? error.code : "WEB_NATIVE_TOOL_FAILED";
  const message = error instanceof Error ? error.message : String(error);
  return { resultType: "complete", content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }], structuredContent: { error: { code, message } }, isError: true };
}
function readAnnotations() { return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }; }
function submitAnnotations() { return { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }; }
const emptySchema = { type: "object", additionalProperties: false };

const TOOLS: ToolDefinition[] = [
  {
    name: "wco_get_pending_task",
    title: "Get pending WCO task",
    description: "Return the newest exact pending WCO authoring task for this local user. Call this before authoring. It never mutates the repository.",
    inputSchema: emptySchema,
    annotations: readAnnotations(),
  },
  {
    name: "wco_repository_summary",
    title: "Get exact repository summary",
    description: "Read the exact sealed Git base identity and tree SHA for a pending WCO authoring job.",
    inputSchema: { type: "object", additionalProperties: false, required: ["job_id"], properties: { job_id: { type: "string" } } },
    annotations: readAnnotations(),
  },
  {
    name: "wco_repository_tree",
    title: "List exact repository tree",
    description: "List bounded non-sensitive paths from the exact sealed Git base. Prefer focused prefixes and small limits.",
    inputSchema: { type: "object", additionalProperties: false, required: ["job_id"], properties: { job_id: { type: "string" }, prefix: { type: "string" }, maximum_paths: { type: "integer", minimum: 1, maximum: 5000 } } },
    annotations: readAnnotations(),
  },
  {
    name: "wco_repository_search",
    title: "Search exact repository",
    description: "Perform a bounded literal Git search against the exact sealed base to localize relevant files.",
    inputSchema: { type: "object", additionalProperties: false, required: ["job_id", "query"], properties: { job_id: { type: "string" }, query: { type: "string", maxLength: 256 }, maximum_matches: { type: "integer", minimum: 1, maximum: 500 } } },
    annotations: readAnnotations(),
  },
  {
    name: "wco_repository_read",
    title: "Read exact repository content",
    description: "Read bounded exact files or byte regions from the sealed Git base. Use known_content_sha256 to avoid retransmitting immutable content. Full exact reads remain required before replace/delete authority.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["job_id"],
      properties: {
        job_id: { type: "string" },
        paths: { type: "array", minItems: 1, maxItems: 32, uniqueItems: true, items: { type: "string" } },
        regions: { type: "array", minItems: 1, maxItems: 32, items: { type: "object", additionalProperties: false, required: ["path", "start_byte", "end_byte_exclusive"], properties: { path: { type: "string" }, start_byte: { type: "integer", minimum: 0 }, end_byte_exclusive: { type: "integer", minimum: 1 } } } },
        known_content_sha256: { type: "object", additionalProperties: { type: "string", pattern: "^[a-f0-9]{64}$" }, maxProperties: 32 },
      },
      oneOf: [{ required: ["paths"] }, { required: ["regions"] }],
    },
    annotations: readAnnotations(),
  },
  {
    name: "wco_get_authoring_updates",
    title: "Get WCO authoring updates",
    description: "Return bounded user clarifications recorded for an exact pending authoring job after a sequence number.",
    inputSchema: { type: "object", additionalProperties: false, required: ["job_id"], properties: { job_id: { type: "string" }, after_sequence: { type: "integer", minimum: 0 } } },
    annotations: readAnnotations(),
  },
  {
    name: "wco_submit_contract",
    title: "Submit sealed WCO contract",
    description: "Submit a bounded, exact WebContractEnvelope to local WCO durable state. This is semantic authority only: it cannot write repository files, run shell/Git, publish, merge, deploy, or release.",
    inputSchema: { type: "object", additionalProperties: false, required: ["envelope"], properties: { envelope: { type: "object" } } },
    annotations: submitAnnotations(),
  },
  {
    name: "wco_submit_implementation",
    title: "Submit bounded implementation proposal",
    description: "Submit an exact WebImplementationSubmission to local WCO durable state. Harness independently validates and is the only component allowed to mutate the worktree.",
    inputSchema: { type: "object", additionalProperties: false, required: ["submission"], properties: { submission: { type: "object" } } },
    annotations: submitAnnotations(),
  },
  {
    name: "wco_get_pending_review",
    title: "Get pending WCO review",
    description: "Return the newest exact pending WCO Web review identity. The associated evidence determines whether this is independent PAIR review or original-Web final intent review.",
    inputSchema: emptySchema,
    annotations: readAnnotations(),
  },
  {
    name: "wco_get_review_evidence",
    title: "Get exact WCO review evidence",
    description: "Return the bounded exact Result evidence associated with a pending review job. Review every supplied diff hunk and request exact repository context only through WCO-authorized tools when needed.",
    inputSchema: { type: "object", additionalProperties: false, required: ["review_id"], properties: { review_id: { type: "string" } } },
    annotations: readAnnotations(),
  },
  {
    name: "wco_submit_review_verdict",
    title: "Submit WCO review verdict",
    description: "Submit a schema-validated Web review verdict, optionally with bounded repair operations. This does not mutate code; Harness owns any repair application and re-verification.",
    inputSchema: { type: "object", additionalProperties: false, required: ["verdict"], properties: { verdict: { type: "object" } } },
    annotations: submitAnnotations(),
  },
];

class NativeMcpTools {
  private readonly paths = resolveWcoPaths({});
  private readonly store = new RelayFileStore(this.paths.bridge);
  private readonly owner = "local";

  private async records(): Promise<RelayJobRecord[]> { return await this.store.list(this.owner); }
  private async job(jobId: string, kind?: "authoring" | "final_review"): Promise<RelayJobRecord> {
    const record = await this.store.get(identifier(jobId, "job_id"), this.owner);
    if (kind && record.kind !== kind) throw new WebBridgeError("WEB_NATIVE_JOB_KIND_MISMATCH", `WCO job '${jobId}' is not ${kind}.`);
    return record;
  }
  private async reader(jobId: string): Promise<ExactRepositoryReadService> {
    const record = await this.job(jobId, "authoring");
    const request = record.request as { repository?: { repository_id?: unknown; base_branch?: unknown; base_commit?: unknown } };
    const repository = request.repository;
    if (!repository || typeof repository.repository_id !== "string" || typeof repository.base_branch !== "string" || typeof repository.base_commit !== "string") throw new WebBridgeError("WEB_NATIVE_JOB_INVALID", "Pending authoring job has no exact repository binding.");
    const config = await loadTrustedConfig(this.paths.config);
    const configured = config.repositories[repository.repository_id];
    if (!configured) throw new WebBridgeError("REPOSITORY_NOT_REGISTERED", "Pending WCO repository is not registered in trusted config.");
    return new ExactRepositoryReadService(
      configured.path,
      { repository_id: repository.repository_id, base_branch: repository.base_branch, base_commit: repository.base_commit },
      new ReadCoverageStore(path.join(this.paths.state, "bridge", "read-coverage")),
      {},
      new ContentAddressedContextCache(path.join(this.paths.state, "cache", "web-context")),
    );
  }

  async call(name: string, input: unknown): Promise<unknown> {
    const args = object(input ?? {});
    if (name === "wco_get_pending_task") {
      closed(args, []);
      const record = newest(await this.records(), "authoring");
      return { job: record ? { identity: record.identity, request: record.request } : null };
    }
    if (name === "wco_repository_summary") {
      closed(args, ["job_id"]); const jobId = identifier(args.job_id, "job_id"); return await (await this.reader(jobId)).execute(jobId, `mcp-summary-${contentDigest({ jobId })}`, { operation: "summary" });
    }
    if (name === "wco_repository_tree") {
      closed(args, ["job_id", "prefix", "maximum_paths"]); const jobId = identifier(args.job_id, "job_id");
      return await (await this.reader(jobId)).execute(jobId, `mcp-tree-${contentDigest(args)}`, parseRepositoryCommand({ operation: "tree", ...(args.prefix !== undefined ? { prefix: args.prefix } : {}), ...(args.maximum_paths !== undefined ? { maximum_paths: args.maximum_paths } : {}) }));
    }
    if (name === "wco_repository_search") {
      closed(args, ["job_id", "query", "maximum_matches"]); const jobId = identifier(args.job_id, "job_id");
      return await (await this.reader(jobId)).execute(jobId, `mcp-search-${contentDigest(args)}`, parseRepositoryCommand({ operation: "search", query: args.query, ...(args.maximum_matches !== undefined ? { maximum_matches: args.maximum_matches } : {}) }));
    }
    if (name === "wco_repository_read") {
      closed(args, ["job_id", "paths", "regions", "known_content_sha256"]); const jobId = identifier(args.job_id, "job_id");
      const command = parseRepositoryCommand({ operation: "read", ...(args.paths !== undefined ? { paths: args.paths } : {}), ...(args.regions !== undefined ? { regions: args.regions } : {}), ...(args.known_content_sha256 !== undefined ? { known_content_sha256: args.known_content_sha256 } : {}) });
      return await (await this.reader(jobId)).execute(jobId, `mcp-read-${contentDigest(args)}`, command);
    }
    if (name === "wco_get_authoring_updates") {
      closed(args, ["job_id", "after_sequence"]); const jobId = identifier(args.job_id, "job_id"), after = args.after_sequence === undefined ? 0 : args.after_sequence;
      if (!Number.isSafeInteger(after) || (after as number) < 0) throw new WebBridgeError("WEB_NATIVE_TOOL_ARGUMENT_INVALID", "after_sequence is invalid.");
      const record = await this.job(jobId, "authoring");
      return { events: record.events.filter((event) => event.sequence > (after as number) && event.type === "user_clarification").map((event) => ({ sequence: event.sequence, type: event.type, payload: event.payload, created_at: event.created_at })) };
    }
    if (name === "wco_submit_contract") {
      closed(args, ["envelope"]); const envelope = parseWebContractEnvelope(args.envelope); await this.job(envelope.job_id, "authoring");
      const payload = { envelope }; await this.store.append(envelope.job_id, this.owner, "contract_sealed", payload, `mcp-contract-${contentDigest(payload)}`); return { accepted: true, job_id: envelope.job_id, digest: contentDigest(envelope) };
    }
    if (name === "wco_submit_implementation") {
      closed(args, ["submission"]); const submission = parseWebImplementationSubmission(args.submission); await this.job(submission.job_id, "authoring");
      const payload = { submission }; await this.store.append(submission.job_id, this.owner, "implementation_sealed", payload, `mcp-implementation-${contentDigest(payload)}`); return { accepted: true, job_id: submission.job_id, digest: contentDigest(submission) };
    }
    if (name === "wco_get_pending_review") {
      closed(args, []); const record = newest(await this.records(), "final_review"); return { review: record ? { identity: record.identity, request: record.request } : null };
    }
    if (name === "wco_get_review_evidence") {
      closed(args, ["review_id"]); const reviewId = identifier(args.review_id, "review_id"), record = await this.job(reviewId, "final_review");
      const evidence = record.events.findLast((event) => event.type === "final_review_evidence"); return { evidence: evidence?.payload ?? null };
    }
    if (name === "wco_submit_review_verdict") {
      closed(args, ["verdict"]); const verdict = parseWebVerdictEnvelope(args.verdict); await this.job(verdict.review_id, "final_review");
      const payload = { verdict }; await this.store.append(verdict.review_id, this.owner, "web_verdict", payload, `mcp-verdict-${contentDigest(payload)}`); return { accepted: true, review_id: verdict.review_id, digest: contentDigest(verdict) };
    }
    throw new WebBridgeError("WEB_NATIVE_TOOL_NOT_FOUND", `Unknown WCO MCP tool '${name}'.`);
  }
}

function rpcError(id: JsonRpcRequest["id"], error: RpcError): string { return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error }); }
function rpcResult(id: JsonRpcRequest["id"], value: unknown): string { return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result: value }); }
function protocolVersion(request: JsonRpcRequest): string | null {
  const params = request.params && typeof request.params === "object" && !Array.isArray(request.params) ? request.params as Record<string, unknown> : null;
  const meta = params?._meta && typeof params._meta === "object" && !Array.isArray(params._meta) ? params._meta as Record<string, unknown> : null;
  return typeof meta?.["io.modelcontextprotocol/protocolVersion"] === "string" ? meta["io.modelcontextprotocol/protocolVersion"] as string : null;
}

export async function handleNativeMcpRequest(request: JsonRpcRequest, tools = new NativeMcpTools()): Promise<string | null> {
  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string" || (!Object.prototype.hasOwnProperty.call(request, "id") && !request.method.startsWith("notifications/"))) return rpcError(request?.id, { code: -32600, message: "Invalid Request" });
  if (request.method === "notifications/initialized") return null;
  if (request.method === "server/discover") return rpcResult(request.id, { resultType: "complete", supportedVersions: [MODERN_PROTOCOL, LEGACY_PROTOCOL], capabilities: { tools: { listChanged: false } }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }, instructions: "WCO exposes bounded semantic authoring/review and exact read tools. Harness alone mutates, verifies, publishes Draft PRs, and enforces human-only merge/release." });
  if (request.method === "initialize") {
    const params = object(request.params ?? {}, "initialize params"); const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : LEGACY_PROTOCOL;
    const selected = requested === MODERN_PROTOCOL ? MODERN_PROTOCOL : LEGACY_PROTOCOL;
    return rpcResult(request.id, { protocolVersion: selected, capabilities: { tools: { listChanged: false } }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }, instructions: "Use WCO tools only for bounded semantic authority and exact reads; never request shell, Git mutation, merge, deploy, or release." });
  }
  const version = protocolVersion(request);
  if (version && version !== MODERN_PROTOCOL && version !== LEGACY_PROTOCOL) return rpcError(request.id, { code: -32602, message: `Unsupported MCP protocol version '${version}'.` });
  if (request.method === "tools/list") return rpcResult(request.id, { resultType: "complete", tools: TOOLS, ttlMs: 300_000, cacheScope: "public" });
  if (request.method === "tools/call") {
    try {
      const params = object(request.params ?? {}, "tools/call params"); closed(params, ["name", "arguments", "_meta", "inputResponses", "requestState"], "tools/call params"); const name = identifier(params.name, "tool name");
      return rpcResult(request.id, result(await tools.call(name, params.arguments ?? {})));
    } catch (error) { return rpcResult(request.id, failResult(error)); }
  }
  return rpcError(request.id, { code: -32601, message: "Method not found" });
}

export async function runNativeMcpServer(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout, errorOutput: NodeJS.WritableStream = process.stderr): Promise<number> {
  const lines = readline.createInterface({ input: input as NodeJS.ReadableStream & { on(event: string, listener: (...args: unknown[]) => void): unknown }, crlfDelay: Infinity, terminal: false });
  try {
    for await (const line of lines) {
      if (Buffer.byteLength(line, "utf8") > MAX_STDIN_LINE_BYTES) { output.write(`${rpcError(null, { code: -32700, message: "MCP message exceeds WCO input bound." })}\n`); continue; }
      let request: JsonRpcRequest;
      try { request = JSON.parse(line) as JsonRpcRequest; }
      catch { output.write(`${rpcError(null, { code: -32700, message: "Parse error" })}\n`); continue; }
      try {
        const response = await handleNativeMcpRequest(request);
        if (response !== null) output.write(`${response}\n`);
      } catch (error) {
        errorOutput.write(`WCO MCP internal error: ${error instanceof Error ? error.message : String(error)}\n`);
        if (Object.prototype.hasOwnProperty.call(request, "id")) output.write(`${rpcError(request.id, { code: -32603, message: "Internal error" })}\n`);
      }
    }
    return 0;
  } finally { lines.close(); }
}

export { TOOLS as WCO_NATIVE_MCP_TOOLS, MODERN_PROTOCOL as WCO_MCP_PROTOCOL_VERSION };
