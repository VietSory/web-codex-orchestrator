import fs from "node:fs/promises";
import path from "node:path";
import { intakeArchive } from "../intake/intake-service.js";
import type { AcceptedIntakeReceipt } from "../intake/contracts.js";

const MAX_PREVIEW_JSON_BYTES = 2 * 1024 * 1024;

export interface TaskPreviewCommand {
  id: string;
  command: string;
  required: boolean;
  timeout_seconds: number;
}

export interface TaskPreview {
  task_id: string;
  title: string;
  archive_sha256: string;
  repository: {
    id: string;
    base_branch: string;
    base_commit: string;
  };
  delivery: {
    branch_name: string;
    draft: boolean;
    auto_merge: boolean;
  };
  scope: {
    allowed_paths: string[];
    forbidden_paths: string[];
    max_changed_files: number;
    max_diff_lines: number;
  };
  verification: TaskPreviewCommand[];
  human_approval_required_for: string[];
  effects: {
    repository_modified: false;
    worktree_created: false;
    network_requested: false;
    state_intake_written: true;
  };
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a non-empty string.`);
  return value;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
}

function integer(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${name} must be a non-negative safe integer.`);
  return value as number;
}

function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error(`${name} must be an array of strings.`);
  return [...value] as string[];
}

function resolveAcceptedBundle(stateDirectory: string, receipt: AcceptedIntakeReceipt): string {
  const root = path.resolve(stateDirectory);
  const target = path.resolve(root, ...receipt.stored_bundle.split("/"));
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Accepted bundle path escapes the WCO state directory.");
  return target;
}

async function readPreviewJson(bundleDirectory: string, fileName: string): Promise<unknown> {
  const filePath = path.join(bundleDirectory, fileName);
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PREVIEW_JSON_BYTES) throw new Error(`${fileName} is not a bounded regular preview file.`);
  const value = await fs.readFile(filePath, "utf8");
  return JSON.parse(value) as unknown;
}

export async function previewTaskBundle(archivePath: string, stateDirectory: string): Promise<TaskPreview> {
  const intake = await intakeArchive(archivePath, stateDirectory);
  if (intake.status !== "accepted") {
    const first = intake.errors[0];
    throw new Error(first ? `${first.code}: ${first.message}` : "Task Bundle was rejected during secure intake.");
  }

  const bundleDirectory = resolveAcceptedBundle(stateDirectory, intake);
  const [manifestValue, validationValue, riskValue] = await Promise.all([
    readPreviewJson(bundleDirectory, "manifest.json"),
    readPreviewJson(bundleDirectory, "validation.json"),
    readPreviewJson(bundleDirectory, "risk-policy.json"),
  ]);
  const manifest = record(manifestValue, "manifest");
  const repository = record(manifest.repository, "manifest.repository");
  const delivery = record(manifest.delivery, "manifest.delivery");
  const limits = record(manifest.limits, "manifest.limits");
  const validation = record(validationValue, "validation");
  const risk = record(riskValue, "risk-policy");
  if (!Array.isArray(validation.commands)) throw new Error("validation.commands must be an array.");

  const verification = validation.commands.map((entry, index): TaskPreviewCommand => {
    const command = record(entry, `validation.commands[${index}]`);
    const executable = text(command.executable, `validation.commands[${index}].executable`);
    const args = strings(command.args, `validation.commands[${index}].args`);
    return {
      id: text(command.id, `validation.commands[${index}].id`),
      command: [executable, ...args].join(" "),
      required: boolean(command.required, `validation.commands[${index}].required`),
      timeout_seconds: integer(command.timeout_seconds, `validation.commands[${index}].timeout_seconds`),
    };
  });

  return {
    task_id: text(manifest.task_id, "manifest.task_id"),
    title: text(manifest.title, "manifest.title"),
    archive_sha256: intake.archive_sha256,
    repository: {
      id: text(repository.id, "manifest.repository.id"),
      base_branch: text(repository.base_branch, "manifest.repository.base_branch"),
      base_commit: text(repository.base_commit, "manifest.repository.base_commit"),
    },
    delivery: {
      branch_name: text(delivery.branch_name, "manifest.delivery.branch_name"),
      draft: boolean(delivery.draft, "manifest.delivery.draft"),
      auto_merge: boolean(delivery.auto_merge, "manifest.delivery.auto_merge"),
    },
    scope: {
      allowed_paths: strings(manifest.allowed_paths, "manifest.allowed_paths"),
      forbidden_paths: strings(manifest.forbidden_paths, "manifest.forbidden_paths"),
      max_changed_files: integer(limits.max_changed_files, "manifest.limits.max_changed_files"),
      max_diff_lines: integer(limits.max_diff_lines, "manifest.limits.max_diff_lines"),
    },
    verification,
    human_approval_required_for: strings(risk.human_approval_required_for, "risk-policy.human_approval_required_for"),
    effects: {
      repository_modified: false,
      worktree_created: false,
      network_requested: false,
      state_intake_written: true,
    },
  };
}

function terminalText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

export function formatTaskPreview(preview: TaskPreview): string {
  const lines = [
    `Task: ${terminalText(preview.task_id)}`,
    `Title: ${terminalText(preview.title)}`,
    "",
    "Repository target",
    `  ${terminalText(preview.repository.id)} @ ${terminalText(preview.repository.base_branch)}`,
    `  Base commit: ${terminalText(preview.repository.base_commit)}`,
    `  Delivery branch: ${terminalText(preview.delivery.branch_name)}`,
    `  Draft PR: ${preview.delivery.draft ? "yes" : "no"}`,
    `  Auto-merge: ${preview.delivery.auto_merge ? "yes" : "no"}`,
    "",
    "Scope contract",
    `  Allowed: ${preview.scope.allowed_paths.map(terminalText).join(", ") || "(none)"}`,
    `  Forbidden: ${preview.scope.forbidden_paths.map(terminalText).join(", ") || "(none)"}`,
    `  Max changed files: ${preview.scope.max_changed_files}`,
    `  Max diff lines: ${preview.scope.max_diff_lines}`,
    "",
    "Verification",
    ...preview.verification.map((command) => `  ${command.required ? "✓" : "○"} ${terminalText(command.id)}: ${terminalText(command.command)} (${command.timeout_seconds}s)`),
    "",
    "Human approval boundaries",
    ...preview.human_approval_required_for.map((value) => `  - ${terminalText(value)}`),
    "",
    "Preview effects",
    "  ✓ Task Bundle securely validated and stored in WCO state",
    "  ✓ No repository files modified",
    "  ✓ No worktree created",
    "  ✓ No network operation requested",
  ];
  return lines.join("\n");
}
