import fs from "node:fs/promises";
import path from "node:path";
import { CodexSdkAgentClient } from "../agent/codex-sdk-client.js";
import { DeadlineAgentClient } from "../agent/deadline-agent-client.js";
import { loadPhase4Config } from "../execution/execution-config.js";
import { GitRunner } from "../git/git-runner.js";
import { preparePublishGitSecurity } from "../publish/publish-auth.js";
import { resolveCodexRuntime } from "../runtime/codex-runtime.js";
import { CodexVerificationSandbox } from "../verifier/codex-sandbox.js";
import { resolveTrustedRunContext } from "../web-review/trusted-run-context.js";
import { getRevisionStatus, reviseRun } from "./revision-service.js";
import { RevisionError, isRevisionError, revisionExitCode } from "./contracts.js";

export interface RevisionCliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

interface CommonArgs {
  runId: string;
  stateDirectory: string;
  json: boolean;
}
interface ReviseArgs extends CommonArgs {
  configPath: string;
  round: number;
}
interface StatusArgs extends CommonArgs {
  round?: number;
}

function parseFlags(argv: string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]!;
    if (!key.startsWith("--")) throw new RevisionError("REVISION_REQUEST_INVALID", `Unexpected positional argument '${key}'.`);
    if (flags.has(key)) throw new RevisionError("REVISION_REQUEST_INVALID", `Duplicate option '${key}'.`);
    if (key === "--json") { flags.set(key, true); continue; }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new RevisionError("REVISION_REQUEST_INVALID", `Option '${key}' requires a value.`);
    flags.set(key, value); index += 1;
  }
  return flags;
}
function required(flags: Map<string, string | true>, key: string): string {
  const value = flags.get(key);
  if (typeof value !== "string" || value.length === 0) throw new RevisionError("REVISION_REQUEST_INVALID", `Missing required option '${key}'.`);
  return value;
}
function parseRound(value: string | undefined, requiredRound: boolean): number | undefined {
  if (value === undefined) {
    if (requiredRound) throw new RevisionError("REVISION_REQUEST_INVALID", "Missing required option '--round'.");
    return undefined;
  }
  if (!/^[1-3]$/.test(value)) throw new RevisionError("REVISION_REQUEST_INVALID", "--round must be 1, 2, or 3.");
  return Number(value);
}
function parseRevise(argv: string[]): ReviseArgs {
  const flags = parseFlags(argv);
  const allowed = new Set(["--run-id","--state-dir","--config","--round","--json"]);
  for (const key of flags.keys()) if (!allowed.has(key)) throw new RevisionError("REVISION_REQUEST_INVALID", `Unknown revise option '${key}'.`);
  return { runId:required(flags,"--run-id"), stateDirectory:path.resolve(required(flags,"--state-dir")), configPath:path.resolve(required(flags,"--config")), round:parseRound(flags.get("--round") as string | undefined,true)!, json:flags.get("--json")===true };
}
function parseStatus(argv: string[]): StatusArgs {
  const flags = parseFlags(argv);
  const allowed = new Set(["--run-id","--state-dir","--round","--json"]);
  for (const key of flags.keys()) if (!allowed.has(key)) throw new RevisionError("REVISION_REQUEST_INVALID", `Unknown revision-status option '${key}'.`);
  const round=parseRound(flags.get("--round") as string | undefined,false);
  return { runId:required(flags,"--run-id"), stateDirectory:path.resolve(required(flags,"--state-dir")), ...(round!==undefined?{round}:{}), json:flags.get("--json")===true };
}

async function prepareRuntimeDirectory(stateDirectory: string): Promise<string> {
  const runtime = path.resolve(stateDirectory,"revision-runtime");
  await fs.mkdir(runtime,{recursive:true,mode:0o700});
  const stat=await fs.lstat(runtime);
  if(stat.isSymbolicLink()||!stat.isDirectory()||await fs.realpath(runtime)!==runtime) throw new RevisionError("REVISION_STATE_UNSAFE","Revision runtime directory must be a canonical real directory.");
  const hooks=path.join(runtime,"empty-hooks");
  await fs.mkdir(hooks,{mode:0o700}).catch(async(error)=>{if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;});
  const hookStat=await fs.lstat(hooks); if(hookStat.isSymbolicLink()||!hookStat.isDirectory()) throw new RevisionError("REVISION_STATE_UNSAFE","Revision empty-hooks path is unsafe.");
  const config=path.join(runtime,"empty-config");
  try{await fs.writeFile(config,"",{flag:"wx",mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error; const info=await fs.lstat(config);if(info.isSymbolicLink()||!info.isFile()||info.size!==0)throw new RevisionError("REVISION_STATE_UNSAFE","Revision empty-config file is unsafe.");}
  return runtime;
}
function collectSecrets(config: Awaited<ReturnType<typeof loadPhase4Config>>): string[] {
  const keys = new Set<string>();
  if(config.publish?.authentication.mode==="https_token") keys.add(config.publish.authentication.token_environment_key);
  if(config.github_pull_request?.authentication.mode==="https_token") keys.add(config.github_pull_request.authentication.token_environment_key);
  return [...keys].map((key)=>process.env[key]).filter((value):value is string=>typeof value==="string"&&value.length>=8);
}

export async function runReviseCli(argv: string[], io: RevisionCliIo): Promise<number> {
  let authPath: string | undefined;
  try {
    const args=parseRevise(argv);
    const runContext=await resolveTrustedRunContext(args.runId,args.stateDirectory,args.configPath);
    if(!runContext.runReceipt.remote_url) throw new RevisionError("REVISION_HISTORY_INVALID","Canonical run receipt has no trusted remote_url.");
    const config=await loadPhase4Config(args.configPath);
    if(!config.publish) throw new RevisionError("REVISION_CONFIG_INVALID","Trusted publish configuration is required.");
    const runtimeDir=await prepareRuntimeDirectory(args.stateDirectory);
    const runtime=await resolveCodexRuntime(config.runtime,args.stateDirectory);
    const auth=await preparePublishGitSecurity(config.publish,runContext.runReceipt.remote_url,runtimeDir,process.env);
    if(auth.mode==="https_token") authPath=auth.askpassScriptPath;
    const runner=new GitRunner(process.env,runtimeDir,{identity:config.publish.identity,auth});
    const agentClient=new DeadlineAgentClient(new CodexSdkAgentClient(runtime),config.agents.limits.maximum_turn_seconds);
    const receipt=await reviseRun({runId:args.runId,revisionRound:args.round,stateDirectory:args.stateDirectory,configPath:args.configPath,agentClient,sandbox:new CodexVerificationSandbox(runtime),gitRunner:runner,secrets:collectSecrets(config)});
    io.stdout(args.json?JSON.stringify(receipt):`Revision round ${receipt.revision_round}: ${receipt.state}\nPR #${receipt.pull_request_number}\nHead: ${receipt.new_published_commit_sha??"pending"}\nNext Web review round: ${receipt.next_review_round}`);
    return 0;
  } catch(error) {
    const revisionError=isRevisionError(error)?error:new RevisionError("REVISION_OPERATIONAL_ERROR",error instanceof Error?error.message:String(error));
    io.stderr(JSON.stringify({error:revisionError.code,message:revisionError.message}));
    return revisionExitCode(revisionError.code);
  } finally {
    if(authPath) await fs.unlink(authPath).catch(()=>undefined);
  }
}

export async function runRevisionStatusCli(argv: string[], io: RevisionCliIo): Promise<number> {
  try {
    const args=parseStatus(argv);
    const receipt=await getRevisionStatus(args.stateDirectory,args.runId,args.round);
    if(!receipt){io.stdout(args.json?"null":"No Phase 8 revision state found.");return 0;}
    io.stdout(args.json?JSON.stringify(receipt):`Revision round ${receipt.revision_round}: ${receipt.state}\nPR #${receipt.pull_request_number}\nHead: ${receipt.new_published_commit_sha??"pending"}\nNext Web review round: ${receipt.next_review_round}`);
    return 0;
  } catch(error) {
    const revisionError=isRevisionError(error)?error:new RevisionError("REVISION_OPERATIONAL_ERROR",error instanceof Error?error.message:String(error));
    io.stderr(JSON.stringify({error:revisionError.code,message:revisionError.message}));
    return revisionExitCode(revisionError.code);
  }
}
