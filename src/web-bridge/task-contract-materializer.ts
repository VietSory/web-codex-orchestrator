import crypto from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TrustedConfig } from "../config/contracts.js";
import { validateBundleDirectory } from "../bundle/validator.js";
import { intakeArchive } from "../intake/intake-service.js";
import type { IntakeReceipt } from "../intake/contracts.js";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { buildDeterministicZip } from "../result-bundle/deterministic-zip.js";
import { WebBridgeError, contentDigest, parseWebContractEnvelope, type RepositoryBinding, type WebContractEnvelope } from "./contracts.js";

const TEMPLATE_FILES = ["README.md", "REQUEST.md", "RESEARCH.md", "SOURCES.md", "PLAN.md", "RULES.md", "VALIDATION.md", "manifest.json", "acceptance.json", "test-matrix.json", "validation.json", "risk-policy.json"] as const;
const HARD_FORBIDDEN = [".env", ".env.*", ".git/**", "**/*.pem", "**/*.key", "**/credentials*", "**/secrets*"];
function sha256(value: Buffer | string): string { return crypto.createHash("sha256").update(value).digest("hex"); }
function lexical(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function markdown(title: string, values: string[]): Buffer { return Buffer.from(`# ${title}\n\n${values.length ? values.map((value) => `- ${value}`).join("\n") : "None."}\n`, "utf8"); }
async function safeOwnedDirectory(directory: string): Promise<string> { const absolute = path.resolve(directory); await mkdir(absolute, { recursive: true, mode: 0o700 }); const stat = await lstat(absolute); if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(absolute) !== absolute) throw new WebBridgeError("WEB_ARTIFACT_ROOT_UNSAFE", "Artifact root must be a canonical WCO-owned directory."); return absolute; }
function templateRoot(): string { return fileURLToPath(new URL("../../templates/task-bundle/", import.meta.url)); }

export interface MaterializedTaskBundle { task_id: string; directory: string; archive_path: string; archive_sha256: string; intake_receipt: IntakeReceipt; }

export async function materializeTaskBundle(options: { envelope: WebContractEnvelope | unknown; repository: RepositoryBinding; config: TrustedConfig; stateDirectory: string }): Promise<MaterializedTaskBundle> {
  const envelope = parseWebContractEnvelope(options.envelope);
  const repository = options.config.repositories[envelope.repository.repository_id];
  if (!repository) throw new WebBridgeError("WEB_CONTRACT_REPOSITORY_REJECTED", "Web contract names an unregistered repository.");
  if (envelope.repository.repository_id !== options.repository.repository_id || envelope.repository.base_branch !== options.repository.base_branch || envelope.repository.base_commit !== options.repository.base_commit) throw new WebBridgeError("WEB_CONTRACT_REPOSITORY_REJECTED", "Web contract differs from the exact local repository/base identity.");
  if (envelope.repository.base_branch !== envelope.delivery.base_branch || envelope.delivery.remote !== repository.remote || !repository.expected_remote_urls.length) throw new WebBridgeError("WEB_CONTRACT_POLICY_CONFLICT", "Web contract conflicts with trusted repository delivery policy.");
  if (!/^[a-f0-9]{40}$/.test(envelope.repository.base_commit) || !envelope.delivery.branch_name.startsWith("codex/") || ["main", "master", "develop", "production"].includes(envelope.delivery.branch_name)) throw new WebBridgeError("WEB_CONTRACT_POLICY_CONFLICT", "Web contract base or delivery branch violates local policy.");
  const allowedExecutables = new Set(options.config.verification?.allowed_executables ?? []);
  for (const command of envelope.verification_commands) if (allowedExecutables.size && !allowedExecutables.has(command.executable)) throw new WebBridgeError("WEB_CONTRACT_POLICY_CONFLICT", `Verification executable '${command.executable}' is not allowed by trusted config.`);
  const taskId = `TASK-${contentDigest(envelope).slice(0, 32).toUpperCase()}`;
  const root = await safeOwnedDirectory(path.join(options.stateDirectory, "bridge", "artifacts", envelope.job_id));
  const directory = await safeOwnedDirectory(path.join(root, "task-bundle"));
  const entries = new Map<string, Buffer>();
  for (const name of TEMPLATE_FILES) entries.set(name, await readFile(path.join(templateRoot(), name)));
  const forbidden = [...new Set([...envelope.forbidden_paths, ...HARD_FORBIDDEN])].sort();
  entries.set("manifest.json", canonicalJsonBuffer({ schema_version: "1.3", task_id: taskId, title: envelope.title, repository: { id: envelope.repository.repository_id, base_branch: envelope.repository.base_branch, base_commit: envelope.repository.base_commit }, payload: { type: "none", review_before_execution: true }, delivery: { mode: "github_pull_request", remote: envelope.delivery.remote, base_branch: envelope.delivery.base_branch, branch_name: envelope.delivery.branch_name, draft: true, push_after: ["VERIFIER_PASS", "REVIEWER_APPROVE"], auto_merge: false }, git_policy: { allowed_remote: envelope.delivery.remote, allowed_branch_prefix: "codex/", deny_direct_push_branches: ["main", "master", "develop", "production"], allow_force_push: false, allow_remote_branch_delete: false, allow_merge: false }, limits: { max_internal_iterations: Math.min(options.config.agents?.limits.maximum_implementation_iterations ?? 4, 8), max_review_rounds: Math.min(options.config.agents?.limits.maximum_sol_review_rounds ?? 2, 3), max_changed_files: options.config.verification?.maximum_changed_files ?? 50, max_diff_lines: options.config.verification?.maximum_diff_lines ?? 8_000 }, allowed_paths: envelope.allowed_paths, forbidden_paths: forbidden }));
  entries.set("acceptance.json", canonicalJsonBuffer({ criteria: envelope.acceptance_criteria.map((criterion, index) => ({ id: criterion.id, description: criterion.description, required: true, verification: { type: "command", reference: envelope.verification_commands[Math.min(index, envelope.verification_commands.length - 1)]!.id } })) }));
  entries.set("test-matrix.json", canonicalJsonBuffer({ cases: envelope.acceptance_criteria.map((criterion) => ({ id: `TC-${criterion.id}`, category: "acceptance", given: ["The exact task base is prepared"], when: `Criterion ${criterion.id} is verified`, then: [criterion.description] })) }));
  entries.set("validation.json", canonicalJsonBuffer({ commands: envelope.verification_commands.map((command) => ({ id: command.id, executable: command.executable, args: command.args, cwd: ".", environment: { CI: "1" }, required: true, timeout_seconds: Math.min(options.config.verification?.maximum_command_seconds ?? 900, 3_600), maximum_output_bytes: Math.min(options.config.verification?.maximum_output_bytes ?? 4_194_304, 10_000_000) })) }));
  entries.set("risk-policy.json", canonicalJsonBuffer({ human_approval_required_for: [...new Set(["production_deployment", "destructive_database_change", "force_push", "publishing_packages", ...(envelope.risk_policy.network_access ? ["network_access"] : []), ...(envelope.risk_policy.secrets_required ? ["secret_access"] : [])])] }));
  entries.set("REQUEST.md", Buffer.from(`# ${envelope.title}\n\n${envelope.goal}\n\n## User intent\n\n${envelope.user_intent}\n`, "utf8"));
  entries.set("PLAN.md", markdown("Implementation plan", envelope.implementation_strategy));
  entries.set("RULES.md", markdown("Architecture and scope rules", [...envelope.architecture_decisions, ...forbidden.map((value) => `Do not change ${value}`)]));
  entries.set("RESEARCH.md", markdown("Research", envelope.sources.map((source) => `${source.title}: ${source.relevance}`)));
  entries.set("SOURCES.md", markdown("Sources", envelope.sources.map((source) => `${source.title} — ${source.url} — accessed ${source.accessed_at}`)));
  entries.set("VALIDATION.md", markdown("Required validation", envelope.verification_commands.map((command) => `${command.id}: ${[command.executable, ...command.args].join(" ")}`)));
  entries.set("README.md", Buffer.from(`# WCO Task Bundle\n\nTask ID: \`${taskId}\`\n\nGenerated deterministically from sealed Web contract job \`${envelope.job_id}\`. Local validation remains authoritative.\n`, "utf8"));
  const checksums: Record<string, string> = {};
  for (const [name, content] of [...entries.entries()].sort(([a], [b]) => lexical(a, b))) checksums[name] = sha256(content);
  entries.set("checksums.json", canonicalJsonBuffer({ algorithm: "sha256", files: checksums }));
  for (const [name, content] of entries) {
    const target = path.join(directory, name);
    try { const existing = await readFile(target); if (!existing.equals(content)) throw new WebBridgeError("WEB_ARTIFACT_REPLAY_CONFLICT", `Existing generated Task Bundle entry '${name}' differs.`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await writeFile(target, content, { flag: "wx", mode: 0o600 }); }
  }
  const report = await validateBundleDirectory(directory);
  if (!report.ok) throw new WebBridgeError("WEB_TASK_BUNDLE_INVALID", report.errors.join(" "));
  const archive = await buildDeterministicZip([...entries.entries()].sort(([a], [b]) => lexical(a, b)).map(([entryPath, content]) => ({ path: entryPath, content })), root, "task-bundle.zip", { maximumEntries: 256, maximumArchiveBytes: 16_777_216, maximumTotalUncompressedBytes: 33_554_432 });
  const intake = await intakeArchive(archive.archivePath, options.stateDirectory);
  if (intake.status !== "accepted") throw new WebBridgeError("WEB_TASK_BUNDLE_INTAKE_REJECTED", intake.errors.map((error) => `${error.code}: ${error.message}`).join(" "));
  return { task_id: taskId, directory, archive_path: archive.archivePath, archive_sha256: archive.sha256, intake_receipt: intake };
}
