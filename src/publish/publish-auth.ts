import { open, lstat, realpath, chmod, mkdir, unlink, readFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import type { PublishConfig } from "../config/contracts.js";
import { resolveGitHubToken } from "../setup/credential-provider.js";
import { GitPublishError } from "./contracts.js";

export type PreparedPublishGitSecurity =
  | {
      mode: "none";
    }
  | {
      mode: "https_token";
      askpassScriptPath: string;
      askpassToken: string;
    };

const ASKPASS_CONTENT = `#!/usr/bin/env node

const prompt = process.argv[2] ?? "";

if (/username/i.test(prompt)) {
  process.stdout.write("x-access-token\\n");
  process.exit(0);
}

if (/password/i.test(prompt)) {
  const token = process.env.WCO_GIT_ASKPASS_TOKEN;

  if (!token) {
    process.exit(1);
  }

  process.stdout.write(\`\${token}\\n\`);
  process.exit(0);
}

process.exit(1);
`;

async function writeAskpassHelper(runtimeDirectory: string): Promise<string> {
  const authDir = path.resolve(runtimeDirectory, "publish-auth");
  await mkdir(authDir, { recursive: true, mode: 0o700 });
  
  const dirStat = await lstat(authDir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new GitPublishError("PUBLISH_AUTH_UNAVAILABLE", "Auth directory is invalid or symlink.");
  }
  const realAuthDir = await realpath(authDir);
  if (realAuthDir !== authDir) {
    throw new GitPublishError("PUBLISH_AUTH_UNAVAILABLE", "Auth directory path mismatch (symlink in parents).");
  }

  if (os.platform() !== "win32") {
    await chmod(authDir, 0o700);
    const updatedDirStat = await lstat(authDir);
    if ((updatedDirStat.mode & 0o077) !== 0) {
      throw new GitPublishError("PUBLISH_AUTH_UNAVAILABLE", "Auth directory permissions are unsafe.");
    }
  }

  const finalPath = path.join(authDir, `askpass-${process.pid}-${crypto.randomUUID()}.mjs`);
  
  let fd;
  try {
    fd = await open(finalPath, "wx", 0o700);
    await fd.write(ASKPASS_CONTENT);
    await fd.sync();
  } catch (err) {
    try { await unlink(finalPath); } catch {}
    throw new GitPublishError("PUBLISH_AUTH_UNAVAILABLE", "Failed to atomically create askpass helper.");
  } finally {
    if (fd) await fd.close();
  }

  if (os.platform() !== "win32") {
    await chmod(finalPath, 0o700);
  }
  
  const fileStat = await lstat(finalPath);
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    await unlink(finalPath);
    throw new GitPublishError("PUBLISH_AUTH_UNAVAILABLE", "Askpass helper is invalid or symlink.");
  }
  const realFinalPath = await realpath(finalPath);
  if (realFinalPath !== finalPath) {
    await unlink(finalPath);
    throw new GitPublishError("PUBLISH_AUTH_UNAVAILABLE", "Askpass helper path mismatch.");
  }

  if (os.platform() !== "win32") {
    if ((fileStat.mode & 0o077) !== 0) {
      await unlink(finalPath);
      throw new GitPublishError("PUBLISH_AUTH_UNAVAILABLE", "Askpass helper permissions are unsafe.");
    }
  }

  const readBack = await readFile(finalPath, "utf8");
  if (readBack !== ASKPASS_CONTENT) {
    await unlink(finalPath);
    throw new GitPublishError("PUBLISH_AUTH_UNAVAILABLE", "Askpass helper source mismatch.");
  }

  return finalPath;
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

  let protocol: "https" | "ssh" | "local" | "http";
  if (remoteUrl.startsWith("https://")) {
    protocol = "https";
  } else if (remoteUrl.startsWith("http://")) {
    protocol = "http";
  } else if (remoteUrl.startsWith("ssh://") || remoteUrl.startsWith("git@")) {
    protocol = "ssh";
  } else if (path.isAbsolute(remoteUrl) || remoteUrl.startsWith("file://")) {
    protocol = "local";
  } else {
    throw new GitPublishError("PUBLISH_AUTH_UNAVAILABLE", "Remote URL protocol is unsupported.");
  }

  if (protocol === "http" || protocol === "ssh") {
    throw new GitPublishError("PUBLISH_AUTH_UNAVAILABLE", "SSH and HTTP remotes are rejected.");
  }

  const auth = config.authentication;

  if (protocol === "local") {
    if (auth.mode !== "none") {
      throw new GitPublishError("PUBLISH_AUTH_UNAVAILABLE", "Local remote requires mode: none.");
    }
    return { mode: "none" };
  }

  if (protocol === "https") {
    if (auth.mode === "none") {
      throw new GitPublishError("PUBLISH_AUTH_UNAVAILABLE", "HTTPS remote requires token or gh_cli authentication.");
    }
    let token: string;
    try {
      token = await resolveGitHubToken(auth, env);
    } catch {
      throw new GitPublishError("PUBLISH_AUTH_UNAVAILABLE", "GitHub credentials are missing or invalid.");
    }

    const askpassScriptPath = await writeAskpassHelper(runtimeDirectory);

    return {
      mode: "https_token",
      askpassScriptPath,
      askpassToken: token,
    };
  }

  throw new GitPublishError("PUBLISH_AUTH_UNAVAILABLE", "Unsupported authentication state.");
}
