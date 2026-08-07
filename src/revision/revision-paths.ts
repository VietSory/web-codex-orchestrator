import fs from "node:fs/promises";
import path from "node:path";
import { RevisionError } from "./contracts.js";
import { parseRunIdentity } from "../web-review/web-review-paths.js";

export interface RevisionRoundPaths {
  directory: string;
  requestPath: string;
  receiptPath: string;
  implementationPath: string;
  verificationPath: string;
  terraReviewPath: string;
  solReviewPath: string;
  publishPath: string;
  evidencePath: string;
  lockPath: string;
  resultDirectory: string;
  resultReceiptPath: string;
  resultLockPath: string;
}

function assertContained(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new RevisionError("REVISION_STATE_UNSAFE", `Revision path escapes state directory: ${target}`);
}
async function assertRealDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new RevisionError("REVISION_STATE_UNSAFE", `Revision lifecycle path is not a real directory: ${directory}`);
}

export function resolveRevisionRoundPaths(stateDirectory: string, runId: string, round: number): RevisionRoundPaths {
  if (!Number.isInteger(round) || round < 1 || round > 3) throw new RevisionError("REVISION_REQUEST_INVALID", `Revision round must be an integer between 1 and 3; got ${round}`);
  const { taskId, archiveSha256 } = parseRunIdentity(runId);
  const root = path.resolve(stateDirectory);
  const padded = String(round).padStart(2, "0");
  const directory = path.resolve(root, "revisions", "runs", taskId, archiveSha256, "rounds", padded);
  const resultDirectory = path.resolve(root, "handoff", "runs", taskId, archiveSha256, "revisions", padded);
  assertContained(root, directory); assertContained(root, resultDirectory);
  return {
    directory,
    requestPath: path.join(directory, "revision-request.json"),
    receiptPath: path.join(directory, "revision-receipt.json"),
    implementationPath: path.join(directory, "implementation.json"),
    verificationPath: path.join(directory, "verification.json"),
    terraReviewPath: path.join(directory, "terra-review.json"),
    solReviewPath: path.join(directory, "sol-review.json"),
    publishPath: path.join(directory, "publish.json"),
    evidencePath: path.join(directory, "revision-evidence.json"),
    lockPath: path.join(directory, "revision.lock"),
    resultDirectory,
    resultReceiptPath: path.join(resultDirectory, "result-bundle.json"),
    resultLockPath: path.join(resultDirectory, "result-bundle.lock"),
  };
}

async function ensurePath(root: string, target: string): Promise<void> {
  const resolvedRoot = path.resolve(root); const resolvedTarget = path.resolve(target); assertContained(resolvedRoot, resolvedTarget); await assertRealDirectory(resolvedRoot);
  let current = resolvedRoot;
  for (const segment of path.relative(resolvedRoot, resolvedTarget).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try { await assertRealDirectory(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try { await fs.mkdir(current, { mode: 0o700 }); } catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError; }
      await assertRealDirectory(current);
    }
  }
  assertContained(await fs.realpath(resolvedRoot), await fs.realpath(resolvedTarget));
}
export async function prepareRevisionRoundPaths(stateDirectory: string, paths: RevisionRoundPaths): Promise<void> { await ensurePath(stateDirectory, paths.directory); await ensurePath(stateDirectory, paths.resultDirectory); }

export async function assertExistingRevisionPathSafe(stateDirectory: string, target: string, expectedType: "file" | "directory"): Promise<void> {
  const root = path.resolve(stateDirectory); const resolved = path.resolve(target); assertContained(root, resolved); await assertRealDirectory(root);
  let current = root; const segments = path.relative(root, resolved).split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]!); const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new RevisionError("REVISION_STATE_UNSAFE", `Revision path contains symbolic link: ${current}`);
    const final = index === segments.length - 1;
    if (!final && !stat.isDirectory()) throw new RevisionError("REVISION_STATE_UNSAFE", `Revision path ancestor is not a directory: ${current}`);
    if (final && expectedType === "file" && !stat.isFile()) throw new RevisionError("REVISION_STATE_UNSAFE", `Expected regular revision file: ${current}`);
    if (final && expectedType === "directory" && !stat.isDirectory()) throw new RevisionError("REVISION_STATE_UNSAFE", `Expected revision directory: ${current}`);
  }
  assertContained(await fs.realpath(root), await fs.realpath(resolved));
}
