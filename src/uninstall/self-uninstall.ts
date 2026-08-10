import { spawn } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export interface SelfUninstallPlan { supported: boolean; command?: string[]; explanation: string; }
export interface SelfUninstallSchedule { scheduled: boolean; helper_path?: string; record_path?: string; explanation: string; }

export function planSelfUninstall(currentFile = fileURLToPath(import.meta.url)): SelfUninstallPlan {
  const normalized = currentFile.replaceAll("\\", "/");
  const globalMarker = "/lib/node_modules/web-codex-orchestrator/";
  const globalIndex = normalized.indexOf(globalMarker);
  if (globalIndex > 0) {
    const prefix = normalized.slice(0, globalIndex);
    return {
      supported: true,
      command: [process.platform === "win32" ? "npm.cmd" : "npm", "uninstall", "--global", "--prefix", prefix, "web-codex-orchestrator"],
      explanation: `The global npm package under '${prefix}' will be removed by a detached post-exit helper.`,
    };
  }
  const localMarker = "/node_modules/web-codex-orchestrator/";
  const localIndex = normalized.indexOf(localMarker);
  if (localIndex > 0) {
    const prefix = normalized.slice(0, localIndex);
    return {
      supported: true,
      command: [process.platform === "win32" ? "npm.cmd" : "npm", "uninstall", "--prefix", prefix, "web-codex-orchestrator"],
      explanation: `The npm package under '${prefix}' will be removed by a detached post-exit helper.`,
    };
  }
  return {
    supported: false,
    explanation: `This installation appears to be a source checkout or npm link (${path.dirname(currentFile)}). WCO preserved source; remove the link/package explicitly after reviewing it.`,
  };
}

export async function scheduleSelfUninstall(plan: SelfUninstallPlan, parentPid = process.pid): Promise<SelfUninstallSchedule> {
  if (!plan.supported || !plan.command?.length) return { scheduled: false, explanation: plan.explanation };
  const id = crypto.randomUUID();
  const helperPath = path.join(os.tmpdir(), `wco-uninstall-${id}.mjs`);
  const recordPath = path.join(os.tmpdir(), `wco-uninstall-${id}.json`);
  const encodedCommand = Buffer.from(JSON.stringify(plan.command), "utf8").toString("base64");
  const helper = `import { spawnSync } from "node:child_process";\nimport { unlinkSync, writeFileSync } from "node:fs";\nconst parentPid = ${JSON.stringify(parentPid)};\nconst helperPath = ${JSON.stringify(helperPath)};\nconst recordPath = ${JSON.stringify(recordPath)};\nconst command = JSON.parse(Buffer.from(${JSON.stringify(encodedCommand)}, "base64").toString("utf8"));\nconst sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));\nfunction alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }\nfor (let i = 0; i < 1200 && alive(parentPid); i += 1) await sleep(100);\nlet status = "parent_timeout", exitCode = null, error = null;\nif (!alive(parentPid)) {\n  try { const result = spawnSync(command[0], command.slice(1), { stdio: "ignore", shell: process.platform === "win32", windowsHide: true, timeout: 120000 }); exitCode = result.status; error = result.error?.message ?? null; status = !result.error && result.status === 0 ? "removed" : "failed"; }\n  catch (value) { status = "failed"; error = value instanceof Error ? value.message : String(value); }\n}\ntry { writeFileSync(recordPath, JSON.stringify({ status, exit_code: exitCode, error, completed_at: new Date().toISOString() }) + "\\n", { mode: 0o600 }); } catch {}\ntry { unlinkSync(helperPath); } catch {}\nprocess.exit(status === "removed" ? 0 : 1);\n`;
  await writeFile(helperPath, helper, { flag: "wx", mode: 0o600 });
  await chmod(helperPath, 0o600).catch(() => undefined);
  const child = spawn(process.execPath, [helperPath], { detached: true, stdio: "ignore", shell: false, windowsHide: true });
  child.unref();
  return { scheduled: true, helper_path: helperPath, record_path: recordPath, explanation: `Global package removal is scheduled after WCO exits. Completion record: ${recordPath}` };
}
