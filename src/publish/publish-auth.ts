import { mkdir, stat, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import type { PublishConfig } from "../config/contracts.js";
import { GitPublishError } from "./contracts.js";

export interface PreparedPublishGitSecurity {
  askpassScriptPath?: string;
  askpassToken?: string;
  sshAuthSock?: string;
}

const ASKPASS_CONTENT = `#!/usr/bin/env node
const token = process.env.WCO_GIT_ASKPASS_TOKEN;
if (!token) process.exit(1);
process.stdout.write(token + "\\n");
`;

async function writeAskpassHelper(runtimeDirectory: string): Promise<string> {
  const authDir = path.join(runtimeDirectory, "publish-auth");
  const scriptPath = path.join(authDir, "askpass.mjs");
  const tempPath = path.join(authDir, `askpass-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs.tmp`);

  await mkdir(authDir, { recursive: true });
  await writeFile(tempPath, ASKPASS_CONTENT, { mode: 0o700 });
  
  try {
    await rename(tempPath, scriptPath);
  } catch {
    await writeFile(scriptPath, ASKPASS_CONTENT, { mode: 0o700 });
  }

  return scriptPath;
}

export async function preparePublishGitSecurity(
  config: PublishConfig | undefined,
  remoteUrl: string,
  runtimeDirectory: string,
  env: NodeJS.ProcessEnv,
): Promise<PreparedPublishGitSecurity> {
  if (!config) {
    throw new GitPublishError("PUBLISH_AUTH_UNAVAILABLE", "Publish configuration is missing.");
  }

  let protocol: "https" | "ssh" | "local";
  if (remoteUrl.startsWith("https://")) {
    protocol = "https";
  } else if (remoteUrl.startsWith("ssh://") || remoteUrl.startsWith("git@")) {
    protocol = "ssh";
  } else if (remoteUrl.startsWith("/") || remoteUrl.startsWith("C:\\") || remoteUrl.startsWith("file://")) {
    protocol = "local";
  } else {
    throw new GitPublishError("PUBLISH_AUTH_UNAVAILABLE", "Remote URL protocol is unsupported.");
  }

  const auth = config.authentication;

  if (protocol === "local") {
    if (auth.mode !== "none") {
      throw new GitPublishError("PUBLISH_AUTH_UNAVAILABLE", "Local remote requires mode: none.");
    }
    return {};
  }

  if (protocol === "https") {
    if (auth.mode !== "https_token") {
      throw new GitPublishError("PUBLISH_AUTH_UNAVAILABLE", "HTTPS remote requires mode: https_token.");
    }

    const token = env[auth.token_environment_key];
    if (typeof token !== "string" || token.length === 0 || token.includes("\n") || token.includes("\r") || token.includes("\0")) {
      throw new GitPublishError("PUBLISH_AUTH_UNAVAILABLE", "The HTTPS token is missing or invalid in the environment.");
    }

    const askpassScriptPath = await writeAskpassHelper(runtimeDirectory);

    return {
      askpassScriptPath,
      askpassToken: token,
    };
  }

  if (protocol === "ssh") {
    if (auth.mode !== "ssh_agent") {
      throw new GitPublishError("PUBLISH_AUTH_UNAVAILABLE", "SSH remote requires mode: ssh_agent.");
    }

    const sock = env[auth.socket_environment_key];
    if (typeof sock !== "string" || sock.length === 0 || sock.includes("\0") || (!path.isAbsolute(sock) && !sock.startsWith("\\\\.\\pipe\\"))) {
      throw new GitPublishError("PUBLISH_AUTH_UNAVAILABLE", "The SSH_AUTH_SOCK is missing or invalid in the environment.");
    }

    try {
      const info = await stat(sock);
      if (!info.isSocket() && !info.isFIFO() && !sock.startsWith("\\\\.\\pipe\\")) {
        throw new GitPublishError("PUBLISH_AUTH_UNAVAILABLE", "The SSH_AUTH_SOCK is not a socket or pipe.");
      }
    } catch {
      throw new GitPublishError("PUBLISH_AUTH_UNAVAILABLE", "The SSH_AUTH_SOCK path cannot be accessed.");
    }

    return {
      sshAuthSock: sock,
    };
  }

  throw new GitPublishError("PUBLISH_AUTH_UNAVAILABLE", "Unsupported authentication state.");
}
