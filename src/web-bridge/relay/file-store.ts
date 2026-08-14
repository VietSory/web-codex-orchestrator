import crypto from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { canonicalJsonBuffer } from "../../result-bundle/canonical-json.js";
import { WebBridgeError, WEB_BRIDGE_PROTOCOL_VERSION, contentDigest, type BridgeJobIdentity } from "../contracts.js";
import type { AuthoringJobRequest } from "../web-bridge.js";
import type { FinalReviewRequest } from "../contracts.js";
import { DEFAULT_RELAY_LIMITS, isRelayJobPending, type RelayJobKind, type RelayJobRecord, type RelayLimits, type RelayStoredEvent } from "./protocol.js";

const SHA256 = /^[a-f0-9]{64}$/;
function safeId(value: string): void { if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new WebBridgeError("RELAY_ID_INVALID", "Relay identifier is invalid."); }
function sameIdentity(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs; }
function recordObject(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new WebBridgeError("RELAY_RECORD_INVALID", "Relay record must be an object."); return value as Record<string, unknown>; }

export class RelayFileStore {
  private readonly limits: RelayLimits;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly root: string, limits: Partial<RelayLimits> = {}, private readonly now: () => Date = () => new Date()) {
    this.limits = { ...DEFAULT_RELAY_LIMITS, ...limits };
  }

  private async safeRoot(): Promise<string> {
    const absolute = path.resolve(this.root);
    await mkdir(absolute, { recursive: true, mode: 0o700 });
    const stat = await lstat(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(absolute) !== absolute) throw new WebBridgeError("RELAY_STORE_ROOT_UNSAFE", "Relay store root is not canonical.");
    await chmod(absolute, 0o700).catch(() => undefined);
    return absolute;
  }

  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  private validate(record: unknown, jobId: string): RelayJobRecord {
    const root = recordObject(record);
    if (root.schema_version !== "1.0" || (root.kind !== "authoring" && root.kind !== "final_review") || !Array.isArray(root.events) || !root.idempotency || typeof root.idempotency !== "object" || Array.isArray(root.idempotency)) {
      throw new WebBridgeError("RELAY_RECORD_INVALID", "Relay record failed top-level schema validation.");
    }
    const identity = recordObject(root.identity);
    if (identity.protocol_version !== WEB_BRIDGE_PROTOCOL_VERSION || identity.job_id !== jobId || typeof identity.owner !== "string" || typeof identity.created_at !== "string" || typeof identity.expires_at !== "string" || typeof identity.content_sha256 !== "string" || !SHA256.test(identity.content_sha256)) {
      throw new WebBridgeError("RELAY_RECORD_INVALID", "Relay record failed identity validation.");
    }
    safeId(identity.owner);
    const created = Date.parse(identity.created_at), expires = Date.parse(identity.expires_at);
    if (!Number.isFinite(created) || !Number.isFinite(expires) || expires <= created || expires - created > this.limits.maximum_ttl_seconds * 1_000) throw new WebBridgeError("RELAY_RECORD_INVALID", "Relay record has invalid lifetime metadata.");
    if (contentDigest({ kind: root.kind, owner: identity.owner, request: root.request }) !== identity.content_sha256) throw new WebBridgeError("RELAY_RECORD_INVALID", "Relay request digest no longer matches its durable identity.");
    if (root.events.length > this.limits.maximum_events_per_job) throw new WebBridgeError("RELAY_EVENT_LIMIT", "Relay record exceeds its event bound.");

    const idempotency = root.idempotency as Record<string, unknown>;
    for (const [key, value] of Object.entries(idempotency)) {
      if ((!key.startsWith("create:") && !key.startsWith("event:")) || typeof value !== "string" || !SHA256.test(value)) throw new WebBridgeError("RELAY_RECORD_INVALID", "Relay idempotency index is invalid.");
      const rawKey = key.slice(key.indexOf(":") + 1);
      safeId(rawKey);
    }

    const seen = new Set<string>();
    const events = root.events as unknown[];
    for (let index = 0; index < events.length; index += 1) {
      const event = recordObject(events[index]);
      if (event.sequence !== index + 1 || typeof event.type !== "string" || event.type.length < 1 || event.type.length > 128 || /[\r\n\0]/.test(event.type) || typeof event.created_at !== "string" || !Number.isFinite(Date.parse(event.created_at)) || typeof event.idempotency_key !== "string" || typeof event.content_sha256 !== "string" || !SHA256.test(event.content_sha256)) {
        throw new WebBridgeError("RELAY_RECORD_INVALID", "Relay event journal is structurally inconsistent.");
      }
      safeId(event.idempotency_key);
      if (seen.has(event.idempotency_key)) throw new WebBridgeError("RELAY_RECORD_INVALID", "Relay event idempotency key is duplicated.");
      seen.add(event.idempotency_key);
      const digest = contentDigest({ type: event.type, payload: event.payload });
      if (digest !== event.content_sha256 || idempotency[`event:${event.idempotency_key}`] !== digest) throw new WebBridgeError("RELAY_RECORD_INVALID", "Relay event digest or idempotency index is inconsistent.");
    }
    const eventIndexKeys = Object.keys(idempotency).filter((key) => key.startsWith("event:"));
    if (eventIndexKeys.length !== events.length) throw new WebBridgeError("RELAY_RECORD_INVALID", "Relay event idempotency index contains orphaned entries.");

    return root as unknown as RelayJobRecord;
  }

  private async read(jobId: string): Promise<RelayJobRecord> {
    safeId(jobId);
    const root = await this.safeRoot();
    const target = path.join(root, `${jobId}.json`);
    const pathStat = await lstat(target);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.size > this.limits.maximum_record_bytes || await realpath(target) !== target) throw new WebBridgeError("RELAY_RECORD_INVALID", "Relay record path is unsafe or exceeds its bound.");
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    const handle = await open(target, fsConstants.O_RDONLY | noFollow).catch((error) => { throw new WebBridgeError("RELAY_RECORD_INVALID", `Relay record could not be opened safely: ${error instanceof Error ? error.message : String(error)}`); });
    try {
      const before = await handle.stat();
      if (!before.isFile() || !sameIdentity(pathStat, before) || before.size > this.limits.maximum_record_bytes) throw new WebBridgeError("RELAY_RECORD_INVALID", "Relay record changed before stable open.");
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) throw new WebBridgeError("RELAY_RECORD_INVALID", "Relay record truncated during read.");
        offset += bytesRead;
      }
      if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) throw new WebBridgeError("RELAY_RECORD_INVALID", "Relay record grew during read.");
      const [afterHandle, afterPath] = await Promise.all([handle.stat(), lstat(target)]);
      if (!afterPath.isFile() || afterPath.isSymbolicLink() || !sameIdentity(before, afterHandle) || !sameIdentity(before, afterPath) || await realpath(root) !== root) throw new WebBridgeError("RELAY_RECORD_INVALID", "Relay record changed during read.");
      let parsed: unknown;
      try { parsed = JSON.parse(bytes.toString("utf8")) as unknown; }
      catch { throw new WebBridgeError("RELAY_RECORD_INVALID", "Relay record is not valid JSON."); }
      return this.validate(parsed, jobId);
    } finally { await handle.close(); }
  }

  private async write(record: RelayJobRecord): Promise<void> {
    const bytes = canonicalJsonBuffer(record);
    if (bytes.byteLength > this.limits.maximum_record_bytes) throw new WebBridgeError("RELAY_RECORD_LIMIT", "Relay record exceeds its bound.");
    const root = await this.safeRoot();
    const target = path.join(root, `${record.identity.job_id}.json`);
    const existing = await lstat(target).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new WebBridgeError("RELAY_RECORD_INVALID", "Relay record target is unsafe.");
    const temp = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try {
      await rename(temp, target);
      await chmod(target, 0o600).catch(() => undefined);
      const parent = await open(root, fsConstants.O_RDONLY);
      try { await parent.sync(); } finally { await parent.close(); }
    } finally { await unlink(temp).catch(() => undefined); }
  }

  async create(kind: RelayJobKind, owner: string, request: AuthoringJobRequest | FinalReviewRequest, idempotencyKey: string, ttlSeconds: number): Promise<BridgeJobIdentity> {
    safeId(owner); safeId(idempotencyKey);
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > this.limits.maximum_ttl_seconds) throw new WebBridgeError("RELAY_TTL_INVALID", "Relay TTL is outside its bound.");
    return await this.locked(async () => {
      const requestDigest = contentDigest({ kind, owner, request });
      const existing = await this.findByIdempotency(owner, idempotencyKey);
      if (existing) {
        if (existing.identity.content_sha256 !== requestDigest) throw new WebBridgeError("RELAY_IDEMPOTENCY_CONFLICT", "Conflicting relay creation replay was rejected.");
        if (Date.parse(existing.identity.expires_at) <= this.now().getTime()) throw new WebBridgeError("RELAY_JOB_EXPIRED", "The idempotent relay job has expired; create a new local session.");
        return existing.identity;
      }
      const active = await this.list(owner);
      if (active.filter((item) => isRelayJobPending(item, this.now().getTime())).length >= this.limits.maximum_active_jobs_per_owner) throw new WebBridgeError("RELAY_ACTIVE_JOB_LIMIT", "Active relay job limit reached.");
      const created = this.now();
      const jobId = `${kind === "authoring" ? "job" : "review"}-${contentDigest({ owner, idempotencyKey, request }).slice(0, 24)}`;
      const identity: BridgeJobIdentity = { protocol_version: WEB_BRIDGE_PROTOCOL_VERSION, job_id: jobId, owner, created_at: created.toISOString(), expires_at: new Date(created.getTime() + ttlSeconds * 1000).toISOString(), content_sha256: requestDigest };
      const record: RelayJobRecord = { schema_version: "1.0", identity, kind, request, events: [], idempotency: { [`create:${idempotencyKey}`]: requestDigest } };
      await this.write(record);
      return identity;
    });
  }

  async append(jobId: string, owner: string, type: string, payload: unknown, idempotencyKey: string): Promise<RelayStoredEvent> {
    safeId(idempotencyKey);
    if (typeof type !== "string" || type.length < 1 || type.length > 128 || /[\r\n\0]/.test(type)) throw new WebBridgeError("RELAY_RECORD_INVALID", "Relay event type is invalid.");
    return await this.locked(async () => {
      const record = await this.read(jobId);
      this.authorize(record, owner);
      const digest = contentDigest({ type, payload });
      const previous = record.idempotency[`event:${idempotencyKey}`];
      if (previous) {
        if (previous !== digest) throw new WebBridgeError("RELAY_IDEMPOTENCY_CONFLICT", "Conflicting relay mutation replay was rejected.");
        const event = record.events.find((value) => value.idempotency_key === idempotencyKey);
        if (!event) throw new WebBridgeError("RELAY_RECORD_INVALID", "Relay idempotency index is inconsistent.");
        return event;
      }
      if (record.events.length >= this.limits.maximum_events_per_job) throw new WebBridgeError("RELAY_EVENT_LIMIT", "Relay event limit reached.");
      const event: RelayStoredEvent = { sequence: (record.events.at(-1)?.sequence ?? 0) + 1, type, payload, created_at: this.now().toISOString(), idempotency_key: idempotencyKey, content_sha256: digest };
      record.events.push(event);
      record.idempotency[`event:${idempotencyKey}`] = digest;
      await this.write(record);
      return event;
    });
  }

  async get(jobId: string, owner: string): Promise<RelayJobRecord> { const record = await this.read(jobId); this.authorize(record, owner); return record; }
  async events(jobId: string, owner: string, afterSequence: number): Promise<RelayStoredEvent[]> { if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new WebBridgeError("RELAY_RECORD_INVALID", "Relay event cursor is invalid."); const record = await this.get(jobId, owner); return record.events.filter((event) => event.sequence > afterSequence); }
  async list(owner: string): Promise<RelayJobRecord[]> {
    safeId(owner);
    const root = await this.safeRoot();
    const names = (await readdir(root)).filter((name) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\.json$/.test(name));
    if (names.length > this.limits.maximum_record_files) throw new WebBridgeError("RELAY_RECORD_LIMIT", "Relay store record count exceeds its independent storage bound.");
    const values: RelayJobRecord[] = [];
    for (const name of names) { const record = await this.read(name.slice(0, -5)); if (record.identity.owner === owner) values.push(record); }
    return values.sort((a, b) => a.identity.created_at.localeCompare(b.identity.created_at));
  }
  private async findByIdempotency(owner: string, key: string): Promise<RelayJobRecord | undefined> { return (await this.list(owner)).find((record) => `create:${key}` in record.idempotency); }
  private authorize(record: RelayJobRecord, owner: string): void { if (record.identity.owner !== owner) throw new WebBridgeError("RELAY_FORBIDDEN", "Relay job ownership check failed."); if (Date.parse(record.identity.expires_at) <= this.now().getTime()) throw new WebBridgeError("RELAY_JOB_EXPIRED", "Relay job has expired."); }
}
