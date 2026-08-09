import crypto from "node:crypto";
import path from "node:path";
import { matches } from "../execution/change-set.js";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import type { WebImplementationPack } from "../web-authority/contracts.js";
import { ExecutorError } from "./contracts.js";

const MAX_CONTEXT_PATHS = 24;
const MAX_CONTEXT_PATH_BYTES = 16 * 1024;

interface ReadCoverageEntry {
  path: string;
  coverage: "full" | "partial";
}

interface ProjectMapNode {
  path: string;
  role?: string;
}

export interface SmartContextSelection {
  schema_version: "1.0";
  source: "bound-project-map-read-coverage";
  changed_paths: string[];
  paths: string[];
  candidate_count: number;
  truncated: boolean;
  selection_sha256: string;
}

function parseObject(pack: WebImplementationPack, entry: string): Record<string, unknown> {
  const bytes = pack.entries.get(entry);
  if (!bytes) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", `Smart-context authority entry '${entry}' is missing.`);
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch (error) {
    throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", `Smart-context authority entry '${entry}' is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readCoverage(pack: WebImplementationPack): ReadCoverageEntry[] {
  const value = parseObject(pack, "read-coverage.json").reads;
  if (!Array.isArray(value)) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", "Bound read coverage has no reads array.");
  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", "Bound read coverage contains an invalid entry.");
    const entry = raw as Record<string, unknown>;
    if (typeof entry.path !== "string" || !["full", "partial"].includes(String(entry.coverage))) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", "Bound read coverage contains invalid path/coverage metadata.");
    return { path: entry.path, coverage: entry.coverage as "full" | "partial" };
  });
}

function projectMap(pack: WebImplementationPack): ProjectMapNode[] {
  const value = parseObject(pack, "project-map.json").nodes;
  if (!Array.isArray(value)) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", "Bound project map has no nodes array.");
  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", "Bound project map contains an invalid node.");
    const node = raw as Record<string, unknown>;
    if (typeof node.path !== "string") throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", "Bound project map node has no canonical path.");
    return { path: node.path, ...(typeof node.role === "string" && node.role.length <= 256 ? { role: node.role } : {}) };
  });
}

function prohibitedPatterns(pack: WebImplementationPack): string[] {
  const value = parseObject(pack, "prohibited-changes.json").paths;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length < 1 || entry.length > 4096)) {
    throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", "Bound prohibited-change paths are invalid.");
  }
  return [...value] as string[];
}

function hardSensitivePath(candidate: string): boolean {
  if (candidate === ".git" || candidate.startsWith(".git/") || candidate === ".gitmodules") return true;
  const base = path.posix.basename(candidate).toLowerCase();
  return base === ".env" || base.startsWith(".env.");
}

function rankCandidates(pack: WebImplementationPack, changedPaths: readonly string[]): Map<string, number> {
  const changed = new Set(changedPaths);
  const changedDirectories = new Set(changedPaths.map((value) => path.posix.dirname(value)));
  const nodes = projectMap(pack);
  const roleByPath = new Map(nodes.filter((node) => node.role).map((node) => [node.path, node.role!] as const));
  const changedRoles = new Set(changedPaths.map((value) => roleByPath.get(value)).filter((value): value is string => Boolean(value)));
  const prohibited = prohibitedPatterns(pack);
  const ranks = new Map<string, number>();
  const offer = (candidate: string, rank: number): void => {
    if (changed.has(candidate) || hardSensitivePath(candidate) || prohibited.some((pattern) => matches(pattern, candidate))) return;
    const existing = ranks.get(candidate);
    if (existing === undefined || rank < existing) ranks.set(candidate, rank);
  };

  // Least privilege: Smart Context may prioritize only files already attested
  // in read-coverage. Project-map metadata can re-rank that set, but it cannot
  // introduce a new read target on its own.
  for (const read of readCoverage(pack)) {
    const sameDirectory = changedDirectories.has(path.posix.dirname(read.path));
    const sameRole = Boolean(roleByPath.get(read.path) && changedRoles.has(roleByPath.get(read.path)!));
    if (sameDirectory && read.coverage === "full") offer(read.path, 10);
    else if (sameDirectory) offer(read.path, 20);
    else if (sameRole) offer(read.path, 30);
    else if (read.coverage === "full") offer(read.path, 40);
    else offer(read.path, 50);
  }
  return ranks;
}

function boundedPaths(ranks: ReadonlyMap<string, number>): { paths: string[]; truncated: boolean } {
  const ordered = [...ranks.entries()].sort(([leftPath, leftRank], [rightPath, rightRank]) => leftRank - rightRank || leftPath.localeCompare(rightPath));
  const selected: string[] = [];
  let bytes = 0;
  let truncated = false;
  for (const [candidate] of ordered) {
    const candidateBytes = Buffer.byteLength(candidate, "utf8");
    if (selected.length >= MAX_CONTEXT_PATHS || bytes + candidateBytes > MAX_CONTEXT_PATH_BYTES) {
      truncated = true;
      continue;
    }
    selected.push(candidate);
    bytes += candidateBytes;
  }
  return { paths: selected, truncated };
}

export function selectSmartContext(pack: WebImplementationPack, changedPaths: readonly string[]): SmartContextSelection {
  const changed = [...new Set(changedPaths)].sort();
  const ranks = rankCandidates(pack, changed);
  const bounded = boundedPaths(ranks);
  const unsigned = {
    schema_version: "1.0" as const,
    source: "bound-project-map-read-coverage" as const,
    changed_paths: changed,
    paths: bounded.paths,
    candidate_count: ranks.size,
    truncated: bounded.truncated,
  };
  const selection_sha256 = crypto.createHash("sha256").update(canonicalJsonBuffer(unsigned)).digest("hex");
  return { ...unsigned, selection_sha256 };
}
