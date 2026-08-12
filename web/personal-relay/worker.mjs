const MAX_BODY = 98_304;
const MAX_EVENTS = 1_000;
const MAX_ACTIVE = 32;
const MAX_TTL = 604_800;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function reply(status, value) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
function fail(code, message, status = 400) { return reply(status, { error: { code, message } }); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
async function sha(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((item) => item.toString(16).padStart(2, "0")).join("");
}
async function authenticated(request, secret) {
  const match = request.headers.get("Authorization")?.match(/^Bearer ([^\s]+)$/);
  if (!match || typeof secret !== "string" || secret.length < 32) return false;
  const [left, right] = await Promise.all([sha(match[1]), sha(secret)]);
  let different = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) different |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return different === 0;
}
async function body(request) {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY) throw new Error("RELAY_REQUEST_LIMIT");
  try { return JSON.parse(text); } catch { throw new Error("RELAY_REQUEST_INVALID"); }
}
function key(request) {
  const value = request.headers.get("Idempotency-Key");
  if (!value || !ID.test(value)) throw new Error("RELAY_IDEMPOTENCY_REQUIRED");
  return value;
}
function pending(record) {
  if (Date.parse(record.identity.expires_at) <= Date.now()) return false;
  if (record.kind === "final_review") return !record.events.some((event) => event.type === "web_verdict");
  return !record.events.some((event) => event.type === "implementation_sealed");
}

export class PersonalMailbox {
  constructor(state) { this.storage = state.storage; }
  async records() {
    const values = await this.storage.list({ prefix: "job:" });
    return [...values.values()].sort((a, b) => a.identity.created_at.localeCompare(b.identity.created_at));
  }
  async record(id) {
    if (!ID.test(id)) throw new Error("RELAY_ID_INVALID");
    const value = await this.storage.get(`job:${id}`);
    if (!value) throw new Error("RELAY_JOB_NOT_FOUND");
    if (Date.parse(value.identity.expires_at) <= Date.now()) throw new Error("RELAY_JOB_EXPIRED");
    return value;
  }
  async put(record) {
    const encoded = new TextEncoder().encode(canonical(record));
    if (encoded.byteLength > 8_388_608) throw new Error("RELAY_RECORD_LIMIT");
    await this.storage.put(`job:${record.identity.job_id}`, record);
  }
  async create(kind, request, idempotencyKey, ttl) {
    if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > MAX_TTL) throw new Error("RELAY_TTL_INVALID");
    const records = await this.records();
    const requestDigest = await sha(canonical({ kind, owner: "personal", request }));
    const existing = records.find((record) => record.idempotency[`create:${idempotencyKey}`]);
    if (existing) {
      if (existing.identity.content_sha256 !== requestDigest) throw new Error("RELAY_IDEMPOTENCY_CONFLICT");
      return existing.identity;
    }
    if (records.filter(pending).length >= MAX_ACTIVE) throw new Error("RELAY_ACTIVE_JOB_LIMIT");
    const created = new Date();
    const jobId = `${kind === "authoring" ? "job" : "review"}-${(await sha(canonical({ kind, idempotencyKey, request }))).slice(0, 24)}`;
    const identity = { protocol_version: "wco-web-bridge-v1", job_id: jobId, owner: "personal", created_at: created.toISOString(), expires_at: new Date(created.getTime() + ttl * 1000).toISOString(), content_sha256: requestDigest };
    await this.put({ schema_version: "1.0", identity, kind, request: { ...request, ...(kind === "authoring" ? { owner: "personal" } : {}) }, events: [], idempotency: { [`create:${idempotencyKey}`]: requestDigest } });
    return identity;
  }
  async append(id, type, payload, idempotencyKey) {
    const record = await this.record(id);
    const digest = await sha(canonical({ type, payload }));
    const previous = record.idempotency[`event:${idempotencyKey}`];
    if (previous) {
      if (previous !== digest) throw new Error("RELAY_IDEMPOTENCY_CONFLICT");
      return record.events.find((event) => event.idempotency_key === idempotencyKey);
    }
    if (!pending(record)) throw new Error("RELAY_JOB_COMPLETE");
    if (record.events.length >= MAX_EVENTS) throw new Error("RELAY_EVENT_LIMIT");
    const event = { sequence: (record.events.at(-1)?.sequence || 0) + 1, type, payload, created_at: new Date().toISOString(), idempotency_key: idempotencyKey, content_sha256: digest };
    record.events.push(event); record.idempotency[`event:${idempotencyKey}`] = digest; await this.put(record); return event;
  }
  async fetch(request) {
    try {
      const url = new URL(request.url), method = request.method;
      const records = await this.records();
      const latest = (kind) => records.filter((item) => item.kind === kind && pending(item)).at(-1);
      if (method === "GET" && url.pathname === "/v1/status") return reply(200, { configured: true, connected: true, account: "personal", pending_author_job: latest("authoring")?.identity.job_id, pending_final_review: latest("final_review")?.identity.job_id });
      if (method === "POST" && url.pathname === "/v1/authoring/jobs") { const value = await body(request); return reply(201, await this.create("authoring", value, key(request), value.ttl_seconds)); }
      if (method === "POST" && url.pathname === "/v1/final-reviews") return reply(201, await this.create("final_review", await body(request), key(request), 86_400));
      if (method === "GET" && url.pathname === "/v1/authoring/pending") { const value = latest("authoring"); return reply(200, { job: value ? { identity: value.identity, request: value.request } : null }); }
      if (method === "GET" && url.pathname === "/v1/final-reviews/pending") { const value = latest("final_review"); return reply(200, { review: value ? { identity: value.identity, request: value.request } : null }); }
      let match = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/(local-)?events$/);
      if (match && method === "GET") { const after = Number(url.searchParams.get("after") || 0); const record = await this.record(decodeURIComponent(match[1])); const types = match[2] ? ["repository_command", "contract_sealed", "implementation_sealed"] : ["repository_command_result", "user_clarification"]; const found = record.events.find((event) => event.sequence > after && types.includes(event.type)); return reply(200, { event: found ? { sequence: found.sequence, type: found.type, ...found.payload } : null }); }
      if (match && method === "POST") { const value = await body(request); if (!["repository_command", "contract_sealed", "implementation_sealed"].includes(value.type)) throw new Error("RELAY_EVENT_INVALID"); return reply(201, await this.append(decodeURIComponent(match[1]), value.type, value.payload, key(request))); }
      match = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/repository\/(summary|tree|search|files)$/);
      if (match && method === "POST") { const value = await body(request), requestId = value.request_id || `rpc-${key(request)}`, operation = match[2] === "files" ? "read" : match[2]; const command = operation === "summary" ? { operation } : operation === "tree" ? { operation, ...(value.prefix ? { prefix: value.prefix } : {}), ...(value.maximum_paths ? { maximum_paths: value.maximum_paths } : {}) } : operation === "search" ? { operation, query: value.query, ...(value.maximum_matches ? { maximum_matches: value.maximum_matches } : {}) } : { operation, ...(value.paths ? { paths: value.paths } : {}), ...(value.regions ? { regions: value.regions } : {}), ...(value.known_content_sha256 ? { known_content_sha256: value.known_content_sha256 } : {}) }; const event = await this.append(decodeURIComponent(match[1]), "repository_command", { request_id: requestId, command }, key(request)); return reply(201, { request_id: requestId, event_sequence: event.sequence, status: "pending_local_result" }); }
      match = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/repository-results(?:\/([^/]+))?$/);
      if (match && method === "POST" && !match[2]) { await this.append(decodeURIComponent(match[1]), "repository_command_result", await body(request), key(request)); return reply(201, { accepted: true }); }
      if (match && method === "GET" && match[2]) { const record = await this.record(decodeURIComponent(match[1])), requestId = decodeURIComponent(match[2]); const event = record.events.findLast((item) => item.type === "repository_command_result" && item.payload?.request_id === requestId); return reply(200, { result: event?.payload || null }); }
      match = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/clarifications$/);
      if (match && method === "POST") { const value = await body(request); if (typeof value.text !== "string" || !value.text || value.text.length > 16_384) throw new Error("RELAY_REQUEST_INVALID"); await this.append(decodeURIComponent(match[1]), "user_clarification", { text: value.text }, key(request)); return reply(201, { accepted: true }); }
      match = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/(contract|implementation)$/);
      if (match && method === "GET") { const record = await this.record(decodeURIComponent(match[1])), type = match[2] === "contract" ? "contract_sealed" : "implementation_sealed", field = match[2] === "contract" ? "envelope" : "submission", event = record.events.findLast((item) => item.type === type); return reply(200, { [field]: event?.payload?.[field] || event?.payload || null }); }
      match = url.pathname.match(/^\/v1\/final-reviews\/([^/]+)\/(verdict|evidence)$/);
      if (match && method === "POST") { const type = match[2] === "verdict" ? "web_verdict" : "final_review_evidence"; await this.append(decodeURIComponent(match[1]), type, match[2] === "verdict" ? { verdict: await body(request) } : await body(request), key(request)); return reply(201, { accepted: true }); }
      if (match && method === "GET") { const record = await this.record(decodeURIComponent(match[1])), type = match[2] === "verdict" ? "web_verdict" : "final_review_evidence", event = record.events.findLast((item) => item.type === type); return reply(200, { [match[2]]: match[2] === "verdict" ? event?.payload?.verdict || null : event?.payload || null }); }
      return fail("RELAY_ROUTE_NOT_FOUND", "Relay route was not found.", 404);
    } catch (error) {
      const code = error instanceof Error ? error.message : "RELAY_OPERATIONAL_ERROR";
      const status = code.includes("CONFLICT") ? 409 : code.endsWith("_LIMIT") ? 413 : code.includes("NOT_FOUND") ? 404 : 400;
      return fail(code, "Relay rejected the bounded transport request.", status);
    }
  }
}

export default {
  async fetch(request, env) {
    if (!await authenticated(request, env.WCO_RELAY_TOKEN)) return fail("RELAY_UNAUTHORIZED", "Bearer authentication failed.", 401);
    return await env.MAILBOX.get(env.MAILBOX.idFromName("personal")).fetch(request);
  },
};
