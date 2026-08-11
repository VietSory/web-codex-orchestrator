import http, { type IncomingMessage, type ServerResponse } from "node:http";
import {
  WebBridgeError,
  parseWebContractEnvelope,
  parseWebImplementationSubmission,
  parseWebVerdictEnvelope,
  type FinalReviewRequest,
  type RepositoryBinding,
} from "../contracts.js";
import type { AuthoringJobRequest } from "../web-bridge.js";
import { RelayFileStore } from "./file-store.js";
import { PersonalBearerAuthenticator } from "./auth.js";
import { isRelayJobPending, toAuthoringEvent, type RelayJobRecord } from "./protocol.js";

const MAX_REQUEST_BYTES = 8_388_608;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of request) {
    const chunk = Buffer.from(raw);
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new WebBridgeError("RELAY_REQUEST_LIMIT", "Relay request exceeded its byte bound.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new WebBridgeError("RELAY_REQUEST_INVALID", "Relay request is not valid JSON."); }
}

function send(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": body.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(body);
}

function idempotency(request: IncomingMessage): string {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new WebBridgeError("RELAY_IDEMPOTENCY_REQUIRED", "A valid Idempotency-Key is required.");
  return value;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WebBridgeError("RELAY_REQUEST_INVALID", `${label} must be an object.`);
  return value as Record<string, unknown>;
}

function closed(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new WebBridgeError("RELAY_REQUEST_INVALID", `${label} contains unknown field '${key}'.`);
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.includes("\0")) throw new WebBridgeError("RELAY_REQUEST_INVALID", `${label} is invalid.`);
  return value;
}

function sha256(value: unknown, label: string): string {
  const result = boundedText(value, label, 64);
  if (!SHA256.test(result)) throw new WebBridgeError("RELAY_REQUEST_INVALID", `${label} must be lowercase SHA-256.`);
  return result;
}

function repositoryBinding(value: unknown): RepositoryBinding {
  const repository = object(value, "repository");
  closed(repository, ["repository_id", "base_branch", "base_commit"], "repository");
  const repositoryId = boundedText(repository.repository_id, "repository.repository_id", 128);
  if (!SAFE_ID.test(repositoryId)) throw new WebBridgeError("RELAY_REQUEST_INVALID", "repository.repository_id is invalid.");
  return { repository_id: repositoryId, base_branch: boundedText(repository.base_branch, "repository.base_branch", 256), base_commit: boundedText(repository.base_commit, "repository.base_commit", 64) };
}

function normalizeAuthoringRequest(supplied: unknown, owner: string): AuthoringJobRequest {
  const input = object(supplied, "Authoring request");
  closed(input, ["owner", "repository", "user_intent", "ttl_seconds", "orchestration_mode"], "Authoring request");
  if (!Number.isSafeInteger(input.ttl_seconds)) throw new WebBridgeError("RELAY_REQUEST_INVALID", "ttl_seconds must be an integer.");
  const mode = input.orchestration_mode;
  if (mode !== undefined && mode !== "PAIR" && mode !== "AUTOPILOT") throw new WebBridgeError("RELAY_REQUEST_INVALID", "orchestration_mode must be PAIR or AUTOPILOT when supplied.");
  return {
    owner,
    repository: repositoryBinding(input.repository),
    user_intent: boundedText(input.user_intent, "user_intent", 16_384),
    ttl_seconds: input.ttl_seconds as number,
    ...(mode ? { orchestration_mode: mode } : {}),
  };
}

function normalizeFinalReviewRequest(supplied: unknown): FinalReviewRequest {
  const input = object(supplied, "Final review request");
  closed(input, ["run_id", "result_bundle_sha256", "published_commit_sha", "pull_request_url", "review_round"], "Final review request");
  if (!Number.isSafeInteger(input.review_round) || (input.review_round as number) < 1 || (input.review_round as number) > 10_000) throw new WebBridgeError("RELAY_REQUEST_INVALID", "review_round is invalid.");
  const pullRequestUrl = boundedText(input.pull_request_url, "pull_request_url", 2_048);
  let parsed: URL;
  try { parsed = new URL(pullRequestUrl); } catch { throw new WebBridgeError("RELAY_REQUEST_INVALID", "pull_request_url is invalid."); }
  if (parsed.protocol !== "https:") throw new WebBridgeError("RELAY_REQUEST_INVALID", "pull_request_url must use HTTPS.");
  return {
    run_id: boundedText(input.run_id, "run_id", 256),
    result_bundle_sha256: sha256(input.result_bundle_sha256, "result_bundle_sha256"),
    published_commit_sha: sha256(input.published_commit_sha, "published_commit_sha"),
    pull_request_url: pullRequestUrl,
    review_round: input.review_round as number,
  };
}

function latestPendingJob(jobs: RelayJobRecord[], kind: RelayJobRecord["kind"]): RelayJobRecord | undefined {
  return jobs.filter((job) => job.kind === kind && isRelayJobPending(job)).at(-1);
}

function sameRepository(left: RepositoryBinding, right: RepositoryBinding): boolean {
  return left.repository_id === right.repository_id && left.base_branch === right.base_branch && left.base_commit === right.base_commit;
}

async function authoringMutationRecord(store: RelayFileStore, jobId: string, owner: string, key: string): Promise<RelayJobRecord> {
  const record = await store.get(jobId, owner);
  if (record.kind !== "authoring") throw new WebBridgeError("RELAY_JOB_KIND_INVALID", "Mutation target is not an authoring job.");
  if (!isRelayJobPending(record) && !(`event:${key}` in record.idempotency)) throw new WebBridgeError("RELAY_JOB_COMPLETE", "The authoring job is already complete; no additional authoring mutations are accepted.");
  return record;
}

async function finalReviewMutationRecord(store: RelayFileStore, reviewId: string, owner: string, key: string): Promise<RelayJobRecord> {
  const record = await store.get(reviewId, owner);
  if (record.kind !== "final_review") throw new WebBridgeError("RELAY_JOB_KIND_INVALID", "Mutation target is not a final-review job.");
  if (!isRelayJobPending(record) && !(`event:${key}` in record.idempotency)) throw new WebBridgeError("RELAY_JOB_COMPLETE", "The final-review job already has a terminal verdict.");
  return record;
}

export function createRelayServer(options: { store: RelayFileStore; authenticator: PersonalBearerAuthenticator }): http.Server {
  return http.createServer(async (request, response) => {
    try {
      const principal = options.authenticator.authenticate(request.headers.authorization);
      const url = new URL(request.url ?? "/", "http://relay.invalid");
      const method = request.method ?? "GET";

      if (method === "GET" && url.pathname === "/v1/status") {
        const jobs = await options.store.list(principal.owner);
        send(response, 200, { configured: true, connected: true, account: principal.owner, pending_author_job: latestPendingJob(jobs, "authoring")?.identity.job_id, pending_final_review: latestPendingJob(jobs, "final_review")?.identity.job_id }); return;
      }
      if (method === "POST" && url.pathname === "/v1/authoring/jobs") {
        const body = normalizeAuthoringRequest(await jsonBody(request), principal.owner);
        send(response, 201, await options.store.create("authoring", principal.owner, body, idempotency(request), body.ttl_seconds)); return;
      }
      if (method === "POST" && url.pathname === "/v1/final-reviews") {
        const body = normalizeFinalReviewRequest(await jsonBody(request));
        send(response, 201, await options.store.create("final_review", principal.owner, body, idempotency(request), 86_400)); return;
      }
      if (method === "GET" && url.pathname === "/v1/authoring/pending") {
        const record = latestPendingJob(await options.store.list(principal.owner), "authoring");
        send(response, 200, { job: record ? { identity: record.identity, request: record.request } : null }); return;
      }
      if (method === "GET" && url.pathname === "/v1/final-reviews/pending") {
        const record = latestPendingJob(await options.store.list(principal.owner), "final_review");
        send(response, 200, { review: record ? { identity: record.identity, request: record.request } : null }); return;
      }

      const eventMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/events$/);
      if (method === "GET" && eventMatch) {
        const after = Number(url.searchParams.get("after") ?? 0);
        if (!Number.isSafeInteger(after) || after < 0) throw new WebBridgeError("RELAY_REQUEST_INVALID", "Event sequence is invalid.");
        const event = (await options.store.events(decodeURIComponent(eventMatch[1]!), principal.owner, after)).find((item) => ["repository_command_result", "user_clarification"].includes(item.type)) ?? null;
        send(response, 200, { event }); return;
      }
      if (method === "POST" && eventMatch) {
        const jobId = decodeURIComponent(eventMatch[1]!);
        const key = idempotency(request);
        const body = await jsonBody(request) as { type?: unknown; payload?: unknown };
        if (typeof body.type !== "string" || !["repository_command", "contract_sealed", "implementation_sealed"].includes(body.type)) throw new WebBridgeError("RELAY_EVENT_INVALID", "Authoring event type is invalid.");
        const record = await authoringMutationRecord(options.store, jobId, principal.owner, key);
        const authoringRequest = record.request as AuthoringJobRequest;
        if ((authoringRequest.orchestration_mode ?? "PAIR") === "AUTOPILOT" && body.type === "implementation_sealed") throw new WebBridgeError("RELAY_AUTOPILOT_AUTHORITY_VIOLATION", "AUTOPILOT authoring ends at contract_sealed; Web implementation authority is not accepted.");
        let payload = body.payload;
        if (body.type === "contract_sealed") {
          const envelope = parseWebContractEnvelope((body.payload as any)?.envelope ?? body.payload);
          if (envelope.job_id !== jobId || !sameRepository(envelope.repository, authoringRequest.repository) || envelope.user_intent !== authoringRequest.user_intent) throw new WebBridgeError("RELAY_JOB_BINDING_MISMATCH", "Sealed contract does not match the exact authoring job binding.");
          payload = { envelope };
        }
        if (body.type === "implementation_sealed") {
          const submission = parseWebImplementationSubmission((body.payload as any)?.submission ?? body.payload);
          if (submission.job_id !== jobId) throw new WebBridgeError("RELAY_JOB_BINDING_MISMATCH", "Web implementation does not match the exact authoring job binding.");
          payload = { submission };
        }
        if (body.type === "repository_command") {
          const value = body.payload as any;
          if (!value || typeof value.request_id !== "string" || !value.command || typeof value.command.operation !== "string") throw new WebBridgeError("RELAY_EVENT_INVALID", "Repository command is invalid.");
          payload = { request_id: value.request_id, command: value.command };
        }
        send(response, 201, await options.store.append(jobId, principal.owner, body.type, payload, key)); return;
      }

      const localEventMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/local-events$/);
      if (method === "GET" && localEventMatch) {
        const after = Number(url.searchParams.get("after") ?? 0);
        if (!Number.isSafeInteger(after) || after < 0) throw new WebBridgeError("RELAY_REQUEST_INVALID", "Event sequence is invalid.");
        const event = (await options.store.events(decodeURIComponent(localEventMatch[1]!), principal.owner, after)).map(toAuthoringEvent).find(Boolean) ?? null;
        send(response, 200, { event }); return;
      }
      const resultMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/repository-results$/);
      if (method === "POST" && resultMatch) {
        await options.store.append(decodeURIComponent(resultMatch[1]!), principal.owner, "repository_command_result", await jsonBody(request), idempotency(request));
        send(response, 201, { accepted: true }); return;
      }
      const clarificationMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/clarifications$/);
      if (method === "POST" && clarificationMatch) {
        const jobId = decodeURIComponent(clarificationMatch[1]!);
        const key = idempotency(request);
        await authoringMutationRecord(options.store, jobId, principal.owner, key);
        const body = await jsonBody(request) as any;
        if (typeof body?.text !== "string" || !body.text || body.text.length > 16_384) throw new WebBridgeError("RELAY_REQUEST_INVALID", "Clarification is invalid.");
        await options.store.append(jobId, principal.owner, "user_clarification", { text: body.text }, key);
        send(response, 201, { accepted: true }); return;
      }
      const repositoryAction = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/repository\/(summary|tree|search|files)$/);
      if (method === "POST" && repositoryAction) {
        const jobId = decodeURIComponent(repositoryAction[1]!);
        const key = idempotency(request);
        await authoringMutationRecord(options.store, jobId, principal.owner, key);
        const body = await jsonBody(request) as any;
        const requestId = typeof body?.request_id === "string" ? body.request_id : `rpc-${key}`;
        const operation = repositoryAction[2] === "files" ? "read" : repositoryAction[2];
        const command = operation === "summary" ? { operation } : operation === "tree" ? { operation, ...(body?.prefix ? { prefix: body.prefix } : {}), ...(body?.maximum_paths ? { maximum_paths: body.maximum_paths } : {}) } : operation === "search" ? { operation, query: body?.query, ...(body?.maximum_matches ? { maximum_matches: body.maximum_matches } : {}) } : { operation, paths: body?.paths };
        const event = await options.store.append(jobId, principal.owner, "repository_command", { request_id: requestId, command }, key);
        send(response, 201, { request_id: requestId, event_sequence: event.sequence, status: "pending_local_result" }); return;
      }
      const repositoryResult = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/repository-results\/([^/]+)$/);
      if (method === "GET" && repositoryResult) {
        const requestId = decodeURIComponent(repositoryResult[2]!);
        const event = (await options.store.events(decodeURIComponent(repositoryResult[1]!), principal.owner, 0)).slice().reverse().find((item) => item.type === "repository_command_result" && (item.payload as any)?.request_id === requestId);
        send(response, 200, { result: event?.payload ?? null }); return;
      }
      const artifactMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/(contract|implementation)$/);
      if (method === "GET" && artifactMatch) {
        const type = artifactMatch[2] === "contract" ? "contract_sealed" : "implementation_sealed";
        const event = (await options.store.events(decodeURIComponent(artifactMatch[1]!), principal.owner, 0)).slice().reverse().find((item) => item.type === type);
        const key = artifactMatch[2] === "contract" ? "envelope" : "submission";
        send(response, 200, { [key]: event ? (event.payload as any)?.[key] ?? event.payload : null }); return;
      }

      const verdictMatch = url.pathname.match(/^\/v1\/final-reviews\/([^/]+)\/verdict$/);
      if (method === "GET" && verdictMatch) {
        const event = (await options.store.events(decodeURIComponent(verdictMatch[1]!), principal.owner, 0)).slice().reverse().find((item) => item.type === "web_verdict");
        send(response, 200, { verdict: event ? (event.payload as any)?.verdict ?? event.payload : null }); return;
      }
      if (method === "POST" && verdictMatch) {
        const reviewId = decodeURIComponent(verdictMatch[1]!);
        const key = idempotency(request);
        const record = await finalReviewMutationRecord(options.store, reviewId, principal.owner, key);
        const body = parseWebVerdictEnvelope(await jsonBody(request));
        const reviewRequest = record.request as FinalReviewRequest;
        if (body.review_id !== reviewId || body.run_id !== reviewRequest.run_id || body.result_bundle_sha256 !== reviewRequest.result_bundle_sha256) throw new WebBridgeError("RELAY_JOB_BINDING_MISMATCH", "Web verdict does not match the exact final-review job binding.");
        await options.store.append(reviewId, principal.owner, "web_verdict", body, key);
        send(response, 201, { accepted: true }); return;
      }
      const evidenceMatch = url.pathname.match(/^\/v1\/final-reviews\/([^/]+)\/evidence$/);
      if (method === "POST" && evidenceMatch) {
        const reviewId = decodeURIComponent(evidenceMatch[1]!);
        const key = idempotency(request);
        await finalReviewMutationRecord(options.store, reviewId, principal.owner, key);
        await options.store.append(reviewId, principal.owner, "final_review_evidence", await jsonBody(request), key);
        send(response, 201, { accepted: true }); return;
      }
      if (method === "GET" && evidenceMatch) {
        const event = (await options.store.events(decodeURIComponent(evidenceMatch[1]!), principal.owner, 0)).slice().reverse().find((item) => item.type === "final_review_evidence");
        send(response, 200, { evidence: event?.payload ?? null }); return;
      }
      send(response, 404, { error: { code: "RELAY_ROUTE_NOT_FOUND", message: "Relay route was not found." } });
    } catch (error) {
      const code = error instanceof WebBridgeError ? error.code : "RELAY_OPERATIONAL_ERROR";
      const status = code === "RELAY_UNAUTHORIZED" ? 401 : code === "RELAY_FORBIDDEN" ? 403 : code.endsWith("_LIMIT") ? 413 : code.includes("CONFLICT") ? 409 : 400;
      send(response, status, { error: { code, message: error instanceof Error ? error.message : String(error) } });
    }
  });
}
