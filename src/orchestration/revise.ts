import fs from "node:fs/promises";
import path from "node:path";
import { CodexSdkAgentClient } from "../agent/codex-sdk-client.js";
import { loadPhase4Config } from "../execution/execution-config.js";
import { GitRunner } from "../git/git-runner.js";
import { preparePublishGitSecurity } from "../publish/publish-auth.js";
import { resolveCodexRuntime } from "../runtime/codex-runtime.js";
import { CodexVerificationSandbox } from "../verifier/codex-sandbox.js";
import { resolveTrustedRunContext } from "../web-review/trusted-run-context.js";
import { reviseRun } from "../revision/revision-service.js";
import type { RevisionReceipt } from "../revision/contracts.js";
import { OrchestrationError } from "./contracts.js";

async function prepareRuntimeDirectory(stateDirectory: string): Promise<string> {
  const runtime = path.resolve(stateDirectory, "revision-runtime");
  await fs.mkdir(runtime, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(runtime);
  if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(runtime) !== runtime) throw new OrchestrationError("ORCHESTRATION_REVISION_STATE_UNSAFE", "Revision runtime directory must be a canonical real directory.");
  const hooks = path.join(runtime, "empty-hooks");
  await fs.mkdir(hooks, { mode: 0o700 }).catch(async (error) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  const hookStat = await fs.lstat(hooks);
  if (hookStat.isSymbolicLink() || !hookStat.isDirectory()) throw new OrchestrationError("ORCHESTRATION_REVISION_STATE_UNSAFE", "Revision empty-hooks path is unsafe.");
  const config = path.join(runtime, "empty-config");
  try { await fs.writeFile(config, "", { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await fs.lstat(config);
    if (info.isSymbolicLink() || !info.isFile() || info.size !== 0) throw new OrchestrationError("ORCHESTRATION_REVISION_STATE_UNSAFE", "Revision empty-config file is unsafe.");
  }
  return runtime;
}

function collectSecrets(config: Awaited<ReturnType<typeof loadPhase4Config>>): string[] {
  const keys = new Set<string>();
  if (config.publish?.authentication.mode === "https_token") keys.add(config.publish.authentication.token_environment_key);
  if (config.github_pull_request?.authentication.mode === "https_token") keys.add(config.github_pull_request.authentication.token_environment_key);
  return [...keys].map((key) => process.env[key]).filter((value): value is string => typeof value === "string" && value.length >= 8);
}

export async function reviseRunForOrchestration(options: {
  runId: string;
  revisionRound: number;
  stateDirectory: string;
  configPath: string;
  now?: () => Date;
}): Promise<RevisionReceipt> {
  let authPath: string | undefined;
  try {
    const runContext = await resolveTrustedRunContext(options.runId, options.stateDirectory, options.configPath);
    if (!runContext.runReceipt.remote_url) throw new OrchestrationError("ORCHESTRATION_REVISION_HISTORY_INVALID", "Canonical run receipt has no trusted remote_url.");
    const config = await loadPhase4Config(options.configPath);
    if (!config.publish) throw new OrchestrationError("ORCHESTRATION_REVISION_CONFIG_INVALID", "Trusted publish configuration is required.");
    const runtimeDirectory = await prepareRuntimeDirectory(options.stateDirectory);
    const runtime = await resolveCodexRuntime(config.runtime, options.stateDirectory);
    const auth = await preparePublishGitSecurity(config.publish, runContext.runReceipt.remote_url, runtimeDirectory, process.env);
    if (auth.mode === "https_token") authPath = auth.askpassScriptPath;
    const runner = new GitRunner(process.env, runtimeDirectory, { identity: config.publish.identity, auth });
    return await reviseRun({
      runId: options.runId,
      revisionRound: options.revisionRound,
      stateDirectory: options.stateDirectory,
      configPath: options.configPath,
      agentClient: new CodexSdkAgentClient(runtime),
      sandbox: new CodexVerificationSandbox(runtime),
      gitRunner: runner,
      secrets: collectSecrets(config),
      ...(options.now ? { now: options.now } : {}),
    });
  } finally {
    if (authPath) await fs.unlink(authPath).catch(() => undefined);
  }
}
