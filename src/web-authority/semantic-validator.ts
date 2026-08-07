import { WebAuthorityError, type WebImplementationPack } from "./contracts.js";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SOURCE_TYPES = new Set(["web", "github", "document", "mcp", "other"]);
const AUTHORITIES = new Set(["primary", "secondary", "community", "unknown"]);

interface InventoryIdentity { objectSha: string; type: string; }

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", `${label} must be a JSON object.`);
  return value as Record<string, unknown>;
}
function parse(pack: WebImplementationPack, name: string): Record<string, unknown> {
  const bytes = pack.entries.get(name);
  if (!bytes) throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", `Missing '${name}'.`);
  try { return object(JSON.parse(bytes.toString("utf8")), name); }
  catch (error) {
    if (error instanceof WebAuthorityError) throw error;
    throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", `${name} is invalid JSON.`);
  }
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const expected = new Set(allowed);
  for (const key of Object.keys(value)) if (!expected.has(key)) throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", `${label} contains unexpected field '${key}'.`);
  for (const key of allowed) if (!(key in value)) throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", `${label} is missing required field '${key}'.`);
}
function safePath(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096 || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", `${label} is not a canonical repository path.`);
  }
}

function validateInventory(pack: WebImplementationPack): Map<string, InventoryIdentity> {
  const doc = parse(pack, "repository-inventory.json");
  exactKeys(doc, ["schema_version", "repository_tree_sha", "entries"], "repository-inventory.json");
  if (doc.schema_version !== "2.0" || doc.repository_tree_sha !== pack.manifest.repository.tree_sha || !Array.isArray(doc.entries)) throw new WebAuthorityError("WEB_AUTHORITY_BINDING_MISMATCH", "Repository inventory snapshot binding is invalid.");
  const identities = new Map<string, InventoryIdentity>();
  let previous: string | undefined;
  for (const raw of doc.entries) {
    const entry = object(raw, "repository inventory entry");
    exactKeys(entry, ["path", "mode", "type", "object_sha", "size_bytes"], "repository inventory entry");
    safePath(entry.path, "repository inventory path");
    if (!/^[0-9]{6}$/.test(String(entry.mode)) || !["blob", "commit"].includes(String(entry.type)) || !GIT_SHA.test(String(entry.object_sha)) || !(entry.size_bytes === null || Number.isSafeInteger(entry.size_bytes) && Number(entry.size_bytes) >= 0)) throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", `Invalid inventory metadata for '${entry.path}'.`);
    if (identities.has(entry.path) || previous !== undefined && previous >= entry.path) throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", "Repository inventory must be unique and strictly lexical.");
    identities.set(entry.path, { objectSha: String(entry.object_sha), type: String(entry.type) });
    previous = entry.path;
  }
  return identities;
}

function validateReadCoverage(pack: WebImplementationPack, inventory: ReadonlyMap<string, InventoryIdentity>): void {
  const doc = parse(pack, "read-coverage.json");
  exactKeys(doc, ["schema_version", "repository_tree_sha", "reads"], "read-coverage.json");
  if (doc.schema_version !== "2.0" || doc.repository_tree_sha !== pack.manifest.repository.tree_sha || !Array.isArray(doc.reads)) throw new WebAuthorityError("WEB_AUTHORITY_BINDING_MISMATCH", "Read coverage snapshot binding is invalid.");
  const seen = new Set<string>();
  for (const raw of doc.reads) {
    const read = object(raw, "read coverage entry");
    exactKeys(read, ["path", "object_sha", "coverage"], "read coverage entry");
    safePath(read.path, "read coverage path");
    const identity = inventory.get(read.path);
    if (!identity || identity.type !== "blob" || identity.objectSha !== read.object_sha || !GIT_SHA.test(String(read.object_sha)) || !["full", "partial"].includes(String(read.coverage)) || seen.has(read.path)) throw new WebAuthorityError("WEB_AUTHORITY_BINDING_MISMATCH", `Read coverage does not bind the exact inventory blob '${read.path}'.`);
    seen.add(read.path);
  }
}

function validateProjectMap(pack: WebImplementationPack, inventory: ReadonlyMap<string, InventoryIdentity>): void {
  const doc = parse(pack, "project-map.json");
  exactKeys(doc, ["schema_version", "repository_tree_sha", "nodes"], "project-map.json");
  if (doc.schema_version !== "2.0" || doc.repository_tree_sha !== pack.manifest.repository.tree_sha || !Array.isArray(doc.nodes)) throw new WebAuthorityError("WEB_AUTHORITY_BINDING_MISMATCH", "Project map snapshot binding is invalid.");
  if (doc.nodes.length > 100_000) throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", "Project map node count is unreasonably large.");
  const seen = new Set<string>();
  for (const raw of doc.nodes) {
    const node = object(raw, "project map node");
    if (!("path" in node)) throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", "Project map node requires path.");
    safePath(node.path, "project map path");
    if (!inventory.has(node.path) || seen.has(node.path)) throw new WebAuthorityError("WEB_AUTHORITY_BINDING_MISMATCH", `Project map path is missing/duplicated in inventory: '${node.path}'.`);
    if (Object.keys(node).length > 32) throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", `Project map node '${node.path}' has too many fields.`);
    seen.add(node.path);
  }
}

function validateSources(pack: WebImplementationPack): void {
  const doc = parse(pack, "source-receipts.json");
  exactKeys(doc, ["schema_version", "receipts"], "source-receipts.json");
  if (doc.schema_version !== "2.0" || !Array.isArray(doc.receipts) || doc.receipts.length > 512) throw new WebAuthorityError("WEB_AUTHORITY_SOURCE_INVALID", "Source receipt document is invalid.");
  const seen = new Set<string>();
  for (const raw of doc.receipts) {
    const receipt = object(raw, "source receipt");
    exactKeys(receipt, ["source_id", "source_type", "locator", "accessed_at", "content_sha256", "authority"], "source receipt");
    if (typeof receipt.source_id !== "string" || !SAFE_ID.test(receipt.source_id) || seen.has(receipt.source_id) || !SOURCE_TYPES.has(String(receipt.source_type)) || typeof receipt.locator !== "string" || receipt.locator.length < 1 || receipt.locator.length > 4096 || typeof receipt.accessed_at !== "string" || !Number.isFinite(Date.parse(receipt.accessed_at)) || !SHA256.test(String(receipt.content_sha256)) || !AUTHORITIES.has(String(receipt.authority))) throw new WebAuthorityError("WEB_AUTHORITY_SOURCE_INVALID", `Invalid source receipt '${String(receipt.source_id)}'.`);
    seen.add(receipt.source_id);
  }
}

function validateLocks(pack: WebImplementationPack): void {
  for (const [name, required] of [["architecture-lock.json", "decisions"], ["acceptance-lock.json", "criteria"]] as const) {
    const doc = parse(pack, name);
    exactKeys(doc, ["schema_version", "spec_set_sha256", required], name);
    if (doc.schema_version !== "2.0" || doc.spec_set_sha256 !== pack.manifest.bindings.spec_set_sha256 || !Array.isArray(doc[required])) throw new WebAuthorityError("WEB_AUTHORITY_BINDING_MISMATCH", `${name} does not bind the frozen spec set.`);
  }
  const prohibited = parse(pack, "prohibited-changes.json");
  exactKeys(prohibited, ["schema_version", "paths", "rules"], "prohibited-changes.json");
  if (prohibited.schema_version !== "2.0" || !Array.isArray(prohibited.paths) || !Array.isArray(prohibited.rules)) throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", "prohibited-changes.json is invalid.");
  for (const value of prohibited.paths) if (typeof value !== "string" || value.length < 1 || value.length > 4096) throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", "Invalid prohibited path pattern.");
  for (const value of prohibited.rules) if (typeof value !== "string" || value.length < 1 || value.length > 8192) throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", "Invalid prohibited-change rule.");
}

export function validateWebImplementationPackSemantics(pack: WebImplementationPack): void {
  const inventory = validateInventory(pack);
  validateReadCoverage(pack, inventory);
  validateProjectMap(pack, inventory);
  validateSources(pack);
  validateLocks(pack);
}
