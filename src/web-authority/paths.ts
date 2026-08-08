import fs from "node:fs/promises";
import path from "node:path";
import { WebAuthorityError } from "./contracts.js";

export interface WebAuthorityPaths {
  authorityRoot: string;
  runDirectory: string;
  artifactDirectory: string;
  archivePath: string;
  registrationPath: string;
}

function assertContained(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new WebAuthorityError("WEB_AUTHORITY_STATE_DIR_UNSAFE", `Authority path escapes the state root: ${target}`);
  }
}

async function assertDirectory(directoryPath: string): Promise<void> {
  const stat = await fs.lstat(directoryPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new WebAuthorityError("WEB_AUTHORITY_STATE_DIR_UNSAFE", `Authority state path must be a real directory: ${directoryPath}`);
  }
}

export async function prepareAuthorityDirectory(stateDirectory: string, targetDirectory: string): Promise<void> {
  const root = path.resolve(stateDirectory);
  const target = path.resolve(targetDirectory);
  assertContained(root, target);
  await assertDirectory(root);
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      await assertDirectory(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try { await fs.mkdir(current); } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      await assertDirectory(current);
    }
  }
  const realRoot = await fs.realpath(root);
  const realTarget = await fs.realpath(target);
  assertContained(realRoot, realTarget);
}

export async function assertExistingAuthorityFileSafe(stateDirectory: string, filePath: string): Promise<void> {
  const root = path.resolve(stateDirectory);
  const target = path.resolve(filePath);
  assertContained(root, target);
  await assertDirectory(root);
  const segments = path.relative(root, target).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new WebAuthorityError("WEB_AUTHORITY_STATE_DIR_UNSAFE", `Authority path contains a symbolic link: ${current}`);
    const final = index === segments.length - 1;
    if (!final && !stat.isDirectory()) throw new WebAuthorityError("WEB_AUTHORITY_STATE_DIR_UNSAFE", `Authority ancestor is not a directory: ${current}`);
    if (final && !stat.isFile()) throw new WebAuthorityError("WEB_AUTHORITY_STATE_DIR_UNSAFE", `Authority artifact is not a regular file: ${current}`);
  }
  const realRoot = await fs.realpath(root);
  const realTarget = await fs.realpath(target);
  assertContained(realRoot, realTarget);
}

export function webAuthorityPaths(stateDirectory: string, taskId: string, taskBundleSha256: string, artifactSha256: string): WebAuthorityPaths {
  const root = path.resolve(stateDirectory);
  const authorityRoot = path.join(root, "authority");
  const runDirectory = path.join(authorityRoot, "runs", taskId, taskBundleSha256);
  const artifactDirectory = path.join(runDirectory, "artifacts", artifactSha256);
  return {
    authorityRoot,
    runDirectory,
    artifactDirectory,
    archivePath: path.join(artifactDirectory, "web-implementation-pack.zip"),
    registrationPath: path.join(artifactDirectory, "registration.json"),
  };
}
