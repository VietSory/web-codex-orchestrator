import { mkdir } from "node:fs/promises";
import path from "node:path";
import { loadTrustedConfig } from "../config/config-loader.js";
import type { TrustedConfig } from "../config/contracts.js";
import { writeTrustedConfigAtomic } from "./config-writer.js";
import { resolveWcoPaths, type WcoPaths } from "./default-paths.js";
import { detectProject, type ProjectDiscovery } from "./project-detect.js";
import { detectRepository, type RepositoryDiscovery } from "./repository-detect.js";
import { atomicWriteJson } from "../run/run-store.js";

function allowedExecutables(project: ProjectDiscovery): string[] {
  const values = new Set(["node"]);
  for (const command of project.suggested_commands) values.add(command.executable);
  return [...values].sort();
}

export function buildFirstRunConfig(repository: RepositoryDiscovery, project: ProjectDiscovery): TrustedConfig {
  const githubAuth = repository.github_repository ? { mode: "gh_cli" as const } : undefined;
  return {
    config_version: "1.0",
    inbox: { poll_interval_ms: 2_000, stable_age_ms: 3_000, stable_observations: 2, maximum_candidates_per_scan: 100 },
    repositories: {
      [repository.repository_id]: {
        path: repository.root, remote: repository.remote, expected_remote_urls: repository.expected_remote_urls, fetch_policy: "if-missing",
      },
    },
    runtime: { source: "bundled" },
    agents: {
      implementer: { model: "gpt-5.6-terra", reasoning_effort: "high" },
      internal_reviewer: { model: "gpt-5.6-terra", reasoning_effort: "high" },
      final_reviewer: { model: "gpt-5.6-sol", reasoning_effort: "high" },
      limits: { maximum_implementation_iterations: 4, maximum_internal_review_rounds: 2, maximum_sol_review_rounds: 2, maximum_total_agent_turns: 16, maximum_turn_seconds: 900, maximum_total_seconds: 7_200, maximum_total_input_tokens: 2_000_000, maximum_total_output_tokens: 300_000 },
    },
    verification: { allowed_executables: allowedExecutables(project), allowed_environment_keys: ["CI"], maximum_command_seconds: 900, maximum_output_bytes: 4_194_304, maximum_file_bytes: 8_388_608, maximum_changed_files: 256, maximum_diff_lines: 100_000, allowed_generated_paths: [] },
    publish: { identity: { name: repository.git_user_name ?? "WCO User", email: repository.git_user_email ?? "wco@users.noreply.github.com" }, authentication: githubAuth ?? { mode: "none" } },
    ...(githubAuth ? { github_pull_request: { provider: "github.com" as const, authentication: githubAuth } } : {}),
    result_bundle: { github_attestation: githubAuth ? "required" : "optional" },
    ui: { interactive: true },
    web_bridge: { mode: "manual_file", poll_interval_ms: 1_000, job_ttl_seconds: 86_400 },
  };
}

export interface FirstRunResult {
  paths: WcoPaths;
  repository: RepositoryDiscovery;
  project: ProjectDiscovery;
  config: TrustedConfig;
}

export async function performFirstRunSetup(options: { cwd: string; configPath?: string; stateDirectory?: string; overwrite?: boolean }): Promise<FirstRunResult> {
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("SETUP_NODE_UNSUPPORTED: WCO requires Node.js 22 or newer.");
  const paths = resolveWcoPaths({
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
    ...(options.stateDirectory !== undefined ? { stateDirectory: options.stateDirectory } : {}),
  });
  const repository = await detectRepository(options.cwd);
  const project = await detectProject(repository.root);
  const discovered = buildFirstRunConfig(repository, project);
  for (const directory of [paths.home, paths.credentials, paths.state, paths.cache, paths.logs, paths.bridge]) await mkdir(directory, { recursive: true, mode: 0o700 });
  let current: TrustedConfig | null = null;
  try {
    current = await loadTrustedConfig(paths.config);
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "CONFIG_NOT_FOUND") throw error;
  }
  let config = discovered;
  let write = true;
  if (current) {
    const previous = current.repositories[repository.repository_id];
    if (previous) {
      const samePath = path.resolve(previous.path) === repository.root;
      const sameRemote = previous.remote === repository.remote && repository.expected_remote_urls.every((url) => previous.expected_remote_urls.includes(url));
      if (!samePath || !sameRemote) {
        throw new Error(`SETUP_REPOSITORY_ID_CONFLICT: '${repository.repository_id}' is already registered to a different path or remote. Existing trusted configuration was preserved.`);
      }
      config = current;
      write = false;
    } else {
      const allowedExecutables = new Set([...(current.verification?.allowed_executables ?? []), ...(discovered.verification?.allowed_executables ?? [])]);
      config = {
        ...current,
        repositories: { ...current.repositories, [repository.repository_id]: discovered.repositories[repository.repository_id]! },
        ...(current.verification ? { verification: { ...current.verification, allowed_executables: [...allowedExecutables].sort() } } : {}),
        ...(!current.github_pull_request && discovered.github_pull_request ? { github_pull_request: discovered.github_pull_request } : {}),
      };
    }
  }
  const written = write
    ? await writeTrustedConfigAtomic(paths.config, config, { overwrite: Boolean(current) || options.overwrite === true })
    : { config, backup_path: null };
  await atomicWriteJson(paths.install_manifest, { schema_version: "1.0", product: "web-codex-orchestrator", version: "0.3.2", home: paths.home, owned_paths: [paths.config, paths.credentials, paths.state, paths.cache, paths.logs, paths.bridge, paths.install_manifest] });
  return { paths, repository, project, config: written.config };
}
